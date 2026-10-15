# {{App}}

A [Ticket](https://github.com/stepanvanzuriak/ticket) app.

```sh
ticket server          # build and serve on http://127.0.0.1:3000 (-p to pick a port)
ticket routes          # print the routes
ticket build           # polar build
ticket check           # polar check
ticket fmt             # polar fmt
```

| Path | What |
|---|---|
| `src/routes.px` | the routes, which generate `router`, `route_table` and the `Paths` module |
| `src/main.px` | the app's entry point: exports `router` and `route_table` |
| `src/controllers/` | one module of actions per controller |
| `src/views/` | the layout and the pages, as `views` zones |
| `public/` | static files |
| `ticket.toml` | Ticket's settings: the database adapter and database |

## Deploying

`Dockerfile` builds the app and runs the launcher with `TICKET_ENV=production`:

```sh
docker build -t {{app}} .
docker run -p 3000:3000 -e TICKET_SECRET="$(openssl rand -hex 32)" {{app}}
```

`GET /up` answers `200 ok` for a health check. SIGTERM finishes in-flight requests, then exits
(`[server] shutdown_timeout` in `ticket.toml`). `PORT` and `HOST` set the address. Put a reverse proxy
in front for HTTPS.
