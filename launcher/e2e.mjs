
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { request as send } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorPage, filterParams, locate, serve } from "./serve.mjs";

const pages = fileURLToPath(new URL("../examples/pages/", import.meta.url));
const dist = `${pages}dist/`;

spawnSync(process.env.POLAR ?? "polar", ["build"], { cwd: pages });

async function start({ env = "production", files = {}, toml = "", log } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ticket-launcher-"));

  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "ticket.toml"), toml);

  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name);

    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }

  writeFileSync(join(root, "secret.txt"), "outside");

  const lines = [];
  const server = await serve(
    {
      version: 1,
      project: "pages",
      main: "routes.js",
      hosts: { Node: dist },
      root,
      options: { port: 0, env, ...(log === undefined ? {} : { log }) },
    },
    { write: (line) => lines.push(line) },
  );

  return { root, lines, server, base: `http://127.0.0.1:${server.address().port}` };
}

function raw(base, method, path, headers = {}, body) {
  const { port } = new URL(base);

  return new Promise((resolve, reject) => {
    const req = send({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";

      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });

    req.on("error", reject);
    req.end(body);
  });
}

const css = "body { color: red }\n";
const files = { "public/app.css": css, "public/.env": "SECRET=1", "public/assets/x.txt": "x", "public/app-3f9a1c2b.css": css };

function line(row, name, text) {
  console.log(`${row} ${name}: ${text}`);
}

let r;
const prod = await start({ files, log: "off" });
const dev = await start({ env: "development", files, log: "off" });

try {
  r = await raw(prod.base, "GET", "/app.css");
  line("1", "serves", `${r.status} ${r.headers["content-type"]} ${JSON.stringify(r.text)}`);
  r = await raw(prod.base, "HEAD", "/app.css");
  line("2", "head", `${r.status} ${r.headers["content-length"]} ${JSON.stringify(r.text)}`);
  r = await raw(prod.base, "GET", "/nope.css");
  line("3", "missing", `${r.status} ${r.text}`);
  r = await raw(prod.base, "GET", "/about");
  line("3", "router_still_works", `${r.status} ${r.headers["content-type"]}`);
  r = await raw(prod.base, "POST", "/app.css");
  line("3", "only_get_and_head", `${r.status}`);

  for (const [name, path] of [
    ["traversal", "/../secret.txt"],
    ["traversal_encoded", "/%2e%2e/secret.txt"],
    ["traversal_double", "/assets/../../secret.txt"],
    ["dotfile", "/.env"],
    ["directory", "/assets"],
    ["directory_slash", "/assets/"],
  ]) {
    r = await raw(prod.base, "GET", path);
    line("4", name, `${r.status} ${r.text}`);
  }

  const publicDir = join(prod.root, "public");

  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/a/%2e%2e/%2e%2e/secret.txt", "/a\\..\\secret.txt", "//etc/passwd", "/x%00.css", "/.env", "/assets/.hidden", "/assets", "/", "/%E0%A4%A"]) {
    line("4", `locate ${JSON.stringify(path)}`, String((await locate(publicDir, path)) !== null));
  }

  symlinkSync(join(prod.root, "secret.txt"), join(publicDir, "link.txt"));
  line("4", "symlink_out", String((await locate(publicDir, "/link.txt")) !== null));

  r = await raw(prod.base, "GET", "/app.css");
  const etag = r.headers.etag;
  line("7", "cache_production", `${r.headers["cache-control"]} etag=${etag !== undefined}`);
  r = await raw(prod.base, "GET", "/app.css", { "if-none-match": etag });
  line("7", "not_modified", `${r.status} ${JSON.stringify(r.text)}`);
  r = await raw(prod.base, "GET", "/app.css", { "if-none-match": "W/\"other\"" });
  line("7", "stale_etag", `${r.status}`);
  r = await raw(dev.base, "GET", "/app.css");
  line("8", "cache_development", `${r.headers["cache-control"]} etag=${r.headers.etag !== undefined}`);
  r = await raw(prod.base, "GET", "/app-3f9a1c2b.css");
  line("9", "hashed", r.headers["cache-control"]);
  r = await raw(dev.base, "GET", "/app-3f9a1c2b.css");
  line("9", "hashed_development", r.headers["cache-control"]);
} finally {
  prod.server.close();
  dev.server.close();
}

const logged = await start({ toml: '[server]\nfilter_params = ["ssn"]\n', files });

