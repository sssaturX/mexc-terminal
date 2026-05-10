from __future__ import annotations

from typing import Any

import requests

from alerts.notifier_base import Notifier, NotifierError


def _required(settings: Any, name: str) -> str:
    value = getattr(settings, name, None)
    if not value:
        raise NotifierError(f"Missing required setting: {name}")
    return str(value)


class PushoverNotifier(Notifier):
    def __init__(self, settings: Any) -> None:
        self.api_url = str(getattr(settings, "pushover_api_url", "https://api.pushover.net/1/messages.json"))
        self.token = _required(settings, "pushover_app_token")
        self.user_key = _required(settings, "pushover_user_key")

    def send(self, message: str) -> None:
        try:
            response = requests.post(
                self.api_url,
                data={"token": self.token, "user": self.user_key, "message": message, "title": "Spread Checker"},
                timeout=20,
            )
        except requests.RequestException as exc:
            raise NotifierError(f"Pushover request failed: {exc}") from exc
        if response.status_code >= 400:
            raise NotifierError(f"Pushover failed: HTTP {response.status_code}: {response.text[:300]}")


class NtfyPushNotifier(Notifier):
    def __init__(self, settings: Any) -> None:
        server = str(getattr(settings, "ntfy_server", "https://ntfy.sh")).rstrip("/")
        topic = _required(settings, "ntfy_topic").strip("/")
        self.url = f"{server}/{topic}"
        self.token = getattr(settings, "ntfy_token", "")

    def send(self, message: str) -> None:
        headers = {"Title": "Spread Checker", "Priority": "urgent"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            response = requests.post(self.url, data=message.encode("utf-8"), headers=headers, timeout=20)
        except requests.RequestException as exc:
            raise NotifierError(f"ntfy request failed: {exc}") from exc
        if response.status_code >= 400:
            raise NotifierError(f"ntfy failed: HTTP {response.status_code}: {response.text[:300]}")
