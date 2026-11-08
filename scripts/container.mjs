/** Container entry point: starts the agent on loopback, waits until it is ready, then serves the web interface. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

mkdirSync(process.env.HOME || "/tmp/home", { recursive: true });
const token = randomBytes(32).toString("base64url");
const api = spawn("python", ["-m", "graphy", "serve", "--host", "127.0.0.1", "--port", "8765", "--cwd", "/workspace"], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, GRAPHY_TOKEN: token },
});
let web = null;
const stop = (code = 0) => { web?.kill(); api.kill(); setTimeout(() => process.exit(code), 1000).unref(); };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
api.on("exit", (code) => { console.error(`[backend] остановился (код ${code})`); stop(code || 1); });
createInterface({ input: api.stdout }).on("line", (line) => {
  if (web || !line.startsWith("{")) return console.log(`[backend] ${line}`);
  let ready;
  try { ready = JSON.parse(line); } catch { return console.log(`[backend] ${line}`); }
  if (ready.type !== "ready") return console.log(`[backend] ${line}`);
  console.log(`[backend] готов: ${ready.url}`);
  web = spawn(process.execPath, ["/app/scripts/web-server.mjs"], {
    stdio: "inherit",
    env: { ...process.env, GRAPHY_API_URL: ready.url, GRAPHY_API_TOKEN: ready.token },
  });
  web.on("exit", (code) => { console.error(`[frontend] остановился (код ${code})`); stop(code || 1); });
});
