# Ticket

A Rails-shaped web framework written in [Polar](https://polar-lang.vercel.app/), for Polar projects.

> Version 0.2.0. Controllers, views and components, resource routing, SQLite or Postgres with migrations and typed queries,
> validations, forms, sessions, flash and CSRF, generators, and a test runner, all in Polar.

## Getting started

```sh
curl -fsSL https://ticket-polar.vercel.app/install.sh | sh   # once
ticket new blog                                      # writes ./blog and builds it
cd blog
ticket server                                        # http://127.0.0.1:3000
```

`install.sh` checks out the newest release into `~/.ticket` and links `~/.local/bin/ticket` to it
(`TICKET_VERSION`, `TICKET_HOME` and `TICKET_BIN` change the tag and the two locations). Run it again to
update. To work from a clone instead, symlink its `bin/ticket` onto your `PATH`.

`bin/ticket` is a small shell script. It finds its checkout through any symlinks, rebuilds
the CLI (`cli/`, a Polar program) when its sources are newer than the build, and runs it.
It needs `polar` and `node` on `PATH`.

### The `ticket` command

| Command | What |
|---|---|
| `ticket new <name> [--skip-build] [--path]` | writes an app skeleton into `./<name>` (snake_case), then `polar fetch`es and `polar build`s it. Refuses a non-empty directory. The app depends on Ticket by its GitHub address and release tag; `--path` depends on this checkout instead |
| `ticket server` / `s` `[-p PORT] [--watch]` | `polar run` in the app: builds, then serves on `PORT` (3000 by default, or `options.port`). `--watch` runs `polar run --watch` in development mode (exit 2 with `TICKET_ENV=production`) |
| `ticket routes` | builds quietly, then prints the route table (`polar start -- routes`) |
| `ticket db:migrate [--version V]` / `db:rollback [--step N]` / `db:status` / `db:reset` / `db:seed` | builds quietly, then runs the launcher's task of that name: apply pending migrations, undo the last N, list them, roll everything back and migrate again (then seed), run `seed` |
| `ticket g migration <Name> [f:T…]` / `g model <Name> [f:T…]` | appends an entry to `src/schema.px` (`Create…`, `Add…To…`, `Remove…From…`) and, for a model, writes `src/models/<name>.px`. Fields: `title:String`, `body:String?`, `email:String:unique`, `n:Int:default=0`, `author:references` |
| `ticket g scaffold <Name> [f:T…]` / `g controller <Names> <action…>` / `g model --validations` | `scaffold` writes the migration, a model with a `validations` zone, a controller with the seven actions, views, a test and a `resources` route; `controller` writes the actions, their views and a route each. `--force` overwrites, `--skip` keeps existing files, `--pretend` writes nothing |
| `ticket destroy scaffold\|model\|controller <Name>` | removes what the generator wrote and keeps the migration. A file you edited needs `--force` |
| `ticket test [filter]` | `polar test` with `TICKET_ENV=test` and an in-memory database |
| `ticket console [-e EXPR] [--sandbox]` | `polar repl` with the app's database connected (needs `Main.boot`, and polar-lang P14 for apps with folders) |
| `ticket build` / `check` / `fmt` `[args…]` | `polar build` / `check` / `fmt` in the app, with the rest of the args |
| `ticket version`, `ticket help` | |

Every command but `new`, `help` and `version` runs from anywhere inside an app: the
nearest directory up whose `polar.toml` has a `[project]` depending on `ticket`. Exit codes
are 0 ok, 1 failed, 2 usage error (unknown command or flag, a missing value), and a
subprocess's code passes through.

`ticket new` writes `polar.toml`, `src/main.px` (exports `router` and `route_table`),
`src/routes.px`, `src/controllers/pages_controller.px`, `src/views/layout.px` and
`src/views/pages.px`, `public/`, `ticket.toml`, `.gitignore` and a `README.md`. The app depends on
Ticket by its GitHub address, pinned to the tag matching your `ticket --version`, and `ticket new`
runs `polar fetch` so the tag is locked in `polar.lock`. With `--path` it depends on your checkout
instead: relative when the app sits under the checkout's parent directory (`../ticket` for
`~/Work/blog`), absolute otherwise. `--skip-build` skips the fetch too, so run `polar fetch` yourself.

