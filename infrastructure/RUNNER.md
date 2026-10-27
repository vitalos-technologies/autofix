# Self-hosted GitHub Actions runners (AWS build VM)

**Why:** GitHub-hosted runners for `vitalos-technologies` are blocked by org billing: every hosted job failed in about two
seconds with "The job was not started because recent account payments have failed or your spending limit needs to be
increased". Autofix CI runs on the Vitalos build VM instead, next to workforce's runners. Self-hosted minutes are free.
Billing itself is handled separately; switching back is one repository variable (below).

## What runs where

| What | Where |
| --- | --- |
| Machine | EC2 `vitalos-workforce-build` (`i-0acc8453065a3eb23`), eu-west-2, `t3a.xlarge` (4 vCPU, 16 GiB), Ubuntu 24.04, reached by SSM only |
| Running hours | 06:00–23:59 Europe/London. Jobs queued overnight wait for the morning start; a job still running at 23:59 is killed by the stop |
| Runners | `autofix-build-vm-1`, `autofix-build-vm-2`: repo-level on `vitalos-technologies/autofix`, labels `self-hosted, linux, x64, autofix`, `actions/runner` v2.338.0 (SHA-256 checked) in `/home/ghrunner-autofix/actions-runner-N` |
| User | `ghrunner-autofix`: non-root, no sudo, not in the `docker` group, home `0750`, cannot read `/srv/workforce/secrets`. Separate from workforce's `ghrunner`, which these scripts refuse to touch |
| Services | systemd `actions.runner.vitalos-technologies-autofix.autofix-build-vm-N.service`, enabled at boot, with a drop-in (`rootless-docker.conf`) that sets `DOCKER_HOST`/`XDG_RUNTIME_DIR` and orders it after the user's systemd instance |
| Docker | rootless: the user's own daemon (`~/.config/systemd/user/docker.service`), started from boot by systemd linger. Socket `/run/user/<uid>/docker.sock`. Used by `supabase start` in `database-tests` |
| Browsers | Chromium's system libraries installed once as root (`playwright install-deps chromium`); jobs run `playwright install chromium` without `--with-deps` into `~/.cache/ms-playwright`. Lighthouse uses that Chromium through `CHROME_PATH` |
| Workflows | every job: `runs-on: ${{ fromJSON(vars.RUNS_ON \|\| '["self-hosted","autofix"]') }}`, workflow `concurrency` per ref with cancel-in-progress |

Workforce's five runners (`workforce-build-vm`, `-2` … `-5`, user `ghrunner`) share the machine and are managed from the
workforce repo (`infrastructure/RUNNER.md` there).

## Sharing one machine

- **Ports:** two autofix jobs can run at once, plus workforce's. Each job that serves the app uses its own port:
  browser tests `3410`, Lighthouse `3420`, the database job's smoke test `3430` and invoice PDF test `3100`. Never use
  `3000` in CI.
- **Supabase:** `supabase start` uses fixed ports (`54321`–`54324`) and container names, so `database-tests` is
  serialised across all branches with `concurrency: autofix-supabase-vm` (queued, never cancelled), and always ends with
  `supabase stop --no-backup`. It starts only the services the tests use (`-x studio,imgproxy,vector,logflare,…`):
  vector/logflare would mount the Docker socket.
- **Disk:** both runners share one pnpm store (`~/.local/share/pnpm/store`) and one Playwright browser cache. Checkouts
  live in each runner's `_work`; delete `_work/autofix` when idle if the disk fills. Rootless images are in
  `~/.local/share/docker`; `docker system prune -af` as the user frees them.
- **Memory:** see **Capacity** below. If available memory drops under about 3 GB during runs, go down to one runner
  (`provision-vm.sh remove 2`).

## Set it up / change it

From any machine with AWS credentials for SSM on the VM (`AWS_PROFILE=workforce` after `aws sso login --profile workforce`)
and an admin `gh` login, while the VM is running:

