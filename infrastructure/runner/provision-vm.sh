#!/usr/bin/env bash
# Provision autofix's self-hosted runners on the AWS build VM from an operator machine. Runbook: infrastructure/RUNNER.md.
# Needs: AWS credentials that can call SSM on the VM (e.g. AWS_PROFILE=workforce after `aws sso login --profile workforce`),
# and a `gh` login with admin on vitalos-technologies/autofix (no jq or Python needed on the operator side).
#
# The VM's own checkouts can't authenticate to GitHub non-interactively, so the scripts travel base64-embedded inside the
# SSM command. The runner registration token is fetched here, never printed or written to disk, and only reaches the VM
# inside the command (RUNNER_TOKEN); it expires after an hour.
#
#   provision-vm.sh inspect           # read-only: users, Docker, Node, memory, ports
#   provision-vm.sh docker            # rootless Docker for ghrunner-autofix + supabase start/stop proof
#   provision-vm.sh playwright-deps   # Chromium system libraries (root, once)
#   provision-vm.sh runners           # register autofix-build-vm-1..$RUNNERS as systemd services
#   provision-vm.sh status            # services, runner registrations, free -h
#   provision-vm.sh remove N          # stop, unregister and delete autofix-build-vm-N
#   provision-vm.sh all               # docker, playwright-deps, runners, status
set -euo pipefail

INSTANCE_ID="${INSTANCE_ID:-i-0acc8453065a3eb23}"
AWS_REGION="${AWS_REGION:-eu-west-2}"
REPO="${REPO:-vitalos-technologies/autofix}"
RUNNERS="${RUNNERS:-2}"
RUNNER_USER="ghrunner-autofix"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.62.1}"   # the repo's locked @playwright/test
NODE_VERSION="${NODE_VERSION:-22.22.0}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONUTF8=1 AWS_REGION

b64() { base64 -w0 < "$1"; }

# Sends a root shell script to the VM over SSM and prints its output; exits non-zero if the script failed.
run_remote() {
  local label="$1" script="$2" env_line="${3:-}"
  local encoded params command_id status
  encoded="$(printf '%s' "$script" | base64 -w0)"
  local cmd="${env_line}echo '${encoded}' | base64 -d > /root/autofix-runner-step.sh && bash /root/autofix-runner-step.sh; rc=\$?; rm -f /root/autofix-runner-step.sh; exit \$rc"
  # The command holds only base64, a token and plain shell, so it needs no JSON escaping; refuse anything that would.
  [[ "$cmd" != *'"'* && "$cmd" != *\\* ]] || { echo "refusing to send a command containing quotes or backslashes" >&2; return 1; }
  params="{\"commands\":[\"${cmd}\"],\"executionTimeout\":[\"3600\"]}"
  unset cmd
  command_id="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
    --comment "autofix runner: ${label}" --timeout-seconds 600 --parameters "$params" --query Command.CommandId --output text)"
  unset params
  echo "== ${label} (SSM command ${command_id})" >&2
  while :; do
    sleep 5
    status="$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) continue ;; esac
    break
  done
  aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE_ID" \
    --query '[StandardOutputContent, StandardErrorContent]' --output text
  [[ "$status" == "Success" ]] || { echo "== ${label}: ${status}" >&2; return 1; }
}

inspect_script='set -u
echo "## host"; hostnamectl --static; uptime; free -h; df -h / /home | tail -n +1; nproc
echo "## users"; getent passwd ghrunner ghrunner-autofix || true; id ghrunner 2>/dev/null || true; id ghrunner-autofix 2>/dev/null || true
echo "## secrets dir"; ls -ld /srv/workforce/secrets 2>/dev/null || true
echo "## docker"; command -v docker dockerd rootlesskit dockerd-rootless-setuptool.sh || true; dpkg -l | grep -E "docker|containerd|rootlesskit|uidmap|slirp4netns|dbus-user-session" | awk "{print \$2, \$3}" || true
systemctl is-active docker 2>/dev/null || true; sysctl kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone 2>/dev/null || true
echo "## node"; command -v node npx && node -v || true
echo "## runners"; systemctl --no-pager --plain list-units "actions.runner.*" || true
echo "## listening ports"; ss -ltnH | awk "{print \$4}" | sort -u | tr "\n" " "; echo
echo "## needrestart"; ls /etc/needrestart/conf.d 2>/dev/null || true'

