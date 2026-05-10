from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol


@dataclass(frozen=True)
class MexcPrices:
    symbol: str
    fair_price: Decimal
    last_price: Decimal


class ExchangeClientError(RuntimeError):
    """Raised when an exchange client cannot fetch or parse market data."""


class MexcMarketDataClient(Protocol):
    def get_prices(self, symbol: str) -> MexcPrices:
        """Return MEXC fair and last prices for a futures contract."""


class LastPriceClient(Protocol):
    def get_last_price(self, symbol: str) -> Decimal:
        """Return last traded futures price for a contract."""

