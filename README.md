# Ticket

A Rails-shaped web framework written in [Polar](https://polar-lang.vercel.app/), for Polar projects.

> Version 0.1.0. Controllers, views and components, resource routing, SQLite with migrations and typed queries,
> validations, forms, sessions, flash and CSRF, generators, and a test runner, all in Polar.

## Getting started

```sh
ln -s ~/Work/ticket/bin/ticket ~/.local/bin/ticket   # once: put `ticket` on your PATH
ticket new blog                                      # writes ./blog and builds it
cd blog
ticket server                                        # http://127.0.0.1:3000
```

`bin/ticket` is a small shell script. It finds its checkout through any symlinks, rebuilds
the CLI (`cli/`, a Polar program) when its sources are newer than the build, and runs it.
It needs `polar` and `node` on `PATH`.

### The `ticket` command

| Command | What |
|---|---|
| `ticket new <name> [--skip-build]` | writes an app skeleton into `./<name>` (snake_case), then `polar build`s it. Refuses a non-empty directory |
| `ticket server` / `s` `[-p PORT]` | `polar run` in the app: builds, then serves on `PORT` (3000 by default, or `options.port`) |
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
`src/views/pages.px`, `public/`, `ticket.toml`, `.gitignore` and a `README.md`. Its path dependency on
Ticket is relative when the app sits under the checkout's parent directory (`../ticket`
for `~/Work/blog`), and absolute otherwise.

### Without the CLI

```toml
# your project's polar.toml
[project]
name = "app"
hosts = ["Node"]

[dependencies]
ticket = { path = "../ticket" }

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

### Controllers

A controller is a module of actions, each `action(conn: Conn) -> Response / {…}`. An
action names its view and builds a response with `Ticket.Response`:

```polar
show(conn: Conn) -> Response / {Mut, Throws<Halt>} {
  let article = find_or_halt(conn)

  Response.render(Layout.app(article.title, Articles.show(article)))
}

create(conn: Conn) -> Response / {Mut} {
  let article = Article.create(title_of(conn))

  Response.redirect_to(conn, Paths.article_path(article.id))
}
```

`render(page)` is a 200 HTML document and `render_status(422, page)` any other status.
`redirect_to(conn, path)` is a 302 after `GET`/`HEAD` and a 303 after anything else, so a
browser follows a form post with a `GET`. `with_header` replaces a header in any case,
and `content_type` sets that one.

**Path helpers for controllers and views come from `Paths`.** The routes module imports
every controller, so a controller can't import it back. The `routes` zone also generates
a sibling module `Paths`, with the same `*_path` helpers and no controller imports (it has
no file: `src/paths.px` is generated from `src/routes.px`). Write `uses Paths` and call
`Paths.article_path(id)`.

**Halting.** `throw Halt(response)` (from `Ticket.Error`) anywhere under an action answers
with `response`. It suits helpers like `find_or_halt` that 404 from deep inside. Any other
error that escapes is logged and answered with a 500: the message and stack with
`options.env = "development"`, and `internal server error` otherwise.

**Filters** are Rails' `before_action`: functions `Conn -> Result<Response, Conn>`.
`Ok(conn)` continues (with a possibly changed conn), and `Err(response)` halts.
`Action.before(filters, action)` runs them in order, then the action:

```polar
show(conn: Conn) -> Response / {Mut} {
  Action.before([require_token], stats)(conn)
}

require_token(conn: Conn) -> Result<Response, Conn> {
  if Params.string(conn, "token") == Some("secret") {
    Ok(conn)
  } else {
    Err(Response.text(401, "unauthorized"))
  }
}
```

Filters and the action may use effects, and `before` keeps them. `Action.Filter` names the
pure filter type. A value annotated `Filter` can't go in a list with effectful filters, so
pass functions by name instead.

### The database

`Ticket.Db` is the `Db` effect. Its Node binding is generic over database adapters, picked
in `ticket.toml`. The one adapter so far is `sqlite`, on `node:sqlite` (no install).
Parameters are `SqlValue`s (`SqlNull`, `SqlInt`, `SqlFloat`, `SqlText`, `SqlBool`), and
rows decode by column name into any type with `derive(Json)`:

```polar
types
  Post = { id: Int, title: String, draft: Bool, note: Option<String> } derive(Json)

