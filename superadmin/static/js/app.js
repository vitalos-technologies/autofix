// Autofix Super Admin client behaviour (from the Vitalos Super Admin). Loaded as an external file so the CSP needs no inline script.
(function () {
  "use strict";

  function modal() {
    return document.getElementById("modal");
  }

  function closeModal() {
    var element = modal();
    if (element) element.innerHTML = "";
    document.body.classList.remove("overflow-hidden");
  }

  function showToast(message, tone) {
    var region = document.getElementById("toasts");
    if (!region || !message) return;
    var toast = document.createElement("div");
    toast.setAttribute("role", tone === "error" ? "alert" : "status");
    toast.className =
      tone === "error"
        ? "rounded-lg bg-rose-600 px-4 py-3 text-sm font-medium text-white shadow-lg"
        : "rounded-lg bg-midnight px-4 py-3 text-sm font-medium text-white shadow-lg dark:bg-slate-700";
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(function () {
      toast.remove();
    }, 5000);
  }

  function clearSearch() {
    var results = document.getElementById("search-results");
    if (results) results.innerHTML = "";
  }

  // ---------------------------------------------------------------------------------------------
  // Preferences live in first-party cookies so the server renders the right state (no flash).
  var root = document.documentElement;
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  function setCookie(name, value) {
    var secure = window.location.protocol === "https:" ? "; Secure" : "";
    // Scoped to the app's path, so the Autofix app on the same host never sees them.
    var path = root.getAttribute("data-cookie-path") || "/";
    document.cookie = name + "=" + value + "; Path=" + path + "; Max-Age=31536000; SameSite=Strict" + secure;
  }

  function isTyping(target) {
    return (
      target &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    );
  }

  // Sidebar: collapse to the icon rail on desktop (Ctrl/Cmd+B); off-canvas sheet below 768px.
  function sidebar() {
    return document.getElementById("sidebar");
  }

  function toggleCollapsed() {
    var collapsed = root.getAttribute("data-sidebar") !== "collapsed";
    root.setAttribute("data-sidebar", collapsed ? "collapsed" : "expanded");
    setCookie("afsa_sidebar", collapsed ? "collapsed" : "expanded");
    document.querySelectorAll("[data-sidebar-toggle]").forEach(function (button) {
      button.setAttribute("aria-expanded", collapsed ? "false" : "true");
      var label = button.querySelector(".nav-label");
      if (label) label.textContent = collapsed ? "Expand sidebar" : "Collapse sidebar";
    });
  }

  var sheetOpener = null;

  function openSheet(opener) {
    var element = sidebar();
    if (!element) return;
    sheetOpener = opener || document.activeElement;
    root.setAttribute("data-sidebar-open", "");
    var backdrop = document.querySelector("[data-sidebar-backdrop]");
    if (backdrop) backdrop.classList.remove("hidden");
    document.querySelectorAll("[data-sidebar-open]").forEach(function (button) {
      if (button !== root) button.setAttribute("aria-expanded", "true");
    });
    var first = element.querySelector("a, button");
    if (first) first.focus();
  }

  function closeSheet() {
    if (!root.hasAttribute("data-sidebar-open")) return;
    root.removeAttribute("data-sidebar-open");
    var backdrop = document.querySelector("[data-sidebar-backdrop]");
    if (backdrop) backdrop.classList.add("hidden");
    document.querySelectorAll("button[data-sidebar-open]").forEach(function (button) {
      button.setAttribute("aria-expanded", "false");
    });
    if (sheetOpener && sheetOpener.focus) sheetOpener.focus();
    sheetOpener = null;
  }

  function trapSheetFocus(event) {
    if (event.key !== "Tab" || !root.hasAttribute("data-sidebar-open")) return;
    var focusable = Array.prototype.filter.call(
      sidebar().querySelectorAll("a[href], button, summary, [tabindex]:not([tabindex='-1'])"),
      function (element) {
        return element.offsetParent !== null;
      },
    );
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Theme: system → light → dark → system.
  var THEMES = ["system", "light", "dark"];

  function cycleTheme() {
    var current = root.getAttribute("data-theme") || "system";
    var next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    root.setAttribute("data-theme", next);
    setCookie("afsa_theme", next);
    document.querySelectorAll("[data-theme-label]").forEach(function (label) {
      label.textContent = next.charAt(0).toUpperCase() + next.slice(1);
    });
  }

  // Command palette (accessible combobox in a modal <dialog>).
  function palette() {
    return document.getElementById("palette");
  }

  function paletteOptions() {
    return Array.prototype.slice.call(document.querySelectorAll("#palette-list [data-palette-option]"));
  }

  function selectOption(index) {
    var options = paletteOptions();
    var input = document.querySelector("[data-palette-input]");
    if (!options.length || !input) {
      if (input) input.removeAttribute("aria-activedescendant");
      return;
    }
    var bounded = (index + options.length) % options.length;
    options.forEach(function (option, position) {
      option.setAttribute("aria-selected", position === bounded ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", options[bounded].id);
    options[bounded].scrollIntoView({ block: "nearest" });
  }

  function selectedIndex() {
    return paletteOptions().findIndex(function (option) {
      return option.getAttribute("aria-selected") === "true";
    });
  }

  function openPalette() {
    var dialog = palette();
    if (!dialog || dialog.open) return;
    closeSheet();
    dialog.showModal();
    var input = dialog.querySelector("[data-palette-input]");
    input.value = "";
    input.focus();
    if (window.htmx) window.htmx.trigger(input, "palette-open");
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (target.closest("[data-sidebar-toggle]")) toggleCollapsed();
    if (target.closest("button[data-sidebar-open]")) openSheet(target.closest("button"));
    if (target.closest("[data-sidebar-close]") || target.matches("[data-sidebar-backdrop]")) closeSheet();
    if (target.closest("[data-theme-toggle]")) cycleTheme();
    if (target.closest("[data-palette-open]")) openPalette();
    // The top bar's Refresh link: reload the address bar's URL (HTMX may have moved it on).
    if (target.closest("a[data-refresh]") && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      window.location.reload();
    }
    var dialog = palette();
    if (dialog && target === dialog) dialog.close(); // Click on the backdrop.
  });

  document.addEventListener("keydown", function (event) {
    var mod = event.metaKey || event.ctrlKey;
    var key = event.key.toLowerCase();
    if (mod && key === "k") {
      event.preventDefault();
      openPalette();
      return;
    }
    if (mod && key === "b" && !isTyping(event.target) && sidebar()) {
      event.preventDefault();
      toggleCollapsed();
      return;
    }
    if (event.key === "Escape") closeSheet();
    trapSheetFocus(event);
    if (event.target.matches && event.target.matches("[data-palette-input]")) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        selectOption(selectedIndex() + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter") {
        var options = paletteOptions();
        var chosen = options[selectedIndex()] || options[0];
        if (chosen) {
          event.preventDefault();
          window.location.assign(chosen.getAttribute("href"));
        }
      }
    }
  });

  document.addEventListener("htmx:afterSwap", function (event) {
    if (event.detail.target && event.detail.target.id === "palette-list") selectOption(0);
  });

  if (isMac) {
    document.querySelectorAll("[data-kbd-mod]").forEach(function (element) {
      element.textContent = "⌘K";
    });
  }


  // Sign-out confirmation: the menu button opens a <dialog>; without JS the form posts directly.
  var logoutReturn = null;
  function logoutDialog() {
    var dialog = document.getElementById("logout-dialog");
    return dialog && typeof dialog.showModal === "function" ? dialog : null;
  }
  document.addEventListener("click", function (event) {
    var dialog = logoutDialog();
    if (!dialog) return;
    var open = event.target.closest("[data-confirm-logout]");
    if (open) {
      event.preventDefault();
      logoutReturn = open;
      dialog.showModal();
      var cancel = dialog.querySelector("[data-close-logout]");
      if (cancel) cancel.focus();
    } else if (event.target.closest("[data-close-logout]") || event.target === dialog) {
      dialog.close();
    }
  });
  document.addEventListener(
    "close",
    function (event) {
      if (event.target.id !== "logout-dialog" || !logoutReturn) return;
      var details = logoutReturn.closest("details[data-menu]");
      if (details) details.setAttribute("open", "");
      logoutReturn.focus();
      logoutReturn = null;
    },
    true,
  );

  document.addEventListener("vsa-close-modal", closeModal);
  document.addEventListener("vsa-toast", function (event) {
    showToast(event.detail && event.detail.message);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeModal();
      clearSearch();
      document.querySelectorAll("details[open][data-menu]").forEach(function (menu) {
        menu.removeAttribute("open");
      });
    }
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (target.closest("[data-close-modal]") || target.matches("[data-modal-backdrop]")) {
      event.preventDefault();
      closeModal();
    }
    if (!target.closest("[data-search]")) clearSearch();
    document.querySelectorAll("details[open][data-menu]").forEach(function (menu) {
      if (!menu.contains(target)) menu.removeAttribute("open");
    });
    var copy = target.closest("[data-copy]");
    if (copy) {
      var source = document.getElementById(copy.getAttribute("data-copy"));
      if (source && navigator.clipboard) {
        navigator.clipboard.writeText(source.textContent.trim()).then(function () {
          copy.textContent = "Copied";
        });
      }
    }
  });

  document.addEventListener("htmx:afterSwap", function (event) {
    if (event.detail.target && event.detail.target.id === "modal") {
      document.body.classList.add("overflow-hidden");
      var first = event.detail.target.querySelector(
        "input:not([type=hidden]):not([type=checkbox]), select, textarea",
      );
      if (first) first.focus();
    }
  });

  document.addEventListener("htmx:responseError", function (event) {
    var status = event.detail.xhr ? event.detail.xhr.status : 0;
    var message =
      status === 403
        ? "You do not have permission to do that."
        : status === 429
          ? "Too many attempts. Please wait and try again."
          : "Something went wrong. Please try again.";
    showToast(message, "error");
  });

  document.addEventListener("htmx:sendError", function () {
    showToast("Network error. Check your connection and try again.", "error");
  });

  // Sidebar dropdowns (Mail): show or hide the child links.
  document.addEventListener("click", function (event) {
    var toggle = event.target.closest("[data-nav-toggle]");
    if (!toggle) return;
    var list = document.getElementById(toggle.getAttribute("aria-controls"));
    var open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (list) list.hidden = !open;
  });

  // Email template editor: insert a merge variable at the caret of the last focused text field.
  var lastTemplateField = null;
  document.addEventListener("focusin", function (event) {
    var field = event.target;
    if (field.closest && field.closest("[data-template-form]") && field.matches("input[type=text], textarea")) {
      lastTemplateField = field;
    }
  });
  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-insert-variable]");
    if (!button) return;
    event.preventDefault();
    var token = button.getAttribute("data-insert-variable");
    var field = lastTemplateField && document.body.contains(lastTemplateField) ? lastTemplateField : null;
    if (!field) {
      if (navigator.clipboard) navigator.clipboard.writeText(token);
      showToast("Copied " + token + ". Click into a field to insert variables.", "info");
      return;
    }
    var start = field.selectionStart == null ? field.value.length : field.selectionStart;
    var end = field.selectionEnd == null ? start : field.selectionEnd;
    field.setRangeText(token, start, end, "end");
    field.focus();
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Garage tabs load with HTMX: move aria-current to the tab that was clicked.
  document.addEventListener("htmx:afterSwap", function (event) {
    if (!event.detail.target || event.detail.target.id !== "garage-tab") return;
    var clicked = event.detail.requestConfig && event.detail.requestConfig.elt;
    if (!clicked || !clicked.matches || !clicked.matches("[data-tab]")) return;
    document.querySelectorAll("[data-tab]").forEach(function (tab) {
      if (tab === clicked) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
  });

  // Plain form posts that need a confirm (no inline handlers: the CSP allows only nonced scripts).
  document.addEventListener("submit", function (event) {
    var form = event.target;
    var message = form.getAttribute && form.getAttribute("data-confirm");
    if (message && !window.confirm(message)) event.preventDefault();
  });

  // Bulk actions on list pages: row checkboxes, "select all on this page" and the action bar. Without
  // JavaScript the bar stays visible and the form still posts; the server rejects an empty selection.
  function bulkItems() {
    return Array.prototype.slice.call(document.querySelectorAll("[data-bulk-item]"));
  }

  function syncBulk() {
    var bar = document.querySelector("[data-bulk-bar]");
    if (!bar) return;
    var items = bulkItems();
    var checked = items.filter(function (item) {
      return item.checked;
    }).length;
    var all = document.querySelector("[data-bulk-all]");
    if (all) {
      all.checked = items.length > 0 && checked === items.length;
      all.indeterminate = checked > 0 && checked < items.length;
    }
    var count = bar.querySelector("[data-bulk-count]");
    if (count) count.textContent = checked ? checked + " selected" : "Select items to act on them";
    bar.classList.toggle("hidden", checked === 0);
  }

  document.addEventListener("change", function (event) {
    var target = event.target;
    if (!target.matches) return;
    if (target.matches("[data-bulk-all]")) {
      bulkItems().forEach(function (item) {
        item.checked = target.checked;
      });
      syncBulk();
    } else if (target.matches("[data-bulk-item]")) {
      syncBulk();
    }
  });

  document.addEventListener("click", function (event) {
    if (!event.target.closest("[data-bulk-clear]")) return;
    bulkItems().forEach(function (item) {
      item.checked = false;
    });
    syncBulk();
  });

  // Back/forward restores checkbox state; recount on load and on show.
  window.addEventListener("pageshow", syncBulk);
  syncBulk();

  // ---------------------------------------------------------------------------------------------
  // Busy states: button spinners (full-page and HTMX submissions), a blurred "Saving…" overlay for
  // full-page POST submissions, and a slim progress bar for HTMX navigations that swap main content.
  // Opt a form out of the overlay with data-no-submit-overlay.
  var SVG_NS = "http://www.w3.org/2000/svg";
  var busyButtons = [];
  var submitting = false;

  function spinnerNode() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "btn-spinner h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none");
    var track = document.createElementNS(SVG_NS, "circle");
    track.setAttribute("cx", "12");
    track.setAttribute("cy", "12");
    track.setAttribute("r", "9");
    track.setAttribute("stroke", "currentColor");
    track.setAttribute("stroke-width", "3");
    track.setAttribute("opacity", "0.25");
    var arc = document.createElementNS(SVG_NS, "path");
    arc.setAttribute("d", "M21 12a9 9 0 0 0-9-9");
    arc.setAttribute("stroke", "currentColor");
    arc.setAttribute("stroke-width", "3");
    arc.setAttribute("stroke-linecap", "round");
    svg.appendChild(track);
    svg.appendChild(arc);
    return svg;
  }

  function isButtonLike(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.tagName === "BUTTON") return element.type !== "reset";
    if (element.tagName === "INPUT") return element.type === "submit" || element.type === "button";
    return element.tagName === "A" && element.classList.contains("btn");
  }

  function setBusy(button) {
    if (!isButtonLike(button) || button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    if (button.tagName === "A") {
      button.setAttribute("aria-disabled", "true");
      button.classList.add("pointer-events-none");
    } else {
      button.disabled = true;
    }
    if (button.tagName !== "INPUT") {
      var icon = button.querySelector(":scope > svg");
      if (icon) {
        icon.classList.add("hidden");
        icon.setAttribute("data-spinner-hid", "");
      }
      button.insertBefore(spinnerNode(), button.firstChild);
    }
    busyButtons.push(button);
  }

  function clearBusy(button) {
    var index = busyButtons.indexOf(button);
    if (index !== -1) busyButtons.splice(index, 1);
    button.removeAttribute("aria-busy");
    if (button.tagName === "A") {
      button.removeAttribute("aria-disabled");
      button.classList.remove("pointer-events-none");
    } else {
      button.disabled = false;
    }
    button.querySelectorAll(":scope > .btn-spinner").forEach(function (node) {
      node.remove();
    });
    button.querySelectorAll(":scope > svg[data-spinner-hid]").forEach(function (node) {
      node.classList.remove("hidden");
      node.removeAttribute("data-spinner-hid");
    });
  }

  function submitOverlay() {
    return document.getElementById("submit-overlay");
  }

  function showSubmitOverlay(label) {
    var overlay = submitOverlay();
    if (!overlay) return;
    var text = overlay.querySelector("[data-submit-overlay-text]");
    if (text) text.textContent = label;
    overlay.hidden = false;
    submitting = true;
  }

  function hideSubmitOverlay() {
    var overlay = submitOverlay();
    if (overlay) overlay.hidden = true;
    submitting = false;
  }

  function overlayLabel(form, submitter) {
    var explicit = form.getAttribute("data-submit-label");
    if (explicit) return explicit;
    var text = ((submitter && (submitter.value || submitter.textContent)) || "").trim().toLowerCase();
    return /^(save|publish|create|add|update|apply|confirm|send|import)/.test(text)
      ? "Saving…"
      : "Working…";
  }

  // Full-page submissions. Deferred one tick so handlers that cancel the submit (confirm prompts,
  // validation, HTMX) have run first; the form data is read before the button is disabled.
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || form.tagName !== "FORM") return;
    if (submitting) {
      event.preventDefault();
      return;
    }
    if (event.defaultPrevented) return;
    var submitter = event.submitter;
    window.setTimeout(function () {
      if (event.defaultPrevented) return;
      if (submitter) setBusy(submitter);
      var method = (form.getAttribute("method") || "get").toLowerCase();
      var target = form.getAttribute("target");
      var submitterTarget = submitter && submitter.getAttribute("formtarget");
      var skip =
        method !== "post" ||
        form.hasAttribute("data-no-submit-overlay") ||
        form.hasAttribute("hx-post") ||
        form.hasAttribute("download") ||
        (target && target !== "_self") ||
        (submitterTarget && submitterTarget !== "_self");
      if (!skip) showSubmitOverlay(overlayLabel(form, submitter));
    }, 0);
  });

  // Back/forward restore from the bfcache: never leave the page stuck in a busy state.
  window.addEventListener("pageshow", function () {
    busyButtons.slice().forEach(clearBusy);
    hideSubmitOverlay();
  });

  // HTMX requests: spinner on the triggering button; progress bar for navigations.
  function requestButton(detail) {
    var elt = detail.elt;
    if (!elt) return null;
    if (elt.tagName === "FORM") {
      var triggering = detail.requestConfig && detail.requestConfig.triggeringEvent;
      var submitter = triggering && triggering.submitter;
      if (isButtonLike(submitter)) return submitter;
      if (triggering && triggering.type && triggering.type !== "submit") return null;
      return elt.querySelector("button[type='submit'], button:not([type]), input[type='submit']");
    }
    return isButtonLike(elt) ? elt : null;
  }

  function navigationRequest(detail) {
    var main = document.getElementById("main");
    return Boolean(
      detail.elt &&
        detail.target &&
        detail.elt.hasAttribute &&
        detail.elt.hasAttribute("hx-push-url") &&
        main &&
        main.contains(detail.target),
    );
  }

  var progressCount = 0;

  function progress(on) {
    var bar = document.getElementById("nav-progress");
    progressCount = Math.max(0, progressCount + (on ? 1 : -1));
    if (bar) bar.hidden = progressCount === 0;
  }

  document.addEventListener("htmx:beforeRequest", function (event) {
    var detail = event.detail;
    var button = requestButton(detail);
    if (button) {
      if (button.getAttribute("aria-busy") === "true") {
        event.preventDefault(); // a second submit while one is in flight
        return;
      }
      setBusy(button);
    }
    if (navigationRequest(detail)) {
      detail.elt.setAttribute("data-htmx-nav", "");
      detail.target.setAttribute("aria-busy", "true");
      detail.target.classList.add("opacity-60", "animate-pulse", "motion-reduce:animate-none");
      progress(true);
    }
  });

  document.addEventListener("htmx:afterRequest", function (event) {
    var detail = event.detail;
    var button = requestButton(detail);
    if (button && button.isConnected) clearBusy(button);
    if (detail.elt && detail.elt.hasAttribute && detail.elt.hasAttribute("data-htmx-nav")) {
      detail.elt.removeAttribute("data-htmx-nav");
      progress(false);
      if (detail.target && detail.target.isConnected) {
        detail.target.removeAttribute("aria-busy");
        detail.target.classList.remove("opacity-60", "animate-pulse", "motion-reduce:animate-none");
      }
    }
  });

  // Auto-dismiss server-rendered flash messages.
  window.setTimeout(function () {
    document.querySelectorAll("[data-autodismiss]").forEach(function (element) {
      element.remove();
    });
  }, 6000);
})();
