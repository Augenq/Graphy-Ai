/**
 * Runs the agent (`graphy serve`) inside a Docker container, so its `bash` and file tools cannot touch the
 * rest of the computer. Shared by `npm run web` (scripts/run.mjs).
 *
 * What the container can see:
 *   /app/graphy   the agent's code, read-only
 *   /data         Graphy's data folder (~/.graphy: lessons, settings, provider keys), read-write
 *   /workspace    the working folder (~/.graphy/workspace or $GRAPHY_WORKSPACE), read-write
 * Everything else is the image: a read-only root file system, no Linux capabilities, no new privileges, limited
 * processes, memory and CPUs. The API port is published on this computer's loopback only.
 * `GRAPHY_SANDBOX=off` runs the agent directly on the computer instead.
 */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const backendDir = path.join(root, "backend");
const PORT = 8765;
const NETWORK = "graphy-net";
const SEARCH_NAME = "graphy-searxng";
const SEARCH_IMAGE = "docker.io/searxng/searxng:latest";

const enabled = () => process.env.GRAPHY_SANDBOX !== "off";
const dataDir = () => process.env.GRAPHY_DIR || path.join(os.homedir(), ".graphy");
const workspaceDir = () => process.env.GRAPHY_WORKSPACE || path.join(dataDir(), "workspace");

const docker = (args, options = {}) => spawnSync("docker", args, { encoding: "utf8", ...options });

/** Why Docker cannot be used, or "" when it can. The messages say what to do about it. */
function problem() {
  const probe = docker(["info", "--format", "{{.ServerVersion}}"]);
  if (probe.error) return "Docker не установлен (команда docker не найдена). Установите Docker или запустите с GRAPHY_SANDBOX=off.";
  if (probe.status === 0) return "";
  const out = `${probe.stderr}`;
  if (/permission denied/i.test(out)) return "Нет доступа к Docker. Добавьте себя в группу docker: sudo usermod -aG docker $USER, затем войдите в систему заново.";
  if (/cannot connect|no such file|is the docker daemon running/i.test(out)) return "Демон Docker не запущен. Запустите его: sudo systemctl enable --now docker.";
  return `Docker не отвечает: ${out.trim().split("\n")[0]}`;
}

/** Python adapters are mounted; the image includes the compiled Rust core and dependencies. */
function imageTag() {
  const hash = crypto.createHash("sha256");
  function sources(folder) {
    return fs.readdirSync(path.join(backendDir, folder), { withFileTypes: true }).flatMap(entry => {
      const relative = `${folder}/${entry.name}`;
      return entry.isDirectory() ? sources(relative) : /\.(rs|json)$/.test(entry.name) ? [relative] : [];
    });
  }
  const rustSources = sources("rust/src").sort();
  for (const file of ["Dockerfile", ".dockerignore", "requirements.lock", "graphy/_native/libgraphy_core.so", "rust/Cargo.toml", "rust/Cargo.lock", ...rustSources]) {
    hash.update(fs.readFileSync(path.join(backendDir, file)));
  }
  return `graphy-agent:${hash.digest("hex").slice(0, 12)}`;
}

const hasImage = (tag) => docker(["image", "inspect", tag]).status === 0;

/** Builds the agent image if it is missing. `log` receives progress lines. */
function ensureImage(log = console.log) {
  const tag = imageTag();
  if (hasImage(tag)) return tag;
  log("Собираю образ песочницы (один раз, пара минут)…");
  const build = docker(["build", "--network", "host", "-t", tag, "-f", path.join(backendDir, "Dockerfile"), backendDir], { stdio: "inherit" });
  if (build.status !== 0) throw new Error("Не удалось собрать образ песочницы (docker build).");
  return tag;
}

/** One private network for the agent and its search engine; neither is reachable from outside. */
function ensureNetwork() {
  if (docker(["network", "inspect", NETWORK]).status !== 0) docker(["network", "create", NETWORK]);
}

