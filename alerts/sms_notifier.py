from __future__ import annotations

import smtplib
from html import escape
from email.message import EmailMessage
from typing import Any

from alerts.notifier_base import Notifier, NotifierError


def _required(settings: Any, name: str) -> str:
    value = getattr(settings, name, None)
    if not value:
        raise NotifierError(f"Missing required setting: {name}")
    return str(value)


class TwilioSmsNotifier(Notifier):
    def __init__(self, settings: Any) -> None:
        try:
            from twilio.rest import Client
        except ImportError as exc:
            raise NotifierError("Install twilio package to use NOTIFICATION_METHOD=sms") from exc

        self.client = Client(
            _required(settings, "twilio_account_sid"),
            _required(settings, "twilio_auth_token"),
        )
        self.from_number = _required(settings, "twilio_from_number")
        self.to_number = _required(settings, "twilio_to_number")

    def send(self, message: str) -> None:
        self.client.messages.create(body=message, from_=self.from_number, to=self.to_number)


class TwilioCallNotifier(Notifier):
    def __init__(self, settings: Any) -> None:
        try:
            from twilio.rest import Client
        except ImportError as exc:
            raise NotifierError("Install twilio package to use NOTIFICATION_METHOD=call") from exc

        self.client = Client(
            _required(settings, "twilio_account_sid"),
            _required(settings, "twilio_auth_token"),
        )
        self.from_number = _required(settings, "twilio_from_number")
        self.to_number = _required(settings, "twilio_to_number")

    def send(self, message: str) -> None:
        spoken = escape(message)
        twiml = f"<Response><Say voice=\"alice\">{spoken}</Say></Response>"
        self.client.calls.create(twiml=twiml, from_=self.from_number, to=self.to_number)


class EmailToSmsNotifier(Notifier):
    def __init__(self, settings: Any) -> None:
        self.smtp_host = _required(settings, "smtp_host")
        self.smtp_port = int(getattr(settings, "smtp_port", 587))
        self.smtp_username = _required(settings, "smtp_username")
        self.smtp_password = _required(settings, "smtp_password")
        self.email_from = _required(settings, "email_from")
        self.email_to_sms_address = _required(settings, "email_to_sms_address")

    def send(self, message: str) -> None:
        email = EmailMessage()
        email["From"] = self.email_from
        email["To"] = self.email_to_sms_address
        email["Subject"] = "Spread Checker Alert"
        email.set_content(message)

        with smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=20) as smtp:
            smtp.starttls()
            smtp.login(self.smtp_username, self.smtp_password)
            smtp.send_message(email)