functions
  drafts() -> Result<DbError, List<Post>> / {Db} {
    Db.all("select * from posts where draft = ?", [SqlBool(true)])
  }

  publish(id: Int) -> Result<DbError, Changes> / {Db} {
    Db.transaction(
      function() { Db.exec("update posts set draft = ? where id = ?", [SqlBool(false), SqlInt(id)]) },
    )
  }
```

| Function | What |
|---|---|
| `Db.all(sql, params)` / `Db.one(sql, params)` | the rows, or the first one, decoded |
| `Db.exec(sql, params)` | one statement: `Changes { changes, last_id }` |
| `Db.script(sql)` | several `;`-separated statements, no params |
| `Db.transaction(body)` | `Ok` commits, `Err` or a throw rolls back; nested calls are savepoints |
| `Db.connect({ adapter, database })` | connects to another database (`sqlite`, `":memory:"` in tests) |
| `Db.query(sql, params)` | the rows as JSON text |

Each returns `Result<DbError, …>`, where `DbError = { kind, code, message, sql }`. `kind`
is the same for every adapter (`unique`, `foreign_key`, `not_null`, `check`, `syntax`,
`decode`, `connection`, `other`), and `code` is the adapter's own (SQLite's `2067`). With
`sqlite`, declare `Bool` columns `BOOLEAN` so they read back as `true`/`false`, and foreign
keys are on. While a transaction runs, other requests' Db calls wait for it.

```toml
# ticket.toml: Ticket's settings for the app, next to polar.toml
[database]
adapter = "sqlite"                    # TICKET_DATABASE_ADAPTER overrides it
database = "db/development.sqlite3"   # TICKET_DATABASE overrides it; relative to the app
```

Without `ticket.toml`, the defaults are `sqlite` and `db/development.sqlite3`. The file is
created on first use.

### The schema: a `migrations` zone

Write the schema as migrations in one module, `Schema` (`src/schema.px`). The zone
generates a record and an insert type per table, and `migrations` for the runner:

```polar
module Schema

uses
  Std.Id
  Std.Json
  Std.List
  Std.Option
  Ticket.Db
  Ticket.Migration
  Ticket.Model
  Ticket.Query

migrations
  20261001_120000 create_table users
    name   String
    email  String  unique

  20261001_130000 create_table posts
    title      String
    published  Bool              default false
    author_id  Option<Id<User>>  references users

  20261002_090000 rename_column posts
    title -> heading
```

That gives `User`/`NewUser` and `Post`/`NewPost` (`NewPost` is `Post` without `id`, and without
`timestamps` columns, which SQLite fills), and the model API below.

| Change | Lines under it |
|---|---|
| `create_table <table> [as Record]` | columns: `name  Type  [default v] [references table [on_delete action]] [unique]` |
| `add_column <table>` | columns, which need a `default` or an `Option` type |
| `remove_column <table>` / `drop_table <table>` | column names / nothing |
| `rename_column <table>` | `old -> new` |
| `add_index <table>` / `remove_index <table>` | `column…  [unique]`, one index per line |

The column types are `Int`, `Float`, `String`, `Bool`, `Time`, `Id<Record>` (with `references`) and
`Option<…>`. Each migration's `down` is worked out from the schema, so `remove_column` and
`drop_table` can be rolled back. Mistakes are reported at the line that makes them.

`Time` columns (`Std.Time`'s `Time`, stored as ISO-8601 text) and `timestamps` (`created_at`
and `updated_at`, filled by SQLite) need `Std.Time` in `uses`. `timestamps` goes in
`create_table` only.

### Model queries

Each table also gets a host-less effect (`Posts`, bound in Node to SQLite) and a typed constant per
column (`post_title: Column<Post, String>`, named `<record>_<column>`):

```polar
index(conn: Conn) -> Response / {Posts, Throws<DbFailure>} {
  let posts = Posts.filter(
    [Query.eq(Schema.post_published, true)],
    [Query.order_desc(Schema.post_id)],
  )

  Response.render(Layout.app("Posts", PostViews.index(posts)))
}
```

| Operation | Returns |
|---|---|
| `find(id)` | `Option<Post>` |
| `all()` / `filter(filters, clauses)` | `List<Post>` |
| `count(filters)` | `Int` |
| `insert(NewPost)` / `update(Post)` | the stored `Post`. `update` sets every column, and `updated_at` |
| `delete(id)` | `Bool`: whether a row was there |

Filters are `Query.eq`, `not_eq`, `lt`, `gt`, `like` and `is_null`, and are ANDed. Clauses are
`order_asc`, `order_desc`, `limit` and `offset`. A column from another table, or a value of the
wrong type, is a compile error. A database failure is thrown as `DbFailure(DbError)`
(`kind` is `unique`, `foreign_key`, `not_found` for an `update` with no row, …). A test can bind
`Posts` itself (`binds Posts in Node { … }` in its own module) to an in-memory list.

### Associations

A `references` column named `<name>_id` gives both ends of the relation, as functions in `Schema`
over the two tables' effects (so a test that rebinds `Users` or `Posts` keeps them working):

```polar
// posts: author_id  Option<Id<User>>  references users   comments: post_id  Id<Post>  references posts
Schema.post_author(post)                 // belongs_to: Option<User> (the column allows NULL), else User
Schema.user_posts_as_author(user)        // has_many: List<Post>, by id
Schema.user_posts_as_author_filter(user, [Query.eq(Schema.post_title, "Hi")], [Query.order_desc(Schema.post_id)])
Schema.post_comments(post)               // a column named `<record>_id` drops the `_as_…`
```

The belongs_to is `<record>_<name>`, and the has_many `<target record>_<referencing table>`, with
`_as_<name>` unless the column is `<target record>_id` (so two references to one table, or a
`parent_id` on `comments`, never clash). A non-null belongs_to throws `DbFailure` (`not_found`) if
the row is gone. A name that is already taken is reported at the column.

`on_delete cascade | set_null | restrict` after `references` is rendered as `ON DELETE …`, and
can only be set where the column is created. Without it, deleting a referenced row is a
`foreign_key` `DbFailure`. `set_null` needs an `Option` column.

### Forms and validations

`Params.record(conn, "post")` decodes the `post[…]` form fields into the insert type through a
`Form` impl that the `migrations` zone generates, so the insert type is the permit list: other
keys are dropped, and a missing or ill-typed field is a message on that field. A model module's
`validations` zone adds Rails' `validates`:

```polar
module Post

