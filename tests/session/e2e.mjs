
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionSettings } from "../../launcher/serve.mjs";

const launcher = fileURLToPath(new URL("../../launcher/serve.mjs", import.meta.url));
const pages = fileURLToPath(new URL("../../examples/pages/", import.meta.url));
const dist = `${pages}dist/`;

spawnSync(process.env.POLAR ?? "polar", ["build"], { cwd: pages });

function show(name, settings) {
  try {
    const { variables, warning } = sessionSettings(...settings);
    const warned = warning === undefined ? "" : " (warns)";

    console.log(`${name}: ${JSON.stringify(variables)}${warned}`);
  } catch (error) {
    console.log(`${name}: refuses: ${error.message}`);
  }
}

show("no_session_dev", [{}, {}, { env: "development" }]);
show("no_session_production", [{}, {}, {}]);
show("table_dev_warns", [{ session: {} }, {}, { env: "development" }]);
show("table_production_refuses", [{ session: {} }, {}, {}]);
show("toml_secret", [{ session: { secret: "a", max_age: 60 } }, {}, {}]);
show("env_beats_toml", [{ session: { secret: "a" } }, { TICKET_SECRET: "b" }, {}]);
show("env_alone_opts_in", [{}, { TICKET_SECRET: "b", TICKET_ENV: "test" }, { env: "development" }]);

function app(toml, options) {
  const root = mkdtempSync(join(tmpdir(), "ticket-session-"));
  const manifest = join(root, "manifest.json");

  writeFileSync(join(root, "ticket.toml"), toml);
  writeFileSync(
    manifest,
    JSON.stringify({ version: 1, project: "pages", main: "routes.js", hosts: { Node: dist }, root, options: { port: 0, ...options } }),
  );

  return manifest;
}

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TICKET_")));

function refused(name, toml, options, env = {}) {
  const ran = spawnSync("node", [launcher, app(toml, options)], {
    env: { ...clean, ...env },
    encoding: "utf8",
    timeout: 10000,
  });

  console.log(`${name}: exit ${ran.status} ${ran.stderr.trim()}`);
}

function served(name, toml, options, env = {}) {
  return new Promise((done) => {
    const child = spawn("node", [launcher, app(toml, options)], { env: { ...clean, ...env } });
    let out = "";
    let err = "";
    const finish = () => {
      console.log(`${name}: ${out.includes("is listening") ? "serves" : "silent"}${err.trim() === "" ? "" : `, stderr: ${err.trim()}`}`);
      child.kill();
      done();
    };

    child.stdout.on("data", (d) => {
      out += d;

      if (out.includes("is listening")) {
        finish();
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", () => out.includes("is listening") || finish());
  });
}

const secretless = "[session]\nmax_age = 60\n";

refused("21 production_without_secret", secretless, { env: "production" });
await served("22 production_with_secret_env", secretless, { env: "production" }, { TICKET_SECRET: "x" });
await served("22 production_with_secret_toml", '[session]\nsecret = "x"\n', { env: "production" });
await served("22 development_warns", secretless, { env: "development" });
await served("22 no_session_table", "", { env: "production" });