/** The host's address on that network: what the agent must use to reach servers running on this machine. */
function hostGateway() {
  const out = docker(["network", "inspect", NETWORK, "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"]);
  return out.status === 0 ? out.stdout.trim() : "";
}

function searchSecret() {
  const file = path.join(dataDir(), "searxng", "secret");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return fs.readFileSync(file, "utf8").trim();
}

/**
 * SearXNG as a sibling container on the private network: the agent searches the web through it (key-less, no
 * rate limit of its own). Best effort: without it the agent falls back to DuckDuckGo.
 * Returns true when this call started it (so the caller stops it again).
 */
function ensureSearch(log = console.log) {
  if (docker(["ps", "-q", "--filter", `name=^${SEARCH_NAME}$`]).stdout.trim()) return false;
  const run = docker(["run", "-d", "--rm", "--name", SEARCH_NAME, "--network", NETWORK, "--security-opt=no-new-privileges", "-v", `${path.join(root, "searxng", "settings.yml")}:/etc/searxng/settings.yml:ro`,
    "-e", `SEARXNG_SECRET=${searchSecret()}`, SEARCH_IMAGE], { stdio: ["ignore", "pipe", "pipe"] });
  if (run.status !== 0) {
    log(`SearXNG не запустился, поиск пойдёт через DuckDuckGo: ${run.stderr.trim().split("\n").pop()}`);
    return false;
  }
  return true;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Everything needed to start the agent in a container. Resolves with the command to spawn (stdin must stay open:
 * closing it stops the agent and with it the container), the address the interface should use, and a cleanup.
 */
async function prepare({ origins = [], log = console.log } = {}) {
  const why = problem();
  if (why) throw new Error(why);
  const tag = ensureImage(log);
  ensureNetwork();
  const gateway = hostGateway();
  const startedSearch = ensureSearch(log);
  fs.mkdirSync(workspaceDir(), { recursive: true });
  fs.mkdirSync(dataDir(), { recursive: true });
  const port = await freePort();
  const name = `graphy-agent-${process.pid}-${port}`;
  const user = typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
  const args = [
    "run", "--rm", "-i", "--name", name, "--network", NETWORK, "-p", `127.0.0.1:${port}:${PORT}`,
    "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=1g",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=2g", "--cpus=2",
    ...user,
    "-v", `${path.join(backendDir, "graphy")}:/app/graphy:ro`,
    "-v", `${dataDir()}:/data`,
    "-v", `${workspaceDir()}:/workspace`,
    "-e", "GRAPHY_DIR=/data", "-e", `SEARXNG_URL=http://${SEARCH_NAME}:8080`,
    ...(gateway ? ["-e", `GRAPHY_HOST_GATEWAY=${gateway}`] : []),
    "-w", "/workspace", tag,
    "sh", "-c", 'mkdir -p "$HOME" && exec python -m graphy "$@"', "graphy",
    "serve", "--host", "0.0.0.0", "--port", String(PORT), "--exit-on-stdin-close", "--cwd", "/workspace",
    ...origins.flatMap((origin) => ["--allow-origin", origin]),
  ];
  return {
    command: "docker",
    args,
    url: `http://127.0.0.1:${port}`,
    cleanup() {
      spawn("docker", ["stop", "-t", "3", name], { stdio: "ignore" }).unref();
      if (startedSearch) spawn("docker", ["stop", "-t", "3", SEARCH_NAME], { stdio: "ignore" }).unref();
    },
  };
}

/**
 * A file the learner attached lives on this computer, out of the container's sight. It is copied into the
 * working folder (attachments/) and the agent is given its path inside the container.
 */
function importAttachment(source) {
  const folder = path.join(workspaceDir(), "attachments");
  fs.mkdirSync(folder, { recursive: true });
  const { name, ext } = path.parse(source);
  let target = path.join(folder, name + ext);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(folder, `${name} (${n})${ext}`);
  fs.copyFileSync(source, target);
  return `/workspace/attachments/${path.basename(target)}`;
}

module.exports = { enabled, problem, imageTag, ensureImage, prepare, workspaceDir, dataDir, importAttachment };
