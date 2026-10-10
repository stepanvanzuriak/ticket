
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = fileURLToPath(new URL("..", import.meta.url));
const shim = join(home, "bin", "ticket");
const scratch = mkdtempSync(join(tmpdir(), "ticket-scaffold-e2e-"));

function ticket(args, cwd, env = {}) {
  return spawnSync(shim, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

const stamped = (text) => text.replace(/\d{8}_\d{6}/g, "V");
const lines = (r) => stamped(r.stdout.trim().split("\n").join(" | "));
const row = (n, name, text) => console.log(`${n} ${name}: ${text}`);
const read = (app, path) => readFileSync(join(app, path), "utf8");

function files(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

      return entry.isDirectory() ? files(dir, path) : [path];
    })
    .sort();
}

function app(name) {
  const dir = join(scratch, name);

  mkdirSync(dir, { recursive: true });
  ticket(["new", name, "--path"], dir);
  return join(dir, name);
}

async function start(root, database) {
  const child = spawn(shim, ["server", "-p", "0"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TICKET_DATABASE: database },
  });
  let output = "";

  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const exited = new Promise((resolve) => child.on("exit", resolve));

  for (let i = 0; i < 300; i++) {
    const port = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];

    if (port !== undefined) {
      const browser = { cookie: "", token: "" };
      const base = `http://127.0.0.1:${port}`;

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

        return { status: response.status, location: response.headers.get("location"), text };
      }

      return {
        visit,
        stop: async () => {
          process.kill(-child.pid, "SIGINT");
          await exited;
        },
      };
    }

    if (child.exitCode !== null) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  process.kill(-child.pid, "SIGINT");
  throw new Error(`the server didn't start: ${output}`);
}

const notice = (text) => text.match(/<p class="notice">(.*?)<\/p>/)?.[1] ?? "-";

