from django.http import HttpResponseServerError
from django.shortcuts import render
from django.template import loader
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

from apps.accounts.roles import role_required
from apps.autofix import selectors
from apps.autofix.db import AutofixUnavailable
from apps.autofix.views.common import unavailable_message

from . import health, palette


def permission_denied(request, exception=None):
    return render(request, "errors/403.html", status=403)


def page_not_found(request, exception=None):
    return render(request, "errors/404.html", status=404)


def server_error(request):
    # Rendered without the request so a database outage cannot break the error page itself.
    return HttpResponseServerError(loader.get_template("errors/500.html").render({}))


@role_required()
@require_GET
@never_cache
def overview(request):
    """KPIs, items needing attention and system status. Each block degrades on its own."""
    context = {"kpis": None, "attention": None, "error": ""}
    try:
        context["kpis"] = selectors.overview_kpis()
        context["attention"] = selectors.attention_items()
        context["plans"] = selectors.plan_counts()
    except AutofixUnavailable as error:
        context["error"] = unavailable_message(error)
    results = health.checks()
    context["checks"] = results
    context["overall"] = health.overall(results)
    return render(request, "core/overview.html", context)


@role_required()
@require_GET
def palette_results(request):
    query = request.GET.get("q", "")
    return render(
        request,
        "partials/palette_results.html",
        {"groups": palette.results(request.user, query), "query": query},
    )


@role_required()
@require_GET
def search(request):
    """Live search in the top bar (HTMX dropdown) and its full page: pages, garages and domains."""
    query = request.GET.get("q", "").strip()[:100]
    groups = palette.results(request.user, query) if query else []
    template = "partials/search_results.html" if getattr(request, "htmx", False) else "core/search.html"
    return render(request, template, {"groups": groups, "query": query})


@role_required()
@require_GET
def help_page(request):
    return render(request, "core/help.html")


@role_required()
@require_GET
def health_page(request):
    results = health.checks()
    return render(request, "core/health.html", {"checks": results, "overall": health.overall(results)})


@role_required()
@require_GET
def health_footer(request):
    """Loaded after each page renders, so health checks never slow a page down."""
    return render(request, "partials/health_footer.html", {"overall": health.overall(health.checks())})
