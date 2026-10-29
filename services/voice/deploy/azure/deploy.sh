#!/usr/bin/env bash
# Deploy autofix-voice (the AI front desk on calls, services/voice) to Azure Container Apps, in the super
# admin's existing environment (consumption plan, UK South, scale to zero). Run by
# .github/workflows/voice-deploy.yml; `--dry-run` prints the plan and calls nothing.
#
# Idempotent: creates what is missing, updates the rest, deletes nothing. Secret values are never printed:
# they live in Container Apps secrets, referenced with secretref:. The relay secret is generated once and
# kept, so a re-run does not break calls in flight; the Claude key and the Twilio auth token are taken
# from the environment when given, else the app's existing ones are kept.
#
#   deploy.sh --dry-run
#   deploy.sh apply
#
# Environment (apply): AZURE_SUBSCRIPTION_ID, IMAGE, GHCR_PULL_USERNAME, GHCR_PULL_TOKEN. Optional:
# ANTHROPIC_API_KEY, TWILIO_AUTH_TOKEN, VOICE_CLAUDE_MODEL, MIN_REPLICAS (default 0: scale to zero; 1 keeps
# a replica warm, about £10/month, Temitope's call). With DEPLOY_OUT_FILE, writes VOICE_RELAY_URL,
# VOICE_RELAY_SECRET, VOICE_ORIGIN and VOICE_CLAUDE_READY (yes/no) there (mode 0600) for the Vercel step.
set -euo pipefail

RG="${AZ_RESOURCE_GROUP:-rg-autofix-superadmin}"
LOCATION="${LOCATION:-uksouth}"
APP="autofix-voice"
ENVIRONMENT="cae-autofix-superadmin"
REGISTRY="ghcr.io"
AUTOFIX_BASE_URL="${AUTOFIX_BASE_URL:-https://autofix.vitalos.co.uk}"
MIN_REPLICAS="${MIN_REPLICAS:-0}"
MAX_REPLICAS="${MAX_REPLICAS:-2}"

