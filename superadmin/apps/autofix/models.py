"""Unmanaged, read-only models over Pitline's Supabase Postgres (the ``autofix`` alias).

Each model maps one view in schema ``superadmin`` (migration ``20261028004000_superadmin_role.sql``),
which carries only the columns the super admin shows, with contact details and registrations masked in
the database. Django never creates, migrates or writes these tables:

- ``managed = False`` and ``AutofixRouter.allow_migrate`` keep them out of every migration;
- ``AutofixRouter.db_for_write`` raises, and ``save``/``delete``/``update``/``bulk_create`` raise here;
- the database role holds SELECT on the views only.

Writes go through the platform SQL functions in ``apps.autofix.db`` (plan and status, job retry,
domain re-check, enquiry status and notes), never through the ORM. Nothing here touches bookings except to read them.
"""

from django.db import models


class ReadOnlyModelError(RuntimeError):
    """Pitline data is read-only in the super admin; writes go through the platform functions."""


class ReadOnlyQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise ReadOnlyModelError("Pitline data is read-only here.")

    def delete(self):
        raise ReadOnlyModelError("Pitline data is read-only here.")

    def bulk_create(self, *args, **kwargs):
        raise ReadOnlyModelError("Pitline data is read-only here.")

    def bulk_update(self, *args, **kwargs):
        raise ReadOnlyModelError("Pitline data is read-only here.")

    def create(self, **kwargs):
        raise ReadOnlyModelError("Pitline data is read-only here.")

    def get_or_create(self, *args, **kwargs):
        raise ReadOnlyModelError("Pitline data is read-only here.")

    def update_or_create(self, *args, **kwargs):
        raise ReadOnlyModelError("Pitline data is read-only here.")


class AutofixModel(models.Model):
    objects = ReadOnlyQuerySet.as_manager()

    class Meta:
        abstract = True
        managed = False

    def __str__(self):
        return f"{self._meta.verbose_name} {self.pk}"

    def save(self, *args, **kwargs):
        raise ReadOnlyModelError("Pitline data is read-only here.")

    def delete(self, *args, **kwargs):
        raise ReadOnlyModelError("Pitline data is read-only here.")


def _garage_fk(related_name: str, *, null: bool = False):
    return models.ForeignKey(
        "Garage",
        on_delete=models.DO_NOTHING,
        db_constraint=False,
        related_name=related_name,
        null=null,
        blank=null,
    )


GARAGE_STATUSES = [
    ("onboarding", "Onboarding"),
    ("active", "Active"),
    ("suspended", "Suspended"),
    ("cancelled", "Cancelled"),
]
DOMAIN_STATUSES = [
    ("pending_dns", "Waiting for DNS"),
    ("verifying", "Verifying"),
    ("active", "Active"),
    ("failed", "Failed"),
]
JOB_STATUSES = [("queued", "Queued"), ("running", "Running"), ("done", "Done"), ("failed", "Failed")]


class Garage(AutofixModel):
    id = models.UUIDField(primary_key=True)
    slug = models.TextField()
    name = models.TextField()
    # Old (trial, growth, front_desk) or D17 (essentials, pro) values: read them through ``plans``.
    plan = models.TextField()
    status = models.TextField(choices=GARAGE_STATUSES)
    timezone = models.TextField(default="Europe/London")
    mot_enabled = models.BooleanField(default=False)
    accent = models.TextField(default="#155fba")
    booking_prefix = models.TextField(default="")
    # The garage's own business contact details (not a customer's).
    phone = models.TextField(null=True, blank=True)
    email = models.TextField(null=True, blank=True)
    # D17's 14-day Pro trial; null until the plans migration adds the column (the view reads it safely).
    trial_ends_at = models.DateTimeField(null=True, blank=True)
    plan_chosen = models.TextField(null=True, blank=True)
    onboarding_started_at = models.DateTimeField(null=True, blank=True)
    onboarding_completed_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "garages"
        ordering = ["-created_at", "id"]

    def __str__(self):
        return self.name

    @property
    def plan_key(self) -> str:
        from .plans import TRIAL, effective, on_trial

        return TRIAL if on_trial(self) else effective(self)

    @property
    def plan_label(self) -> str:
        from .plans import label

        return label(self)


