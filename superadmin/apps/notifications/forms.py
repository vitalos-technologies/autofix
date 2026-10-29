from django import forms

from apps.core.forms import StyledFormMixin

from .models import NotificationPreference


class PreferenceForm(StyledFormMixin, forms.ModelForm):
    class Meta:
        model = NotificationPreference
        fields = ["job_failures", "domain_failures", "onboarding_stuck", "messaging_failures", "voicemails"]
