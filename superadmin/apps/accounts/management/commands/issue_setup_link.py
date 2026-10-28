import os

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.accounts.services import setup_link
from apps.accounts.tokens import SET_PASSWORD_TIMEOUT_SECONDS


class Command(BaseCommand):
    help = (
        "Print a single-use set-password link (valid for 30 minutes) to this terminal only. "
        "It is not emailed, stored or logged; the issue itself is audited."
    )

    def add_arguments(self, parser):
        parser.add_argument("--email", default=os.environ.get("PRIMARY_OWNER_EMAIL", ""))
        parser.add_argument("--base-url", default=settings.APP_BASE_URL)

    def handle(self, *args, email, base_url, **options):
        user = get_user_model().objects.filter(email__iexact=(email or "").strip(), is_active=True).first()
        if user is None:
            raise CommandError("No active account with that email.")
        link = setup_link(user, base_url)
        minutes = SET_PASSWORD_TIMEOUT_SECONDS // 60
        self.stdout.write(f"One-time link for {user.email} (expires in {minutes} minutes, works once):")
        self.stdout.write(link)