docker_script() {
  cat <<SCRIPT
set -euo pipefail
echo '$(b64 "$here/setup-rootless-docker.sh")' | base64 -d > /root/setup-rootless-docker.sh
RUNNER_USER=${RUNNER_USER} bash /root/setup-rootless-docker.sh --prove
SCRIPT
}

playwright_script="set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v npx >/dev/null; then npx_bin=npx; else
  tmp=\$(mktemp -d); cd \$tmp
  curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz
  curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt | grep \" node-v${NODE_VERSION}-linux-x64.tar.xz\$\" | sha256sum -c -
  tar -xJf node-v${NODE_VERSION}-linux-x64.tar.xz; export PATH=\$tmp/node-v${NODE_VERSION}-linux-x64/bin:\$PATH; npx_bin=npx
fi
\$npx_bin -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium 2>&1 | tail -n 5
[[ -n \${tmp:-} ]] && rm -rf \$tmp
echo 'Chromium system dependencies installed.'"

runners_script() {
  cat <<SCRIPT
set -euo pipefail
echo '$(b64 "$here/setup-runner.sh")' | base64 -d > /root/setup-runner.sh
for n in \$(seq 1 ${RUNNERS}); do
  RUNNER_USER=${RUNNER_USER} RUNNER_NAME=autofix-build-vm-\$n RUNNER_DIR=/home/${RUNNER_USER}/actions-runner-\$n bash /root/setup-runner.sh
done
unset RUNNER_TOKEN
SCRIPT
}

status_script="set -u
systemctl --no-pager --plain list-units 'actions.runner.*'
for f in /home/${RUNNER_USER}/actions-runner-*/.runner; do [[ -f \$f ]] && jq -c '{agentName, gitHubUrl}' \$f; done
free -h"

remove_script() {
  local n="$1"
  cat <<SCRIPT
set -euo pipefail
dir=/home/${RUNNER_USER}/actions-runner-${n}
[[ -d \$dir ]] || { echo "no \$dir"; exit 0; }
cd \$dir
./svc.sh stop >/dev/null 2>&1 || true; ./svc.sh uninstall >/dev/null 2>&1 || true
sudo -u ${RUNNER_USER} ./config.sh remove --token "\$RUNNER_REMOVE_TOKEN" >/dev/null
unset RUNNER_REMOVE_TOKEN
cd / && rm -rf \$dir
echo "Removed autofix-build-vm-${n}."
SCRIPT
}

registration_token() { gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token; }
removal_token() { gh api -X POST "repos/${REPO}/actions/runners/remove-token" --jq .token; }

step="${1:-all}"
case "$step" in
  inspect) run_remote inspect "$inspect_script" ;;
  docker) run_remote "rootless docker" "$(docker_script)" ;;
  playwright-deps) run_remote "playwright deps" "$playwright_script" ;;
  runners) token="$(registration_token)"; run_remote runners "$(runners_script)" "export RUNNER_TOKEN='${token}'; "; unset token ;;
  status) run_remote status "$status_script" ;;
  remove) token="$(removal_token)"; run_remote "remove ${2:?runner number}" "$(remove_script "$2")" "export RUNNER_REMOVE_TOKEN='${token}'; "; unset token ;;
  all) "$0" docker && "$0" playwright-deps && "$0" runners && "$0" status ;;
  *) echo "usage: $0 inspect|docker|playwright-deps|runners|status|remove N|all" >&2; exit 2 ;;
esac
