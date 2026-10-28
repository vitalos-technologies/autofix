# Autofix Super Admin

The Vitalos staff console over every garage on Autofix: health, plans, bookings, messaging, domains, jobs and onboarding, with an append-only audit trail. It replicates the [Vitalos platform Super Admin](https://github.com/vitalos-technologies/vitalos-platform/tree/main/superadmin) (ADR-026) with the Autofix by Vitalos look (navy `#071127`, number-plate yellow `#f6c700`, Barlow Condensed and Inter). Planned address: `https://superadmin.autofix.vitalos.co.uk` (not deployed yet; [DECISIONS](../docs/autofix/DECISIONS.md) "Waiting on Temitope").

Stack: Python 3.12, Django 5.2 LTS, HTMX 2 (django-htmx), Tailwind CSS v4 (standalone CLI, no Node), PostgreSQL 17, django-simple-history, django-axes, django-otp, django-csp, Django REST Framework with drf-spectacular, WhiteNoise and gunicorn. Decision record: [DECISIONS D16](../docs/autofix/DECISIONS.md) (assumptions A130–A139).

## How it reaches Autofix

Two databases:

- `default`: the super admin's own PostgreSQL 17 (users, OTP devices, sessions, axes, history, notifications, audit trail).
- `autofix`: Autofix's Supabase Postgres as the least-privilege role `autofix_superadmin` ([migration](../supabase/migrations/20261028004000_superadmin_role.sql)). It reads only schema `superadmin`, a set of views carrying the columns this app shows, with phones, emails and registrations masked in the database and no message bodies, payloads or token hashes. Sessions start read-only.

Writes never bypass Autofix's rules. The role may call three functions and nothing else: `platform_update_garage` (plan, status), `platform_retry_job` and `platform_request_domains_check`. Each runs in a read-write transaction as the signed-in person's **linked Autofix platform admin** (Settings → Users), after Django has checked their role, their TOTP and a 5–500 character reason; the function checks the platform admin again and writes Autofix's `platform_audit_log` and the garage's own audit log. Nothing touches bookings. `AutofixRouter` never migrates or writes the `autofix` alias, the models refuse writes, and `migrate --database autofix` is refused.

**View as support** is an audited POST that redirects to the garage in Autofix's `/admin`, where the read-only session starts under your own Autofix sign-in and authenticator. Nothing but the garage id is in the link.

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

Roles: **SuperAdmin** (everything), **Support** (read-only plus audited customer details and View as support), **Finance** (plans, statuses, sign-ups and counts; no personal data, no changes). The command palette (Ctrl/⌘ K) and the live search find pages, garages and domains.

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
pytest                                          # 318 tests; DATABASE_URL / AUTOFIX_TEST_DATABASE_URL=postgres://… to match CI
AUTOFIX_LIVE_DATABASE_URL=postgres://autofix_superadmin:…@127.0.0.1:54322/postgres \
AUTOFIX_LIVE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres \
  pytest -m integration                         # 39 tests against the local Supabase as autofix_superadmin
DJANGO_SETTINGS_MODULE=config.settings.prod … python manage.py check --deploy --fail-level WARNING
pip-audit --strict -r requirements.txt
bandit -r apps config -c pyproject.toml
```

CI also builds the image, runs the release job twice, starts the production image against the isolated local Supabase and drives `e2e/smoke.py` (52 checks) and `e2e/a11y.py` (axe-core, WCAG 2.2 AA, every page light and dark at 1440 and 390; no serious or critical violations) against it. The database side has its own pgTAP test (`supabase/tests/database/028_superadmin_role.test.sql`).

## Management commands

- `create_superadmin [--email EMAIL] [--password]` creates the bootstrap SuperAdmin if it is missing and otherwise leaves the account unchanged. The password is read **only** from `$BOOTSTRAP_ADMIN_PASSWORD`; `--password` resets an existing account's password from it.
- `create_owner` creates or confirms the primary owner (`$PRIMARY_OWNER_EMAIL`) with no password. Only the owner grants or revokes SuperAdmin.
- `issue_setup_link --email EMAIL` prints a single-use set-password link, valid for 30 minutes, to the terminal only. This app sends no email.
- `notify_attention` turns Autofix items needing attention into bell notifications for SuperAdmin and Support (once per problem per person). Schedule it every 5 minutes.
- `migrate` refuses `--database autofix`: Autofix's schema belongs to `supabase/migrations/`.
