from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv


DEFAULTS: dict[str, Any] = {
    "SYMBOLS": "BTC_USDT,ETH_USDT,SOL_USDT",
    "MEXC_THRESHOLD_PERCENT": "0.30",
    "CROSS_EXCHANGE_THRESHOLD_PERCENT": "0.50",
    "CHECK_INTERVAL_SEC": "3",
    "ALERT_COOLDOWN_SEC": "300",
    "NOTIFICATION_METHOD": "push",
    "PUSH_PROVIDER": "pushover",
    "DRY_RUN": "true",
    "MEXC_BASE_URL": "https://contract.mexc.com",
    "GATE_BASE_URL": "https://api.gateio.ws/api/v4",
    "GATE_SETTLE": "usdt",
    "REQUEST_TIMEOUT_SEC": "10",
    "RETRY_MAX_ATTEMPTS": "3",
    "RETRY_BASE_DELAY_SEC": "0.5",
    "LOG_FILE": "logs/spread_checker.log",
    "PUSHOVER_API_URL": "https://api.pushover.net/1/messages.json",
    "NTFY_SERVER": "https://ntfy.sh",
    "SMTP_PORT": "587",
}


@dataclass(frozen=True)
class Settings:
    symbols: list[str]
    mexc_threshold_percent: Decimal
    cross_exchange_threshold_percent: Decimal
    check_interval_sec: int
    alert_cooldown_sec: int
    notification_method: str
    push_provider: str
    dry_run: bool
    mexc_base_url: str
    gate_base_url: str
    gate_settle: str
    request_timeout_sec: float
    retry_max_attempts: int
    retry_base_delay_sec: float
    log_file: str
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from_number: str = ""
    twilio_to_number: str = ""
    pushover_api_url: str = ""
    pushover_app_token: str = ""
    pushover_user_key: str = ""
    ntfy_server: str = ""
    ntfy_topic: str = ""
    ntfy_token: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    email_from: str = ""
    email_to_sms_address: str = ""


def load_settings(
    *,
    config_path: str | None = None,
    cli_symbols: list[str] | None = None,
    cli_dry_run: bool | None = None,
) -> Settings:
    load_dotenv()
    values = dict(DEFAULTS)

    if config_path:
        values.update(_load_yaml_config(config_path))

    for key in _known_keys():
        if key in os.environ:
            values[key] = os.environ[key]

    if cli_symbols:
        values["SYMBOLS"] = ",".join(cli_symbols)
    if cli_dry_run is not None:
        values["DRY_RUN"] = str(cli_dry_run).lower()

    settings = Settings(
        symbols=_parse_symbols(values["SYMBOLS"]),
        mexc_threshold_percent=_decimal(values["MEXC_THRESHOLD_PERCENT"], "MEXC_THRESHOLD_PERCENT"),
        cross_exchange_threshold_percent=_decimal(
            values["CROSS_EXCHANGE_THRESHOLD_PERCENT"], "CROSS_EXCHANGE_THRESHOLD_PERCENT"
        ),
        check_interval_sec=_positive_int(values["CHECK_INTERVAL_SEC"], "CHECK_INTERVAL_SEC"),
        alert_cooldown_sec=_positive_int(values["ALERT_COOLDOWN_SEC"], "ALERT_COOLDOWN_SEC"),
        notification_method=str(values["NOTIFICATION_METHOD"]).lower(),
        push_provider=str(values["PUSH_PROVIDER"]).lower(),
        dry_run=_bool(values["DRY_RUN"]),
        mexc_base_url=str(values["MEXC_BASE_URL"]),
        gate_base_url=str(values["GATE_BASE_URL"]),
        gate_settle=str(values["GATE_SETTLE"]),
        request_timeout_sec=_positive_float(values["REQUEST_TIMEOUT_SEC"], "REQUEST_TIMEOUT_SEC"),
        retry_max_attempts=_positive_int(values["RETRY_MAX_ATTEMPTS"], "RETRY_MAX_ATTEMPTS"),
        retry_base_delay_sec=_positive_float(values["RETRY_BASE_DELAY_SEC"], "RETRY_BASE_DELAY_SEC"),
        log_file=str(values["LOG_FILE"]),
        twilio_account_sid=str(values.get("TWILIO_ACCOUNT_SID", "")),
        twilio_auth_token=str(values.get("TWILIO_AUTH_TOKEN", "")),
        twilio_from_number=str(values.get("TWILIO_FROM_NUMBER", "")),
        twilio_to_number=str(values.get("TWILIO_TO_NUMBER", "")),
        pushover_api_url=str(values.get("PUSHOVER_API_URL", DEFAULTS["PUSHOVER_API_URL"])),
        pushover_app_token=str(values.get("PUSHOVER_APP_TOKEN", "")),
        pushover_user_key=str(values.get("PUSHOVER_USER_KEY", "")),
        ntfy_server=str(values.get("NTFY_SERVER", DEFAULTS["NTFY_SERVER"])),
        ntfy_topic=str(values.get("NTFY_TOPIC", "")),
        ntfy_token=str(values.get("NTFY_TOKEN", "")),
        smtp_host=str(values.get("SMTP_HOST", "")),
        smtp_port=_positive_int(values.get("SMTP_PORT", DEFAULTS["SMTP_PORT"]), "SMTP_PORT"),
        smtp_username=str(values.get("SMTP_USERNAME", "")),
        smtp_password=str(values.get("SMTP_PASSWORD", "")),
        email_from=str(values.get("EMAIL_FROM", "")),
        email_to_sms_address=str(values.get("EMAIL_TO_SMS_ADDRESS", "")),
    )
    _validate(settings)
    return settings