try {
  await raw(logged.base, "GET", "/about");
  await raw(logged.base, "GET", "/nope");
  await raw(logged.base, "GET", "/app.css");
  await raw(logged.base, "POST", "/articles", { "content-type": "application/x-www-form-urlencoded" }, "article[title]=Hi&password=hunter2&ssn=1&authenticity_token=t");
  await raw(logged.base, "POST", "/articles", { "content-type": "application/x-www-form-urlencoded" }, "user[token]=abc&user[name]=ann&tags[]=a&tags[]=b");
  await raw(logged.base, "POST", "/articles", { "content-type": "application/json" }, JSON.stringify({ title: "J", nested: { Secret: "x" } }));
  await raw(logged.base, "POST", "/articles", { "content-type": "text/plain" }, "password=plain");
  await raw(logged.base, "GET", "/admin/stats?token=secret&page=2");
  const names = [["10", "log_line"], ["11", "log_404"], ["10", "log_static"], ["12", "log_params"], ["13", "log_filtered_nested"], ["12", "log_json"], ["12", "log_other_body"], ["13", "log_query_filtered"]];

  logged.lines.forEach((text, i) => line(names[i][0], names[i][1], text.replace(/\(\d+ms\)/, "(Nms)")));
} finally {
  logged.server.close();
}

const quiet = await start({ log: "off" });

try {
  await raw(quiet.base, "GET", "/about");
  line("14", "log_off", `${quiet.lines.length} lines`);
} finally {
  quiet.server.close();
}

line("12", "filter_params", JSON.stringify(filterParams({ a: { "X-Token": 1, b: [{ password_confirmation: 2, ok: 3 }] }, cookie: { k: 1 } })));

const develop = await start({ env: "development", files, log: "off" });

try {
  r = await raw(develop.base, "GET", "/boom", { accept: "text/html" });
  const page = r.text;
  line("15", "dev_500_html", `${r.status} ${r.headers["content-type"]} message=${page.includes("the boom action blew up")} stack=${page.includes("Boom") && page.includes("at ")} request=${page.includes("GET /boom")}`);
  r = await raw(develop.base, "GET", "/boom?token=hunter2&q=a<b", { accept: "text/html" });
  line("15", "dev_500_filtered_and_escaped", `${r.status} token=${r.text.includes("hunter2")} filtered=${r.text.includes("token=[FILTERED]")} escaped=${r.text.includes("q=a%3Cb") || r.text.includes("q=a&lt;b")} raw_lt=${r.text.includes("a<b")}`);
  r = await raw(develop.base, "GET", "/boom", { accept: "application/json" });
  line("16", "dev_500_text", `${r.status} ${r.headers["content-type"]} ${r.text.split("\n")[0]} +message=${r.text.includes("the boom action blew up")}`);
} finally {
  develop.server.close();
}

const direct = await errorPage(
  "500",
  new Request("http://x/p?a=1", { method: "POST", headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" }, body: "name=<b>&password=x" }),
  new Error("<script>alert(1)</script>"),
  { env: "development" },
);
const directText = await direct.text();
line("15", "error_page_escapes", `script=${directText.includes("<script>alert")} escaped=${directText.includes("&lt;script&gt;")} password=${directText.includes("password") && !directText.includes("\"x\"")}`);

const pagesDir = { ...files, "public/500.html": "<h1>We're sorry</h1>", "public/404.html": "<h1>Gone</h1>" };
const withPages = await start({ files: pagesDir, log: "off" });
const without = await start({ files, log: "off" });

try {
  r = await raw(withPages.base, "GET", "/boom", { accept: "text/html" });
  line("17", "prod_500_page", `${r.status} ${r.text} error=${r.text.includes("blew up")}`);
  r = await raw(withPages.base, "GET", "/boom", { accept: "application/json" });
  line("17", "prod_500_not_html", `${r.status} ${r.text}`);
  r = await raw(without.base, "GET", "/boom", { accept: "text/html" });
  line("17", "prod_500_plain", `${r.status} ${r.text}`);
  r = await raw(withPages.base, "GET", "/nope", { accept: "text/html" });
  line("18", "prod_404_page", `${r.status} ${r.text}`);
  r = await raw(withPages.base, "GET", "/nope", { accept: "application/json" });
  line("18", "prod_404_json", `${r.status} ${r.text}`);
  r = await raw(without.base, "GET", "/nope", { accept: "text/html" });
  line("18", "prod_404_plain", `${r.status} ${r.text}`);
  r = await raw(withPages.base, "GET", "/articles/99", { accept: "text/html" });
  line("18", "action_404_stays", `${r.status} ${r.text}`);
} finally {
  withPages.server.close();
  without.server.close();
}
