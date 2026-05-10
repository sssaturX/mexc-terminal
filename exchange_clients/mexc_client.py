from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from exchange_clients.base import ExchangeClientError, MexcPrices
from exchange_clients.http import RetryingHttpClient


def normalize_mexc_symbol(symbol: str) -> str:
    return symbol.strip().upper().replace("-", "_").replace("/", "_")


class MexcFuturesClient:
    """REST market-data client for MEXC USDT-M perpetual futures."""

    def __init__(self, http_client: RetryingHttpClient) -> None:
        self.http = http_client

    def get_fair_price(self, symbol: str) -> Decimal:
        normalized = normalize_mexc_symbol(symbol)
        payload = self.http.get_json(f"/api/v1/contract/fair_price/{normalized}")
        data = self._extract_success_data(payload, "fair price")
        return self._decimal(data.get("fairPrice"), f"{normalized}.fairPrice")

    def get_last_price(self, symbol: str) -> Decimal:
        normalized = normalize_mexc_symbol(symbol)
        payload = self.http.get_json("/api/v1/contract/ticker", params={"symbol": normalized})
        data = self._extract_success_data(payload, "ticker")
        if isinstance(data, list):
            data = self._find_symbol(data, normalized)
        return self._decimal(data.get("lastPrice"), f"{normalized}.lastPrice")

    def get_prices(self, symbol: str) -> MexcPrices:
        normalized = normalize_mexc_symbol(symbol)
        fair_price = self.get_fair_price(normalized)
        last_price = self.get_last_price(normalized)
        return MexcPrices(symbol=normalized, fair_price=fair_price, last_price=last_price)

    def _extract_success_data(self, payload: Any, context: str) -> Any:
        if not isinstance(payload, dict):
            raise ExchangeClientError(f"Unexpected MEXC {context} response: {payload!r}")
        if payload.get("success") is False:
            raise ExchangeClientError(f"MEXC {context} error: {payload!r}")
        data = payload.get("data")
        if data is None:
            raise ExchangeClientError(f"MEXC {context} response has no data: {payload!r}")
        return data

    def _find_symbol(self, rows: list[Any], symbol: str) -> dict[str, Any]:
        for row in rows:
            if isinstance(row, dict) and row.get("symbol") == symbol:
                return row
        raise ExchangeClientError(f"MEXC ticker did not contain {symbol}")

    def _decimal(self, value: Any, field_name: str) -> Decimal:
        if value is None:
            raise ExchangeClientError(f"MEXC response missing {field_name}")
        try:
            return Decimal(str(value))
        except (InvalidOperation, ValueError) as exc:
            raise ExchangeClientError(f"Invalid MEXC decimal {field_name}={value!r}") from exc

