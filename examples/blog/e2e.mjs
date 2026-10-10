
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { serve } from "../../launcher/serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const home = join(here, "..", "..");
const dist = join(here, "dist/");
const scratch = mkdtempSync(join(tmpdir(), "ticket-blog-e2e-"));
const database = join(scratch, "blog.sqlite3");

process.env.TICKET_DATABASE_ADAPTER = "sqlite";
process.env.TICKET_DATABASE = database;

const reset = spawnSync(process.env.POLAR ?? "polar", ["start", "--", "db:reset"], { cwd: here, encoding: "utf8", env: process.env });

if (reset.status !== 0) {
  console.log(`db:reset failed: ${reset.stdout}${reset.stderr}`);
  process.exit(1);
}

const log = [];
const server = await serve(
  { version: 1, project: "blog", main: "main.js", hosts: { Node: dist }, root: here, options: { port: 0, env: "development" } },
  { write: (line) => log.push(line.replace(/\(\d+ms\)/, "(Nms)")) },
);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = { cookie: "", token: "" };

async function visit(method, path, form, { token = true } = {}) {
  const init = { method, redirect: "manual", headers: {} };

  if (form !== undefined) {
    init.body = token ? `${form}&authenticity_token=${browser.token}` : form;
    init.headers["content-type"] = "application/x-www-form-urlencoded";
  }

  if (browser.cookie !== "") {
    init.headers.cookie = browser.cookie;
  }

  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();

  browser.cookie = response.headers.getSetCookie()[0]?.split(";")[0] ?? browser.cookie;
  browser.token = text.match(/<meta name="csrf-token" content="([^"]+)">/)?.[1] ?? browser.token;

  return { status: response.status, location: response.headers.get("location"), type: response.headers.get("content-type"), text };
}

