# Autofix — start here

This folder is the Claude Code setup for Autofix, Vitalos's multi-tenant garage booking platform. It holds the spec, build plan, design system and agent setup. The app code comes from SOB Autofix when you run `/bootstrap`. Repo: https://github.com/vitalos-technologies/autofix

## Steps

**In Claude Code cloud (recommended)**

1. Install the Claude GitHub App on `vitalos-technologies/autofix` and `Isaacpyo/sobautofix` (github.com/apps/claude → Configure).
2. In the Claude desktop app's Code tab, choose a **Cloud** environment and the `vitalos-technologies/autofix` repo.
3. Run `/bootstrap`. It brings in SOB's code and history, overlays the Autofix files, runs the baseline and pushes.
4. Run `/build` to run Phases 1–4 back to back without stopping (or `/phase <n>` for one phase at a time). Use `/status` any time.

**In a local folder**

Open the folder in Claude Code (Local), say "Read START-HERE.md and do the one-time setup". Claude copies `claude-setup/` into `.claude/` (remote tools can't write `.claude/`) and runs the same bootstrap.

## What's inside

| Path | What |
| --- | --- |
| `docs/autofix/SPEC.md` | Backend engine spec |
| `docs/autofix/BUILD-PLAN.md` | 4 phases, tasks by lane, gates |
| `docs/autofix/DECISIONS.md` | Decisions, assumptions, what's waiting on you |
| `docs/autofix/INFRA.md` | DNS (live), Vercel, Supabase, env vars |
| `design/DESIGN.md` | Design system and screen-to-route map |
| `design/screenshots/` | The 9 designed screens as PNGs |
| `design/preview/` | The same screens as HTML you can open in a browser |
| `design/screens/` | Source markup from the design canvas |
| `claude-setup/agents/` | 5 lane subagents: data, api, ui, integrations, qa (copied to `.claude/agents/`) |
| `claude-setup/commands/` | `/bootstrap`, `/phase`, `/gate`, `/status` (copied to `.claude/commands/`) |
| `claude-setup/settings.json` | Permission allow/deny list (copied to `.claude/settings.json`) |
| `.autofix/` | CLAUDE.md, AGENTS.md, README.md, env additions; copied to the root by `/bootstrap` |

Live versions: design canvas https://claude.ai/artifact/UYRN7ayr8LpWS5U59221mP · spec doc https://claude.ai/artifact/VyDyF3gpqZk5CdeFBMCDjA
