from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, ROUND_HALF_UP

from alerts.notifier_base import Notifier
from config import Settings
from exchange_clients.base import ExchangeClientError, LastPriceClient, MexcMarketDataClient, MexcPrices


MEXC_INTERNAL = "MEXC_INTERNAL"
CROSS_EXCHANGE = "CROSS_EXCHANGE"


@dataclass
class AlertState:
    above_threshold: bool = False
    last_alert_monotonic: float | None = None


class SpreadChecker:
    def __init__(
        self,
        *,
        settings: Settings,
        mexc_client: MexcMarketDataClient,
        gate_client: LastPriceClient,
        notifier: Notifier,
        logger: logging.Logger | None = None,
    ) -> None:
        self.settings = settings
        self.mexc_client = mexc_client
        self.gate_client = gate_client
        self.notifier = notifier
        self.logger = logger or logging.getLogger(__name__)
        self.alert_state: dict[tuple[str, str], AlertState] = {}

    def run_forever(self) -> None:
        self.logger.info(
            "Spread Checker started: symbols=%s interval=%ss dry_run=%s",
            ",".join(self.settings.symbols),
            self.settings.check_interval_sec,
            self.settings.dry_run,
        )
        while True:
            self.check_once()
            time.sleep(self.settings.check_interval_sec)

    def check_once(self) -> None:
        for symbol in self.settings.symbols:
            mexc_prices = self._fetch_mexc_prices(symbol)
            if mexc_prices is None:
                continue

            self._check_mexc_internal(mexc_prices)

            gate_last = self._fetch_gate_last(symbol)
            if gate_last is None:
                continue
            self._check_cross_exchange(mexc_prices, gate_last)

    def _fetch_mexc_prices(self, symbol: str) -> MexcPrices | None:
        try:
            return self.mexc_client.get_prices(symbol)
        except ExchangeClientError as exc:
            self.logger.warning("MEXC unavailable for %s: %s", symbol, exc)
            return None

    def _fetch_gate_last(self, symbol: str) -> Decimal | None:
        try:
            return self.gate_client.get_last_price(symbol)
        except ExchangeClientError as exc:
            self.logger.warning("Gate.io unavailable for %s: %s", symbol, exc)
            return None

    def _check_mexc_internal(self, mexc_prices: MexcPrices) -> None:
        if mexc_prices.fair_price == 0:
            self.logger.warning("Skipping %s MEXC internal spread because fair price is zero", mexc_prices.symbol)
            return
        spread = percent_spread(mexc_prices.last_price, mexc_prices.fair_price)
        direction = (
            "MEXC_LAST_ABOVE_FAIR"
            if mexc_prices.last_price >= mexc_prices.fair_price
            else "MEXC_LAST_BELOW_FAIR"
        )
        message = format_mexc_alert(
            symbol=mexc_prices.symbol,
            fair_price=mexc_prices.fair_price,
            mexc_last=mexc_prices.last_price,
            spread=spread,
            threshold=self.settings.mexc_threshold_percent,
            direction=direction,
        )
        self._process_threshold(
            symbol=mexc_prices.symbol,
            spread_type=MEXC_INTERNAL,
            spread=spread,
            threshold=self.settings.mexc_threshold_percent,
            message=message,
        )

    def _check_cross_exchange(self, mexc_prices: MexcPrices, gate_last: Decimal) -> None:
        if mexc_prices.last_price == 0:
            self.logger.warning("Skipping %s cross-exchange spread because MEXC last price is zero", mexc_prices.symbol)
            return
        spread = percent_spread(gate_last, mexc_prices.last_price)
        direction = "GATE_ABOVE_MEXC" if gate_last >= mexc_prices.last_price else "GATE_BELOW_MEXC"
        message = format_cross_alert(
            symbol=mexc_prices.symbol,
            gate_last=gate_last,
            mexc_last=mexc_prices.last_price,
            spread=spread,
            threshold=self.settings.cross_exchange_threshold_percent,
            direction=direction,
        )
        self._process_threshold(
            symbol=mexc_prices.symbol,
            spread_type=CROSS_EXCHANGE,
            spread=spread,
            threshold=self.settings.cross_exchange_threshold_percent,
            message=message,
        )

    def _process_threshold(
        self,
        *,
        symbol: str,
        spread_type: str,
        spread: Decimal,
        threshold: Decimal,
        message: str,
    ) -> None:
        key = (symbol, spread_type)
        state = self.alert_state.setdefault(key, AlertState())

        if spread < threshold:
            if state.above_threshold:
                self.logger.info("%s %s spread recovered below threshold: %s%% < %s%%", symbol, spread_type, spread, threshold)
            state.above_threshold = False
            return

        cooldown_elapsed = (
            state.last_alert_monotonic is None
            or time.monotonic() - state.last_alert_monotonic >= self.settings.alert_cooldown_sec
        )
        should_alert = not state.above_threshold or cooldown_elapsed
        state.above_threshold = True

        if not should_alert:
            self.logger.info(
                "Alert suppressed by hysteresis/cooldown: symbol=%s type=%s spread=%s%% threshold=%s%%",
                symbol,
                spread_type,
                spread,
                threshold,
            )
            return

        self.logger.warning(
            "Spread threshold triggered: symbol=%s type=%s spread=%s%% threshold=%s%%",
            symbol,
            spread_type,
            spread,
            threshold,
        )
        try:
            self.notifier.send(message)
            state.last_alert_monotonic = time.monotonic()
        except Exception as exc:
            self.logger.error("Notification failed: symbol=%s type=%s error=%s", symbol, spread_type, exc)


def percent_spread(left: Decimal, right: Decimal) -> Decimal:
    return (abs(left - right) / right) * Decimal("100")


def format_mexc_alert(
    *,
    symbol: str,
    fair_price: Decimal,
    mexc_last: Decimal,
    spread: Decimal,
    threshold: Decimal,
    direction: str,
) -> str:
    return "\n".join(
        [
            f"ALERT: {symbol}",
            "Type: MEXC Fair/Last",
            f"Fair: {_price(fair_price)}",
            f"MEXC Last: {_price(mexc_last)}",
            f"Spread: {_percent(spread)}%",
            f"Threshold: {_percent(threshold)}%",
            f"Direction: {direction}",
            f"Time: {_utc_now()} UTC",
        ]
    )


def format_cross_alert(
    *,
    symbol: str,
    gate_last: Decimal,
    mexc_last: Decimal,
    spread: Decimal,
    threshold: Decimal,
    direction: str,
) -> str:
    return "\n".join(
        [
            f"ALERT: {symbol}",
            "Type: Gate vs MEXC",
            f"Gate Last: {_price(gate_last)}",
            f"MEXC Last: {_price(mexc_last)}",
            f"Spread: {_percent(spread)}%",
            f"Threshold: {_percent(threshold)}%",
            f"Direction: {direction}",
            f"Time: {_utc_now()} UTC",
        ]
    )


def _price(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _percent(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def _utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")
