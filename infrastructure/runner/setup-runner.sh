#!/usr/bin/env bash
# Install a GitHub Actions self-hosted runner for vitalos-technologies/pitline on the AWS build VM.
# Runbook: infrastructure/RUNNER.md. Run as root on vitalos-workforce-build (SSM send-command or an SSM session).
#
# Adapted from workforce's infrastructure/runner/setup-runner.sh (branch ops/runner-capacity). Differences:
# - Repo URL, user, name pattern and labels are parameters (defaults are autofix's), so the workforce runners and their
#   user `ghrunner` are never touched: this script refuses to manage `ghrunner` or a folder registered to another repo.
# - The runner user gets rootless Docker (setup-rootless-docker.sh, run first) and the service gets DOCKER_HOST and
#   XDG_RUNTIME_DIR through a systemd drop-in, so `supabase start` works without the root-equivalent docker group.
#
# - Runs as its own non-root user (default `ghrunner-autofix`): no sudo, not in the docker group, cannot read
#   /srv/workforce/secrets.
# - Downloads actions/runner v2.338.0 linux-x64 and checks its SHA-256 against the release notes.
# - Registers a repo-level runner (default autofix-build-vm-1) and installs it as a systemd service that starts at boot
#   (the VM is stopped 23:59-06:00 London).
# - The registration token comes from RUNNER_TOKEN (or hidden terminal input). It is never echoed or written to disk.
#
# Re-running is safe: an already-registered runner is left as is unless --reconfigure is given.
#   RUNNER_NAME=autofix-build-vm-2 RUNNER_DIR=/home/ghrunner-autofix/actions-runner-2 bash setup-runner.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/vitalos-technologies/pitline}"
RUNNER_USER="${RUNNER_USER:-ghrunner-autofix}"
RUNNER_NAME_PREFIX="${RUNNER_NAME_PREFIX:-autofix-build-vm}"
RUNNER_NAME="${RUNNER_NAME:-${RUNNER_NAME_PREFIX}-1}"
RUNNER_DIR="${RUNNER_DIR:-/home/${RUNNER_USER}/actions-runner-1}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,x64,autofix}"
RUNNER_VERSION="2.338.0"
RUNNER_SHA256="af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32"   # linux-x64, from the v2.338.0 release notes
RECONFIGURE=0
[[ "${1:-}" == "--reconfigure" ]] && RECONFIGURE=1

