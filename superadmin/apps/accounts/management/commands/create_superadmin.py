import os

from django.contrib.auth import get_user_model, password_validation
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.accounts.roles import SUPERADMIN
from apps.accounts.services import ensure_roles, set_role

# The name of the environment variable, not a password value.
PASSWORD_ENV = "BOOTSTRAP_ADMIN_PASSWORD"  # noqa: S105  # nosec B105


class Command(BaseCommand):
    help = (
        "Create (or confirm) the bootstrap SuperAdmin. The password is read from the "
        f"{PASSWORD_ENV} environment variable and never accepted on the command line."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--email",
            default=os.environ.get("BOOTSTRAP_ADMIN_EMAIL", ""),
            help="Admin email (defaults to $BOOTSTRAP_ADMIN_EMAIL).",
        )
        parser.add_argument(
            "--password",
            action="store_true",
            help=f"Also reset an existing admin's password from ${PASSWORD_ENV}.",
        )

    @transaction.atomic
    def handle(self, *args, email, password, **options):
        email = (email or "").strip().lower()
        if not email:
            raise CommandError("Provide --email or set BOOTSTRAP_ADMIN_EMAIL.")
        User = get_user_model()
        ensure_roles()
        user = User.objects.filter(email__iexact=email).first()
        created = user is None
        if created or password:
            raw = os.environ.get(PASSWORD_ENV, "")
            if not raw:
                raise CommandError(f"Set {PASSWORD_ENV} in the environment; it is never read from argv.")
            candidate = user or User(email=email)
            try:
                password_validation.validate_password(raw, candidate)
            except ValidationError as exc:
                raise CommandError("Bootstrap password rejected: " + " ".join(exc.messages)) from exc
        if created:
            user = User.objects.create_superuser(email=email, password=raw)
            set_role(user, SUPERADMIN, actor=None)
            self.stdout.write(self.style.SUCCESS(f"Created SuperAdmin {email}."))
            return
        # Runs on every release: an existing account is never re-activated, re-promoted or otherwise
        # changed, so deliberate deactivation or demotion in the app survives redeploys.
        if password:
            user.set_password(raw)
            user.save(update_fields=["password"])
            self.stdout.write(
                self.style.SUCCESS(f"Updated password for {email}; roles and status unchanged.")
            )
        else:
            self.stdout.write(self.style.SUCCESS(f"{email} already exists; left unchanged."))
