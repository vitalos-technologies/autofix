#!/usr/bin/env bash
# Exports this runner's local Supabase URL and keys to later CI steps (P1.11).
# Run after `supabase start`. The keys belong to the throwaway local stack, but
# are masked in the log all the same.
set -euo pipefail

if [[ -z "${GITHUB_ENV:-}" ]]; then
  echo "supabase-env: GITHUB_ENV is not set; this script is for CI jobs." >&2
  exit 1
fi

eval "$(supabase status -o env)"
publishable="${PUBLISHABLE_KEY:-${ANON_KEY:-}}"
secret="${SECRET_KEY:-${SERVICE_ROLE_KEY:-}}"
if [[ -z "${API_URL:-}" || -z "$publishable" || -z "$secret" ]]; then
  echo "supabase-env: supabase status did not report an API URL and keys." >&2
  exit 1
fi
echo "::add-mask::$publishable"
echo "::add-mask::$secret"

{
  echo "INTEGRATION_SUPABASE_URL=$API_URL"
  echo "INTEGRATION_SUPABASE_PUBLISHABLE_KEY=$publishable"
  echo "INTEGRATION_SUPABASE_SECRET_KEY=$secret"
  # The app (pnpm build / start / dev) reads these.
  echo "NEXT_PUBLIC_SUPABASE_URL=$API_URL"
  echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$publishable"
  echo "SUPABASE_SECRET_KEY=$secret"
} >> "$GITHUB_ENV"
echo "supabase-env: exported the local stack at $API_URL"
