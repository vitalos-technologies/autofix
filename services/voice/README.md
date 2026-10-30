# autofix-voice

The AI front desk on calls (DECISIONS D20, [docs/autofix/voice-desk.md](../../docs/autofix/voice-desk.md)). A small Node 22 service: Twilio ConversationRelay connects a missed call's audio-as-text to `wss://<host>/relay`; the desk answers with Claude and books through Pitline's agent tool API with a per-call token. The design comes from Answerd's desk (vitalos-technologies/workforce).

```bash
pnpm install
pnpm verify        # typecheck, tests, build
pnpm build && VOICE_RELAY_SECRET=… ANTHROPIC_API_KEY=… AUTOFIX_BASE_URL=http://localhost:3000 pnpm start
```

| Env | |
| --- | --- |
| `VOICE_RELAY_SECRET` | 32+ characters, the same value as the Pitline app's. Checks the relay claim; the key for `/api/voice/v1/session` |
| `ANTHROPIC_API_KEY` | Claude. Without it `/readyz` is 503 and calls are refused (Twilio then falls back to the voicemail) |
| `AUTOFIX_BASE_URL` | default `https://pitline.co.uk` |
| `VOICE_CLAUDE_MODEL` | default `claude-haiku-5-5` |
| `TWILIO_AUTH_TOKEN`, `PUBLIC_RELAY_URL` | optional: also check `X-Twilio-Signature` on the upgrade, against `PUBLIC_RELAY_URL` + query |
| `VOICE_MAX_CALL_SECONDS` | default 600 |
| `PORT` | default 8080 |

Endpoints: `GET /healthz` (always 200; the voice webhook calls it to wake the container), `GET /readyz`, `GET /relay` (WebSocket).

Logs are JSON lines with ids, tool names, outcomes and timings only: never a number, registration, transcript, token or key.

## Deploy

Actions > **Voice desk deploy**: `CHECK` lists which secrets are set; `DEPLOY` verifies, builds `ghcr.io/vitalos-technologies/autofix-voice`, deploys the Container App `autofix-voice` to `cae-autofix-superadmin` (`deploy/azure/deploy.sh`; `--dry-run` prints the plan), health-checks it, and, once it has a Claude key, sets `VOICE_RELAY_URL` and `VOICE_RELAY_SECRET` in Vercel (Production) and redeploys. Secrets: the super admin's `AZURE_*`, `GHCR_PULL_TOKEN`, `VERCEL_API_TOKEN`, plus `ANTHROPIC_API_KEY` and optionally `TWILIO_AUTH_TOKEN`. Scale to zero by default (£0 at rest); `min_replicas=1` keeps one warm (about £10/month, Temitope's call).
