/**
 * Local SearXNG: the agent's default web search (no key, no sign-up, no rate limit of its own).
 *
 * Installs into <data dir>/searxng (git clone + a Python venv) the first time and runs it on
 * http://127.0.0.1:8888 with the settings in searxng/settings.yml (JSON output on, bot limiter off).
 * `--docker` runs the official image through docker or podman instead of the native install.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
export const PORT = Number(process.env.SEARXNG_PORT || 8888);
export const ADDRESS = `http://127.0.0.1:${PORT}`;

const home = join(process.env.GRAPHY_DIR || join(homedir(), ".graphy"), "searxng");
const source = join(home, "src");
const venvPython = join(home, "venv", ...(win ? ["Scripts", "python.exe"] : ["bin", "python"]));
const settings = join(root, "searxng", "settings.yml");
const backendPython = join(root, "backend", ".venv", ...(win ? ["Scripts", "python.exe"] : ["bin", "python"]));

const has = (cmd) => !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
const step = (cmd, args, options = {}) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.error || result.status) throw new Error(`${cmd} ${args[0] ?? ""}: ${result.error?.message ?? `код ${result.status}`}`);
};

/** The secret key is generated once and kept, so restarts do not log anything out of a running page. */
function secret() {
  const file = join(home, "secret");
  if (!existsSync(file)) {
    mkdirSync(home, { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(file, "utf8").trim();
}

export const installed = () => existsSync(venvPython) && existsSync(join(source, "searx"));

export async function isUp() {
  try {
    return (await fetch(`${ADDRESS}/healthz`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** First start only: a shallow clone of SearXNG and its Python dependencies in a private venv. */
export function install() {
  if (!has("git")) throw new Error("нужен git, чтобы скачать SearXNG (или запустите с --docker)");
  const base = existsSync(backendPython) ? backendPython : win ? "python" : "python3";
  console.log(`Устанавливаю SearXNG в ${home} (один раз, около минуты)`);
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(source, "searx"))) step("git", ["clone", "--depth", "1", "https://github.com/searxng/searxng", source]);
  if (!existsSync(venvPython)) step(base, ["-m", "venv", join(home, "venv")]);
  step(venvPython, ["-m", "pip", "install", "-q", "-U", "pip", "setuptools", "wheel"]);
  step(venvPython, ["-m", "pip", "install", "-q", "-r", join(source, "requirements.txt")]);
}

/** Starts SearXNG and resolves with its process once /healthz answers (null when it was already running). */
export async function start({ docker = false, log = console.log } = {}) {
  if (await isUp()) return null;
  let child;
  const env = { ...process.env, SEARXNG_SECRET: secret(), SEARXNG_SETTINGS_PATH: settings };
  if (docker) {
    const tool = ["docker", "podman"].find(has);
    if (!tool) throw new Error("docker и podman не найдены");
    child = spawn(tool, ["run", "--rm", "--name", "graphy-searxng", "-p", `127.0.0.1:${PORT}:8080`, "-v", `${settings}:/etc/searxng/settings.yml:ro`,
      "-e", `SEARXNG_SECRET=${env.SEARXNG_SECRET}`, "docker.io/searxng/searxng:latest"], { stdio: ["ignore", "pipe", "pipe"] });
  } else {
    if (!installed()) install();
    child = spawn(venvPython, ["-m", "searx.webapp"], {
      cwd: source,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, PYTHONPATH: source, SEARXNG_BIND_ADDRESS: "127.0.0.1", SEARXNG_PORT: String(PORT) },
    });
  }
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => chunk.split("\n").filter((l) => l && !/botdetection|can't register engine|RuntimeWarning/.test(l)).forEach((line) => log(line)));
  }
  let exited = false;
  child.once("exit", () => (exited = true));
  for (let i = 0; i < 60 && !exited; i++) {
    if (await isUp()) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("SearXNG не ответил за 30 секунд");
}
