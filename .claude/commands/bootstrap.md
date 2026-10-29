---
description: One-time setup. Brings the SOB Autofix code and history into this repo, overlays the Pitline files, runs the baseline and pushes.
argument-hint: "[path-or-url-to-sobautofix] (default ../sobautofix if it exists, else https://github.com/Isaacpyo/sobautofix.git)"
---

Set up the Pitline repository. Works in a Claude Code cloud session on `vitalos-technologies/pitline` (the usual case) or in a local folder. Do every step, check each one, and stop with a clear message if a check fails. Never modify the SOB repo.

1. **Pre-checks**
   - `src/` must NOT exist yet. If it does, bootstrap already ran: stop and run `/status`.
   - `.claude/agents`, `.claude/commands`, `docs/autofix/`, `design/` and `.autofix/` must exist. Local folder only: if `.claude/` is missing but `claude-setup/` exists, copy `claude-setup/*` into `.claude/` first.
   - `git --version` must work. Note whether `node -v` (22.x) and `pnpm -v` (10.x) are available; if not, step 5 is skipped.

2. **Source of the fork**: `$ARGUMENTS` if given; else `../sobautofix` if that folder exists; else `https://github.com/Isaacpyo/sobautofix.git`. In a cloud session the Claude GitHub App must be installed on `Isaacpyo/sobautofix` for the fetch to work; if the fetch is refused, stop and tell Temitope to add that repo to the app.
   ```bash
   git remote add sob <source>   # skip if it exists
   git fetch sob main
   ```

3. **Combine histories**
   - If this repo already has commits (it does on GitHub: the Pitline kit was uploaded first):
     `git merge sob/main --allow-unrelated-histories --no-edit -m "chore: import SOB Autofix as the base of Pitline"`
     Expected conflicts: `README.md` (both sides have one). Resolve it with `git checkout --ours README.md` (step 4 replaces it with `.autofix/README.md` anyway), `git add README.md`, then `git commit --no-edit`. For any other conflict, list the files and stop.
   - If this is a fresh local folder with no commits: `git init -b main` (if needed) then `git checkout -B main sob/main` (untracked kit files are kept).

4. **Overlay Pitline files**
   - Copy `.autofix/CLAUDE.md` → `CLAUDE.md`, `.autofix/AGENTS.md` → `AGENTS.md`, `.autofix/README.md` → `README.md` (replacing SOB's).
   - Append `.autofix/env.autofix.example` to `.env.example`.
   - In `package.json` set `"name": "autofix"` and add `"db:seed": "node scripts/seed-demo.mjs"` if missing (implemented in P1.9).
   - Keep the `sob` remote for cherry-picking upstream fixes. Never push to it.

5. **Baseline** (skip if Node/pnpm are missing and note "baseline deferred" under P0.4)
   - `pnpm install`
   - `pnpm verify` on the untouched fork. Record pass/fail per step under P0.4 in `docs/autofix/BUILD-PLAN.md`. A failing SOB baseline is recorded, not fixed, here.

6. **Commit**
   ```bash
   git add -A
   git commit -m "chore: start Pitline from SOB Autofix" -m "Overlays Pitline CLAUDE.md, AGENTS.md, README and env on the SOB Autofix codebase." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
   ```
   Check that `.env.local` and other secrets are not staged.

7. **Push to `https://github.com/vitalos-technologies/pitline`**
   - Cloud session: push `main` (or, if direct pushes to `main` are refused, push branch `phase-0/bootstrap` and open a PR titled "Start Pitline from SOB Autofix").
   - Local folder: `git remote add origin https://github.com/vitalos-technologies/pitline.git` if missing, `git fetch origin`, `git merge origin/main --allow-unrelated-histories --no-edit` (the web-uploaded kit), then `git push -u origin main`.
   - After the first push: protect `main` (require PR + passing CI), matching `vitalos-technologies/workforce`.

8. Tick P0.1 to P0.5 in `docs/autofix/BUILD-PLAN.md`, commit, push, and report Done / Needs approval / Blockers. Suggest `/build` (all phases) or `/phase 1`.
