
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve } from "../../launcher/serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = fileURLToPath(new URL("dist/", import.meta.url));

async function start(options) {
  const server = await serve({
    version: 1,
    project: "pages",
    main: "routes.js",
    hosts: { Node: dist },
    options: { port: 0, log: "off", ...options },
  });

  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const browser = { cookie: "", token: "" };

function summary(text) {
  const title = text.match(/<title>(.*?)<\/title>/)?.[1];

  if (title !== undefined) {
    const main = text.match(/<main>(.*)<\/main>/s)?.[1] ?? "";
    const notice = text.match(/<p class="notice">(.*?)<\/p>/)?.[1];
    const flash = notice === undefined ? "" : ` notice=${JSON.stringify(notice)}`;
    const shown = main.replace(/(name="authenticity_token" value=")[^"]*/g, "$1TOKEN");

    return `title=${JSON.stringify(title)}${flash} main=${JSON.stringify(shown)}`;
  }

  const [first, ...rest] = text.split("\n");
  const more = rest.join("\n").includes("the boom action blew up") ? " +error message" : "";

  return `${JSON.stringify(first)}${more}`;
}

async function visit(base, method, path, form, { token = true } = {}) {
  const init = { method, redirect: "manual", headers: {} };

  if (form !== undefined) {
    const sent = token && method !== "GET" ? `${form}&authenticity_token=${browser.token}` : form;

    init.body = sent;
    init.headers["content-type"] = "application/x-www-form-urlencoded";
  }

  if (browser.cookie !== "") {
    init.headers.cookie = browser.cookie;
  }

  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];

  if (cookie !== undefined) {
    browser.cookie = cookie;
  }

  browser.token = text.match(/<meta name="csrf-token" content="([^"]+)">/)?.[1] ?? browser.token;

  return { response, text };
}

async function call(base, row, name, method, path, form, options) {
  const { response, text } = await visit(base, method, path, form, options);
  const extra = ["location", "allow", "content-type"]
    .map((h) => [h, response.headers.get(h)])
    .filter(([, v]) => v !== null)
    .map(([h, v]) => ` [${h}: ${v}]`)
    .join("");

  console.log(`${row} ${name}: ${method} ${path} -> ${response.status}${extra} ${summary(text)}`);
}

const dev = await start({ env: "development" });
const prod = await start({});

try {
  await visit(dev.base, "GET", "/articles/new");
  await call(dev.base, 1, "home_renders", "GET", "/");
  await call(dev.base, 2, "create_redirects_303", "POST", "/articles", "article[title]=Hi");
  await call(dev.base, 3, "follow_redirect", "GET", "/articles/1");
  await call(dev.base, 4, "missing_article", "GET", "/articles/99");
  await call(dev.base, 5, "bad_id", "GET", "/articles/abc");
  await call(dev.base, 6, "admin_needs_token", "GET", "/admin/stats");
  await call(dev.base, 7, "admin_with_token", "GET", "/admin/stats?token=secret");
  await call(dev.base, 8, "crash_dev", "GET", "/boom");
  await call(prod.base, 9, "crash_prod", "GET", "/boom");
  await call(dev.base, 10, "not_found", "GET", "/nope");
  await call(dev.base, 11, "method_not_allowed", "DELETE", "/");
  await call(dev.base, "+", "create_blank_422", "POST", "/articles", "article[title]=");
  await call(dev.base, "17", "create_blank_keeps_input", "POST", "/articles", "article[title]=%20");
  await call(dev.base, "23", "csrf_rejected", "POST", "/articles", "article[title]=Nope", { token: false });
  await call(dev.base, "23", "flash_once", "GET", "/articles/1");
  await call(dev.base, "+", "index_lists", "GET", "/articles");
  await call(dev.base, "+", "new_form", "GET", "/articles/new");
} finally {
  dev.server.close();
  prod.server.close();
}

function task(row, name, ...args) {
  const ran = spawnSync(process.env.POLAR ?? "polar", ["start", "--", ...args], {
    cwd: here,
    encoding: "utf8",
  });

  console.log(`${row} ${name}: exit ${ran.status}`);
  console.log(`${ran.stdout}${ran.stderr}`.trimEnd().replace(/^/gm, "  "));
}

task(12, "routes_task", "routes");
task(13, "unknown_task", "nope");
