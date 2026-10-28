from django import forms

INPUT = (
    "block min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm "
    "focus:border-cobalt-600 focus:outline-none focus:ring-2 focus:ring-cobalt-600/30 "
    "dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
)
CHECKBOX = "h-4 w-4 rounded border-slate-300 text-cobalt-600 focus:ring-cobalt-600 dark:border-slate-600"


class StyledFormMixin:
    """Apply consistent Tailwind classes so templates can render fields generically."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            widget = field.widget
            if isinstance(widget, forms.CheckboxSelectMultiple):
                widget.attrs.setdefault("class", CHECKBOX)
            elif isinstance(widget, forms.CheckboxInput):
                widget.attrs.setdefault("class", CHECKBOX)
            else:
                widget.attrs.setdefault("class", INPUT)
            if isinstance(widget, forms.Textarea):
                widget.attrs["rows"] = 3