uses
  Std.Result
  Ticket.Errors
  Ticket.Validations
  Schema

validations
  title   presence  length 3..120
  status  inclusion "draft" "live"
  slug    presence  format "^[a-z0-9-]+$"  uniqueness
```

```polar
create(conn: Conn) -> Response / {Posts, Throws<DbFailure>} {
  let decoded: Result<Errors, NewPost> = Params.record(conn, "post")

  match Result.and_then(decoded, Post.validate) {
    Ok(row) -> Response.redirect_to(conn, Paths.post_path(Posts.insert(row).id)),
    Err(errors) -> Response.render_status(422, PostViews.new(errors)),
  }
}
```

It generates `validate(row: NewPost)` and `validate_update(row: Post)` (which `uniqueness` checks
against the other rows). Both return every message at once as `Errors`: read a field's with
`Errors.on(errors, "title")`, or all of them with `Errors.full_messages(errors)` (`"Title can't
be blank"`). The rules are `presence`, `length` (`3..120`, `3..`, `..120`), `inclusion`,
`format "regex"` (a `String` that matches, unanchored as in JS, so write `^…$`; "is invalid") and
`uniqueness`. `format` runs on `Std.Regex` and needs it in the compiler's std. `uniqueness` queries through the
table's effect (`Posts`), so it needs `Std.List`, `Ticket.Db` and `Ticket.Query` in `uses`, and
`validate` then has the effects `{Posts, Throws<DbFailure>}`.

Fields read as `Int`, `Float` (JSON number syntax), `String`, `Bool` (`true`, `on`, `1`; an
absent checkbox is false), `Id<…>` and `Time` (ISO-8601). A blank `Option` field is `None`.

### Launcher tasks

`polar start -- <task>` runs a task against the built app instead of serving:

| Task | What |
|---|---|
| `routes` | prints `route_table`: helper, method, path and action, aligned. Exits 0 |

| `db:migrate [--version V]`, `db:rollback [--step N]`, `db:status` | the app's `migrate(command, step, version)`, which calls `Ticket.Migrate.run(Schema.migrations, …)` |
| `db:reset`, `db:seed` | `migrate("reset")` then `seed`; the app's `seed() -> {} / {Db}` |

The app's `main` exports `migrate` and `seed` (as it exports `router`):

```
migrate(command: String, step: Int, version: String) -> Int / {Db, Clock} {
  Migrate.run(Schema.migrations, command, step, version)
}
```

`[database] migrate = "auto"` in `ticket.toml` applies the pending migrations on boot.

