#!/usr/bin/env bash
# Rootless Docker for a CI runner user on the AWS build VM (default `ghrunner-autofix`). Runbook: infrastructure/RUNNER.md.
# Run as root BEFORE setup-runner.sh. The runner user never joins the `docker` group (that socket is root-equivalent):
# it gets its own daemon, started by its systemd user instance, which linger keeps running from boot.
#
# - Packages: uidmap, dbus-user-session, slirp4netns, and the rootless extras for whichever engine is installed
#   (docker-ce-rootless-extras from Docker's apt repo, or rootlesskit next to Ubuntu's docker.io). If no engine is
#   installed, Docker's apt repo is added and only the CLI + rootless extras are installed; the system daemon that comes
#   with docker-ce is masked, so nothing root-level starts.
# - Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor: a profile for rootlesskit allows them for it.
# - subordinate uid/gid ranges for the user, systemd linger, then `dockerd-rootless-setuptool.sh install` as the user.
# - With --prove, runs `supabase start` / `supabase stop` (CLI v2.113.0, checksum-checked) as the user.
set -euo pipefail

RUNNER_USER="${RUNNER_USER:-ghrunner-autofix}"
SUPABASE_CLI_VERSION="2.113.0"
SUPABASE_CLI_SHA256="14659e7148ad17b77e69e5c36b27be572110519c76c796da1b53c07c3590f593"   # supabase_linux_amd64.tar.gz, from the release checksums.txt
PROVE=0
[[ "${1:-}" == "--prove" ]] && PROVE=1