const row = (n, name, text) => console.log(`${n} ${name}: ${text}`);
const count = (table) => {
  const db = new DatabaseSync(database);
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();

  db.close();
  return n;
};
const strip = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const titles = (html) => [...html.matchAll(/<li><a href="\/posts\/(\d+)">(.*?)<\/a><span class="byline"> by (.*?)<\/span><\/li>/g)].map((m) => `${m[2]} (${m[3]})`).join(" | ");
const notice = (html) => html.match(/<p class="notice">(.*?)<\/p>/)?.[1] ?? "-";
const message = (html) => [...html.matchAll(/<li>([^<]*(?:can&#39;t|is too|already)[^<]*)<\/li>/g)].map((m) => m[1]).join(" | ") || "-";

try {
  await visit("GET", "/posts/new");

  let r = await visit("GET", "/posts");
  row(1, "index", `${r.status} ${titles(r.text)}`);
  r = await visit("GET", "/");
  row(1, "root_is_index", `${r.status} ${titles(r.text).split(" | ")[0]}`);

  r = await visit("GET", "/posts/1");
  row(2, "show", `${r.status} ${strip(r.text.match(/<article>(.*?)<h2>/s)?.[1] ?? "")} | comments: ${[...r.text.matchAll(/<li>(.*?)<form/g)].map((m) => strip(m[1])).join(", ")}`);

  const alert = (html) => html.match(/<p class="alert">(.*?)<\/p>/)?.[1] ?? "-";
  const users = count("users");

  r = await visit("GET", "/posts/new");
  row(20, "protected", `${r.status} ${r.location}`);
  r = await visit("GET", "/login");
  row(20, "login_page", `${r.status} alert=${alert(r.text)}`);
  r = await visit("POST", "/login", "email=ann%40example.com&password=wrong");
  row(21, "wrong_password", `${r.status} ${alert(r.text)}`);
  r = await visit("POST", "/login", "email=nobody%40example.com&password=wrong");
  row(21, "unknown_email", `${r.status} ${alert(r.text)}`);
  r = await visit("POST", "/login", "email=ann%40example.com&password=password");
  row(22, "login_returns_to", `${r.status} ${r.location}`);
  r = await visit("GET", r.location);
  row(22, "logged_in_page", `${r.status} logout=${r.text.includes("Log out")}`);
  r = await visit("POST", "/logout", "_method=delete");
  row(22, "logout", `${r.status} ${r.location}`);
  await visit("GET", r.location);
  r = await visit("POST", "/posts", "post[title]=Not+logged+in&post[body]=x");
  row(22, "create_refused", `${r.status} ${r.location}`);
  r = await visit("POST", "/signup", "user[name]=Dan&user[email]=dan%40example.com&user[password]=short&user[password_confirmation]=different");
  row(23, "signup_invalid", `${r.status} ${message(r.text)} users=${count("users") - users}`);
  r = await visit("POST", "/signup", "user[name]=Dan&user[email]=dan%40example.com&user[password]=long-enough&user[password_confirmation]=long-enough");
  row(23, "signup", `${r.status} ${r.location} users=${count("users") - users}`);
  await visit("GET", r.location);
  r = await visit("POST", "/logout", "_method=delete");
  await visit("GET", r.location);
  r = await visit("POST", "/login", "email=dan%40example.com&password=long-enough");
  row(23, "login_new_user", `${r.status} ${r.location}`);
  await visit("GET", r.location);
  r = await visit("POST", "/logout", "_method=delete");
  await visit("GET", r.location);
  r = await visit("POST", "/login", "email=ann%40example.com&password=password");
  row(24, "login_again", `${r.status} ${r.location}`);
  await visit("GET", r.location);

  r = await visit("POST", "/posts", "post[title]=A+brand+new+post&post[body]=Some+text&post[published]=on");
  row(3, "create", `${r.status} ${r.location}`);
  const created = r.location;

  const before = count("posts");

  r = await visit("POST", "/posts", "post[title]=Hi&post[body]=text");
  row(4, "create_short", `${r.status} ${message(r.text)} typed=${r.text.includes('value="Hi"')} posts=${count("posts") - before}`);
  r = await visit("POST", "/posts", "post[title]=%20%20&post[body]=");
  row(5, "create_blank", `${r.status} ${message(r.text)} posts=${count("posts") - before}`);
  r = await visit("POST", "/posts", "post[title]=Hello,+Ticket&post[body]=again");
  row(6, "create_duplicate", `${r.status} ${message(r.text)} typed=${r.text.includes('value="Hello, Ticket"')} posts=${count("posts") - before}`);

  r = await visit("POST", created, "_method=patch&post[title]=A+better+title&post[body]=Edited");
  row(7, "update", `${r.status} ${r.location}`);
  r = await visit("GET", created);
  row(7, "updated", `${strip(r.text.match(/<h1>(.*?)<\/h1>/)?.[1] ?? "")} / ${strip(r.text.match(/<p>(Edited)<\/p>/)?.[1] ?? "-")}`);
  r = await visit("POST", created, "_method=patch&post[title]=x&post[body]=Edited");
  row(7, "update_invalid", `${r.status} ${message(r.text)}`);

  const comments = count("comments");

  r = await visit("POST", "/posts/1", "_method=delete");
  row(8, "delete", `${r.status} ${r.location}`);
  row(9, "delete_cascade", `post gone=${(await visit("GET", "/posts/1")).status} comments ${comments} -> ${count("comments")}`);

  r = await visit("POST", "/posts/2/comments", "comment[body]=Third+comment");
  row(10, "comment_create", `${r.status} ${r.location}`);
  r = await visit("GET", "/posts/2");
  row(10, "comments_in_order", [...r.text.matchAll(/<li>(.*?)<form/g)].map((m) => strip(m[1])).join(" | "));
  r = await visit("POST", "/posts/2/comments", "comment[body]=");
  row(11, "comment_invalid", `${r.status} ${message(r.text)} post_shown=${r.text.includes("<h1>Forms and flash</h1>")}`);
  r = await visit("POST", "/posts/2/comments/4", "_method=delete");
  row(11, "comment_delete", `${r.status} ${r.location}`);
  r = await visit("GET", "/posts/2");
  row(11, "comment_deleted", [...r.text.matchAll(/<li>(.*?)<form/g)].map((m) => strip(m[1])).join(" | "));
  r = await visit("POST", "/posts/2/comments/1", "_method=delete");
  row(11, "comment_of_another_post", `${r.status}`);

  for (const [method, path, form] of [["GET", "/posts/99"], ["POST", "/posts/99", "_method=patch&post[title]=nope"], ["POST", "/posts/99", "_method=delete"], ["GET", "/posts/99/edit"]]) {
    r = await visit(method, path, form);
    row(12, "not_found", `${method} ${path}${form === undefined ? "" : ` ${form.split("&")[0]}`} -> ${r.status}`);
  }

  r = await visit("POST", "/posts", "post[title]=Flash+post&post[body]=x");
  const flashed = r.location;
  r = await visit("GET", flashed);
  row(13, "flash_created", `notice=${notice(r.text)}`);
  r = await visit("GET", flashed);
  row(14, "flash_once", `notice=${notice(r.text)}`);
  r = await visit("POST", `${flashed}`, "_method=delete");
  r = await visit("GET", r.location);
  row(14, "flash_deleted", `notice=${notice(r.text)}`);

  const total = count("posts");

  r = await visit("POST", "/posts", "post[title]=No+token+here&post[body]=x", { token: false });
  row(15, "csrf_rejected", `${r.status} ${r.text} posts_changed=${count("posts") !== total}`);
  r = await visit("POST", "/posts", "post[title]=With+a+token&post[body]=x");
  row(16, "csrf_ok", `${r.status} posts_changed=${count("posts") !== total}`);

  log.length = 0;
  r = await visit("GET", "/app.css");
  row(17, "static_file", `${r.status} ${r.type} ${r.text.includes("font-family")}`);
  await visit("GET", "/nope");
  await visit("POST", "/posts", "post[title]=Logged+post&post[body]=x&password=hunter2");
  row(17, "request_log", log.join(" | "));
} finally {
  server.close();
}

const ticket = (args, cwd, env = {}) => spawnSync(join(home, "bin", "ticket"), args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const passes = (text) => text.match(/(\d+) passed/)?.[1] ?? "?";

let r = ticket(["test"], here);
row(19, "ticket_test", `exit=${r.status} pass=${passes(r.stdout)}`);

const broken = join(here, "src", "broken_test.px");

writeFileSync(broken, "module BrokenTest\n\nuses\n  Std.Assert\n\nfunctions\n  test_broken() -> {} / {Throws<Failed>} {\n    Assert.equal(1, 2)\n  }\n\nexports\n  test_broken\n");

try {
  r = ticket(["test"], here);
  row(19, "ticket_test_broken", `exit=${r.status}`);
} finally {
  rmSync(broken);
}

const notes = join(scratch, "notes");

mkdirSync(notes);
ticket(["new", "notes", "--path"], notes);

const app = join(notes, "notes");

r = ticket(["g", "scaffold", "Note", "title:String"], app);
row(18, "scaffold_generated", `exit=${r.status}`);
ticket(["db:migrate"], app, { TICKET_DATABASE: join(scratch, "notes.sqlite3") });

const child = spawn(join(home, "bin", "ticket"), ["server", "-p", "0"], {
  cwd: app,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, TICKET_DATABASE: join(scratch, "notes.sqlite3") },
});
let output = "";

child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

const exited = new Promise((resolve) => child.on("exit", resolve));

try {
  let port;

  for (let i = 0; i < 300 && port === undefined; i++) {
    port = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const jar = { cookie: "", token: "" };
  const call = async (method, path, form, token = true) => {
    const init = { method, redirect: "manual", headers: {} };

    if (form !== undefined) {
      init.body = token ? `${form}&authenticity_token=${jar.token}` : form;
      init.headers["content-type"] = "application/x-www-form-urlencoded";
    }

    if (jar.cookie !== "") {
      init.headers.cookie = jar.cookie;
    }

    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();

    jar.cookie = response.headers.getSetCookie()[0]?.split(";")[0] ?? jar.cookie;
    jar.token = text.match(/<meta name="csrf-token" content="([^"]+)">/)?.[1] ?? jar.token;

    return { status: response.status, location: response.headers.get("location"), text };
  };

  await call("GET", "/notes/new");

  let reply = await call("POST", "/notes", "note[title]=First");
  row(18, "scaffold_create", `${reply.status} ${reply.location}`);
  reply = await call("GET", reply.location);
  row(18, "scaffold_show", `${reply.status} notice=${notice(reply.text)}`);
  reply = await call("POST", "/notes/1", "_method=patch&note[title]=Renamed");
  row(18, "scaffold_update", `${reply.status} ${reply.location}`);
  reply = await call("POST", "/notes", "note[title]=");
  row(18, "scaffold_invalid", `${reply.status} ${message(reply.text)}`);
  reply = await call("POST", "/notes/1", "_method=delete");
  row(18, "scaffold_delete", `${reply.status} ${reply.location}`);
  reply = await call("GET", "/notes/1");
  row(18, "scaffold_gone", `${reply.status}`);
} finally {
  process.kill(-child.pid, "SIGINT");
  await exited;
  rmSync(scratch, { recursive: true, force: true });
}
