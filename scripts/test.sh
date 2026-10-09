#!/usr/bin/env bash
# Runs every test in the repo:
#   tests/*      polar test, or `polar check` against check.expected.txt, then e2e.mjs and fmt/ cases
#   examples/*   e2e.mjs (when present)
#   launcher/, cli/   e2e scripts
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
polar="${POLAR:-polar}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export root polar tmp NODE_NO_WARNINGS=1

ok() { printf 'ok   %s%s\n' "$1" "${2:-}"; }
fail() { printf 'FAIL %s%s\n' "$1" "${2:-}"; }

# Command output shows the measured time as (Nms) in snapshots.
normalize() { sed -E 's/\([0-9]+ms\)/(Nms)/g'; }

expect_match() { # name expected_file actual_file
  local name="$1" expected="$2" actual="$3"

  if [ ! -f "$expected" ]; then
    fail "$name" ": missing ${expected#"$root"/}"
    return 1
  fi

  normalize <"$actual" >"$actual.norm"

  if cmp -s "$expected" "$actual.norm"; then
    ok "$name"
  else
    fail "$name"
    diff "$expected" "$actual.norm" | sed -n 's/^< /  - /p; s/^> /  + /p'
    return 1
  fi
}

native() { # name dir
  local name="$1" dir="$2" out status

  out="$(cd "$dir" && "$polar" test --no-color 2>&1)"
  status=$?

  if [ "$status" -eq 0 ]; then
    ok "$name" " (polar test: $(printf '%s' "$out" | sed -n 's/.* \([0-9]*\) passed.*/\1/p' | tail -1) passed)"
  else
    fail "$name" " (polar test, exit $status)"
    printf '%s\n' "$out"
    return 1
  fi
}

check() { # name dir
  local name="$1" dir="$2" actual="$tmp/$$.check"

  (cd "$dir" && "$polar" check --no-color) >/dev/null 2>"$actual"
  expect_match "$name" "$dir/check.expected.txt" "$actual"
}

e2e() { # name dir [script] [expected]
  local name="$1" dir="$2" script="${3:-e2e.mjs}" expected="${4:-e2e.expected.txt}"
  local actual="$tmp/$$.e2e" out status

  if [ -f "$dir/polar.toml" ]; then
    out="$(cd "$dir" && "$polar" build 2>&1)"
    status=$?

    if [ "$status" -ne 0 ]; then
      fail "$name" " (exit $status)"
      printf '%s\n' "$out"
      return 1
    fi
  fi

  (cd "$dir" && node "$script") >"$actual" 2>"$actual.err"
  status=$?

  if [ "$status" -ne 0 ]; then
    fail "$name" " (exit $status)"
    cat "$actual.err" "$actual"
    return 1
  fi

  expect_match "$name" "$dir/$expected" "$actual"
}

formats() { # name dir
  local name="$1" dir="$2" cases="$2/fmt" scratch="$2/.polar/fmt" input file

  [ -d "$cases" ] || return 0

  for file in "$cases"/*.px; do
    case "$file" in *.expected.px) continue ;; esac

    local base case_name="$name fmt/$(basename "$file")" out
    base="$(basename "$file" .px)"
    input="$scratch/$(basename "$file")"

    rm -rf "$scratch"
    mkdir -p "$scratch"
    cp "$file" "$input"

    # Formatting twice checks that the formatter is idempotent.
    if ! out="$(cd "$dir" && "$polar" fmt --no-color "$input" 2>&1 && "$polar" fmt --no-color "$input" 2>&1)"; then
      fail "$case_name"
      printf '%s\n' "$out"
      continue
    fi

    expect_match "$case_name" "$cases/$base.expected.px" "$input"
  done
}

project() { # dir
  local dir="$1" name="${1#"$root"/}"

  if [ -f "$dir/check.expected.txt" ]; then
    check "$name" "$dir"
  elif find "$dir/src" -name '*_test.px' -print -quit 2>/dev/null | grep -q .; then
    native "$name" "$dir"
  fi

  if [ -f "$dir/e2e.mjs" ]; then
    e2e "$name e2e" "$dir"
  fi

  formats "$name" "$dir"
}

example() { e2e "${1#"$root"/} e2e" "$1"; }
launcher() { e2e "launcher e2e" "$1"; }

# `job <index> <function> <dir>`: output goes to a file so results print in order.
job() { "$2" "$3" >"$tmp/$1.out" 2>&1; }

export -f ok fail normalize expect_match native check e2e formats project example launcher job

cli="$root/cli"

if ! build="$(cd "$cli" && "$polar" build 2>&1)"; then
  printf 'FAIL cli build\n%s\n' "$build"
  exit 1
fi

jobs=()
for dir in "$root"/tests/*/; do
  [ -f "$dir/polar.toml" ] && jobs+=("project ${dir%/}")
done
for dir in "$root"/examples/*/; do
  [ -f "$dir/e2e.mjs" ] && jobs+=("example ${dir%/}")
done
jobs+=("launcher $root/launcher")

for i in "${!jobs[@]}"; do
  printf '%s\0%s\0%s\0' "$i" ${jobs[$i]}
done | xargs -0 -n 3 -P "$(nproc)" bash -c 'job "$0" "$1" "$2"'

count=${#jobs[@]}

# These start servers and processes of their own, so they run one at a time.
for spec in \
  "cli e2e|e2e.mjs|e2e.expected.txt" \
  "scaffold e2e|scaffold_e2e.mjs|scaffold_e2e.expected.txt" \
  "console e2e|console_e2e.mjs|console_e2e.expected.txt" \
  "watch e2e|watch_e2e.mjs|watch_e2e.expected.txt"; do
  IFS='|' read -r name script expected <<<"$spec"
  e2e "$name" "$cli" "$script" "$expected" >"$tmp/$count.out" 2>&1
  count=$((count + 1))
done

for ((i = 0; i < count; i++)); do
  cat "$tmp/$i.out"
done

failed="$(cat "$tmp"/*.out | grep -c '^FAIL')"

if [ "$failed" -eq 0 ]; then
  printf '\nall passed\n'
else
  printf '\n%s failed\n' "$failed"
  exit 1
fi
