#!/usr/bin/env node
/**
 * One entry point for the whole project: `npm run <command>` at the root.
 *
 *   setup  install the backend (Python venv) and the frontend (npm)
 *   dev    the agent API and the web interface, started together
 *   web    the agent API and the interface in a browser, started together
 *   serve  only the agent API (prints its address and token)
 *   search the local SearXNG that the agent searches the web with (installs itself on the first start)
 *   sandbox  build the Docker image the agent runs in and check that Docker works

 * The agent runs inside Docker by default (see scripts/sandbox.cjs); GRAPHY_SANDBOX=off runs it directly.
 *   test   backend tests, linters and the frontend type check
 *   build  production build of the interface
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import * as searxng from "./searxng.mjs";

const sandbox = createRequire(import.meta.url)("./sandbox.cjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "backend");
const frontend = join(root, "frontend");
const win = process.platform === "win32";
const npm = win ? "npm.cmd" : "npm";
const python = process.env.GRAPHY_PYTHON || join(backend, ".venv", ...(win ? ["Scripts", "python.exe"] : ["bin", "python"]));

/** Match Vite's localhost binding and skip ports occupied by other dev servers. */
async function webPort() {
  for (let port = 5174; port <= 65535; port++) {
    const available = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", (error) => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
      probe.listen(port, "localhost", () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("Нет свободного порта для веб-интерфейса.");
}

const [command = "dev", ...rest] = process.argv.slice(2);

function fail(message) {
  console.error(`graphy: ${message}`);
  process.exit(1);
}

/** Runs a command to completion, output attached to this terminal. */
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: win && cmd.endsWith(".cmd"), ...options });
  if (result.error) fail(`${cmd}: ${result.error.message}`);
  return result.status ?? 1;
}

function needBackend() {
  if (!existsSync(python)) fail("бэкенд не установлен. Выполните: npm run setup");
}

function needFrontend() {
  if (!existsSync(join(frontend, "node_modules"))) fail("зависимости интерфейса не установлены. Выполните: npm run setup");
}

/** Prints every line of a stream with a prefix, so two processes stay readable in one terminal. */
function prefixed(stream, label, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      if (onLine?.(line) === false) continue;
      console.log(`[${label}] ${line}`);
    }
  });
}