try {
  const blog = app("blog");
  let r = ticket(["g", "scaffold", "Post", "title:String", "body:String?", "published:Bool:default=false"], blog);

  row(1, "scaffold_output", `exit=${r.status} ${lines(r)}`);
  row(1, "scaffold_files", files(blog).filter((f) => /post/.test(f)).join(","));

  r = spawnSync("polar", ["check", "--no-color"], { cwd: blog, encoding: "utf8" });
  row(2, "scaffold_checks", `exit=${r.status} diagnostics=${r.stderr.trim() === "" ? "none" : r.stderr.trim()}`);

  row(8, "model_validations", read(blog, "src/models/post.px").split("\n").filter((l) => /^  \w+  /.test(l)).join(" | "));

  const passes = (text) => text.match(/(\d+) passed/)?.[1] ?? "?";
  const fails = (text) => text.match(/(\d+) failed/)?.[1] ?? "?";

  writeFileSync(
    join(blog, "src/env_test.px"),
    'module EnvTest\n\nuses\n  Std.Assert\n  Std.Option\n  Std.Process\n\nhosts\n  Node\n\nfunctions\n  test_environment() -> {} / {Throws<Failed>, Process} {\n    Assert.equal(Process.env("TICKET_ENV"), Some("test"))\n    Assert.equal(Process.env("TICKET_DATABASE"), Some(":memory:"))\n  }\n\nexports\n  test_environment\n',
  );
  r = ticket(["test"], blog);
  row(17, "ticket_test", `exit=${r.status} pass=${passes(r.stdout)} fail=${fails(r.stdout)}`);

  r = ticket(["test", "test_index"], blog);
  row(17, "ticket_test_filter", `exit=${r.status} pass=${passes(r.stdout)} fail=${fails(r.stdout)}`);

  writeFileSync(
    join(blog, "src/broken_test.px"),
    "module BrokenTest\n\nuses\n  Std.Assert\n\nfunctions\n  test_broken() -> {} / {Throws<Failed>} {\n    Assert.equal(1, 2)\n  }\n\nexports\n  test_broken\n",
  );
  r = ticket(["test"], blog);
  row(17, "ticket_test_fails", `exit=${r.status} pass=${passes(r.stdout)} fail=${fails(r.stdout)}`);

  r = ticket(["test", "test_new"], blog);
  row(17, "ticket_test_filter_skips_broken", `exit=${r.status} pass=${passes(r.stdout)} fail=${fails(r.stdout)}`);

  r = ticket(["test", "a", "b"], blog);
  row(17, "ticket_test_usage", `exit=${r.status} ${r.stderr.trim()}`);

  rmSync(join(blog, "src/broken_test.px"));
  rmSync(join(blog, "src/env_test.px"));

  const database = join(scratch, "blog.sqlite3");

  ticket(["db:migrate"], blog, { TICKET_DATABASE: database });

  const server = await start(blog, database);

  try {
    const { visit } = server;
    const form = await visit("GET", "/posts/new");

    row(3, "new_form", `${form.status} fields=${(form.text.match(/name="post\[(\w+)\]"/g) ?? []).join(",")}`);

    let reply = await visit("POST", "/posts", "post[title]=Hello&post[body]=World&post[published]=on");
    row(3, "create", `${reply.status} ${reply.location}`);
    reply = await visit("GET", reply.location);
    row(3, "show_after_create", `${reply.status} notice=${notice(reply.text)} title=${reply.text.includes("<strong>Title:</strong> Hello")}`);
    reply = await visit("GET", "/posts/1");
    row(3, "notice_once", `notice=${notice(reply.text)}`);
    reply = await visit("GET", "/posts");
    row(3, "index", `${reply.status} rows=${(reply.text.match(/<tr>/g) ?? []).length - 1}`);

    reply = await visit("GET", "/posts/1/edit");
    row(4, "edit", `${reply.status} title=${reply.text.includes('value="Hello"')} checked=${reply.text.includes("checked")} method=${reply.text.includes('name="_method" value="patch"')}`);
    reply = await visit("POST", "/posts/1", "_method=patch&post[title]=Hi&post[body]=");
    row(4, "update", `${reply.status} ${reply.location}`);
    reply = await visit("GET", reply.location);
    row(4, "after_update", `notice=${notice(reply.text)} title=${reply.text.includes("<strong>Title:</strong> Hi")} published=${reply.text.includes("<strong>Published:</strong> false")}`);

    reply = await visit("POST", "/posts", "post[title]=%20&post[body]=keep+me");
    row(6, "create_invalid", `${reply.status} message=${reply.text.includes("Title can&#39;t be blank")} typed=${reply.text.includes("keep me")} class=${reply.text.includes("field_with_errors")}`);
    reply = await visit("POST", "/posts/1", "_method=patch&post[title]=&post[body]=x");
    row(6, "update_invalid", `${reply.status} message=${reply.text.includes("can&#39;t be blank")}`);
    reply = await visit("GET", "/posts");
    row(6, "nothing_created", `rows=${(reply.text.match(/<tr>/g) ?? []).length - 1}`);

    reply = await visit("POST", "/posts", "post[title]=x", { token: false });
    row(6, "csrf_rejected", `${reply.status}`);

    for (const [method, path, body] of [["GET", "/posts/99"], ["GET", "/posts/99/edit"], ["POST", "/posts/99", "_method=patch&post[title]=a"], ["POST", "/posts/99", "_method=delete"]]) {
      reply = await visit(method, path, body);
      row(7, "missing", `${method} ${path}${body === undefined ? "" : ` ${body.split("&")[0]}`} -> ${reply.status}`);
    }

    reply = await visit("POST", "/posts/1", "_method=delete");
    row(5, "delete", `${reply.status} ${reply.location}`);
    reply = await visit("GET", reply.location);
    row(5, "after_delete", `notice=${notice(reply.text)} rows=${(reply.text.match(/<tr>/g) ?? []).length - 1}`);
    reply = await visit("GET", "/posts/1");
    row(5, "gone", `${reply.status}`);
  } finally {
    await server.stop();
  }

  const users = app("users");

  ticket(["g", "scaffold", "User", "email:String:unique", "name:String"], users);
  row(9, "unique_validation", read(users, "src/models/user.px").split("\n").filter((l) => /^  \w+  /.test(l)).join(" | "));

  const items = app("items");

  ticket(["g", "scaffold", "Owner", "name:String"], items);
  r = ticket(["g", "scaffold", "Item", "title:String", "body:String", "count:Int", "price:Float", "done:Bool", "due:Time?", "owner:references"], items);
  const itemViews = read(items, "src/views/item_views.px");
  const helper = (field) => itemViews.match(new RegExp(`<Forms\\.(\\w+) prefix="item" field="${field}"`))?.[1];

  row(10, "field_helpers", ["title", "body", "count", "price", "done", "due", "owner_id"].map((f) => `${f}=${helper(f)}`).join(" "));
  r = spawnSync("polar", ["check", "--no-color"], { cwd: items, encoding: "utf8" });
  row(10, "field_types_check", `exit=${r.status} ${r.stderr.trim().split("\n")[0]}`);
  r = ticket(["test"], items);
  row(10, "two_resources_tests", `exit=${r.status} pass=${r.stdout.match(/(\d+) passed/)?.[1] ?? "?"} fail=${r.stdout.match(/(\d+) failed/)?.[1] ?? "?"}`);

  const site = app("site");

  r = ticket(["g", "controller", "Reports", "index", "show"], site);
  row(11, "controller_output", `exit=${r.status} ${lines(r)}`);
  row(11, "controller_files", files(site).filter((f) => /reports|report_views/.test(f)).join(","));
  row(11, "controller_routes", read(site, "src/routes.px").split("\n").filter((l) => /Reports/.test(l)).map((l) => l.trim().replace(/\s+/g, " ")).join(" | "));
  r = spawnSync("polar", ["check", "--no-color"], { cwd: site, encoding: "utf8" });
  row(11, "controller_checks", `exit=${r.status} ${r.stderr.trim().split("\n")[0]}`);

  r = ticket(["routes"], site);
  row(11, "controller_routes_table", r.stdout.split("\n").filter((l) => /Reports/.test(l)).map((l) => l.trim().replace(/\s+/g, " ")).join(" | "));

  const bare = app("bare");
  const before = files(bare).join();

  for (const [name, args] of [
    ["lowercase_name", ["g", "scaffold", "post", "title:String"]],
    ["bad_field", ["g", "scaffold", "Post", "title"]],
    ["no_fields", ["g", "scaffold", "Post"]],
    ["no_name", ["g", "scaffold"]],
    ["controller_no_action", ["g", "controller", "Reports"]],
    ["controller_singular_only", ["g", "controller", "Staff", "index"]],
    ["controller_bad_action", ["g", "controller", "Reports", "Index"]],
  ]) {
    r = ticket(args, bare);
    row(12, name, `exit=${r.status} unchanged=${files(bare).join() === before} ${r.stderr.trim().split("\n")[0].slice(0, 90)}`);
  }

  const posts = blog;

  r = ticket(["g", "scaffold", "Post", "title:String", "body:String?", "published:Bool:default=false"], posts);
  row(14, "rerun_identical", `exit=${r.status} ${lines(r)}`);

  writeFileSync(join(posts, "src/views/post_views.px"), `${read(posts, "src/views/post_views.px")}\n// mine\n`);
  writeFileSync(join(posts, "src/models/post.px"), `${read(posts, "src/models/post.px")}\n// mine\n`);

  r = ticket(["g", "scaffold", "Post", "title:String", "body:String?", "published:Bool:default=false"], posts);
  row(14, "refuses_overwrite", `exit=${r.status} ${stamped(r.stderr.trim().split("\n").join(" | "))}`);
  row(14, "refused_wrote_nothing", `edits_kept=${read(posts, "src/views/post_views.px").includes("// mine")}`);

  r = ticket(["g", "scaffold", "Post", "title:String", "body:String?", "published:Bool:default=false", "--skip"], posts);
  row(15, "skip", `exit=${r.status} ${lines(r)} kept=${read(posts, "src/views/post_views.px").includes("// mine")}`);

  r = ticket(["g", "scaffold", "Post", "title:String", "body:String?", "published:Bool:default=false", "--pretend", "--force"], posts);
  row(16, "pretend", `exit=${r.status} ${lines(r)} kept=${read(posts, "src/views/post_views.px").includes("// mine")}`);

  r = ticket(["g", "scaffold", "Post", "title:String", "body:String?", "published:Bool:default=false", "--force"], posts);
  row(15, "force", `exit=${r.status} ${lines(r)} replaced=${!read(posts, "src/views/post_views.px").includes("// mine")}`);

  const fresh = app("pretend");

  r = ticket(["g", "scaffold", "Post", "title:String", "--pretend"], fresh);
  row(16, "pretend_fresh", `exit=${r.status} ${lines(r)} written=${files(fresh).filter((f) => /post|schema/.test(f)).join(",") || "nothing"}`);

  const routed = app("routed");
  const routes = read(routed, "src/routes.px").replace("  root  -> PagesController.home", "  root  -> PagesController.home\n\n  resources posts  -> PostsController");

  writeFileSync(join(routed, "src/routes.px"), routes);
  r = ticket(["g", "scaffold", "Post", "title:String"], routed);
  row(17, "route_exists", `exit=${r.status} ${lines(r)} resources=${(read(routed, "src/routes.px").match(/resources posts/g) ?? []).length}`);

  const noZone = app("nozone");

  writeFileSync(join(noZone, "src/routes.px"), "module Routes\n\nexports\n");
  r = ticket(["g", "scaffold", "Post", "title:String"], noZone);
  row(17, "no_routes_zone", `exit=${r.status} ${lines(r)}`);

  const gone = app("destroyed");

  ticket(["g", "scaffold", "Post", "title:String"], gone);
  writeFileSync(join(gone, "src/views/post_views.px"), `${read(gone, "src/views/post_views.px")}\n// mine\n`);

  r = ticket(["destroy", "scaffold", "Post"], gone);
  row(19, "destroy_edited", `exit=${r.status} ${r.stderr.trim().split("\n").join(" | ")} files=${files(gone).filter((f) => /post/.test(f)).join(",")}`);

  r = ticket(["destroy", "scaffold", "Post", "--pretend", "--force"], gone);
  row(19, "destroy_pretend", `exit=${r.status} ${lines(r)} files=${files(gone).filter((f) => /post/.test(f)).length}`);

  r = ticket(["destroy", "scaffold", "Post", "--force"], gone);
  row(19, "destroy_force", `exit=${r.status} ${lines(r)}`);
  row(18, "destroy_left", `files=${files(gone).filter((f) => /post/.test(f)).join(",") || "none"} migration=${read(gone, "src/schema.px").includes("create_table posts")} routes=${!read(gone, "src/routes.px").includes("Posts")}`);

  r = ticket(["destroy", "scaffold", "Post"], gone);
  row(19, "destroy_missing", `exit=${r.status} ${lines(r)}`);

  const clean = app("destroyed2");

  ticket(["g", "scaffold", "Post", "title:String"], clean);
  r = ticket(["destroy", "scaffold", "Post"], clean);
  row(18, "destroy", `exit=${r.status} ${lines(r)}`);
  r = spawnSync("polar", ["check", "--no-color"], { cwd: clean, encoding: "utf8" });
  row(18, "destroyed_app_checks", `exit=${r.status}`);

  ticket(["g", "controller", "Reports", "index"], clean);
  r = ticket(["destroy", "controller", "Reports"], clean);
  row(18, "destroy_controller", `exit=${r.status} ${lines(r)} routes=${!read(clean, "src/routes.px").includes("Reports")}`);

  ticket(["g", "model", "Tag", "name:String", "--validations"], clean);
  row(18, "model_validations_flag", read(clean, "src/models/tag.px").split("\n").filter((l) => /^  \w+  /.test(l)).join(" | "));
  r = ticket(["destroy", "model", "Tag"], clean);
  row(18, "destroy_model", `exit=${r.status} ${lines(r)} exists=${existsSync(join(clean, "src/models/tag.px"))}`);
  const authed = app("authed");

  r = ticket(["g", "auth"], authed);
  row(20, "g_auth", `exit=${r.status} ${lines(r)}`);
  r = ticket(["g", "auth"], authed);
  row(20, "g_auth_again", `exit=${r.status} ${lines(r).split(" | ").map((l) => l.trim().split(" ")[0]).join(",")}`);

  ticket(["g", "controller", "Secrets", "show"], authed);
  writeFileSync(
    join(authed, "src/controllers/secrets_controller.px"),
    `module SecretsController

uses
  Std.Crypto
  Std.Http
  Std.List
  Std.Process
  Std.Time
  Ticket.Action
  Ticket.Auth
  Ticket.Conn
  Ticket.Response
  Ticket.Session
  Views.Layout

functions
  show(conn: Conn) -> Response / {Process, Random, Clock} {
    Session.handle(conn, Action.before([Auth.require_login], reveal))
  }

  reveal(conn: Conn) -> Response {
    Response.text(200, "the secret")
  }

exports
  show
`,
  );
  r = spawnSync("polar", ["check", "--no-color"], { cwd: authed, encoding: "utf8" });
  row(20, "g_auth_checks", `exit=${r.status} diagnostics=${r.stderr.trim() === "" ? "none" : r.stderr.trim()}`);
  r = ticket(["test"], authed);
  row(20, "g_auth_tests", `exit=${r.status} pass=${r.stdout.match(/(\d+) passed/)?.[1] ?? "?"}`);

  const authedDatabase = join(scratch, "authed.sqlite3");

  ticket(["db:migrate"], authed, { TICKET_DATABASE: authedDatabase });

  const authedServer = await start(authed, authedDatabase);

  try {
    const { visit } = authedServer;
    const alert = (text) => text.match(/<p class="alert">(.*?)<\/p>/)?.[1] ?? "-";
    const signup = "user[email]=ann%40example.com&user[password]=long+enough&user[password_confirmation]=long+enough";

    let reply = await visit("GET", "/secrets/show");
    row(20, "auth_protected", `${reply.status} ${reply.location}`);
    reply = await visit("GET", "/login");
    row(20, "auth_login_page", `${reply.status} ${notice(reply.text)} alert=${reply.text.includes("Please log in first.")}`);
    reply = await visit("POST", "/signup", "user[email]=ann%40example.com&user[password]=short&user[password_confirmation]=short");
    row(20, "auth_signup_invalid", `${reply.status} ${reply.text.includes("is too short")}`);
    reply = await visit("POST", "/signup", signup);
    row(20, "auth_signup", `${reply.status} ${reply.location}`);
    reply = await visit("GET", reply.location);
    row(20, "auth_returned_to", `${reply.status} ${reply.text}`);
    reply = await visit("GET", "/");
    row(20, "auth_signed_in", `${reply.status} logout=${reply.text.length > 0}`);
    reply = await visit("POST", "/logout", "_method=delete");
    row(20, "auth_logout", `${reply.status} ${reply.location}`);
    reply = await visit("GET", reply.location);
    reply = await visit("GET", "/secrets/show");
    row(20, "auth_refused", `${reply.status} ${reply.location}`);
    reply = await visit("GET", "/login");
    reply = await visit("POST", "/login", "email=ann%40example.com&password=wrong+one");
    row(20, "auth_wrong", `${reply.status} ${alert(reply.text)}`);
    reply = await visit("POST", "/login", "email=ann%40example.com&password=long+enough");
    row(20, "auth_login", `${reply.status} ${reply.location}`);
    reply = await visit("GET", reply.location);
    row(20, "auth_secret_again", `${reply.status} ${reply.text}`);
  } finally {
    await authedServer.stop();
  }

  r = ticket(["destroy", "auth"], authed);
  row(20, "destroy_auth", `exit=${r.status} ${lines(r)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
