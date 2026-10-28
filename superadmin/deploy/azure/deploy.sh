#!/usr/bin/env bash
# Deploy the Autofix Super Admin to Azure Container Apps (consumption plan, UK South), the same shape
# as the Vitalos Super Admin. NOT RUN YET: deploying, DNS and any spend need Temitope's approval
# (docs/autofix/DECISIONS.md, "Waiting on Temitope").
#
#   superadmin/deploy/azure/deploy.sh --dry-run   # print the plan; calls nothing
#   DEPLOY_APPROVED=yes superadmin/deploy/azure/deploy.sh
#
# Idempotent: existing resources are updated, never deleted. Secret values are never printed; they go
# into Container Apps secrets and are referenced with secretref:.
#
# Environment for a real run:
#   AZ_SUBSCRIPTION, AZ_RESOURCE_GROUP, AZ_ENVIRONMENT (an existing Container Apps environment)
#   IMAGE                   e.g. ghcr.io/vitalos-technologies/autofix/superadmin:<git sha>
#   DATABASE_URL            the super admin's own Postgres 17 (users, sessions, audit), sslmode=require
#   AUTOFIX_DATABASE_URL    Autofix Supabase as autofix_superadmin (session pooler, sslmode=require)
#   AUTOFIX_STATUS_TOKEN    32+ characters; the same value goes into the Vitalos platform's settings
#   NEW_DJANGO_SECRET_KEY, NEW_BOOTSTRAP_ADMIN_PASSWORD   used only when the app has none yet
#   BOOTSTRAP_ADMIN_EMAIL, PRIMARY_OWNER_EMAIL (optional), SENTRY_DSN (optional)
# Fixed: APP_NAME=autofix-superadmin, DOMAIN=superadmin.autofix.vitalos.co.uk (DNS is a separate,
# approved step), AUTOFIX_APP_URL=https://autofix.vitalos.co.uk.
set -euo pipefail

APP_NAME="${APP_NAME:-autofix-superadmin}"
DOMAIN="${DOMAIN:-superadmin.autofix.vitalos.co.uk}"
LOCATION="${LOCATION:-uksouth}"
SECRETS=(DJANGO_SECRET_KEY DATABASE_URL AUTOFIX_DATABASE_URL AUTOFIX_STATUS_TOKEN BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD SENTRY_DSN)

plan() {
  cat <<PLAN
Autofix Super Admin deployment plan
  Container app      ${APP_NAME} (min replicas 0, max 1, 0.25 vCPU / 0.5 GiB) in ${LOCATION}
  Release job        ${APP_NAME}-release: bin/release.sh (migrate the super admin's own DB, bootstrap admin)
  Scheduled jobs     ${APP_NAME}-notify: manage.py notify_attention every 5 minutes
                     ${APP_NAME}-backup: bin/backup.sh nightly
  Ingress            https://${DOMAIN} (managed certificate after the CNAME exists)
  Plain settings     APP_ENVIRONMENT=production, APP_BASE_URL=https://${DOMAIN},
                     AUTOFIX_SUPERADMIN_URL=https://${DOMAIN}, AUTOFIX_APP_URL=https://autofix.vitalos.co.uk,
                     ALLOWED_HOSTS=${DOMAIN}, CSRF_TRUSTED_ORIGINS=https://${DOMAIN}, TRUSTED_PROXY_COUNT=1
  Secrets            ${SECRETS[*]}
  Expected cost      within the Container Apps free grant at this scale (scale to zero); to be confirmed
PLAN
}

if [[ "${1:-}" == "--dry-run" ]]; then
  plan
  exit 0
fi

if [[ "${DEPLOY_APPROVED:-}" != "yes" ]]; then
  plan
  echo "Refusing to deploy: set DEPLOY_APPROVED=yes once Temitope has approved the deployment." >&2
  exit 2
fi

: "${AZ_SUBSCRIPTION:?}" "${AZ_RESOURCE_GROUP:?}" "${AZ_ENVIRONMENT:?}" "${IMAGE:?}" "${DATABASE_URL:?}" "${AUTOFIX_DATABASE_URL:?}"
az account set --subscription "$AZ_SUBSCRIPTION"

secret_args=()
for name in "${SECRETS[@]}"; do
  value="${!name:-}"
  [[ "$name" == DJANGO_SECRET_KEY ]] && value="${DJANGO_SECRET_KEY:-${NEW_DJANGO_SECRET_KEY:-}}"
  [[ "$name" == BOOTSTRAP_ADMIN_PASSWORD ]] && value="${BOOTSTRAP_ADMIN_PASSWORD:-${NEW_BOOTSTRAP_ADMIN_PASSWORD:-}}"
  if [[ -n "$value" ]]; then
    [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::add-mask::$value"
    secret_args+=("$(echo "$name" | tr '[:upper:]_' '[:lower:]-')=$value")
  fi
done
env_args=(
  "APP_ENVIRONMENT=production" "APP_BASE_URL=https://${DOMAIN}" "AUTOFIX_SUPERADMIN_URL=https://${DOMAIN}"
  "AUTOFIX_APP_URL=https://autofix.vitalos.co.uk" "ALLOWED_HOSTS=${DOMAIN}" "CSRF_TRUSTED_ORIGINS=https://${DOMAIN}"
  "TRUSTED_PROXY_COUNT=1"
)
for name in "${SECRETS[@]}"; do
  ref="$(echo "$name" | tr '[:upper:]_' '[:lower:]-')"
  for pair in "${secret_args[@]}"; do [[ "${pair%%=*}" == "$ref" ]] && env_args+=("$name=secretref:$ref"); done
done

if az containerapp show -n "$APP_NAME" -g "$AZ_RESOURCE_GROUP" >/dev/null 2>&1; then
  az containerapp secret set -n "$APP_NAME" -g "$AZ_RESOURCE_GROUP" --secrets "${secret_args[@]}" >/dev/null
  az containerapp update -n "$APP_NAME" -g "$AZ_RESOURCE_GROUP" --image "$IMAGE" --set-env-vars "${env_args[@]}" >/dev/null
else
  az containerapp create -n "$APP_NAME" -g "$AZ_RESOURCE_GROUP" --environment "$AZ_ENVIRONMENT" --image "$IMAGE" \
    --ingress external --target-port 8000 --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --secrets "${secret_args[@]}" --env-vars "${env_args[@]}" >/dev/null
fi
echo "Deployed ${APP_NAME}. Bind https://${DOMAIN} once its CNAME exists (approved DNS step)."
