"""Public HTTP API for submitting and polling Auto24 extraction jobs."""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from auto24_service.contracts import BackgroundCheckState, CaptureDiagnostics, JobResponse
from auto24_service.storage_client import StorageClient, StorageUnavailableError
from auto24_service.store import BackgroundCheckRefused
from auto24_service.urls import InvalidListingURL, canonical_listing_url


DEFAULT_BACKGROUND_CHECK_DIR = "/data/background-checks"


class SubmitBody(BaseModel):
    url: str


def create_public_app(
    client: StorageClient, api_key: str, *,
    background_check_dir: str = DEFAULT_BACKGROUND_CHECK_DIR,
) -> FastAPI:
    """Build the public API around an HTTP storage client supplied by the caller."""
    app = FastAPI()
    pdf_root = Path(background_check_dir).resolve()

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

    @app.post(
        "/v1/jobs/{job_id}/background-check", status_code=202,
        response_model=BackgroundCheckState,
    )
    def start_background_check(job_id: str) -> BackgroundCheckState:
        try:
            state = client.request_background_check(job_id)
        except StorageUnavailableError as exc:
            raise HTTPException(status_code=503, detail="Storage unavailable") from exc
        except BackgroundCheckRefused as exc:
            raise HTTPException(
                status_code=409,
                detail="The job has no settled registration to search with",
            ) from exc
        if state is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return state

    @app.get("/v1/jobs/{job_id}/background-check", response_model=BackgroundCheckState)
    def read_background_check(job_id: str) -> BackgroundCheckState:
        try:
            state = client.background_check(job_id)
        except StorageUnavailableError as exc:
            raise HTTPException(status_code=503, detail="Storage unavailable") from exc
        if state is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return state

    @app.get("/v1/jobs/{job_id}/background-check/pdf")
    def background_check_pdf(job_id: str) -> FileResponse:
        try:
            stored = client.background_check_pdf_path(job_id)
        except StorageUnavailableError as exc:
            raise HTTPException(status_code=503, detail="Storage unavailable") from exc
        path = None if stored is None else Path(stored).resolve()
        if path is None or not path.is_relative_to(pdf_root) or not path.is_file():
            raise HTTPException(status_code=404, detail="Background check PDF not found")
        return FileResponse(path, media_type="application/pdf")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


def create_runnable_public_app() -> FastAPI:
    """Build the Uvicorn app from deployment environment variables."""
    storage_url = os.environ.get("STORAGE_URL", "http://127.0.0.1:8001")
    internal_key = os.environ.get("INTERNAL_API_KEY", "")
    public_key = os.environ.get("PUBLIC_API_KEY", "")
    return create_public_app(
        StorageClient(storage_url, internal_key), public_key,
        background_check_dir=os.environ.get("BACKGROUND_CHECK_DIR", DEFAULT_BACKGROUND_CHECK_DIR),
    )


app = create_runnable_public_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("auto24_service.public_api:app", host="127.0.0.1", port=8000)
