# Legal drafts

Drafts for review by a UK solicitor before the first paying garage. They are working templates, not legal advice.

| File | Who signs or sees it | Wired into the product |
| --- | --- | --- |
| `DPA-template.md` | Each garage (controller) and Vitalos Technologies (processor) | Accepted at garage sign-up (P4.9); stored with version + timestamp |
| `privacy-notice-template.md` | The garage's customers | Linked from every booking page footer and Book 4; garage details filled from `garages` |
| `consent-and-messaging-wording.md` | The garage's customers | Book 4 checkbox, SMS/WhatsApp templates, unsubscribe page, voicemail and AI-assistant disclosures |

Placeholders in square brackets are filled per garage by the app. Keep a version number at the top of each file and bump it on every change, so accepted versions can be traced.

The app renders these files as written (privacy notice at `/privacy` on every garage host, DPA at `/app/settings/agreements`, wording in Book 4 and `/unsubscribe`). After editing one, run `node scripts/sync-legal-copy.mjs` and commit both; `src/__tests__/legal-copy.test.ts` fails until you do. While a heading says "(draft vX)" and the file keeps its "Draft for solicitor review; not legal advice." line, the pages show a "pending solicitor review" flag.
