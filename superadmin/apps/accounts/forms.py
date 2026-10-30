from django import forms
from django.contrib.auth import authenticate, get_user_model, password_validation

from apps.core.forms import StyledFormMixin

from .roles import ROLE_DESCRIPTIONS, ROLES
from .stepup import StepUpMixin


class LoginForm(StyledFormMixin, forms.Form):
    email = forms.EmailField(widget=forms.EmailInput(attrs={"autocomplete": "username", "autofocus": True}))
    password = forms.CharField(
        strip=False, widget=forms.PasswordInput(attrs={"autocomplete": "current-password"})
    )

    error_messages = {"invalid_login": "That email and password combination is not recognised."}

    def __init__(self, request, *args, **kwargs):
        self.request = request
        self.user = None
        super().__init__(*args, **kwargs)

    def clean(self):
        email = (self.cleaned_data.get("email") or "").lower()
        password = self.cleaned_data.get("password")
        if email and password:
            # Passing the request lets django-axes count failures and enforce lockouts.
            self.user = authenticate(self.request, email=email, password=password)
            if self.user is None or not self.user.is_active:
                raise forms.ValidationError(self.error_messages["invalid_login"], code="invalid_login")
        return self.cleaned_data


class OTPTokenForm(StyledFormMixin, forms.Form):
    token = forms.CharField(
        label="6-digit code",
        max_length=8,
        widget=forms.TextInput(
            attrs={
                "autocomplete": "one-time-code",
                "inputmode": "numeric",
                "autofocus": True,
                "pattern": "[0-9 ]*",
                "data-autosubmit": "6",
            }
        ),
    )


ROLE_CHOICES = [(role, f"{role} — {ROLE_DESCRIPTIONS[role]}") for role in ROLES]


class UserCreateForm(StyledFormMixin, StepUpMixin, forms.Form):
    email = forms.EmailField()
    full_name = forms.CharField(max_length=150, required=False)
    role = forms.ChoiceField(choices=ROLE_CHOICES, initial="Support")
    password = forms.CharField(
        label="Initial password",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "new-password"}),
        help_text="At least 12 characters. Share it securely; the user should change it after signing in.",
    )

    def clean_email(self):
        email = self.cleaned_data["email"].lower()
        if get_user_model().objects.filter(email__iexact=email).exists():
            raise forms.ValidationError("A user with this email already exists.")
        return email

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("password") and cleaned.get("email"):
            candidate = get_user_model()(email=cleaned["email"], full_name=cleaned.get("full_name", ""))
            try:
                password_validation.validate_password(cleaned["password"], candidate)
            except forms.ValidationError as exc:
                self.add_error("password", exc)
        return cleaned


class UserEditForm(StyledFormMixin, StepUpMixin, forms.Form):
    full_name = forms.CharField(max_length=150, required=False)
    role = forms.ChoiceField(choices=[("", "No role (no access)"), *ROLE_CHOICES], required=False)
    autofix_admin = forms.ChoiceField(
        label="Linked Pitline platform admin",
        required=False,
        help_text="Needed to change anything in Pitline. Pitline's audit logs show this platform admin.",
    )
    is_active = forms.BooleanField(label="Active", required=False)

    def __init__(self, *args, admin_choices=(), **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["autofix_admin"].choices = [("", "Not linked (read-only in Pitline)"), *admin_choices]


class ProfileForm(StyledFormMixin, forms.ModelForm):
    class Meta:
        model = get_user_model()
        fields = ["full_name"]


class ApiTokenForm(StyledFormMixin, StepUpMixin, forms.Form):
    name = forms.CharField(max_length=100, help_text="What the token is for, e.g. 'Power BI read-only'.")
    expires_in_days = forms.TypedChoiceField(
        label="Expires",
        coerce=int,
        choices=[(30, "In 30 days"), (90, "In 90 days"), (365, "In 1 year"), (0, "Never")],
        initial=90,
    )


class ConfirmPasswordForm(StyledFormMixin, forms.Form):
    password = forms.CharField(
        label="Current password",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "current-password"}),
    )

    def __init__(self, user, *args, **kwargs):
        self.user = user
        super().__init__(*args, **kwargs)

    def clean_password(self):
        password = self.cleaned_data["password"]
        if not self.user.check_password(password):
            raise forms.ValidationError("Incorrect password.")
        return password