def configure_logging(log_file: str) -> None:
    Path(log_file).parent.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    root.addHandler(console)

    file_handler = logging.FileHandler(log_file)
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)


def _load_yaml_config(config_path: str) -> dict[str, Any]:
    path = Path(config_path)
    if not path.exists():
        raise ValueError(f"Config file does not exist: {config_path}")
    with path.open("r", encoding="utf-8") as file:
        raw = yaml.safe_load(file) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"Config file must contain a mapping: {config_path}")
    return {_normalize_key(key): value for key, value in raw.items()}


def _known_keys() -> set[str]:
    return set(DEFAULTS) | {
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_FROM_NUMBER",
        "TWILIO_TO_NUMBER",
        "PUSHOVER_APP_TOKEN",
        "PUSHOVER_USER_KEY",
        "NTFY_TOPIC",
        "NTFY_TOKEN",
        "SMTP_HOST",
        "SMTP_USERNAME",
        "SMTP_PASSWORD",
        "EMAIL_FROM",
        "EMAIL_TO_SMS_ADDRESS",
    }


def _normalize_key(key: Any) -> str:
    return str(key).strip().upper()


def _parse_symbols(value: Any) -> list[str]:
    if isinstance(value, list):
        raw_symbols = value
    else:
        raw_symbols = str(value).split(",")
    symbols = [str(symbol).strip().upper().replace("-", "_").replace("/", "_") for symbol in raw_symbols]
    symbols = [symbol for symbol in symbols if symbol]
    if not symbols:
        raise ValueError("SYMBOLS cannot be empty")
    return symbols


def _decimal(value: Any, name: str) -> Decimal:
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{name} must be a decimal number") from exc
    if decimal < 0:
        raise ValueError(f"{name} must be non-negative")
    return decimal


def _positive_int(value: Any, name: str) -> int:
    try:
        integer = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if integer <= 0:
        raise ValueError(f"{name} must be positive")
    return integer


def _positive_float(value: Any, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number") from exc
    if number <= 0:
        raise ValueError(f"{name} must be positive")
    return number


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    raise ValueError(f"Invalid boolean value: {value!r}")


def _validate(settings: Settings) -> None:
    methods = {"sms", "push", "call", "email_to_sms"}
    if settings.notification_method not in methods:
        raise ValueError(f"NOTIFICATION_METHOD must be one of {sorted(methods)}")
    push_providers = {"pushover", "ntfy"}
    if settings.push_provider not in push_providers:
        raise ValueError(f"PUSH_PROVIDER must be one of {sorted(push_providers)}")

