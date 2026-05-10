from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any


class NotifierError(RuntimeError):
    """Raised when a notification could not be sent."""


class Notifier(ABC):
    @abstractmethod
    def send(self, message: str) -> None:
        """Send an already formatted alert message."""


class DryRunNotifier(Notifier):
    def __init__(self, logger: logging.Logger | None = None) -> None:
        self.logger = logger or logging.getLogger(__name__)

    def send(self, message: str) -> None:
        self.logger.info("DRY-RUN notification:\n%s", message)


def create_notifier(settings: Any, logger: logging.Logger | None = None) -> Notifier:
    if settings.dry_run:
        return DryRunNotifier(logger)

    method = settings.notification_method.lower()
    if method == "sms":
        from alerts.sms_notifier import TwilioSmsNotifier

        return TwilioSmsNotifier(settings)
    if method == "call":
        from alerts.sms_notifier import TwilioCallNotifier

        return TwilioCallNotifier(settings)
    if method == "email_to_sms":
        from alerts.sms_notifier import EmailToSmsNotifier

        return EmailToSmsNotifier(settings)
    if method == "push":
        from alerts.push_notifier import NtfyPushNotifier, PushoverNotifier

        if settings.push_provider.lower() == "ntfy":
            return NtfyPushNotifier(settings)
        return PushoverNotifier(settings)

    raise NotifierError(f"Unsupported NOTIFICATION_METHOD={settings.notification_method!r}")