```bash
infrastructure/runner/provision-vm.sh inspect          # read-only look at the VM
infrastructure/runner/provision-vm.sh all              # rootless Docker (+ supabase proof), Chromium deps, 2 runners, status
infrastructure/runner/provision-vm.sh status
RUNNERS=1 infrastructure/runner/provision-vm.sh runners   # e.g. only one runner
infrastructure/runner/provision-vm.sh remove 2         # stop + unregister + delete autofix-build-vm-2
```

`provision-vm.sh` sends `setup-rootless-docker.sh` and `setup-runner.sh` base64-embedded in an SSM `AWS-RunShellScript`
command (the VM's checkouts can't authenticate to GitHub non-interactively) and polls `get-command-invocation`. The
registration token comes from `gh api -X POST repos/vitalos-technologies/autofix/actions/runners/registration-token`; it
is never printed or written to disk and only reaches the VM inside the command as `RUNNER_TOKEN` (it expires in an hour).
Both setup scripts are idempotent and can also be run by hand as root on the VM.

## What changed on the VM (for VM_OPERATIONS.md)

| Change | Detail |
| --- | --- |
| User | `ghrunner-autofix` (uid 1004), home `/home/ghrunner-autofix` `0750`, subordinate uid/gid range of 65 536 in `/etc/subuid`/`/etc/subgid`, systemd linger on |
| Runners | `/home/ghrunner-autofix/actions-runner-1`, `-2`; services `actions.runner.vitalos-technologies-autofix.autofix-build-vm-{1,2}.service` (enabled) + drop-ins in `/etc/systemd/system/<service>.d/rootless-docker.conf` |
| Rootless Docker | Docker 29.9.2, user unit `docker.service` for `ghrunner-autofix` (enabled, linger on), data in `~/.local/share/docker`; `~/.config/docker/daemon.json` sets `"ip": "127.0.0.1"` so published ports (Supabase 54321–54324) bind to loopback only |
| Packages | `uidmap`, `dbus-user-session`, `slirp4netns`, and the rootless extras for the installed engine (`docker-ce-rootless-extras` or `rootlesskit`); Chromium runtime libraries from `playwright install-deps chromium` (Playwright 1.62.1) |
| AppArmor | profile for the `rootlesskit` binary allowing user namespaces (Ubuntu 24.04 restricts them by default) |
| needrestart | `/etc/needrestart/conf.d/vitalos-technologies-autofix-runner.conf`: unattended upgrades never restart the autofix runner services |

Provisioned 26 Oct 2026 by Temitope with `provision-vm.sh` (the `--prove` run of `supabase start`/`stop` as `ghrunner-autofix`
passed; the Supabase images are cached in that user's Docker). The loopback binding in `daemon.json` was added afterwards:
re-run `provision-vm.sh docker` once to apply it (idempotent; it only writes the file and restarts the user's daemon).

## Day to day

```bash
systemctl --no-pager list-units 'actions.runner.vitalos-technologies-autofix.*'
journalctl -u actions.runner.vitalos-technologies-autofix.autofix-build-vm-1 -f
sudo -u ghrunner-autofix XDG_RUNTIME_DIR=/run/user/$(id -u ghrunner-autofix) systemctl --user status docker
gh api repos/vitalos-technologies/autofix/actions/runners --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
```

## Security rules

- The repo stays **private**. Every job refuses pull requests from forks
  (`github.event.pull_request.head.repo.full_name == github.repository`); never add `pull_request_target`, and never make
  the repo public while these runners are attached.
- `ghrunner-autofix` never joins `docker` or `sudo`; containers go through its rootless daemon only. It can't read
  `/srv/workforce/secrets` or workforce's runner folders.
- Jobs see Actions secrets as usual. Temporary files go to `$RUNNER_TEMP`.

## Switch back to GitHub-hosted runners

Set the repository variable `RUNS_ON` to `"ubuntu-24.04"` (with the quotes: it's read as JSON) under Settings → Secrets
and variables → Actions → Variables. Hosted jobs need `--with-deps` for Playwright again and Actions minutes or a spending
limit above $0. Delete the variable to return to the VM.

## Capacity

Measured on first rollout: see the build log in `docs/autofix/BUILD-PLAN.md` (memory before, peak during a
`database-tests` run, and the runner count chosen).
