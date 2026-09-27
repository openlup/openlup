#!/bin/bash
# Read-only summary. Run from the selected local Supabase project directory.
# Never print, parse or persist Supabase status output: it includes credentials.
set -u

branch=$(git branch --show-current 2>/dev/null) || branch=unknown
printf 'branch=%s\n' "${branch:-detached}"

api=unknown
db=unknown
studio=unknown
project_id=
config=supabase/config.toml
if [ -f "$config" ] && command -v awk >/dev/null 2>&1; then
  # Accept only the numeric ports and a container-safe project identifier.
  # No environment file or other configuration value reaches the report.
  while read -r key value; do
    case "$key" in
      api) api=$value ;;
      db) db=$value ;;
      studio) studio=$value ;;
      project_id) project_id=$value ;;
    esac
  done < <(awk '
    /^[[:space:]]*\[/ {
      section=$0
      sub(/^[[:space:]]*\[/, "", section)
      sub(/\].*$/, "", section)
    }
    /^[[:space:]]*project_id[[:space:]]*=/ && section == "" {
      value=$0
      sub(/^[^=]*=[[:space:]]*"/, "", value)
      sub(/"[[:space:]]*(#.*)?$/, "", value)
      if (value ~ /^[a-zA-Z0-9_-]+$/) print "project_id", value
    }
    /^[[:space:]]*port[[:space:]]*=/ && (section == "api" || section == "db" || section == "studio") {
      value=$0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]*(#.*)?$/, "", value)
      if (value ~ /^[0-9]+$/ && value > 0 && value <= 65535) print section, value
    }
  ' "$config" 2>/dev/null)
fi
printf 'ports api=%s db=%s studio=%s\n' "$api" "$db" "$studio"

printf '\nSupabase status\n'
if [ -f "$config" ] && command -v supabase >/dev/null 2>&1 && supabase status >/dev/null 2>&1; then
  printf 'available (connection details omitted)\n'
else
  printf 'unavailable (connection details omitted)\n'
fi

# An optional caller-selected resource reporter is not required by OpenLup.
if [ -n "${AI_RESOURCE_GATE_BIN:-}" ] && [ -x "$AI_RESOURCE_GATE_BIN" ]; then
  "$AI_RESOURCE_GATE_BIN" status 2>/dev/null || printf 'resource status unavailable\n'
fi

printf '\nLocal containers\n'
if [ -n "$project_id" ] && command -v docker >/dev/null 2>&1; then
  docker ps -a --filter "name=^supabase_.*_${project_id}$" --format '{{.Names}} {{.Status}}' 2>/dev/null || printf 'container status unavailable\n'
else
  printf 'container status unavailable\n'
fi
exit 0
