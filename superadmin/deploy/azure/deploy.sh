#!/usr/bin/env bash
# Deploy the Autofix Super Admin to Azure Container Apps (consumption plan, UK South, scale to zero).
# Run by .github/workflows/superadmin-deploy.yml; `--dry-run` prints the plan and calls nothing.
#
# Served at https://autofix.vitalos.co.uk/superadmin through the Autofix app's proxy (DECISIONS D18): the
# container's own address is only Vercel's SUPERADMIN_ORIGIN and answers 404 without the proxy secret.
# Idempotent: creates what is missing, updates the rest, deletes nothing. Secret values are never printed:
# they live in Container Apps secrets, referenced with secretref:. Existing secrets are kept, so a
# re-run changes no password (supabase_setup.py reuses the connection strings this script exports).
#
#   deploy.sh --dry-run
#   deploy.sh existing-secrets <file>   write the app's current DATABASE_URL and AUTOFIX_DATABASE_URL (0600)
#   deploy.sh apply                      deploy IMAGE with the connection strings in $DB_ENV_FILE
#
# Environment (apply): AZURE_SUBSCRIPTION_ID, IMAGE, GHCR_PULL_USERNAME, GHCR_PULL_TOKEN, DB_ENV_FILE,
# PRIMARY_OWNER_EMAIL. Optional: SENTRY_DSN; TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (voicemail playback).
# With DEPLOY_OUT_FILE, writes SUPERADMIN_ORIGIN and SUPERADMIN_PROXY_SECRET there (mode 0600) for the
# Vercel step.
set -euo pipefail

RG="${AZ_RESOURCE_GROUP:-rg-autofix-superadmin}"
LOCATION="${LOCATION:-uksouth}"
APP="autofix-superadmin"
ENVIRONMENT="cae-autofix-superadmin"
WORKSPACE="log-autofix-superadmin"
RELEASE_JOB="${APP}-release"
NOTIFY_JOB="${APP}-notify"
PUBLIC_HOST="autofix.vitalos.co.uk"
PREFIX="/superadmin"
REGISTRY="ghcr.io"

plan() {
  cat <<PLAN
Autofix Super Admin deployment (resource group ${RG}, ${LOCATION})
  Log Analytics          ${WORKSPACE}: daily cap 0.1 GB, 30-day retention (inside the free 5 GB/month)
  Environment            ${ENVIRONMENT}: Container Apps, consumption only (no workload profiles, no fixed charge)
  Container app          ${APP}: external ingress :8000, 0-1 replicas, 0.25 vCPU / 0.5 GiB (scale to zero)
  Release job            ${RELEASE_JOB}: manual, bin/release.sh (migrates the super admin's own schema)
  Scheduled job          ${NOTIFY_JOB}: manage.py notify_attention every 5 minutes
  Image                  ${REGISTRY} private package, pulled with a read-only token (GHCR_PULL_TOKEN)
  Public address         https://${PUBLIC_HOST}${PREFIX} via the Autofix app (Vercel SUPERADMIN_ORIGIN,
                         SUPERADMIN_PROXY_SECRET); no DNS change
  Data                   Autofix's Supabase project: schema superadmin_app (role superadmin_app) for its own
                         data, autofix_superadmin for Autofix data (A415)
  Secrets                django-secret-key, database-url, autofix-database-url, superadmin-proxy-secret,
                         autofix-status-token, bootstrap-admin-password (generated once, then kept)
  Expected cost          £0: Container Apps free grant (scale to zero), free Log Analytics tier, private
                         GitHub package (free for this size), existing Supabase project
PLAN
}

secret_value() { # name -> value of an existing app secret, or empty
  az containerapp secret list -n "$APP" -g "$RG" --show-values --query "[?name=='$1'].value | [0]" -o tsv 2>/dev/null || true
}

app_exists() { az containerapp show -n "$APP" -g "$RG" -o none 2>/dev/null; }

case "${1:-}" in
  --dry-run)
    plan
    exit 0
    ;;
  existing-secrets)
    : "${2:?usage: deploy.sh existing-secrets <file>}"
    umask 077
    : > "$2"
    if app_exists; then
      for pair in "DATABASE_URL:database-url" "AUTOFIX_DATABASE_URL:autofix-database-url"; do
        value="$(secret_value "${pair#*:}")"
        if [[ -n "$value" ]]; then
          [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::add-mask::$value"
          echo "EXISTING_${pair%%:*}=$value" >> "$2"
        fi
      done
    fi
    exit 0
    ;;
  apply) ;;
  *)
    echo "usage: deploy.sh --dry-run | existing-secrets <file> | apply" >&2
    exit 2
    ;;
esac

: "${AZURE_SUBSCRIPTION_ID:?}" "${IMAGE:?}" "${GHCR_PULL_USERNAME:?}" "${GHCR_PULL_TOKEN:?}" "${DB_ENV_FILE:?}" "${PRIMARY_OWNER_EMAIL:?}"
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
plan

