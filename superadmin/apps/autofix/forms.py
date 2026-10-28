from django import forms

from apps.accounts.stepup import StepUpMixin
from apps.core.forms import StyledFormMixin

from .models import GARAGE_STATUSES
from .plans import PLAN_CHOICES

REASON_WIDGET = forms.Textarea(attrs={"maxlength": 500, "minlength": 5})
REASON_HELP = "5 to 500 characters. Logged in Autofix and shown to the garage's owners."


class ReasonForm(StyledFormMixin, StepUpMixin, forms.Form):
    reason = forms.CharField(min_length=5, max_length=500, widget=REASON_WIDGET, help_text=REASON_HELP)


class PlanStatusForm(StyledFormMixin, StepUpMixin, forms.Form):
    plan = forms.ChoiceField(choices=PLAN_CHOICES)
    status = forms.ChoiceField(choices=GARAGE_STATUSES)
    reason = forms.CharField(min_length=5, max_length=500, widget=REASON_WIDGET, help_text=REASON_HELP)


class ViewAsSupportForm(StyledFormMixin, StepUpMixin, forms.Form):
    reason = forms.CharField(
        min_length=5,
        max_length=500,
        widget=REASON_WIDGET,
        help_text="Why you need to see this garage's app. Logged here and again in Autofix.",
    )


class BulkStatusForm(StyledFormMixin, StepUpMixin, forms.Form):
    status = forms.ChoiceField(choices=GARAGE_STATUSES)
    reason = forms.CharField(min_length=5, max_length=500, widget=REASON_WIDGET, help_text=REASON_HELP)
