# Autofix Super Admin

The Vitalos staff console over every garage on Autofix: health, plans, bookings, messaging, domains, jobs and onboarding, with an append-only audit trail. It replicates the [Vitalos platform Super Admin](https://github.com/vitalos-technologies/vitalos-platform/tree/main/superadmin) (ADR-026) with the Autofix by Vitalos look (navy `#071127`, number-plate yellow `#f6c700`, Barlow Condensed and Inter). Address: `https://autofix.vitalos.co.uk/superadmin`, through the Autofix app's proxy (not deployed yet; [DECISIONS](../docs/autofix/DECISIONS.md) "Waiting on Temitope").

Stack: Python 3.12, Django 5.2 LTS, HTMX 2 (django-htmx), Tailwind CSS v4 (standalone CLI, no Node), PostgreSQL 17, django-simple-history, django-axes, django-otp, django-csp, Django REST Framework with drf-spectacular, WhiteNoise and gunicorn. Decision record: [DECISIONS D18](../docs/autofix/DECISIONS.md) (assumptions A400–A414).

## How it reaches Autofix

Two databases:

- `default`: the super admin's own PostgreSQL 17 (users, OTP devices, sessions, axes, history, notifications, audit trail).
- `autofix`: Autofix's Supabase Postgres as the least-privilege role `autofix_superadmin` ([migration](../supabase/migrations/20261028004000_superadmin_role.sql)). It reads only schema `superadmin`, a set of views carrying the columns this app shows, with phones, emails and registrations masked in the database and no message bodies, payloads or token hashes. Sessions start read-only. Callers on `superadmin.calls` are masked as the garage app shows them, and it also carries calls to Autofix's own line (`platform_calls`, no garage); voicemail recording links are only in `superadmin.call_voicemails`, which only the playback proxy reads ([migration](../supabase/migrations/20261029001400_superadmin_calls.sql)).

Writes never bypass Autofix's rules. The role may call three functions and nothing else: `platform_update_garage` (plan, status), `platform_retry_job` and `platform_request_domains_check`. Each runs in a read-write transaction as the signed-in person's **linked Autofix platform admin** (Settings → Users), after Django has checked their role, their TOTP and a 5–500 character reason; the function checks the platform admin again and writes Autofix's `platform_audit_log` and the garage's own audit log. Nothing touches bookings. `AutofixRouter` never migrates or writes the `autofix` alias, the models refuse writes, and `migrate --database autofix` is refused.

**View as support** is an audited POST that redirects to the garage in Autofix's `/admin`, where the read-only session starts under your own Autofix sign-in and authenticator. Nothing but the garage id is in the link.

## Served under /superadmin, and how that is secured

The app lives on the Autofix app's host, at `/superadmin` (D18). `src/proxy.ts` forwards `/superadmin/*` to this container (`SUPERADMIN_ORIGIN` in Vercel). Because it shares an origin with the Autofix app:

- **Proxy gate.** With `SUPERADMIN_PROXY_SECRET` set, every request must carry it in `x-autofix-superadmin-proxy` (constant-time check) or gets a bare 404. `/healthz/` is the only exception. `config/wsgi.py` also 404s anything outside `SUPERADMIN_PATH_PREFIX`.
- **Proxy headers.** Only behind the gate: client IP from `x-autofix-superadmin-client-ip` (lockouts, audit), public host from `x-autofix-superadmin-host` (CSRF). The proxy strips browser-sent copies.
- **Cookies.** `__Secure-afsa_session` and `__Secure-afsa_csrftoken`, `Path=/superadmin/`, `HttpOnly`, `Secure`, `SameSite=Strict`; the theme and sidebar preferences are `afsa_theme`/`afsa_sidebar` on the same path. The proxy forwards only `afsa_*` cookies, so Autofix's Supabase session never reaches this app.
- **Step-up.** TOTP for every role (`OTP_REQUIRED_FOR_ALL`), plus a fresh authenticator code (`AUTOFIX_STEP_UP`) with every plan/status change, bulk status change, job retry, domain re-check, customer-details view, voicemail playback, View as support, user change and API token.
- **Headers.** Strict nonce CSP, `frame-ancestors 'none'`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: private, no-store`. Next.js adds none of its own under `/superadmin`.

Locally the app runs at the root of `http://localhost:8000` (prefix empty, no secret). To try path mode through Next.js: set `SUPERADMIN_PATH_PREFIX=/superadmin` and a `SUPERADMIN_PROXY_SECRET` here, `SUPERADMIN_ORIGIN=http://localhost:8000` and the same secret in the repo's `.env.local`, and open `http://localhost:3000/superadmin/`.

## Pages

| URL | What |
| --- | --- |
| `/login/`, `/logout/` | Email and password with django-axes lockout. TOTP is required for SuperAdmin and for any change in Autofix |
| `/` | Overview: garages (total, active, trial, suspended, cancelled), bookings today/7 d/30 d, reminders sent and won back, messages sent and failed, failed jobs; needs attention (failed jobs, stuck locks, domains failing verification, onboarding stuck over 48 h, Twilio/Resend failures); system status; plans |
| `/garages/` | Filterable list (name or slug, plan, status), sortable, bulk bar (export selected; change status for SuperAdmin, with a confirmation and a reason), CSV export |
| `/garages/<id>/` | HTMX tabs: Overview, Team, Bookings (counts and a 30-day trend; Support can open audited customer details, masked), Domains (re-check), Messaging and reminders, Plan and status (change with a reason; history), Agreements (DPA), Audit (Autofix platform log and this trail) |
| `/garages/<id>/view-as-support/` | POST only for the hand-off; GET shows the reason form |
| `/jobs/` | Queue counts by kind and status, oldest due job, expired locks, the 20 latest failures (errors masked) with Retry, reminders skipped or failed per garage |
| `/messaging/` | Delivery and failure rates by channel, failures by error code, opt-outs (STOP), consented customers, quiet-hour compliance (09:00–19:00 Mon–Sat, garage time zone), missed calls and text-backs |
| `/calls/` | SuperAdmin and Support. Every garage's calls and Autofix's own line ("Autofix (platform line)", DECISIONS A420), newest first: garage, caller (masked as the garage app shows it, 07••• •••123), time, answered or missed, voicemail length, text-back status. Filters: garage or the platform line, missed only, has voicemail. The sidebar count is your unread "new voicemail" alerts. The same list is the garage's **Calls** tab. See "Voicemail playback" |
| `/domains/` | Every domain and its verification state; Re-check queues Autofix's own `domains.check` job |
| `/signups/` | Sign-up and onboarding funnel (7, 30, 90 days or all time), sign-ups per week, garages stuck in onboarding, latest sign-ups |
| `/audit/`, `/audit/autofix/` | Append-only trails with filters and CSV export: this app's (sign-ins, roles, hand-offs, personal-data views, changes; IP addresses) and Autofix's platform log. SuperAdmin only |
| `/activity/` | Both trails merged, without sign-ins or IP addresses |
| `/team/` | Vitalos staff, roles, two-factor state and Autofix link; Autofix's platform admins |
| `/notifications/` | In-app notifications and Needs attention. The bell polls every 60 seconds |
| `/settings/` | Users and roles (with the Autofix platform admin link), API tokens, notification preferences |
| `/help/` | Roles, how changes reach Autofix, shortcuts |
| `/system/health/` | Both databases (and that Autofix sessions are read-only), the job queue, messaging, the status endpoint |
| `/api/v1/`, `/api/schema/`, `/api/docs/` | Read-only REST API (per-user Bearer tokens): garages, domains, jobs (errors masked), counts. OpenAPI schema, Swagger UI |
| `/api/platform/v1/status` | ADR-044 product status for the Vitalos Product Pipeline, `Authorization: Bearer $AUTOFIX_STATUS_TOKEN`. Counts and alerts only, no personal data. 503 without a token or when Autofix cannot be read |
| `/django-admin/` | Verified Django superusers only |
| `/healthz/` | Liveness and database probe |

Roles: **SuperAdmin** (everything), **Support** (read-only plus audited customer details, Calls and voicemail playback, and View as support), **Finance** (plans, statuses, sign-ups and counts; no personal data, no Calls, no changes). The command palette (Ctrl/⌘ K) and the live search find pages, garages and domains.

### Voicemail playback

Autofix stores each voicemail as a Twilio recording link, which needs the Twilio account's credentials to play. The super admin plays it the way the garage app's `/api/admin/calls/{id}/voicemail` does, and the browser never sees a Twilio link or credential:

1. **Play** (SuperAdmin or Support) posts a fresh authenticator code. The answer is a player whose source is `/calls/<id>/voicemail.mp3?ticket=…`, a ticket signed for that person and that call, valid for 10 minutes.
2. That URL checks the role and the ticket, reads the link from `superadmin.call_voicemails`, accepts it only if it passes `isTwilioRecordingUrl` and is the configured account's own recording, fetches the MP3 from Twilio with `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` (https only; a redirect off `api.twilio.com` drops the credentials) and streams it back with `Cache-Control: private, no-store`.
3. Each playback writes `autofix.voicemail_played` to the audit trail (garage and call, never the caller) and marks that voicemail's alert read.

Without the two Twilio variables, Calls still works and Play says playback is not set up. `notify_attention` turns voicemails from the last 24 hours into one "New voicemail at <garage>" (or "on Autofix (platform line)") alert per person (SuperAdmin and Support; Settings → Notifications can turn them off).

Screenshots of every page at 1440 and 390 pixels: [docs/screenshots/](docs/screenshots/) (from `e2e/smoke.py` against the production image and local Supabase demo data).

## Layout

```
config/            settings (base, dev, test, prod), urls, wsgi
apps/core/         middleware (request ID, health, headers), navigation, palette, health checks, overview, template tags, admin site, migrate guard
apps/accounts/     email User (+ autofix_admin_id link), roles (SuperAdmin, Support, Finance), TOTP, API tokens, users settings
apps/audit/        append-only audit trail and CSV export
apps/notifications in-app notifications, preferences, `notify_attention`
apps/autofix/      unmanaged models over the `superadmin` views, router, db (the write gateway), selectors, services, status, views
apps/api/          DRF read-only API
templates/, static/, assets/tailwind.css
bin/               tailwind.sh, release.sh (migrate the default database + bootstrap admin), backup.sh (pg_dump)
deploy/azure/      deploy.sh (--dry-run prints the plan; a real run needs DEPLOY_APPROVED=yes)
tests/             pytest-django suite; tests/integration/ runs against the local Supabase
e2e/smoke.py       Playwright browser smoke test (every page at 1440 and 390)
docs/screenshots/
```

Business rules live in `services.py` (writes) and `selectors.py` (reads), never in views or templates.

## Develop

```sh
# Autofix: the local Supabase with its migrations and demo data (repo root)
supabase start && supabase db reset && pnpm db:seed
psql "postgres://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "alter role autofix_superadmin with login password '<local-only password>'"

cd superadmin
uv venv --python 3.12 .venv && source .venv/bin/activate
uv pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env    # set AUTOFIX_DATABASE_URL=postgres://autofix_superadmin:<password>@127.0.0.1:54322/postgres
bin/tailwind.sh --watch &
python manage.py migrate
BOOTSTRAP_ADMIN_PASSWORD='<12+ characters>' python manage.py create_superadmin --email you@vitalos.co.uk
python manage.py runserver
```

To change anything in Autofix locally, your account needs a platform admin to link to: insert one in the local Supabase (`insert into public.platform_admins (user_id) select id from auth.users where email = '…'`), then pick it in Settings → Users.

Or `docker compose up --build` (PostgreSQL 17 plus the app on http://localhost:8000; set `AUTOFIX_DB_PASSWORD`).

Refreshing the pinned dependencies (the lockfiles must match the Linux image):

```sh
uv pip compile requirements.in -o requirements.txt --python-version 3.12 --python-platform linux
uv pip compile requirements-dev.in -o requirements-dev.txt --python-version 3.12 --python-platform linux
```

## Quality gates (CI: `.github/workflows/superadmin.yml`)

```sh
ruff check . && ruff format --check .
pytest                                          # 369 tests; DATABASE_URL / AUTOFIX_TEST_DATABASE_URL=postgres://… to match CI
AUTOFIX_LIVE_DATABASE_URL=postgres://autofix_superadmin:…@127.0.0.1:54322/postgres \
AUTOFIX_LIVE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres \
  pytest -m integration                         # 40 tests against the local Supabase as autofix_superadmin
DJANGO_SETTINGS_MODULE=config.settings.prod … python manage.py check --deploy --fail-level WARNING
pip-audit --strict -r requirements.txt
bandit -r apps config -c pyproject.toml
```

CI also builds the image, runs the release job twice, starts the production image in path mode (`/superadmin`, proxy secret) against the isolated local Supabase, checks the proxy gate (404 without the secret), and drives `e2e/smoke.py` (52 checks) and `e2e/a11y.py` (axe-core, WCAG 2.2 AA, every page light and dark at 1440 and 390; no serious or critical violations) against it. The database side has its own pgTAP test (`supabase/tests/database/028_superadmin_role.test.sql`).

## Deploy

Production runs on Azure Container Apps (consumption plan, scale to zero) and answers at `https://autofix.vitalos.co.uk/superadmin` through the Autofix app's proxy. The image is a private GitHub package. Its own data lives in schema `superadmin_app` in Autofix's Supabase project. Expected cost: £0 (DECISIONS D18, A415–A417). `.github/workflows/superadmin-deploy.yml` does everything: image, Supabase roles, Azure, Vercel variables and redeploy, and the live check. `superadmin/deploy/azure/deploy.sh --dry-run` prints what it creates.

### One-time steps (Temitope)

Never paste these values into a chat. Each goes straight into GitHub at **github.com/vitalos-technologies/autofix → Settings → Secrets and variables → Actions → New repository secret**.

1. **Azure deploy identity.** Open https://shell.azure.com, signed in as the subscription owner, and choose **Bash**. Paste the script below. It starts the CI machine if it is stopped, creates resource group `rg-autofix-superadmin` and a deploy login that can change only that group, and prints four lines. Add each as a repository secret with the name before `=` and the value after it: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

   ```bash
   set -e
   SUB=$(az account show --query id -o tsv)
   echo "Subscription: $(az account show --query '[name,state]' -o tsv)"
   VM=$(az vm list -d --query "[?name=='autofix-ci'].{rg:resourceGroup,state:powerState}" -o tsv)
   RG_VM=$(echo "$VM" | cut -f1)
   [ -n "$RG_VM" ] && [ "$(echo "$VM" | cut -f2)" != "VM running" ] && az vm start -g "$RG_VM" -n autofix-ci
   for p in Microsoft.App Microsoft.OperationalInsights; do az provider register -n "$p" --wait; done
   RG=rg-autofix-superadmin
   az group create -n "$RG" -l uksouth --tags app=autofix-superadmin -o none
   az ad sp create-for-rbac --name autofix-superadmin-deploy --role Contributor \
     --scopes "$(az group show -n "$RG" --query id -o tsv)" --query "{appId:appId,password:password,tenant:tenant}" -o tsv \
     | awk -v s="$SUB" '{print "AZURE_CLIENT_ID="$1"\nAZURE_CLIENT_SECRET="$2"\nAZURE_TENANT_ID="$3"\nAZURE_SUBSCRIPTION_ID="s}'
   ```

2. **Read-only GitHub token for the image.** Azure needs it to pull the private package. Open https://github.com/settings/tokens/new (Personal access tokens → **Tokens (classic)**; GitHub's fine-grained tokens can't read packages). Set Note `autofix-superadmin image pull`, Expiration **1 year**, and tick **only** `read:packages`. Generate it and add it as repository secret `GHCR_PULL_TOKEN`. If your GitHub username is not `Isaacpyo`, also add a repository **variable** `GHCR_PULL_USERNAME` with your username.
3. **Bring production's database up to date.** Run the SQL bundle the Phase 5 session gave you in the Supabase SQL editor of Autofix's production project. It applies the merged migrations production doesn't have yet, the super admin's role among them. Launch ops `supabase-migrate` refuses on production, because its migration history table is empty.
4. **Database logins for the super admin.** Choose one:
   - **Without a Supabase token (recommended).** In the same SQL editor, open `superadmin/deploy/supabase_roles.sql` from this repository. Replace `POOLER_HOST` (twice) with your session pooler host: Supabase → **Connect** → **Session pooler**, the part after `@` and before `:5432`, like `aws-0-eu-west-2.pooler.supabase.com`. Run it. It shows two rows. Add each value as the repository secret named in its `secret` column: `SUPERADMIN_DATABASE_URL` and `SUPERADMIN_AUTOFIX_DATABASE_URL`. The passwords are made inside the database, so no log carries them.
   - **With a Supabase token.** Create one at https://supabase.com/dashboard/account/tokens and add it as repository secret `SUPABASE_ACCESS_TOKEN`. The deploy then makes the logins itself, sending only password hashes.
5. **Deploy.** Run **Actions → Super Admin deploy → Run workflow** and type `DEPLOY`. It ends with `https://autofix.vitalos.co.uk/superadmin/login/` answering.
6. **Set your password.** Open https://autofix.vitalos.co.uk/superadmin/ once, to wake it. Then in Azure Cloud Shell run the command below. It prints a one-time 30-minute link; open it, set a password, then set up your authenticator app.

   ```bash
   az containerapp exec -g rg-autofix-superadmin -n autofix-superadmin --command "python manage.py issue_setup_link"
   ```

Re-run **Super Admin deploy** for each new version. It keeps every secret and password. Voicemail playback uses the repository secrets `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (the ones the Vercel sync already uses); when either is missing, the deploy leaves them out and playback says it is not set up.

## Management commands

- `create_superadmin [--email EMAIL] [--password]` creates the bootstrap SuperAdmin if it is missing and otherwise leaves the account unchanged. The password is read **only** from `$BOOTSTRAP_ADMIN_PASSWORD`; `--password` resets an existing account's password from it.
- `create_owner` creates or confirms the primary owner (`$PRIMARY_OWNER_EMAIL`) with no password. Only the owner grants or revokes SuperAdmin.
- `issue_setup_link --email EMAIL` prints a single-use set-password link, valid for 30 minutes, to the terminal only. This app sends no email.
- `notify_attention` turns Autofix items needing attention, and voicemails left in the last 24 hours, into bell notifications for SuperAdmin and Support (once per problem or voicemail per person). Schedule it every 5 minutes.
- `migrate` refuses `--database autofix`: Autofix's schema belongs to `supabase/migrations/`.
