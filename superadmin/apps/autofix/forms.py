from django import forms

from apps.accounts.stepup import StepUpMixin
from apps.core.forms import StyledFormMixin

from .models import ENQUIRY_STATUSES, GARAGE_STATUSES
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


class EnquiryForm(StyledFormMixin, StepUpMixin, forms.Form):
    """Status and internal notes of a contact page enquiry (``platform_update_enquiry``)."""

    status = forms.ChoiceField(choices=ENQUIRY_STATUSES)
    notes = forms.CharField(
        label="Internal notes",
        required=False,
        strip=False,
        max_length=5000,
        widget=forms.Textarea(attrs={"maxlength": 5000}),
        help_text="Only Vitalos staff see these. Up to 5,000 characters; leave empty to clear them.",
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["notes"].widget.attrs["rows"] = 6


class BulkStatusForm(StyledFormMixin, StepUpMixin, forms.Form):
    status = forms.ChoiceField(choices=GARAGE_STATUSES)
    reason = forms.CharField(min_length=5, max_length=500, widget=REASON_WIDGET, help_text=REASON_HELP)
