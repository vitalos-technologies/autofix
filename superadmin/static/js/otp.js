// Two-factor code fields: submit as soon as the last digit is entered or pasted, and show that
// the check is under way. The Verify button stays for keyboard users and if this script fails.
(function () {
  "use strict";

  document.querySelectorAll("input[data-autosubmit]").forEach(function (input) {
    var form = input.form;
    var length = parseInt(input.getAttribute("data-autosubmit"), 10) || 6;
    var submitting = false;

    function submit() {
      if (submitting) return;
      submitting = true;
      var button = form.querySelector("button[type=submit]");
      if (button) {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.textContent = "Verifying\u2026";
      }
      input.readOnly = true;
      form.submit();
    }

    input.addEventListener("input", function () {
      var digits = input.value.replace(/\D/g, "");
      if (digits !== input.value) input.value = digits;
      if (digits.length === length) submit();
    });

    // A manual submit (Enter or the button) also shows the waiting state and blocks a second send.
    form.addEventListener("submit", function (event) {
      if (submitting) {
        event.preventDefault();
        return;
      }
      submitting = true;
      var button = form.querySelector("button[type=submit]");
      if (button) {
        button.setAttribute("aria-busy", "true");
        button.textContent = "Verifying\u2026";
      }
    });
  });
})();