class GarageMember(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("members")
    user_id = models.UUIDField()
    role = models.TextField()
    display_name = models.TextField(default="")
    created_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "garage_members"
        ordering = ["role", "display_name"]


class GarageInvite(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("invites")
    role = models.TextField()
    email_masked = models.TextField(null=True, blank=True)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    sent_count = models.IntegerField(default=1)
    created_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "garage_invites"
        ordering = ["-created_at"]


class PlatformAdmin(AutofixModel):
    """Vitalos staff in Pitline's ``platform_admins``; a Django user links to one to write."""

    user_id = models.UUIDField(primary_key=True)
    display_name = models.TextField(default="")
    email = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "platform_admins"
        ordering = ["display_name", "email"]

    def __str__(self):
        return self.display_name or self.email or str(self.user_id)


class Customer(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("customers")
    name = models.TextField()
    phone_masked = models.TextField(null=True, blank=True)
    email_masked = models.TextField(null=True, blank=True)
    preferred_contact = models.TextField()
    channel = models.TextField()
    reminder_consent = models.BooleanField(default=False)
    consent_at = models.DateTimeField(null=True, blank=True)
    consent_source = models.TextField(null=True, blank=True)
    opted_out_at = models.DateTimeField(null=True, blank=True)
    anonymised_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "customers"


class Vehicle(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("vehicles")
    customer = models.ForeignKey(
        Customer, on_delete=models.DO_NOTHING, db_constraint=False, null=True, related_name="vehicles"
    )
    registration_masked = models.TextField(null=True, blank=True)
    make = models.TextField(null=True, blank=True)
    model = models.TextField(null=True, blank=True)
    year = models.IntegerField(null=True, blank=True)
    mot_expiry = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "vehicles"


class Service(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("services")
    name = models.TextField()
    duration_min = models.IntegerField()
    price_pence = models.IntegerField(null=True, blank=True)
    online_enabled = models.BooleanField(default=True)
    is_mot = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "services"


class Resource(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("resources")
    name = models.TextField()
    kind = models.TextField()
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "resources"


class Booking(AutofixModel):
    BOOKED_STATUSES = (
        "requested",
        "confirmed",
        "arrived",
        "in_progress",
        "waiting_parts",
        "ready",
        "collected",
    )

    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("bookings")
    reference = models.TextField()
    customer = models.ForeignKey(Customer, on_delete=models.DO_NOTHING, db_constraint=False, related_name="+")
    vehicle = models.ForeignKey(Vehicle, on_delete=models.DO_NOTHING, db_constraint=False, related_name="+")
    service = models.ForeignKey(Service, on_delete=models.DO_NOTHING, db_constraint=False, related_name="+")
    resource = models.ForeignKey(Resource, on_delete=models.DO_NOTHING, db_constraint=False, related_name="+")
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    status = models.TextField()
    source = models.TextField()
    location_mode = models.TextField(default="workshop")
    reminder_send_id = models.UUIDField(null=True, blank=True)
    price_pence = models.IntegerField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "bookings"
        ordering = ["-starts_at"]


class GarageDomain(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("domains")
    hostname = models.TextField()
    kind = models.TextField()
    status = models.TextField(choices=DOMAIN_STATUSES)
    last_checked_at = models.DateTimeField(null=True, blank=True)
    error = models.TextField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "garage_domains"
        ordering = ["hostname"]

    @property
    def checkable(self) -> bool:
        return (
            self.kind == "custom" and self.status in ("pending_dns", "verifying") and self.deleted_at is None
        )


class Job(AutofixModel):
    id = models.UUIDField(primary_key=True)
    kind = models.TextField()
    garage = _garage_fk("jobs", null=True)
    status = models.TextField(choices=JOB_STATUSES)
    attempts = models.IntegerField(default=0)
    max_attempts = models.IntegerField(default=5)
    run_at = models.DateTimeField()
    locked_until = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "jobs"
        ordering = ["-created_at"]


class ReminderSend(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("reminder_sends")
    kind = models.TextField()
    channel = models.TextField()
    status = models.TextField()
    skip_reason = models.TextField(null=True, blank=True)
    send_at = models.DateTimeField()
    sent_at = models.DateTimeField(null=True, blank=True)
    opened_at = models.DateTimeField(null=True, blank=True)
    booking = models.ForeignKey(
        Booking, on_delete=models.DO_NOTHING, db_constraint=False, null=True, related_name="+"
    )
    error_code = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "reminder_sends"


class Message(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("messages")
    channel = models.TextField()
    direction = models.TextField()
    provider = models.TextField()
    status = models.TextField()
    reminder_send_id = models.UUIDField(null=True, blank=True)
    booking_id = models.UUIDField(null=True, blank=True)
    call_id = models.UUIDField(null=True, blank=True)
    error_code = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "messages"


# Shown for calls to Pitline's own number (``Call.is_platform``, DECISIONS A420).
PLATFORM_LINE_LABEL = "Pitline (platform line)"


class Call(AutofixModel):
    """A garage's call, or a call to Pitline's own line (``is_platform``: no garage, no text-back)."""

    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("calls", null=True)
    status = models.TextField()
    dial_status = models.TextField(null=True, blank=True)
    missed = models.BooleanField(default=False)
    duration_s = models.IntegerField(null=True, blank=True)
    text_back_message_id = models.UUIDField(null=True, blank=True)
    handled_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField()
    # 20261029002200_superadmin_calls.sql: masked like the garage app (07••• •••123); null when withheld.
    caller_masked = models.TextField(null=True, blank=True)
    voicemail_duration_s = models.IntegerField(null=True, blank=True)
    has_voicemail = models.BooleanField(default=False)
    is_platform = models.BooleanField(default=False)

    class Meta(AutofixModel.Meta):
        db_table = "calls"
        ordering = ["-created_at", "id"]

    @property
    def line_name(self) -> str:
        """The garage's name, or Pitline's own line."""
        return PLATFORM_LINE_LABEL if self.is_platform or not self.garage_id else self.garage.name


class CallVoicemail(AutofixModel):
    """A call's Twilio recording link. Read only by the voicemail proxy (``voicemail.py``), never rendered."""

    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("+", null=True)
    voicemail_url = models.TextField()

    class Meta(AutofixModel.Meta):
        db_table = "call_voicemails"


class GarageAgreement(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("agreements")
    kind = models.TextField()
    version = models.TextField()
    text_hash = models.TextField()
    accepted_by_name = models.TextField()
    accepted_by_role = models.TextField()
    accepted_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "garage_agreements"
        ordering = ["-accepted_at"]


class PlatformAuditEntry(AutofixModel):
    """Pitline's own append-only ``platform_audit_log`` (actions taken in /admin and here)."""

    id = models.BigIntegerField(primary_key=True)
    actor_id = models.UUIDField(null=True, blank=True)
    actor_name = models.TextField(default="Vitalos support")
    action = models.TextField()
    target_garage = _garage_fk("platform_audit", null=True)
    entity_type = models.TextField()
    entity_id = models.TextField()
    reason = models.TextField(null=True, blank=True)
    detail = models.JSONField(default=dict)
    created_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "platform_audit_log"
        ordering = ["-created_at", "-id"]


class PlatformImpersonation(AutofixModel):
    id = models.UUIDField(primary_key=True)
    garage = _garage_fk("impersonations")
    admin_user_id = models.UUIDField()
    admin_name = models.TextField(default="Vitalos support")
    reason = models.TextField()
    started_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)
    end_reason = models.TextField(null=True, blank=True)

    class Meta(AutofixModel.Meta):
        db_table = "platform_impersonations"
        ordering = ["-started_at"]


ENQUIRY_STATUSES = [("new", "New"), ("in_progress", "In progress"), ("closed", "Closed")]
ENQUIRY_TOPICS = [
    ("general", "General question"),
    ("sales", "Sales or a demo"),
    ("support", "Support"),
    ("partnership", "Partnership"),
]


class PlatformEnquiry(AutofixModel):
    """A contact page enquiry to Vitalos (``superadmin.platform_enquiries``, migration
    ``20261029003000_platform_enquiries.sql``). A platform row: no garage. Contact details arrive
    unmasked because staff reply to them; only SuperAdmin and Support see them, and each detail view is
    audited. Status and notes change only through ``platform_update_enquiry``.
    """

    id = models.UUIDField(primary_key=True)
    name = models.TextField()
    email = models.TextField()
    phone = models.TextField(null=True, blank=True)
    garage_name = models.TextField(null=True, blank=True)
    topic = models.TextField(choices=ENQUIRY_TOPICS)
    message = models.TextField()
    status = models.TextField(choices=ENQUIRY_STATUSES, default="new")
    received_at = models.DateTimeField()
    handled_by = models.UUIDField(null=True, blank=True)
    handled_by_name = models.TextField(null=True, blank=True)
    notes = models.TextField(null=True, blank=True)
    updated_at = models.DateTimeField()

    class Meta(AutofixModel.Meta):
        db_table = "platform_enquiries"
        ordering = ["-received_at", "-id"]
        verbose_name = "enquiry"
        verbose_name_plural = "enquiries"

    def __str__(self):
        return f"{self.name} ({self.get_topic_display()})"
