import os

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from apps.accounts.services import ensure_primary_owner


class Command(BaseCommand):
    help = (
        "Create (or confirm) the primary owner account. Idempotent. The account gets no usable "
        "password; run `issue_setup_link` to let the owner set one. Other SuperAdmins are untouched."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--email",
            default=os.environ.get("PRIMARY_OWNER_EMAIL", ""),
            help="Owner email (defaults to $PRIMARY_OWNER_EMAIL).",
        )
        parser.add_argument(
            "--transfer", action="store_true", help="Move ownership from the current primary owner."
        )

    def handle(self, *args, email, transfer, **options):
        if not email:
            raise CommandError("Provide --email or set PRIMARY_OWNER_EMAIL.")
        try:
            user, created, changed = ensure_primary_owner(email, transfer=transfer)
        except ValidationError as exc:
            raise CommandError(" ".join(exc.messages)) from exc
        if created:
            message = (
                f"Created primary owner {user.email}. Run `manage.py issue_setup_link` to set a password."
            )
        elif changed:
            message = f"{user.email} is now the primary owner."
        else:
            message = f"{user.email} is already the primary owner; left unchanged."
        self.stdout.write(self.style.SUCCESS(message))
