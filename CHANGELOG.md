# Changelog

## 0.2.0

Closes F4. Needs Polar 0.4.0 or newer; 0.1.0 doesn't build on it, so apps should depend on `v0.2.0`.

- `ticket server --watch` rebuilds and restarts on edit (development only; a failed rebuild keeps the old server up)
- `Ticket.Auth` and `ticket g auth`: password hashing, `login`/`logout` with a rotated session, and a `require_login` filter
- Queries: `in_list`, `gte`, `lte`, `Query.any`/`Query.all`, `sum`/`min`/`max`, `paginate` and eager loading
- JSON requests and responses (`Conn.format`, `.json` paths) and multipart uploads, with `max_body` and `max_upload` limits
- Production: graceful shutdown on SIGTERM/SIGINT (`[server] shutdown_timeout`), `GET /up`, default security headers,
  JSON request logs with an `x-request-id`, and a `Dockerfile` written by `ticket new`
- `install.sh` installs the `ticket` command

### Breaking

- The request log defaults to `json` in production (`log = "text"` restores the old line; `request` is an alias)
- Every response now carries `x-content-type-options`, `x-frame-options` and `referrer-policy` unless the action sets them
- `TICKET_ENV` now also decides the launcher's environment (logging, static caching, error pages), not only sessions
- Needs Polar 0.4.0 or newer

## 0.1.0

The first release. A Rails-shaped web framework written in Polar.

- Routing, controllers, views, validations and migrations as Polar zones
- `ticket` CLI (`ticket new`, and friends) and a `serve` launcher
- SQLite adapter on `node:sqlite` (no install)
- Add it with `polar add github.com/stepanvanzuriak/ticket` (needs Polar 0.2.0+)
