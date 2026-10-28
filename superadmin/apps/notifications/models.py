from django.conf import settings
from django.db import models
from django.utils import timezone


class Notification(models.Model):
    class Kind(models.TextChoices):
        ROLE_ASSIGNED = "role_assigned", "Role assigned"
        JOB_FAILED = "job_failed", "Autofix job failed"
        DOMAIN_FAILED = "domain_failed", "Custom domain failed verification"
        ONBOARDING_STUCK = "onboarding_stuck", "Garage onboarding stuck"
        MESSAGING_FAILED = "messaging_failed", "Messages failing"

    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications"
    )
    kind = models.CharField(max_length=32, choices=Kind.choices)
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True)
    url = models.CharField(max_length=500, blank=True)
    # Set for alerts raised by `notify_attention`, so the same problem notifies each person once.
    dedupe_key = models.CharField(max_length=120, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["recipient", "read_at"])]
        constraints = [
            models.UniqueConstraint(
                fields=["recipient", "dedupe_key"],
                condition=~models.Q(dedupe_key=""),
                name="notifications_unique_alert_per_recipient",
            )
        ]

    def __str__(self):
        return self.title

    @property
    def is_read(self) -> bool:
        return self.read_at is not None


class NotificationPreference(models.Model):
    """Which Autofix alerts a person wants in the bell. In-app only: this app sends no email."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notification_preference"
    )
    job_failures = models.BooleanField(default=True, verbose_name="Failed jobs")
    domain_failures = models.BooleanField(default=True, verbose_name="Custom domains failing verification")
    onboarding_stuck = models.BooleanField(default=True, verbose_name="Onboarding stuck over 48 hours")
    messaging_failures = models.BooleanField(default=True, verbose_name="Text and email failures")
    updated_at = models.DateTimeField(auto_now=True)

    KIND_FIELDS = {
        Notification.Kind.JOB_FAILED: "job_failures",
        Notification.Kind.DOMAIN_FAILED: "domain_failures",
        Notification.Kind.ONBOARDING_STUCK: "onboarding_stuck",
        Notification.Kind.MESSAGING_FAILED: "messaging_failures",
    }

    def __str__(self):
        return f"Notification preferences for {self.user}"

    def wants(self, kind: str) -> bool:
        field = self.KIND_FIELDS.get(kind)
        return True if field is None else bool(getattr(self, field))
