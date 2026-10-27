#!/usr/bin/env bash
# Per-runner isolation for CI jobs on a shared machine (P1.11).
#
# Several self-hosted runners (autofix-azure-1..4) share one machine and one
# user, and each runs one job at a time. Every job that starts Supabase or
# serves the app runs this first, so jobs on different runners never share a
# Supabase stack (containers, volumes, network) or a port:
#
#   N                      trailing number of $RUNNER_NAME (0 when there is none)
#   supabase/config.toml   project_id = "autofix-ci-N"; every host port Supabase
#                          binds (api, db, shadow, pooler, studio, local_smtp,
#                          analytics, edge-runtime inspector) shifted by N*100.
#                          Ports the CLI would default are written explicitly.
#   $GITHUB_ENV            SUPABASE_PROJECT_ID, SUPABASE_API_PORT, SUPABASE_DB_PORT,
#                          INTEGRATION_SUPABASE_URL, and app ports
#                          PLAYWRIGHT_PORT (browser tests)     3400 + N*10 + 1
#                          LIGHTHOUSE_PORT                      3400 + N*10 + 2
#                          PLAYWRIGHT_SMOKE_PORT (host smoke)   3400 + N*10 + 3
#                          PLAYWRIGHT_INVOICE_PORT (PDF tests)  3400 + N*10 + 4
#
# Only acts when CI=true. Locally nothing changes: project
# sobautofix-local-tests on 54321 and the default app ports.
# Safe to run twice in one job (the shift is applied once).
set -euo pipefail

if [[ "${CI:-}" != "true" ]]; then
  echo "supabase-isolate: CI is not true; leaving supabase/config.toml and ports alone."
  exit 0
fi

config="${SUPABASE_CONFIG:-supabase/config.toml}"
if [[ ! -f "$config" ]]; then
  echo "supabase-isolate: $config not found (run from the repository root)." >&2
  exit 1
fi

runner="${RUNNER_NAME:-}"
if [[ "$runner" =~ ([0-9]+)$ ]]; then
  slot=$((10#${BASH_REMATCH[1]}))
else
  slot=0
fi
if (( slot > 99 )); then
  echo "supabase-isolate: runner number $slot is too large for the port scheme (max 99)." >&2
  exit 1
fi

shift_by=$((slot * 100))
project_id="autofix-ci-${slot}"

if grep -Eq "^project_id[[:space:]]*=[[:space:]]*\"${project_id}\"" "$config"; then
  echo "supabase-isolate: $config already isolated for $project_id."
else
  tmp="$(mktemp)"
  awk -v shift="$shift_by" -v project="$project_id" '
    # Host ports per section; values are the Supabase CLI defaults, used when
    # the key is missing so that no stack falls back to a shared port.
    BEGIN {
      defaults["api|port"] = 54321
      defaults["db|port"] = 54322
      defaults["db|shadow_port"] = 54320
      defaults["db.pooler|port"] = 54329
      defaults["studio|port"] = 54323
      defaults["local_smtp|port"] = 54324
      defaults["analytics|port"] = 54327
      defaults["edge_runtime|inspector_port"] = 8083
      for (key in defaults) {
        split(key, part, "|")
        wanted[part[1]] = wanted[part[1]] " " part[2]
      }
      section = ""
    }
    function flush_missing(name,    count, keys, i) {
      if (!(name in wanted) || (name in flushed)) return
      flushed[name] = 1
      count = split(wanted[name], keys, " ")
      for (i = 1; i <= count; i++) {
        if (!((name "|" keys[i]) in seen)) print keys[i] " = " (defaults[name "|" keys[i]] + shift)
      }
    }
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      flush_missing(section)
      section = $0
      gsub(/^[[:space:]]*\[|\][[:space:]]*$/, "", section)
      present[section] = 1
      print
      next
    }
    /^project_id[[:space:]]*=/ && section == "" {
      print "project_id = \"" project "\""
      next
    }
    {
      if ((section in wanted) && match($0, /^[[:space:]]*[a-z_]+[[:space:]]*=[[:space:]]*[0-9]+/)) {
        key = $0
        sub(/^[[:space:]]*/, "", key)
        sub(/[[:space:]]*=.*/, "", key)
        if ((section "|" key) in defaults) {
          value = $0
          sub(/^[^=]*=[[:space:]]*/, "", value)
          sub(/[^0-9].*$/, "", value)
          seen[section "|" key] = 1
          print key " = " (value + shift)
          next
        }
      }
      print
    }
    END {
      flush_missing(section)
      for (name in wanted) {
        if (!(name in present)) {
          print ""
          print "[" name "]"
          flush_missing(name)
        }
      }
    }
  ' "$config" > "$tmp"
  mv "$tmp" "$config"
  echo "supabase-isolate: $config -> project $project_id, Supabase ports shifted by $shift_by."
fi

port_of() {
  # port_of <section> <key>: the value in the rewritten config.
  awk -v want="$1" -v key="$2" '
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ { section = $0; gsub(/^[[:space:]]*\[|\][[:space:]]*$/, "", section); next }
    section == want && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { value = $0; sub(/^[^=]*=[[:space:]]*/, "", value); sub(/[^0-9].*$/, "", value); print value; exit }
  ' "$config"
}

api_port="$(port_of api port)"
db_port="$(port_of db port)"
app_base=$((3400 + slot * 10))

exports=(
  "SUPABASE_PROJECT_ID=$project_id"
  "SUPABASE_API_PORT=$api_port"
  "SUPABASE_DB_PORT=$db_port"
  "INTEGRATION_SUPABASE_URL=http://127.0.0.1:$api_port"
  "PLAYWRIGHT_PORT=$((app_base + 1))"
  "LIGHTHOUSE_PORT=$((app_base + 2))"
  "PLAYWRIGHT_SMOKE_PORT=$((app_base + 3))"
  "PLAYWRIGHT_INVOICE_PORT=$((app_base + 4))"
)

echo "supabase-isolate: runner '${runner:-unnamed}' -> slot $slot"
for line in "${exports[@]}"; do
  echo "  $line"
  if [[ -n "${GITHUB_ENV:-}" ]]; then echo "$line" >> "$GITHUB_ENV"; fi
done
