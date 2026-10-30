"""``migrate`` that refuses the Pitline database outright.

The router already skips every operation there, but Django would still create its own
``django_migrations`` table on the alias. Pitline's schema belongs to its Supabase migrations only.
Test settings switch the guard off so the test runner can create its empty ``autofix`` test database.
"""

from django.conf import settings
from django.core.management.base import CommandError
from django.core.management.commands.migrate import Command as MigrateCommand

from apps.autofix.router import ALIAS


class Command(MigrateCommand):
    def handle(self, *args, **options):
        database = options.get("database") or "default"
        guarded = getattr(settings, "AUTOFIX_MIGRATE_GUARD", True)
        if guarded and (database == ALIAS or database.startswith(f"{ALIAS}_")):
            raise CommandError(
                "The Pitline database is never migrated from here (supabase/migrations owns it)."
            )
        return super().handle(*args, **options)
