"""Public HTTP API for submitting and polling Auto24 extraction jobs."""

from __future__ import annotations

import os
import secrets

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from auto24_service.contracts import CaptureDiagnostics, JobResponse
from auto24_service.storage_client import StorageClient, StorageUnavailableError
from auto24_service.urls import InvalidListingURL, canonical_listing_url


class SubmitBody(BaseModel):
    url: str


def create_public_app(client: StorageClient, api_key: str) -> FastAPI:
    """Build the public API around an HTTP storage client supplied by the caller."""
    app = FastAPI()

    @app.middleware("http")
    async def require_api_key(request: Request, call_next):
        provided_key = request.headers.get("X-API-Key", "")
        if request.url.path != "/health" and (
            not api_key
            or not secrets.compare_digest(
                provided_key.encode("utf-8"), api_key.encode("utf-8")
            )
        ):
            return JSONResponse(status_code=401, content={"detail": "Invalid API key"})
        return await call_next(request)

    @app.post("/v1/jobs", status_code=202, response_model=JobResponse)
    def submit(body: SubmitBody) -> JobResponse:
        try:
            url = canonical_listing_url(body.url)
        except InvalidListingURL as exc:
            raise HTTPException(status_code=400, detail="Invalid listing URL") from exc
        try:
            job = client.create(url)
        except StorageUnavailableError as exc:
            raise HTTPException(status_code=503, detail="Storage unavailable") from exc
        return JobResponse.model_validate(
            {**job.model_dump(), "status_url": f"/v1/jobs/{job.job_id}"}
        )

    @app.get("/v1/jobs/{job_id}", response_model=JobResponse)
    def poll(job_id: str) -> JobResponse:
        try:
            job = client.get(job_id)
        except StorageUnavailableError as exc:
            raise HTTPException(status_code=503, detail="Storage unavailable") from exc
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return job

    @app.get("/v1/jobs/{job_id}/diagnostics", response_model=CaptureDiagnostics)
    def diagnostics(job_id: str) -> CaptureDiagnostics:
        try:
            result = client.diagnostics(job_id)
        except StorageUnavailableError as exc:
            raise HTTPException(status_code=503, detail="Storage unavailable") from exc
        if result is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return result

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


def create_runnable_public_app() -> FastAPI:
    """Build the Uvicorn app from deployment environment variables."""
    storage_url = os.environ.get("STORAGE_URL", "http://127.0.0.1:8001")
    internal_key = os.environ.get("INTERNAL_API_KEY", "")
    public_key = os.environ.get("PUBLIC_API_KEY", "")
    return create_public_app(StorageClient(storage_url, internal_key), public_key)


app = create_runnable_public_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("auto24_service.public_api:app", host="127.0.0.1", port=8000)