die() { echo "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Run as root."
[[ "$RUNNER_USER" != "ghrunner" ]] || die "Refusing to touch ghrunner (workforce's runner user)."
id "$RUNNER_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --comment "GitHub Actions runner for autofix CI (no sudo, rootless Docker only)" "$RUNNER_USER"
id -nG "$RUNNER_USER" | tr ' ' '\n' | grep -qx docker && gpasswd -d "$RUNNER_USER" docker
uid="$(id -u "$RUNNER_USER")"
home="$(getent passwd "$RUNNER_USER" | cut -d: -f6)"
export DEBIAN_FRONTEND=noninteractive

echo "== Packages"
apt_install() { apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }
apt-get update -qq
apt_install uidmap dbus-user-session slirp4netns ca-certificates curl
if dpkg -s docker-ce >/dev/null 2>&1 || dpkg -s docker-ce-cli >/dev/null 2>&1; then
  apt_install docker-ce-rootless-extras
elif dpkg -s docker.io >/dev/null 2>&1; then
  apt_install rootlesskit
else
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  # docker-ce provides dockerd for the rootless daemon; its root service is masked so no root daemon runs.
  systemctl mask docker.service docker.socket containerd.service >/dev/null 2>&1 || true
  apt_install docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras
  systemctl disable --now docker.service docker.socket containerd.service >/dev/null 2>&1 || true
fi

setuptool="$(command -v dockerd-rootless-setuptool.sh || true)"
[[ -n "$setuptool" ]] || setuptool="$(ls /usr/share/docker.io/contrib/dockerd-rootless-setuptool.sh 2>/dev/null || true)"
[[ -n "$setuptool" ]] || die "dockerd-rootless-setuptool.sh not found after installing packages."
rootlesskit_bin="$(command -v rootlesskit || true)"
[[ -n "$rootlesskit_bin" ]] || die "rootlesskit not found."

echo "== AppArmor: allow user namespaces for ${rootlesskit_bin}"
if [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == "1" ]]; then
  profile="/etc/apparmor.d/$(echo "${rootlesskit_bin#/}" | tr / .)"
  cat > "$profile" <<APPARMOR
# Written by autofix infrastructure/runner/setup-rootless-docker.sh: rootless Docker needs user namespaces.
abi <abi/4.0>,
include <tunables/global>

"${rootlesskit_bin}" flags=(unconfined) {
  userns,

  include if exists <local/$(basename "$profile")>
}
APPARMOR
  apparmor_parser -r "$profile"
fi

echo "== Subordinate ids for ${RUNNER_USER}"
next_range_start() {
  local max=100000
  for f in /etc/subuid /etc/subgid; do
    while IFS=: read -r _ start count; do
      [[ -n "$start" ]] && (( start + count > max )) && max=$(( start + count ))
    done < "$f"
  done
  echo "$max"
}
if ! grep -q "^${RUNNER_USER}:" /etc/subuid || ! grep -q "^${RUNNER_USER}:" /etc/subgid; then
  start="$(next_range_start)"
  usermod --add-subuids "${start}-$(( start + 65535 ))" --add-subgids "${start}-$(( start + 65535 ))" "$RUNNER_USER"
fi

echo "== systemd linger (user instance runs from boot, no login needed)"
loginctl enable-linger "$RUNNER_USER"
for _ in $(seq 1 30); do [[ -S "/run/user/${uid}/bus" ]] && break; sleep 1; done
[[ -S "/run/user/${uid}/bus" ]] || die "The user systemd instance for ${RUNNER_USER} did not start (/run/user/${uid}/bus missing)."

as_user() {
  sudo -u "$RUNNER_USER" -H env XDG_RUNTIME_DIR="/run/user/${uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
    PATH="${home}/bin:/usr/local/bin:/usr/bin:/bin" DOCKER_HOST="unix:///run/user/${uid}/docker.sock" "$@"
}

echo "== Rootless daemon for ${RUNNER_USER}"
# Published container ports bind to 127.0.0.1 unless a job asks otherwise: Supabase publishes 54321-54324 on 0.0.0.0,
# which tailnet peers could reach.
daemon_json="${home}/.config/docker/daemon.json"
if ! sudo -u "$RUNNER_USER" test -f "$daemon_json" || ! grep -q '"ip"' "$daemon_json"; then
  sudo -u "$RUNNER_USER" mkdir -p "$(dirname "$daemon_json")"
  if sudo -u "$RUNNER_USER" test -s "$daemon_json"; then
    python3 - "$daemon_json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["ip"] = "127.0.0.1"
json.dump(data, open(path, "w"), indent=2)
PY
  else
    echo '{ "ip": "127.0.0.1" }' | sudo -u "$RUNNER_USER" tee "$daemon_json" >/dev/null
  fi
  daemon_config_changed=1
fi
if [[ ! -f "${home}/.config/systemd/user/docker.service" ]]; then
  as_user bash -c "cd ~ && '${setuptool}' install --force" >/dev/null
fi
as_user systemctl --user daemon-reload
as_user systemctl --user enable --now docker.service >/dev/null 2>&1
[[ "${daemon_config_changed:-0}" == "1" ]] && as_user systemctl --user restart docker.service
for _ in $(seq 1 30); do as_user docker info >/dev/null 2>&1 && break; sleep 1; done
as_user docker info --format 'rootless daemon {{.ServerVersion}}, security: {{.SecurityOptions}}, storage: {{.Driver}}'

if [[ $PROVE -eq 1 ]]; then
  echo "== Proof: supabase start / stop as ${RUNNER_USER}"
  work="$(as_user mktemp -d)"
  as_user curl -fsSL -o "${work}/supabase.tgz" "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_linux_amd64.tar.gz"
  echo "${SUPABASE_CLI_SHA256}  ${work}/supabase.tgz" | sha256sum -c -
  # The CLI goes in cli/ because `supabase init` creates a supabase/ folder next to it.
  as_user mkdir -p "${work}/cli"
  as_user tar -xzf "${work}/supabase.tgz" -C "${work}/cli" supabase
  as_user bash -c "cd '${work}' && ./cli/supabase init --force >/dev/null 2>&1 && sed -i 's/^project_id = .*/project_id = \"autofix-rootless-proof\"/' supabase/config.toml"
  as_user bash -c "cd '${work}' && ./cli/supabase start -x studio,imgproxy,vector,logflare,edge-runtime,supavisor,realtime,postgres-meta" | grep -E "API URL|DB URL|Started|started" || true
  as_user bash -c "cd '${work}' && ./cli/supabase status -o env" | grep -E '^(API_URL|DB_URL)=' || die "supabase start did not come up."
  as_user docker ps --format '{{.Names}} {{.Ports}}'
  as_user bash -c "cd '${work}' && ./cli/supabase stop --no-backup"
  as_user rm -rf "$work"
  echo "Proof OK."
fi
