import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const shim = join(home, "bin", "ticket");
const scratch = mkdtempSync(join(tmpdir(), "ticket-watch-e2e-"));
const row = (n, name, text) => console.log(`${n} ${name}: ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function get(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    return `${r.status} ${(await r.text()).trim()}`;
  } catch {
    return null;
  }
}

async function until(port, want, ms = 60000) {
  const end = Date.now() + ms;
  let last = null;

  while (Date.now() < end) {
    last = await get(port);
    if (last !== null && want(last)) return last;
    await sleep(200);
  }
  return `timeout (last: ${last})`;
}

let child;

try {
  // Row 3: production is refused.
  const app0 = join(home, "cli", "fixtures", "console_app");
  const r = spawnSync(shim, ["server", "--watch"], { cwd: app0, encoding: "utf8", env: { ...process.env, TICKET_ENV: "production" } });

  row(3, "production", `exit=${r.status} ${r.stderr.trim()}`);

  const app = join(scratch, "app");

  cpSync(join(home, "examples", "hello"), app, { recursive: true, filter: (p) => !p.endsWith("/dist") });
  writeFileSync(join(app, "polar.toml"), readFileSync(join(app, "polar.toml"), "utf8").replace('path = "../.."', `path = "${home}"`));

  const port = await freePort();
  let log = "";

  child = spawn(shim, ["server", "--watch", "-p", String(port)], { cwd: app, detached: true, env: { ...process.env, TICKET_ENV: "" } });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const first = await until(port, (t) => t.startsWith("200"));
  const view = join(app, "src", "pages.px");
  const src = readFileSync(view, "utf8");

  writeFileSync(view, src.replace("Hello from", "Reloaded by"));
  const second = await until(port, (t) => t.includes("Reloaded by"));

  row(1, "reload", `${first.includes("Hello from")} -> ${second.includes("Reloaded by")} same_port=${(await get(port)) !== null}`);

  const mark = log.length;

  writeFileSync(view, src.replace("home(name: String)", "home(name: String)\n    <h1>{missing_name}</h1>\n"));
  await sleep(4000);
  const after = await get(port);

  row(2, "broken_edit", `still=${after}`.includes("Reloaded by") ? "old body served" : `still=${after}`);
  row(2, "diagnostics", log.length > mark ? "printed" : "none");
} finally {
  if (child) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}