plan() {
  cat <<PLAN
autofix-voice deployment (resource group ${RG}, ${LOCATION})
  Environment            ${ENVIRONMENT} (the super admin's; consumption only, no fixed charge)
  Container app          ${APP}: external ingress :8080 (HTTPS and WebSockets), ${MIN_REPLICAS}-${MAX_REPLICAS} replicas,
                         0.25 vCPU / 0.5 GiB, HTTP scale rule (20 concurrent calls per replica)
  Endpoints              /healthz (woken by the voice webhook), /readyz, wss://<host>/relay (Twilio ConversationRelay)
  Image                  ${REGISTRY} private package, pulled with a read-only token (GHCR_PULL_TOKEN)
  Talks to               ${AUTOFIX_BASE_URL} (/api/voice/v1/session, /api/agent/v1/*) and the Claude API
  Secrets                voice-relay-secret (generated once, then kept), anthropic-api-key, twilio-auth-token
  Expected cost          £0 at rest (scale to zero, Container Apps free grant); Claude and Twilio usage per call
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
  apply) ;;
  *)
    echo "usage: deploy.sh --dry-run | apply" >&2
    exit 2
    ;;
esac

: "${AZURE_SUBSCRIPTION_ID:?}" "${IMAGE:?}" "${GHCR_PULL_USERNAME:?}" "${GHCR_PULL_TOKEN:?}"
[[ "$MIN_REPLICAS" =~ ^[01]$ ]] || { echo "deploy: MIN_REPLICAS must be 0 or 1" >&2; exit 2; }
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
plan

az containerapp env show -g "$RG" -n "$ENVIRONMENT" -o none \
  || { echo "deploy: environment $ENVIRONMENT not found; run the Super Admin deploy first" >&2; exit 1; }

existed=no
app_exists && existed=yes

keep_or_new() { # secret name, generator length
  local value=""
  [[ "$existed" == yes ]] && value="$(secret_value "$1")"
  [[ -n "$value" ]] || value="$(python3 -c "import secrets; print(secrets.token_urlsafe($2))")"
  printf '%s' "$value"
}
keep_or_given() { # secret name, given value
  if [[ -n "$2" ]]; then printf '%s' "$2"; elif [[ "$existed" == yes ]]; then secret_value "$1"; fi
}
RELAY_SECRET="$(keep_or_new voice-relay-secret 48)"
CLAUDE_KEY="$(keep_or_given anthropic-api-key "${ANTHROPIC_API_KEY:-}")"
TWILIO_TOKEN="$(keep_or_given twilio-auth-token "${TWILIO_AUTH_TOKEN:-}")"
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  for value in "$RELAY_SECRET" "$CLAUDE_KEY" "$TWILIO_TOKEN" "$GHCR_PULL_TOKEN"; do
    [[ -n "$value" ]] && echo "::add-mask::$value"
  done
fi

secrets=("voice-relay-secret=$RELAY_SECRET")
env_vars=(
  "NODE_ENV=production"
  "PORT=8080"
  "AUTOFIX_BASE_URL=$AUTOFIX_BASE_URL"
  "VOICE_RELAY_SECRET=secretref:voice-relay-secret"
)
[[ -n "${VOICE_CLAUDE_MODEL:-}" ]] && env_vars+=("VOICE_CLAUDE_MODEL=$VOICE_CLAUDE_MODEL")
if [[ -n "$CLAUDE_KEY" ]]; then
  secrets+=("anthropic-api-key=$CLAUDE_KEY")
  env_vars+=("ANTHROPIC_API_KEY=secretref:anthropic-api-key")
fi
if [[ -n "$TWILIO_TOKEN" ]]; then
  secrets+=("twilio-auth-token=$TWILIO_TOKEN")
  env_vars+=("TWILIO_AUTH_TOKEN=secretref:twilio-auth-token")
fi
registry=(--registry-server "$REGISTRY" --registry-username "$GHCR_PULL_USERNAME" --registry-password "$GHCR_PULL_TOKEN")
registry_set=(--server "$REGISTRY" --username "$GHCR_PULL_USERNAME" --password "$GHCR_PULL_TOKEN")

echo "== Container app"
if [[ "$existed" == yes ]]; then
  az containerapp secret set -n "$APP" -g "$RG" --secrets "${secrets[@]}" -o none
  az containerapp registry set -n "$APP" -g "$RG" "${registry_set[@]}" -o none
else
  az containerapp create -n "$APP" -g "$RG" --environment "$ENVIRONMENT" --image "$IMAGE" \
    --ingress external --target-port 8080 --transport auto \
    --min-replicas "$MIN_REPLICAS" --max-replicas "$MAX_REPLICAS" --cpu 0.25 --memory 0.5Gi \
    --scale-rule-name http --scale-rule-type http --scale-rule-http-concurrency 20 \
    --secrets "${secrets[@]}" --env-vars "${env_vars[@]}" "${registry[@]}" -o none
fi

fqdn="$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
[[ -n "$fqdn" ]] || { echo "deploy: no ingress address for $APP" >&2; exit 1; }
# Twilio signs the relay URL as it dialled it; the service checks X-Twilio-Signature against this.
env_vars+=("PUBLIC_RELAY_URL=wss://${fqdn}/relay")
az containerapp update -n "$APP" -g "$RG" --image "$IMAGE" --replace-env-vars "${env_vars[@]}" \
  --min-replicas "$MIN_REPLICAS" --max-replicas "$MAX_REPLICAS" -o none
# Live calls get time to finish when a replica is replaced or scaled in.
az resource update -g "$RG" -n "$APP" --resource-type Microsoft.App/containerApps \
  --set properties.template.terminationGracePeriodSeconds=60 -o none 2>/dev/null \
  || echo "note: could not set the termination grace period (kept the default)"

ready=no
[[ -n "$CLAUDE_KEY" ]] && ready=yes
echo "Deployed ${APP}: https://${fqdn} (relay wss://${fqdn}/relay; Claude key: ${ready}; Twilio signature check: $([[ -n "$TWILIO_TOKEN" ]] && echo on || echo off); min replicas ${MIN_REPLICAS})"
if [[ -n "${DEPLOY_OUT_FILE:-}" ]]; then
  umask 077
  printf 'VOICE_ORIGIN=https://%s\nVOICE_RELAY_URL=wss://%s/relay\nVOICE_RELAY_SECRET=%s\nVOICE_CLAUDE_READY=%s\n' "$fqdn" "$fqdn" "$RELAY_SECRET" "$ready" > "$DEPLOY_OUT_FILE"
fi
