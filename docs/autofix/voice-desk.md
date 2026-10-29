# AI front desk on calls (voice desk, D20)

Pro garages with the AI front desk switched on have their missed calls answered by Autofix's own voice service. Decisions and assumptions: DECISIONS D20, AV1–AV10.

## Call flow

```
caller ─► Twilio number ─► POST /api/webhooks/twilio/voice (Autofix, Vercel)
                              │ garage phone rings first (if it has one); missed, or no phone:
                              │ ai_front_desk_voice_ready(garage, PLAN_PRO_AI_MINUTES)?
                              │   no  ─► voicemail + text-back (Essentials flow)
                              │   yes ─► <Say>disclosure</Say>
                              │          <Connect action=…?step=relay><ConversationRelay url=wss://…/relay?g&c&e&s/>
                              │          after the response: GET https://…/healthz (wakes the service)
                              ▼
            Twilio ConversationRelay ─wss─► autofix-voice (/relay, services/voice, Azure Container Apps)
                                              │ checks the claim (HMAC, 5 min) [+ X-Twilio-Signature]
                                              │ POST /api/voice/v1/session ─► per-call agent token (30 min, one per call)
                                              │ garage_profile, list_services ─► instructions
                                              │ Claude (claude-haiku-5-5, streamed) ⇄ tools:
                                              │   available_slots, lookup_vehicle, create_booking (requested),
                                              │   get_booking, end_call  ─► POST /api/agent/v1/*
                                              │ on hang-up: report_usage (minutes), log_call_summary
                              ◄─ `end` {to: hangup | voicemail}
            POST …/voice?step=relay: failed ─► voicemail + text-back; {to: voicemail} ─► voicemail; else hang up
```

## Where things are

| What | Where |
| --- | --- |
| Webhook hook, fallbacks | `src/lib/messaging/twilio-webhooks.ts` (`relayConnect`, `relayFinished`), `src/lib/calls/twiml.ts` (`aiDeskTwiml`, `aiDisclosure`) |
| Relay claim, env | `src/lib/ai-front-desk/voice-relay.ts` (`VOICE_RELAY_URL`, `VOICE_RELAY_SECRET`) |
| Token exchange | `src/app/api/voice/v1/session/route.ts`, `src/lib/ai-front-desk/voice-session.ts`, `issueVoiceCallToken()` in `src/lib/agent-api/store.ts` |
| Summary tool | `log_call_summary` in `src/lib/agent-api/{schemas,handler}.ts`, `docs/autofix/agent-api.yaml` |
| Database | `supabase/migrations/20261029002000_ai_voice_desk.sql`, pgTAP `039_ai_voice_desk.test.sql` |
| Staff view | missed-call card (`src/components/admin-ui/missed-call-card.tsx`), Settings · AI front desk (status, Your AI desk number with divert codes, test-call guide, minutes) |
| The garage's number (D22) | `src/lib/phone-numbers/*`, job `numbers.provision` (`src/lib/jobs/handlers/numbers-provision.ts`), Twilio adapter `src/lib/messaging/twilio-numbers.ts`, migration `20261029003400_twilio_numbers.sql`, pgTAP `043_twilio_numbers.test.sql` |
| Voice service | `services/voice/` (README there), deploy `services/voice/deploy/azure/deploy.sh`, `.github/workflows/voice-deploy.yml` |

## Switching it on in production

1. Repository secret `ANTHROPIC_API_KEY` (Temitope; spend approval). Optional: `TWILIO_AUTH_TOKEN`.
2. Actions > Voice desk deploy > `DEPLOY`. It deploys `autofix-voice`, then sets `VOICE_RELAY_URL` and `VOICE_RELAY_SECRET` in Vercel (Production) and redeploys.
3. A Twilio number with voice for the garage. Automatic since D22 (DECISIONS A431–A437): once the Twilio account is upgraded and a GB local business bundle is approved, the `numbers.provision` job buys the garage a UK local number (in its area code when Twilio has one), points its voice webhook at `/api/webhooks/twilio/voice` and adds the `garage_phone_numbers` row with `provider_sid` and `ring_garage_first = false`, up to `TWILIO_NUMBER_CAP` numbers on the account. Settings, AI front desk shows where it stands ("Your AI desk number").
4. The garage owner switches the AI front desk on in Settings (which queues step 3 at once), sets the garage's own phone to divert missed calls to the new number (the codes are on the page), then follows the test-call guide there. That number never rings the garage's own phone first, so the divert cannot loop (A432).

## Testing without Twilio or Claude

`pnpm test` covers the webhook, claim, session exchange and summary tool. `services/voice` has its own tests (`pnpm verify` there), with a scripted Claude and a fake Autofix: a full booking call, barge-in, Autofix or Claude being down, voicemail hand-back, and the WebSocket upgrade checks.
