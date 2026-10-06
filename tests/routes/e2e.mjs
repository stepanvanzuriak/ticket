
import { fileURLToPath } from "node:url";
import { serve } from "../../launcher/serve.mjs";

const dist = fileURLToPath(new URL("dist/", import.meta.url));
const server = await serve({
  version: 1,
  project: "routes_tests",
  main: "routes.js",
  hosts: { Node: dist },
  options: { port: 0, log: "off" },
});

const base = `http://127.0.0.1:${server.address().port}`;

async function call(row, name, method, path, form) {
  const init = { method };

  if (form !== undefined) {
    init.body = form;
    init.headers = { "content-type": "application/x-www-form-urlencoded" };
  }

  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  const allow = response.headers.get("allow");
  const extra = allow === null ? "" : ` [allow: ${allow}]`;

  console.log(`${row} ${name}: ${method} ${path} -> ${response.status}${extra} ${JSON.stringify(text)}`);
}

try {
  await call(11, "match_trailing_slash", "GET", "/posts/3/");
  await call(12, "match_new_before_show", "GET", "/posts/new");
  await call(12, "match_collection_before_show", "GET", "/posts/drafts");
  await call(13, "override_delete", "POST", "/posts/3", "_method=DELETE");
  await call(14, "override_only_post", "GET", "/posts/3?_method=delete");
  await call(15, "head_as_get", "HEAD", "/about");
  await call(16, "not_found", "GET", "/nope");
  await call(17, "method_not_allowed", "DELETE", "/about");
  await call(17, "method_not_allowed_lists_all", "DELETE", "/posts");
  await call(18, "path_params_nested", "DELETE", "/posts/2/comments/9");
  await call(19, "non_numeric_id_matches", "GET", "/posts/abc");
  await call(19, "path_param_decoded", "POST", "/webhooks/a%20b");
  await call("+", "root", "GET", "/");
  await call("+", "namespace", "GET", "/admin/users/4/edit");
} finally {
  server.close();
}