const commands = {
  setup() {
    const status =
      run(win ? "cmd" : "bash", win ? ["/c", "setup.bat"] : ["setup.sh"], { cwd: backend }) ||
      // a clean checkout installs exactly what the lock file says; later runs only fill in what is missing
      run(npm, [existsSync(join(frontend, "node_modules")) ? "install" : existsSync(join(frontend, "package-lock.json")) ? "ci" : "install"], { cwd: frontend });
    if (!status && sandbox.enabled()) {
      // the agent runs in Docker: get its image ready now rather than at the first launch
      const why = sandbox.problem();
      if (why) console.warn(`\nПесочница Docker пока недоступна: ${why}`);
      else sandbox.ensureImage();
    }
    process.exit(status);
  },

  dev() { return commands.web(); },

  start() {
    if (!existsSync(join(frontend, "dist", "index.html"))) fail("сначала соберите сайт: npm run build");
    return commands.web(true);
  },

  /** Backend first (its address and token are random), then the interface pointed at it. */
  async web(production = false) {
    if (!production) needFrontend();
    const port = await webPort();
    const webOrigin = `http://localhost:${port}`;
    if (port !== 5174) console.log(`[frontend] порт 5174 занят; используем ${webOrigin}`);
    // The agent in a container (default) or directly on this computer (GRAPHY_SANDBOX=off).
    let box = null;
    if (sandbox.enabled()) {
      try {
        box = await sandbox.prepare({ origins: [webOrigin], log: (line) => console.log(`[sandbox] ${line}`) });
      } catch (error) {
        fail(`${error.message}\n(без песочницы: GRAPHY_SANDBOX=off npm run web)`);
      }
    } else needBackend();
    // web search: start SearXNG too when it has been installed (`npm run search` installs it)
    let search = null;
    if (!box && searxng.installed()) {
      searxng.start({ log: (line) => console.log(`[search] ${line}`) }).then(
        (child) => ((search = child) && console.log(`[search] готов: ${searxng.ADDRESS}`)),
        (error) => console.error(`[search] ${error.message}`),
      );
    }
    const api = spawn(box?.command ?? python, box?.args ?? ["-m", "graphy", "serve", "--exit-on-stdin-close", "--allow-origin", webOrigin, "--cwd", process.cwd()], {
      cwd: backend,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let ui = null;
    let stopping = false;
    const stop = (code = 0) => {
      if (stopping) return;
      stopping = true;
      ui?.kill();
      search?.kill();
      box?.cleanup();
      api.stdin.end();
      setTimeout(() => (api.kill(), process.exit(code)), 1500).unref();
      api.once("exit", () => process.exit(code));
    };
    process.on("SIGINT", () => stop(0));
    process.on("SIGTERM", () => stop(0));
    api.on("exit", (code) => !stopping && (console.error(`[backend] остановился (код ${code})`), stop(code || 1)));
    prefixed(api.stderr, "backend");
    prefixed(api.stdout, "backend", (line) => {
      if (ui || !line.startsWith("{")) return true;
      try {
        const ready = JSON.parse(line);
        if (ready.type !== "ready") return true;
        const url = box?.url ?? ready.url; // in a container the agent's own address is not the one published here
        console.log(`[backend] готов: ${url}${box ? " (в Docker)" : ""}`);
        ui = spawn(production ? process.execPath : npm, production ? [join(root, "scripts", "web-server.mjs")] : ["run", "dev", "--", "--host", "localhost", "--port", String(port)], {
          cwd: frontend,
          stdio: ["ignore", "pipe", "pipe"],
          shell: win,
          env: { ...process.env, GRAPHY_API_URL: url, GRAPHY_API_TOKEN: ready.token, GRAPHY_WEB_PORT: String(port) },
        });
        prefixed(ui.stdout, "frontend");
        prefixed(ui.stderr, "frontend");
        ui.on("exit", (code) => !stopping && (console.error(`[frontend] остановился (код ${code})`), stop(code || 1)));
        return false;
      } catch {
        return true;
      }
    });
  },

  serve() {
    needBackend();
    process.exit(run(python, ["-m", "graphy", "serve", ...rest], { cwd: backend }));
  },

  /** Builds the agent's Docker image (first start only) and checks that Docker is usable. */
  sandbox() {
    const why = sandbox.problem();
    if (why) fail(why);
    console.log(`Образ песочницы: ${sandbox.ensureImage()}`);
    console.log(`Рабочая папка агента: ${sandbox.workspaceDir()}`);
    console.log("Docker готов: `npm run web` и `npm run dev` запускают агента в контейнере.");
  },

  /** Foreground SearXNG: Ctrl+C stops it. `-- --docker` runs the official image instead of the native install. */
  async search() {
    try {
      const child = await searxng.start({ docker: rest.includes("--docker") });
      if (!child) return console.log(`SearXNG уже запущен: ${searxng.ADDRESS}`);
      console.log(`SearXNG готов: ${searxng.ADDRESS} (агент использует его по умолчанию), Ctrl+C останавливает`);
      const stop = () => child.kill();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      child.once("exit", (code) => process.exit(code ?? 0));
    } catch (error) {
      fail(error.message);
    }
  },

  test() {
    needBackend();
    needFrontend();
    const steps = [
      [python, ["-m", "pytest", "-q"], backend],
      [python, ["-m", "ruff", "check", "graphy", "tests"], backend],
      [python, ["-m", "mypy"], backend],
      [npm, ["run", "typecheck"], frontend],
      [process.execPath, ["--check", join(root, "scripts", "web-server.mjs")], root],
      [process.execPath, ["--test", join(root, "scripts", "web-proxy.test.mjs")], root],
    ];
    for (const [cmd, args, cwd] of steps) {
      console.log(`\n$ ${cmd === npm ? "npm" : cmd === python ? "python" : "node"} ${args.join(" ")}   (${cwd.replace(root, ".")})`);
      const status = run(cmd, args, { cwd });
      if (status) process.exit(status);
    }
  },

  build() {
    needFrontend();
    process.exit(run(npm, ["run", "build"], { cwd: frontend }));
  },
};

if (!commands[command]) {
  fail(`неизвестная команда «${command}». Доступны: ${Object.keys(commands).join(", ")}`);
}
commands[command]();
