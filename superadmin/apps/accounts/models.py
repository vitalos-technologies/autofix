import hashlib
import secrets

from django.conf import settings
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone


class UserManager(BaseUserManager):
    use_in_migrations = True

    def _create_user(self, email, password, **extra_fields):
        if not email:
            raise ValueError("An email address is required.")
        email = self.normalize_email(email).lower()
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        return self._create_user(email, password, **extra_fields)

    def get_by_natural_key(self, username):
        return self.get(**{f"{self.model.USERNAME_FIELD}__iexact": username})


class User(AbstractBaseUser, PermissionsMixin):
    """Vitalos staff user. Email is the username; TOTP is mandatory for SuperAdmin."""

    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=150, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    date_joined = models.DateTimeField(default=timezone.now)
    # The single named owner. Only the owner grants or revokes SuperAdmin, and the owner cannot be
    # demoted or deactivated in the app (see services.set_role).
    is_primary_owner = models.BooleanField(default=False)
    # The Pitline platform admin (public.platform_admins.user_id) this person acts as when they change
    # something in Pitline. Empty: Pitline is read-only for them. Set by a SuperAdmin in Settings.
    autofix_admin_id = models.UUIDField(
        null=True, blank=True, unique=True, verbose_name="Linked Pitline platform admin"
    )

    objects = UserManager()

    USERNAME_FIELD = "email"
    EMAIL_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    class Meta:
        ordering = ["email"]
        constraints = [
            models.UniqueConstraint(
                fields=["is_primary_owner"],
                condition=models.Q(is_primary_owner=True),
                name="accounts_single_primary_owner",
            )
        ]

    def __str__(self):
        return self.full_name or self.email

    def save(self, *args, **kwargs):
        self.email = self.email.lower()
        super().save(*args, **kwargs)

    def get_full_name(self):
        return self.full_name or self.email

    def get_short_name(self):
        return (self.full_name or self.email).split(" ")[0]


class ApiTokenQuerySet(models.QuerySet):
    def usable(self):
        now = timezone.now()
        return self.filter(revoked_at__isnull=True).filter(
            models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=now)
        )


class ApiToken(models.Model):
    """Per-user read-only API token. Only a SHA-256 hash of the secret is stored."""

    PREFIX_LENGTH = 8

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="api_tokens")
    name = models.CharField(max_length=100)
    prefix = models.CharField(max_length=PREFIX_LENGTH, db_index=True)
    key_hash = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(default=timezone.now)
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    objects = ApiTokenQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.name} ({self.prefix}…)"

    @staticmethod
    def hash_key(raw_key: str) -> str:
        return hashlib.sha256(raw_key.encode()).hexdigest()

    @classmethod
    def issue(cls, user, name: str, expires_at=None) -> tuple["ApiToken", str]:
        """Create a token and return it with the raw secret, which is never stored."""
        raw_key = f"afsa_{secrets.token_urlsafe(32)}"
        token = cls.objects.create(
            user=user,
            name=name,
            prefix=raw_key[5 : 5 + cls.PREFIX_LENGTH],
            key_hash=cls.hash_key(raw_key),
            expires_at=expires_at,
        )
        return token, raw_key

    @property
    def is_usable(self) -> bool:
        if self.revoked_at is not None:
            return False
        return self.expires_at is None or self.expires_at > timezone.now()
