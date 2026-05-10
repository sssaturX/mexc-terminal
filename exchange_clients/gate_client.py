from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from exchange_clients.base import ExchangeClientError
from exchange_clients.http import RetryingHttpClient


def normalize_gate_symbol(symbol: str) -> str:
    return symbol.strip().upper().replace("-", "_").replace("/", "_")


class GateFuturesClient:
    """REST market-data client for Gate.io perpetual futures API v4."""

    def __init__(self, http_client: RetryingHttpClient, *, settle: str = "usdt") -> None:
        self.http = http_client
        self.settle = settle.strip().lower()

    def get_last_price(self, symbol: str) -> Decimal:
        normalized = normalize_gate_symbol(symbol)
        payload = self.http.get_json(
            f"/futures/{self.settle}/tickers",
            params={"contract": normalized},
        )
        data = self._extract_ticker(payload, normalized)
        return self._decimal(data.get("last"), f"{normalized}.last")

    def _extract_ticker(self, payload: Any, symbol: str) -> dict[str, Any]:
        if isinstance(payload, list):
            for row in payload:
                if isinstance(row, dict) and row.get("contract") == symbol:
                    return row
            if len(payload) == 1 and isinstance(payload[0], dict):
                return payload[0]
            raise ExchangeClientError(f"Gate ticker did not contain {symbol}: {payload!r}")
        if isinstance(payload, dict):
            return payload
        raise ExchangeClientError(f"Unexpected Gate ticker response: {payload!r}")

    def _decimal(self, value: Any, field_name: str) -> Decimal:
        if value is None:
            raise ExchangeClientError(f"Gate response missing {field_name}")
        try:
            return Decimal(str(value))
        except (InvalidOperation, ValueError) as exc:
            raise ExchangeClientError(f"Invalid Gate decimal {field_name}={value!r}") from exc

