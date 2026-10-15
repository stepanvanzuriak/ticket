# syntax=docker/dockerfile:1
# Builds {{App}} and runs the Ticket launcher. Set `TICKET_SECRET` when you run the container.
# polar needs glibc 2.39 or newer, so this is trixie (2.41), not bookworm.
FROM node:22-trixie-slim

# The polar toolchain, at the release the Ticket that wrote this file builds with.
# Override with --build-arg POLAR_VERSION=...
ARG POLAR_VERSION="{{polar_version}}"
ENV POLAR_VERSION=${POLAR_VERSION}
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://polar-lang.vercel.app/install.sh | sh
# Ticket's plugin is Rust, built by `polar build`.
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:/root/.polar/bin:${PATH}"

WORKDIR /app
COPY . .
RUN polar fetch && polar build

ENV TICKET_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

# Node runs as PID 1, so SIGTERM from `docker stop` reaches the launcher and drains requests.
CMD ["node", "dist/start.mjs"]