die() { echo "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Run as root: sudo -i, then bash $0"
[[ "$(uname -m)" == "x86_64" ]] || die "This script installs the x64 runner; this machine is $(uname -m)."
[[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "REPO_URL must be https://github.com/<owner>/<repo>"
[[ "$RUNNER_USER" =~ ^[a-z][a-z0-9-]{2,31}$ ]] || die "RUNNER_USER must be a plain lower-case user name"
# workforce's runners belong to `ghrunner`; this script must never reconfigure them.
[[ "$RUNNER_USER" != "ghrunner" || "$REPO_URL" == "https://github.com/vitalos-technologies/workforce" ]] || die "Refusing to manage user ghrunner (workforce's runners)."
[[ "$RUNNER_NAME" =~ ^${RUNNER_NAME_PREFIX}(-[0-9]+)?$ ]] || die "RUNNER_NAME must be ${RUNNER_NAME_PREFIX}[-N]"
[[ "$RUNNER_DIR" == "/home/${RUNNER_USER}/actions-runner"* ]] || die "RUNNER_DIR must be under /home/${RUNNER_USER}/actions-runner"

echo "== Packages (curl, jq, git, tar; fills gaps only)"
missing=()
for c in curl jq git tar; do command -v "$c" >/dev/null || missing+=("$c"); done
if ((${#missing[@]})); then apt-get update -qq && apt-get install -y -qq "${missing[@]}"; fi

echo "== Runner user ${RUNNER_USER} (non-root, no sudo, not in docker)"
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --comment "GitHub Actions runner for $(basename "$REPO_URL") CI (no sudo, rootless Docker only)" "$RUNNER_USER"
fi
if id -nG "$RUNNER_USER" | tr ' ' '\n' | grep -qxE 'docker|sudo|admin|wheel'; then
  for group in docker sudo admin wheel; do id -nG "$RUNNER_USER" | tr ' ' '\n' | grep -qx "$group" && gpasswd -d "$RUNNER_USER" "$group"; done
  echo "Removed ${RUNNER_USER} from privileged groups (the Docker socket and sudo are root-equivalent)."
fi
if [[ -e "/etc/sudoers.d/${RUNNER_USER}" ]] || sudo -l -U "$RUNNER_USER" 2>/dev/null | grep -q '(ALL'; then
  die "${RUNNER_USER} has sudo rights; remove them before going on."
fi
if [[ -e /srv/workforce/secrets ]] && sudo -u "$RUNNER_USER" test -r /srv/workforce/secrets 2>/dev/null; then
  die "${RUNNER_USER} can read /srv/workforce/secrets. It should be 0700 and owned by the agents' user; fix that before going on."
fi
chmod 0750 "/home/${RUNNER_USER}"

echo "== Runner ${RUNNER_VERSION} in ${RUNNER_DIR}"
if [[ -f "${RUNNER_DIR}/.runner" ]]; then
  registered_url="$(jq -r '.gitHubUrl // empty' "${RUNNER_DIR}/.runner")"
  [[ -z "$registered_url" || "$registered_url" == "$REPO_URL" ]] || die "${RUNNER_DIR} is registered to ${registered_url}, not ${REPO_URL}."
fi
install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0750 "$RUNNER_DIR"
if [[ ! -x "${RUNNER_DIR}/config.sh" ]]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/runner.tgz" "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
  echo "${RUNNER_SHA256}  ${tmp}/runner.tgz" | sha256sum -c -
  tar -xzf "${tmp}/runner.tgz" -C "$RUNNER_DIR"
  chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"
  rm -rf "$tmp"
fi
"${RUNNER_DIR}/bin/installdependencies.sh" >/dev/null

if [[ -f "${RUNNER_DIR}/.runner" && $RECONFIGURE -eq 0 ]]; then
  echo "== Already registered ($(jq -r .agentName "${RUNNER_DIR}/.runner")). Use --reconfigure to register again."
else
  if [[ -z "${RUNNER_TOKEN:-}" ]]; then
    echo "Registration token (GitHub: $(basename "$REPO_URL") → Settings → Actions → Runners → New self-hosted runner). Input is hidden."
    read -rs RUNNER_TOKEN; echo
  fi
  RUNNER_TOKEN="${RUNNER_TOKEN//[$'\r\n\t ']/}"
  [[ -n "$RUNNER_TOKEN" ]] || die "No token given."
  if [[ -f "${RUNNER_DIR}/.runner" ]]; then
    (cd "$RUNNER_DIR" && ./svc.sh stop >/dev/null 2>&1 || true; ./svc.sh uninstall >/dev/null 2>&1 || true)
  fi
  sudo -u "$RUNNER_USER" env -C "$RUNNER_DIR" ./config.sh --unattended --replace \
    --url "$REPO_URL" --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work >/dev/null
  unset RUNNER_TOKEN
  echo "Registered ${RUNNER_NAME}."
fi

echo "== systemd service"
(cd "$RUNNER_DIR" && { [[ -f .service ]] || ./svc.sh install "$RUNNER_USER" >/dev/null; })
svc="$(cat "${RUNNER_DIR}/.service")"

# Rootless Docker for the runner user (setup-rootless-docker.sh): jobs talk to the user's own daemon.
uid="$(id -u "$RUNNER_USER")"
if [[ -S "/run/user/${uid}/docker.sock" ]] || sudo -u "$RUNNER_USER" test -f "/home/${RUNNER_USER}/.config/systemd/user/docker.service"; then
  install -d "/etc/systemd/system/${svc}.d"
  cat > "/etc/systemd/system/${svc}.d/rootless-docker.conf" <<UNIT
[Unit]
# The runner user's systemd instance (kept alive by linger) runs the rootless Docker daemon.
Wants=user@${uid}.service
After=user@${uid}.service

[Service]
Environment=XDG_RUNTIME_DIR=/run/user/${uid}
Environment=DOCKER_HOST=unix:///run/user/${uid}/docker.sock
UNIT
  systemctl daemon-reload
fi
systemctl enable "$svc" >/dev/null 2>&1
systemctl restart "$svc"

# Unattended upgrades must not restart runner services mid-job (a restart kills the running CI job).
if [[ -d /etc/needrestart ]]; then
  install -d /etc/needrestart/conf.d
  repo_slug="$(basename "$(dirname "$REPO_URL")")-$(basename "$REPO_URL")"
  # shellcheck disable=SC2016  # a literal Perl line for needrestart
  printf '$nrconf{override_rc}{qr(^actions\\.runner\\.%s\\.)} = 0;\n' "${repo_slug//./\\.}" > "/etc/needrestart/conf.d/${repo_slug}-runner.conf"
fi

echo
echo "Done. Service: ${svc}"
systemctl --no-pager --lines=0 status "$svc" || true