### Without the CLI

Needs Polar 0.4.0 or newer (`polar --version`). Add Ticket straight from GitHub:

```sh
polar add github.com/stepanvanzuriak/ticket     # newest tag; writes polar.toml + polar.lock
```

or by hand:

```toml
# your project's polar.toml
[project]
name = "app"
hosts = ["Node"]

[dependencies]
ticket = { git = "github.com/stepanvanzuriak/ticket", version = "v0.2.0" }
# working on Ticket itself? use a checkout instead:
# ticket = { path = "../ticket" }

[run]
launcher = "ticket"
options = { port = 3000 }
```

```sh
polar run              # build every host and serve on :3000 (PORT=4000 overrides it)
polar build && polar start
```

The app's main module exports `router(request: Request) -> Option<Response>`. A
`routes` zone generates it (with `route_table`), so point `main` at that module
(`main = "src/routes.px"` under `[project]`). See `examples/pages`; `examples/hello`
writes `router` by hand.

## Testing

```sh
scripts/test.sh   # every tests/*/ project, every examples/*/e2e.mjs, cli/*e2e.mjs and launcher/e2e.mjs
```

## Documentation

The guides, from routing and controllers to the database, forms, testing and the launcher, are on the
[website](https://ticket-polar.vercel.app/docs/). The same pages are in `website/docs/`.

## Deploying

`ticket new` writes a `Dockerfile`; run it with `TICKET_SECRET` set. Health checks, shutdown, headers and
logging are covered in the [launcher guide](https://ticket-polar.vercel.app/docs/launcher.html#production).

## Layout

```
polar.toml          [package] ticket / Ticket, [plugin], [launcher]
src/                Ticket.* modules
src/bindings/       JS bindings (db.js: `Db in Node` and its adapters)
plugin/             Rust zone plugins (`migrations`, `routes`, `view_component`, `views`), built by polar into .polar/plugin
launcher/serve.mjs  HTTP server (public/, client bundle, bridges, router, request log, error pages), tasks (`routes`),
                    ticket.toml, the database path and the session secret (one file: polar copies only it)
bin/ticket          the `ticket` command's shim
cli/                the `ticket` CLI, a Polar project: src/ (args, app root, commands),
                    templates/new/ (the app skeleton), e2e.mjs
examples/hello      smallest app (+ e2e.mjs)
examples/pages      controllers, filters, halting, redirects, an admin namespace (+ e2e.mjs)
examples/blog       posts, comments, validations, forms, flash, CSRF, tests (+ e2e.mjs)
tests/<area>/       .px test projects: native `*_test.px` tests (polar test), or
                    check.expected.txt (polar check stderr) for compile errors, plus
                    optional fmt/ cases and e2e.mjs
scripts/test.sh     runs every project above (polar test, check snapshots, fmt, e2e)
```

Needs the Polar toolchain (`polar` on `PATH`) and Node ≥ 22.5
(`node:sqlite`).

### Postgres

SQLite is the default. For Postgres, add the `pg` package to your app's `package.json` and set the adapter in
`ticket.toml` (or `TICKET_DATABASE_ADAPTER` / `TICKET_DATABASE`):

```toml
[database]
adapter  = "postgres"
database = "postgres://app:secret@localhost:5432/app"
```

Models, queries and migrations don't change. Each transaction pins one pooled connection, so concurrent requests
don't see each other's uncommitted rows (SQLite still serialises them). A failing statement aborts a Postgres
transaction until the savepoint around it is rolled back.

`TICKET_TEST_POSTGRES=postgres://… scripts/test.sh` also runs the test projects on Postgres (it drops and recreates
the `public` schema of that database).