# Connection strings from supabase_setup.py.
DATABASE_URL="$(grep '^DATABASE_URL=' "$DB_ENV_FILE" | cut -d= -f2-)"
AUTOFIX_DATABASE_URL="$(grep '^AUTOFIX_DATABASE_URL=' "$DB_ENV_FILE" | cut -d= -f2-)"
[[ -n "$DATABASE_URL" && -n "$AUTOFIX_DATABASE_URL" ]] || { echo "deploy: $DB_ENV_FILE lacks a connection string" >&2; exit 1; }

# Secrets generated once and kept on later runs.
keep_or_new() { # secret name, generator length
  local value=""
  app_exists && value="$(secret_value "$1")"
  [[ -n "$value" ]] || value="$(python3 -c "import secrets; print(secrets.token_urlsafe($2))")"
  printf '%s' "$value"
}
DJANGO_SECRET_KEY="$(keep_or_new django-secret-key 64)"
PROXY_SECRET="$(keep_or_new superadmin-proxy-secret 48)"
STATUS_TOKEN="$(keep_or_new autofix-status-token 48)"
BOOTSTRAP_PASSWORD="$(keep_or_new bootstrap-admin-password 32)"
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  for value in "$DJANGO_SECRET_KEY" "$PROXY_SECRET" "$STATUS_TOKEN" "$BOOTSTRAP_PASSWORD" "$GHCR_PULL_TOKEN"; do
    echo "::add-mask::$value"
  done
fi

secrets=(
  "django-secret-key=$DJANGO_SECRET_KEY"
  "database-url=$DATABASE_URL"
  "autofix-database-url=$AUTOFIX_DATABASE_URL"
  "superadmin-proxy-secret=$PROXY_SECRET"
  "autofix-status-token=$STATUS_TOKEN"
  "bootstrap-admin-password=$BOOTSTRAP_PASSWORD"
)
[[ -n "${SENTRY_DSN:-}" ]] && secrets+=("sentry-dsn=$SENTRY_DSN")
# Voicemail playback (Calls). Optional: without them the Calls page works and playback says it is not set up.
if [[ -n "${TWILIO_ACCOUNT_SID:-}" && -n "${TWILIO_AUTH_TOKEN:-}" ]]; then
  secrets+=("twilio-account-sid=$TWILIO_ACCOUNT_SID" "twilio-auth-token=$TWILIO_AUTH_TOKEN")
fi
env_vars=(
  "APP_ENVIRONMENT=production"
  "DJANGO_SETTINGS_MODULE=config.settings.prod"
  "SUPERADMIN_PATH_PREFIX=$PREFIX"
  "APP_BASE_URL=https://$PUBLIC_HOST"
  "AUTOFIX_SUPERADMIN_URL=https://$PUBLIC_HOST$PREFIX"
  "AUTOFIX_APP_URL=https://autofix.vitalos.co.uk"
  "ALLOWED_HOSTS=$PUBLIC_HOST"
  "CSRF_TRUSTED_ORIGINS=https://$PUBLIC_HOST"
  "TRUSTED_PROXY_COUNT=1"
  # The Supabase pooler may refuse startup options; the role's own defaults (read-only, search_path) apply.
  "AUTOFIX_DB_STARTUP_OPTIONS=False"
  "LOG_FORMAT=json"
  "WEB_CONCURRENCY=2"
  "PRIMARY_OWNER_EMAIL=$PRIMARY_OWNER_EMAIL"
  "DJANGO_SECRET_KEY=secretref:django-secret-key"
  "DATABASE_URL=secretref:database-url"
  "AUTOFIX_DATABASE_URL=secretref:autofix-database-url"
  "SUPERADMIN_PROXY_SECRET=secretref:superadmin-proxy-secret"
  "AUTOFIX_STATUS_TOKEN=secretref:autofix-status-token"
)
[[ -n "${SENTRY_DSN:-}" ]] && env_vars+=("SENTRY_DSN=secretref:sentry-dsn")
if [[ -n "${TWILIO_ACCOUNT_SID:-}" && -n "${TWILIO_AUTH_TOKEN:-}" ]]; then
  env_vars+=("TWILIO_ACCOUNT_SID=secretref:twilio-account-sid" "TWILIO_AUTH_TOKEN=secretref:twilio-auth-token")
fi
# The release job also creates the primary owner as the bootstrap SuperAdmin, with a password nobody
# knows; the owner sets their own with a one-time link (manage.py issue_setup_link).
# shellcheck disable=SC2034 # used through job_upsert's nameref
release_env=("${env_vars[@]}" "BOOTSTRAP_ADMIN_EMAIL=$PRIMARY_OWNER_EMAIL" "BOOTSTRAP_ADMIN_PASSWORD=secretref:bootstrap-admin-password")
registry=(--registry-server "$REGISTRY" --registry-username "$GHCR_PULL_USERNAME" --registry-password "$GHCR_PULL_TOKEN")
registry_set=(--server "$REGISTRY" --username "$GHCR_PULL_USERNAME" --password "$GHCR_PULL_TOKEN")

