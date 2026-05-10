from __future__ import annotations

import logging
import time
from typing import Any

import requests

from exchange_clients.base import ExchangeClientError


class RetryableExchangeClientError(ExchangeClientError):
    """Exchange error that should be retried by the HTTP wrapper."""


class RetryingHttpClient:
    def __init__(
        self,
        *,
        base_url: str,
        timeout_sec: float,
        max_attempts: int,
        base_delay_sec: float,
        logger: logging.Logger | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_sec = timeout_sec
        self.max_attempts = max(1, max_attempts)
        self.base_delay_sec = max(0.0, base_delay_sec)
        self.session = requests.Session()
        self.logger = logger or logging.getLogger(__name__)

    def get_json(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        last_error: Exception | None = None

        for attempt in range(1, self.max_attempts + 1):
            response = None
            try:
                response = self.session.get(url, params=params, timeout=self.timeout_sec)
                if response.status_code == 429 or 500 <= response.status_code <= 599:
                    raise RetryableExchangeClientError(
                        f"HTTP {response.status_code} from {url}: {response.text[:300]}"
                    )
                if response.status_code >= 400:
                    raise ExchangeClientError(
                        f"HTTP {response.status_code} from {url}: {response.text[:300]}"
                    )
                return response.json()
            except (requests.Timeout, requests.ConnectionError, RetryableExchangeClientError) as exc:
                last_error = exc
                if attempt >= self.max_attempts:
                    break

                delay = self._retry_delay(attempt, response_retry_after=response)
                self.logger.warning(
                    "Request failed, retrying in %.2fs: url=%s attempt=%s/%s error=%s",
                    delay,
                    url,
                    attempt,
                    self.max_attempts,
                    exc,
                )
                time.sleep(delay)
            except ValueError as exc:
                raise ExchangeClientError(f"Invalid JSON from {url}: {exc}") from exc
            except requests.RequestException as exc:
                raise ExchangeClientError(f"Request failed for {url}: {exc}") from exc

        raise ExchangeClientError(f"Request failed after {self.max_attempts} attempts: {url}: {last_error}")

    def _retry_delay(self, attempt: int, *, response_retry_after: Any | None) -> float:
        retry_after = getattr(response_retry_after, "headers", {}).get("Retry-After")
        if retry_after:
            try:
                return min(float(retry_after), 60.0)
            except ValueError:
                pass
        return min(self.base_delay_sec * (2 ** (attempt - 1)), 30.0)
