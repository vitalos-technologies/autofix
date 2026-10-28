"""KPI card values (rendered by ``templates/partials/kpi_card.html``)."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Delta:
    """Change against the previous equivalent period: text plus direction, never colour alone."""

    text: str
    direction: str = "flat"
    tone: str = "neutral"


@dataclass(frozen=True)
class Kpi:
    key: str
    label: str
    value: str
    timeframe: str
    delta: Delta | None = None
    note: str = ""