echo "== Log Analytics and Container Apps environment"
if ! az monitor log-analytics workspace show -g "$RG" -n "$WORKSPACE" -o none 2>/dev/null; then
  az monitor log-analytics workspace create -g "$RG" -n "$WORKSPACE" -l "$LOCATION" \
    --sku PerGB2018 --retention-time 30 --quota 0.1 -o none
fi
if ! az containerapp env show -g "$RG" -n "$ENVIRONMENT" -o none 2>/dev/null; then
  law_id="$(az monitor log-analytics workspace show -g "$RG" -n "$WORKSPACE" --query customerId -o tsv)"
  law_key="$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$WORKSPACE" --query primarySharedKey -o tsv)"
  [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::add-mask::$law_key"
  az containerapp env create -g "$RG" -n "$ENVIRONMENT" -l "$LOCATION" --enable-workload-profiles false \
    --logs-workspace-id "$law_id" --logs-workspace-key "$law_key" -o none
fi

job_upsert() { # name, env array name, trigger args..., -- command args...
  local name="$1"; shift
  local -n job_env="$1"; shift
  local trigger=() command=()
  while [[ "$1" != "--" ]]; do trigger+=("$1"); shift; done
  shift
  command=("$@")
  if az containerapp job show -n "$name" -g "$RG" -o none 2>/dev/null; then
    az containerapp job secret set -n "$name" -g "$RG" --secrets "${secrets[@]}" -o none
    az containerapp job registry set -n "$name" -g "$RG" "${registry_set[@]}" -o none
    az containerapp job update -n "$name" -g "$RG" --image "$IMAGE" --replace-env-vars "${job_env[@]}" \
      "${command[@]}" -o none
  else
    az containerapp job create -n "$name" -g "$RG" --environment "$ENVIRONMENT" --image "$IMAGE" \
      "${trigger[@]}" --replica-timeout 900 --replica-retry-limit 0 --parallelism 1 --replica-completion-count 1 \
      --cpu 0.25 --memory 0.5Gi --secrets "${secrets[@]}" --env-vars "${job_env[@]}" "${registry[@]}" \
      "${command[@]}" -o none
  fi
}

echo "== Release job (migrate the super admin's own schema, create the primary owner)"
job_upsert "$RELEASE_JOB" release_env --trigger-type Manual -- --command "bin/release.sh"
execution="$(az containerapp job start -n "$RELEASE_JOB" -g "$RG" --query name -o tsv)"
for _ in $(seq 1 90); do
  status="$(az containerapp job execution show -n "$RELEASE_JOB" -g "$RG" --job-execution-name "$execution" --query properties.status -o tsv)"
  [[ "$status" == "Running" || "$status" == "Processing" || -z "$status" ]] || break
  sleep 10
done
echo "release job: $status"
[[ "$status" == "Succeeded" ]] || { echo "deploy: the release job did not succeed (see its logs in Log Analytics)" >&2; exit 1; }

echo "== Container app"
if app_exists; then
  az containerapp secret set -n "$APP" -g "$RG" --secrets "${secrets[@]}" -o none
  az containerapp registry set -n "$APP" -g "$RG" "${registry_set[@]}" -o none
  az containerapp update -n "$APP" -g "$RG" --image "$IMAGE" --replace-env-vars "${env_vars[@]}" \
    --min-replicas 0 --max-replicas 1 -o none
else
  az containerapp create -n "$APP" -g "$RG" --environment "$ENVIRONMENT" --image "$IMAGE" \
    --ingress external --target-port 8000 --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --scale-rule-name http --scale-rule-type http --scale-rule-http-concurrency 50 \
    --secrets "${secrets[@]}" --env-vars "${env_vars[@]}" "${registry[@]}" -o none
fi

echo "== Scheduled job (Autofix alerts into the bell every 5 minutes)"
job_upsert "$NOTIFY_JOB" env_vars --trigger-type Schedule --cron-expression "*/5 * * * *" -- \
  --command "python" --args "manage.py" "notify_attention"

fqdn="$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
echo "Deployed ${APP}: origin https://${fqdn}, public https://${PUBLIC_HOST}${PREFIX}"
if [[ -n "${DEPLOY_OUT_FILE:-}" ]]; then
  umask 077
  printf 'SUPERADMIN_ORIGIN=https://%s\nSUPERADMIN_PROXY_SECRET=%s\n' "$fqdn" "$PROXY_SECRET" > "$DEPLOY_OUT_FILE"
fi
