"""Prepare Autofix's Supabase project for the super admin (DECISIONS D18, A415). Run by the deploy workflow.

Over the Supabase Management API (SUPABASE_ACCESS_TOKEN), with no plaintext password ever sent:

1. Checks the role migration (20261028004000_superadmin_role.sql) is applied; stops otherwise.
2. Ensures the super admin's own role and schema: role ``superadmin_app`` (login, search_path
   ``superadmin_app``, nothing granted outside its schema), which creates its tables in schema ``superadmin_app``, for its users,
   sessions and audit trail. Autofix's Data API only serves the schemas listed in its settings, so this
   schema is never exposed there.
3. Gives ``autofix_superadmin`` (and ``superadmin_app``) a login password, but only when the deploy has
   no connection string for it yet: passwords are generated here and set as SCRAM-SHA-256 verifiers, so
   only the hash reaches Supabase. Existing connection strings are reused unchanged.

Writes DATABASE_URL and AUTOFIX_DATABASE_URL (session pooler, sslmode=require) to $OUT_FILE (mode 0600)
and masks every password in the GitHub Actions log. Prints names and states only.

Environment: SUPABASE_ACCESS_TOKEN, NEXT_PUBLIC_SUPABASE_URL, OUT_FILE, and optionally EXISTING_DATABASE_URL
and EXISTING_AUTOFIX_DATABASE_URL (the container's current secrets).
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit

APP_ROLE = "superadmin_app"
AUTOFIX_ROLE = "autofix_superadmin"
SCRAM_ITERATIONS = 4096


def fail(message: str) -> None:
    print(f"::error::supabase_setup: {message}")
    sys.exit(1)


def mask(value: str) -> None:
    print(f"::add-mask::{value}")


def scram_verifier(password: str) -> str:
    """PostgreSQL's SCRAM-SHA-256 verifier, as `CREATE ROLE ... PASSWORD` stores it."""
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, SCRAM_ITERATIONS)
    client_key = hmac.new(salted, b"Client Key", "sha256").digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", "sha256").digest()
    b64 = lambda raw: base64.b64encode(raw).decode()  # noqa: E731
    return f"SCRAM-SHA-256${SCRAM_ITERATIONS}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


class Supabase:
    def __init__(self, token: str, ref: str):
        self.token = token
        self.api = f"https://api.supabase.com/v1/projects/{ref}"

    def call(self, path: str, body: dict | None = None):
        request = urllib.request.Request(  # noqa: S310 - fixed https host
            self.api + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method="POST" if body is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310  # nosec B310
                text = response.read().decode()
        except urllib.error.HTTPError as error:
            detail = error.read().decode()[:300]
            fail(f"{path}: HTTP {error.code} {detail}")
        return json.loads(text) if text else None

    def sql(self, query: str):
        return self.call("/database/query", {"query": query})


def literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def pooler_host(project: Supabase) -> str:
    config = project.call("/config/database/pooler")
    entries = config if isinstance(config, list) else [config]
    primary = next((entry for entry in entries if entry.get("database_type", "PRIMARY") == "PRIMARY"), None)
    host = (primary or {}).get("db_host", "")
    if not re.fullmatch(r"[a-z0-9.-]+\.pooler\.supabase\.com", host):
        fail("could not read the project's session pooler host")
    return host


def url_for(role: str, ref: str, password: str, host: str) -> str:
    # Session mode (5432): the role's own defaults (read-only, search_path) apply on each connection.
    return f"postgres://{role}.{ref}:{quote(password, safe='')}@{host}:5432/postgres?sslmode=require"


def reusable(url: str, role: str, ref: str) -> bool:
    parts = urlsplit(url or "")
    return parts.scheme.startswith("postgres") and parts.username == f"{role}.{ref}" and bool(parts.password)


def main() -> None:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    match = re.fullmatch(
        r"https://([a-z0-9]{20})\.supabase\.co/?", os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
    )
    out_file = os.environ.get("OUT_FILE", "")
    if not token or not match or not out_file:
        fail(
            "SUPABASE_ACCESS_TOKEN, NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co) and OUT_FILE are required"
        )
    ref = match.group(1)
    project = Supabase(token, ref)
    print(f"supabase_setup: project {ref}")

    state = project.sql(
        "select (select count(*) from pg_roles where rolname = 'autofix_superadmin')::int as role, "
        "(to_regclass('superadmin.garages') is not null) as views, "
        "(select count(*) from supabase_migrations.schema_migrations where version = '20261028004000')::int as migration"
    )[0]
    if not (state["role"] and state["views"]):
        fail(
            "the super admin role migration (20261028004000_superadmin_role.sql) is not applied to this project. "
            "Apply it with Actions > Launch ops (task supabase-migrate, apply), then run this deploy again."
        )
    print(
        f"supabase_setup: role {AUTOFIX_ROLE} and schema superadmin present (migration recorded: {bool(state['migration'])})"
    )

    host = pooler_host(project)
    existing_app = os.environ.get("EXISTING_DATABASE_URL", "")
    existing_autofix = os.environ.get("EXISTING_AUTOFIX_DATABASE_URL", "")

    statements = [
        f"do $$ begin if not exists (select from pg_roles where rolname = '{APP_ROLE}') then "
        f"create role {APP_ROLE} login noinherit connection limit 10; end if; end $$",
        # Owned by the project's admin role (postgres is not a superuser on Supabase, so it cannot hand
        # ownership to a role it is not a member of); the app role may use it and create its tables there.
        f"create schema if not exists {APP_ROLE}",
        f"revoke all on schema {APP_ROLE} from public",
        f"grant usage, create on schema {APP_ROLE} to {APP_ROLE}",
        f"alter role {APP_ROLE} set search_path = {APP_ROLE}",
        f"alter role {APP_ROLE} set statement_timeout = '30s'",
        f"revoke all on schema superadmin from {APP_ROLE}",
    ]
    if reusable(existing_app, APP_ROLE, ref):
        database_url = existing_app
        print(f"supabase_setup: {APP_ROLE} keeps its current password")
    else:
        password = secrets.token_urlsafe(32)
        mask(password)
        statements.append(f"alter role {APP_ROLE} with login password {literal(scram_verifier(password))}")
        database_url = url_for(APP_ROLE, ref, password, host)
        print(f"supabase_setup: {APP_ROLE} gets a new password (sent as a SCRAM verifier)")
    if reusable(existing_autofix, AUTOFIX_ROLE, ref):
        autofix_url = existing_autofix
        print(f"supabase_setup: {AUTOFIX_ROLE} keeps its current password")
    else:
        password = secrets.token_urlsafe(32)
        mask(password)
        statements.append(
            f"alter role {AUTOFIX_ROLE} with login password {literal(scram_verifier(password))}"
        )
        autofix_url = url_for(AUTOFIX_ROLE, ref, password, host)
        print(f"supabase_setup: {AUTOFIX_ROLE} gets a login password (sent as a SCRAM verifier)")
    project.sql(";\n".join(statements))

    fd = os.open(out_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(f"DATABASE_URL={database_url}\nAUTOFIX_DATABASE_URL={autofix_url}\n")
    print(f"supabase_setup: connection strings written (pooler {host})")


if __name__ == "__main__":
    main()
