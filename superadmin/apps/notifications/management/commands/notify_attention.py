from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db.models import Q
from django.urls import reverse
from django.utils import timezone

from apps.accounts.roles import SUPERADMIN, SUPPORT
from apps.autofix import selectors
from apps.autofix.db import AutofixUnavailable
from apps.notifications.models import Notification
from apps.notifications.services import notify, voicemail_key

KINDS = {
    "job_failed": Notification.Kind.JOB_FAILED,
    "job_stuck": Notification.Kind.JOB_FAILED,
    "domain_failed": Notification.Kind.DOMAIN_FAILED,
    "onboarding_stuck": Notification.Kind.ONBOARDING_STUCK,
    "messaging_failed": Notification.Kind.MESSAGING_FAILED,
}


class Command(BaseCommand):
    help = (
        "Turn Autofix items needing attention, and voicemails left in the last 24 hours, into in-app "
        "notifications for SuperAdmin and Support (each problem or voicemail notifies each person once). "
        "Schedule every 5 minutes. Sends no email."
    )

    def handle(self, *args, **options):
        try:
            items = selectors.attention_items(limit=50)
            voicemails = selectors.new_voicemails()
        except AutofixUnavailable as exc:
            self.stderr.write(f"Autofix data unavailable ({exc}); nothing notified.")
            return
        recipients = list(
            get_user_model()
            .objects.filter(is_active=True)
            .filter(Q(is_superuser=True) | Q(groups__name__in=(SUPERADMIN, SUPPORT)))
            .distinct()
        )
        created = 0
        for item in items:
            created += notify(
                recipients,
                KINDS[item.kind],
                title=item.title,
                body=item.detail,
                url=item.url,
                dedupe_key=item.key,
            )
        calls_url = reverse("autofix:calls")
        for call in voicemails:
            # Names the garage and when, never the caller.
            left = timezone.localtime(call.created_at)
            created += notify(
                recipients,
                Notification.Kind.VOICEMAIL,
                title=f"New voicemail at {call.garage.name}",
                body=f"{call.voicemail_duration_s or 0} seconds, left {left:%a %d %b %H:%M}",
                url=f"{calls_url}?garage={call.garage_id}&voicemail=1",
                dedupe_key=voicemail_key(call.pk),
            )
        self.stdout.write(
            self.style.SUCCESS(
                f"{len(items)} items, {len(voicemails)} voicemails, {created} notifications created."
            )
        )
