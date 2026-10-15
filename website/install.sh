#!/bin/sh
# Installs the `ticket` command: a checkout of Ticket in ~/.ticket and a symlink on your PATH.
#
#   curl -fsSL https://ticket-polar.vercel.app/install.sh | sh
#
# Environment:
#   TICKET_VERSION  the tag or branch to install (default: the newest v* tag)
#   TICKET_HOME     where the checkout goes (default: ~/.ticket)
#   TICKET_BIN      where the `ticket` symlink goes (default: ~/.local/bin)
#   TICKET_REPO     the repository to clone (default: github.com/stepanvanzuriak/ticket)

set -eu

repo="${TICKET_REPO:-https://github.com/stepanvanzuriak/ticket}"
home="${TICKET_HOME:-$HOME/.ticket}"
bin="${TICKET_BIN:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for tool in git node; do
  command -v "$tool" >/dev/null 2>&1 || die "\`$tool\` isn't installed"
done

command -v polar >/dev/null 2>&1 ||
  die "\`polar\` isn't on your PATH: install it first (https://polar-lang.vercel.app/docs/getting-started.html)"

version="${TICKET_VERSION:-}"

if [ -z "$version" ]; then
  version="$(git ls-remote --tags --refs "$repo" 'v*' | sed 's|.*refs/tags/||' | sort -V | tail -n 1)"
  [ -n "$version" ] || die "no release tags found in $repo; set TICKET_VERSION"
fi

if [ -d "$home/.git" ]; then
  say "Updating $home to $version"
  git -C "$home" fetch --quiet --depth 1 origin "$version" || die "couldn't fetch $version"
  git -C "$home" checkout --quiet --force FETCH_HEAD
else
  [ ! -e "$home" ] || [ -z "$(ls -A "$home" 2>/dev/null)" ] || die "$home exists and isn't a Ticket checkout"
  say "Installing Ticket $version into $home"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$version" "$repo" "$home" || die "couldn't clone $version from $repo"
fi

mkdir -p "$bin"
ln -sf "$home/bin/ticket" "$bin/ticket"

# The first run builds the CLI.
if ! "$bin/ticket" version; then
  die "Ticket $version didn't build with your Polar ($(polar --version 2>/dev/null)). Try a newer release, or TICKET_VERSION=main"
fi

case ":$PATH:" in
  *":$bin:"*) ;;
  *) say "Add $bin to your PATH to use \`ticket\`: export PATH=\"$bin:\$PATH\"" ;;
esac

say "Done. Try: ticket new my_app"
