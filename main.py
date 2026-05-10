from __future__ import annotations

import argparse
import logging
import sys

from alerts.notifier_base import create_notifier
from config import configure_logging, load_settings
from exchange_clients.gate_client import GateFuturesClient
from exchange_clients.http import RetryingHttpClient
from exchange_clients.mexc_client import MexcFuturesClient
from spread_checker import SpreadChecker


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Spread Checker for MEXC and Gate.io perpetual futures.")
    parser.add_argument("--config", help="Path to config.yaml")
    parser.add_argument("--symbols", nargs="+", help="Override symbols, e.g. BTC_USDT ETH_USDT")
    parser.add_argument("--dry-run", action="store_true", help="Log alerts without sending notifications")
    parser.add_argument("--once", action="store_true", help="Run one polling cycle and exit")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    settings = load_settings(
        config_path=args.config,
        cli_symbols=args.symbols,
        cli_dry_run=True if args.dry_run else None,
    )
    configure_logging(settings.log_file)
    logger = logging.getLogger("spread_checker.main")

    mexc_http = RetryingHttpClient(
        base_url=settings.mexc_base_url,
        timeout_sec=settings.request_timeout_sec,
        max_attempts=settings.retry_max_attempts,
        base_delay_sec=settings.retry_base_delay_sec,
        logger=logging.getLogger("spread_checker.mexc_http"),
    )
    gate_http = RetryingHttpClient(
        base_url=settings.gate_base_url,
        timeout_sec=settings.request_timeout_sec,
        max_attempts=settings.retry_max_attempts,
        base_delay_sec=settings.retry_base_delay_sec,
        logger=logging.getLogger("spread_checker.gate_http"),
    )

    checker = SpreadChecker(
        settings=settings,
        mexc_client=MexcFuturesClient(mexc_http),
        gate_client=GateFuturesClient(gate_http, settle=settings.gate_settle),
        notifier=create_notifier(settings, logging.getLogger("spread_checker.notifier")),
        logger=logging.getLogger("spread_checker"),
    )

    try:
        if args.once:
            checker.check_once()
        else:
            checker.run_forever()
    except KeyboardInterrupt:
        logger.info("Spread Checker stopped by user")
    return 0


if __name__ == "__main__":
    sys.exit(main())