An unknown task exits 2 and lists the known ones.

Markup goes in a `views` zone (the module must use `Ticket.Html`). Each view is a
function returning `Html`. `{expr}` holes render through `Render`, `name={expr}`
attributes through `Attr` (a `Bool` gives a bare `name` or nothing, a `None` gives
nothing), and `<Card post={p} />` calls the view `card` in the same module. A layout is a
plain view that takes the page's `Html`: `Layout.app("Title", Pages.home(...))`.

Components shared between modules go in a `view_component` zone. A PascalCase header
`Button(name: String)` becomes `button(props: { name: String })` (export `button`). Use
it as `<Button … />` in the same module, or as `<UI.Button name="x" />` from a module that
uses `UI`.

```polar
views
  card(post: Post, children: Html)
    <article class="post" data-id={post.id}>
      <h2>{post.title}</h2>
      {children}
    </article>
```

## Modules

| Module | What |
|---|---|
| `Ticket.Html` | `Html`, the `Render` and `Attr` traits, `escape`, `raw`, `document`, `scripts` |
| `Ticket.Response` | `render`, `render_status`, `redirect_to`, `head`, `with_header`, `content_type`, `text`, `html`, `view`, `json`, `empty`, `redirect`, `not_found` |
| `Ticket.Action` | `Filter`, `before` |
| `Ticket.Error` | `Halt` |
| `Ticket.Conn` | `Conn` (parsed request: method, path, segments, query, form, cookies, path params), `from_request`, `with_path_params`, `header`, `rescue_halt` (used by the router) |
| `Ticket.Params` | `string`, `int`, `id`, `nested` (precedence: path > form > query) |
| `Ticket.QueryString` | `parse`: query string or urlencoded body to a last-wins `Map` |
| `Ticket.Cookies` | `parse`: a `cookie` header to a `Map` |
| `Ticket.Db` | the `Db` effect (`connect`, `query`, `exec`, `script`), `SqlValue`, `DbConfig`, `DbError`, `Changes`, `DbFailure`, `all`, `one`, `transaction` |
| `Ticket.Migration` | `Column`, `Index`, `Change`, `Migration` (what the `migrations` zone generates), `up_sql`, `down_sql`, `sql` |
| `Ticket.Query` | `Column`, `Filter`, `Clause`, the `ToSql` trait, `eq`, `not_eq`, `lt`, `gt`, `like`, `is_null`, `order_asc`, `order_desc`, `limit`, `offset` |
| `Ticket.Sql` | `Statement`, and the SQL (with `?`) for `find`, `select`, `count`, `insert`, `update`, `delete` |
| `Ticket.Model` | what the generated `Posts` binds call: `find`, `all`, `filter`, `count`, `insert`, `update`, `delete` |
| `Ticket.Inflect` | `singular` (`None` when no rule applies), `plural`, `pascal`, `snake` |

## Forms, sessions and tests

Forms and links are JSX components (`view_component` zones), and a form's fields are its children:

```
<Forms.Form conn={conn} action={Paths.posts_path()}>
  <Forms.ErrorSummary errors={errors} noun="post" />
  <Forms.TextField prefix="post" field="title" value={Forms.value(fields, "title")} errors={errors} />
  <Forms.Checkbox prefix="post" field="published" checked={Forms.checked(fields, "published")} errors={errors} />
  <Forms.Submit text="Create post" />
</Forms.Form>
```

`Ticket.Session` signs a session and flash into one cookie (`TICKET_SECRET` or `[session] secret`), and
`Session.handle(conn, action)` loads it, refuses an unsafe request without the CSRF token, and writes it back. `Flash.put` before
`Response.redirect_to` shows once on the next page. `public/` is served at the root, and each request is logged. `Ticket.Test` is
the request client for `*_test.px` (`Test.with_db`, `Test.get(Routes.router, Test.client(), "/posts")`); `examples/blog` is the
whole thing, and `ticket g scaffold` generates the same shape.

## Testing

```sh
node scripts/test.mjs   # every tests/*/ project, every examples/*/e2e.mjs, cli/*e2e.mjs and launcher/e2e.mjs
```

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
tests/<area>/       .px test projects, each with main.expected.txt (polar run) or
                    check.expected.txt (polar check stderr), plus optional fmt/ cases
scripts/test.mjs    test runner
```

Needs the Polar toolchain (`polar` on `PATH`) and Node ≥ 22.5
(`node:sqlite`).
