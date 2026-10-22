"""Synchronous HTTP client for the private storage service."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from auto24_service.contracts import (
    CaptureDiagnostics,
    CaptureSpan,
    JobResponse,
    Registration,
    RevealDiagnostics,
)
from auto24_service.store import ClaimedJob


_REQUEST_TIMEOUT_SECONDS = 5.0


class StorageUnavailableError(RuntimeError):
    """Raised when the storage service cannot answer a request."""


class StorageClient:
    def __init__(
        self,
        base_url: str,
        internal_key: str,
        *,
        transport: httpx.BaseTransport | None = None,
    ):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/") + "/",
            headers={"X-Internal-Key": internal_key},
            timeout=_REQUEST_TIMEOUT_SECONDS,
            transport=transport,
        )

    def __enter__(self) -> StorageClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        allow_not_found: bool = False,
        timeout: float = _REQUEST_TIMEOUT_SECONDS,
    ) -> httpx.Response:
        try:
            response = self._client.request(method, path, json=json, timeout=timeout)
        except httpx.TimeoutException as exc:
            raise StorageUnavailableError("storage request timed out") from exc
        except httpx.RequestError as exc:
            raise StorageUnavailableError("storage service is unavailable") from exc

        if response.status_code >= 500:
            raise StorageUnavailableError(
                f"storage service returned HTTP {response.status_code}"
            )
        if allow_not_found and response.status_code == 404:
            return response
        response.raise_for_status()
        return response

    def create(self, url: str) -> JobResponse:
        response = self._request("POST", "internal/jobs", json={"url": url})
        return JobResponse.model_validate(response.json())

    def get(self, job_id: str) -> JobResponse | None:
        response = self._request(
            "GET", f"internal/jobs/{quote(job_id, safe='')}", allow_not_found=True
        )
        if response.status_code == 404:
            return None
        return JobResponse.model_validate(response.json())

    def claim(self) -> ClaimedJob | None:
        response = self._request("POST", "internal/jobs/claim")
        if response.status_code == 204:
            return None
        return ClaimedJob.model_validate(response.json())

    def complete(
        self,
        job_id: str,
        lease_token: str,
        listing: dict[str, Any],
        warnings: list[str],
        reveal_diagnostics: RevealDiagnostics | None = None,
        *, diagnostic_omitted: int = 0,
        reveal_token: str | None = None,
    ) -> bool:
        payload: dict[str, Any] = {
            "lease_token": lease_token,
            "listing": listing,
            "warnings": warnings,
        }
        if reveal_diagnostics is not None:
            payload["reveal_diagnostics"] = reveal_diagnostics.model_dump(mode="json")
        if diagnostic_omitted:
            payload["diagnostic_omitted"] = diagnostic_omitted
        if reveal_token is not None:
            payload["reveal_token"] = reveal_token
        response = self._request(
            "POST",
            f"internal/jobs/{quote(job_id, safe='')}/complete",
            json=payload,
        )
        return response.json()["updated"]

    def set_registration(
        self,
        job_id: str,
        reveal_token: str,
        registration: Registration,
        reveal_diagnostics: RevealDiagnostics | None,
    ) -> bool:
        payload: dict[str, Any] = {
            "reveal_token": reveal_token,
            "registration": registration.model_dump(mode="json"),
        }
        if reveal_diagnostics is not None:
            payload["reveal_diagnostics"] = reveal_diagnostics.model_dump(mode="json")
        response = self._request(
            "POST",
            f"internal/jobs/{quote(job_id, safe='')}/registration",
            json=payload,
        )
        return response.json()["updated"]

    def fail(
        self,
        job_id: str,
        lease_token: str,
        code: str,
        message: str,
        transient: bool,
        *, diagnostic_omitted: int = 0,
    ) -> bool:
        response = self._request(
            "POST",
            f"internal/jobs/{quote(job_id, safe='')}/fail",
            json={
                "lease_token": lease_token,
                "code": code,
                "message": message,
                "transient": transient,
                **({"diagnostic_omitted": diagnostic_omitted} if diagnostic_omitted else {}),
            },
        )
        return response.json()["updated"]


    def record_spans(
        self, job_id: str, lease_token: str, spans: list[CaptureSpan], *, timeout: float, omitted: int = 0
    ) -> bool:
        response = self._request(
            "POST", f"internal/jobs/{quote(job_id, safe='')}/diagnostics",
            json={"lease_token": lease_token, "spans": [span.model_dump(mode="json") for span in spans],
                  **({"omitted": omitted} if omitted else {})},
            timeout=timeout,
        )
        return response.json()["updated"]

    def diagnostics(self, job_id: str) -> CaptureDiagnostics | None:
        response = self._request(
            "GET", f"internal/jobs/{quote(job_id, safe='')}/diagnostics", allow_not_found=True
        )
        if response.status_code == 404:
            return None
        return CaptureDiagnostics.model_validate(response.json())
