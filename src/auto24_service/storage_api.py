"""Private HTTP boundary that owns the local Turso job store."""

from __future__ import annotations

import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Callable

from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from auto24_service.contracts import CaptureDiagnostics, CaptureSpan, JobError, JobErrorCode, JobResponse, ListingResult
from auto24_service.store import ClaimedJob, JobRecord, JobStore


DEFAULT_DB_PATH = "/data/auto24.db"


class CreateJobRequest(BaseModel):
    url: str


class CompleteJobRequest(BaseModel):
    lease_token: str
    listing: ListingResult
    warnings: list[str]


class RecordSpansRequest(BaseModel):
    lease_token: str
    spans: list[CaptureSpan] = Field(max_length=16)


class FailJobRequest(BaseModel):
    lease_token: str
    code: JobErrorCode
    message: str
    transient: bool


def _public_job(job: JobRecord) -> JobResponse:
    error = None
    if job.status == "failed":
        error = JobError(
            code=job.error_code or "temporary_failure",
            message=job.error_message or "Job failed",
        )
    return JobResponse(
        job_id=job.job_id,
        status=job.status,
        submitted_at=job.submitted_at,
        parsed_at=job.parsed_at if job.status == "completed" else None,
        listing=job.listing if job.status == "completed" else None,
        error=error,
        warnings=job.warnings,
    )


def _register_routes(
    app: FastAPI,
    store_for: Callable[[], JobStore],
    internal_key: str,
) -> None:
    def authorize(provided_key: str) -> None:
        if not internal_key or not secrets.compare_digest(
            provided_key.encode("utf-8"), internal_key.encode("utf-8")
        ):
            raise HTTPException(status_code=401, detail="Invalid internal key")

    @app.post("/internal/jobs", status_code=201)
    async def create_job(
        payload: CreateJobRequest,
        x_internal_key: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(x_internal_key)
        return _public_job(store_for().create(payload.url)).model_dump(mode="json")

    @app.post("/internal/jobs/claim")
    async def claim_job(
        x_internal_key: str = Header(default=""),
    ) -> Response:
        authorize(x_internal_key)
        claimed: ClaimedJob | None = store_for().claim()
        if claimed is None:
            return Response(status_code=204)
        return JSONResponse(content=claimed.model_dump(mode="json"))

    @app.get("/internal/jobs/{job_id}")
    async def get_job(
        job_id: str,
        x_internal_key: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(x_internal_key)
        job = store_for().get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return _public_job(job).model_dump(mode="json")

    @app.post("/internal/jobs/{job_id}/complete")
    async def complete_job(
        job_id: str,
        payload: CompleteJobRequest,
        x_internal_key: str = Header(default=""),
    ) -> dict[str, bool]:
        authorize(x_internal_key)
        updated = store_for().complete(
            job_id,
            payload.lease_token,
            payload.listing.model_dump(mode="json"),
            payload.warnings,
        )
        return {"updated": updated}

    @app.post("/internal/jobs/{job_id}/fail")
    async def fail_job(
        job_id: str,
        payload: FailJobRequest,
        x_internal_key: str = Header(default=""),
    ) -> dict[str, bool]:
        authorize(x_internal_key)
        updated = store_for().fail(
            job_id,
            payload.lease_token,
            payload.code,
            payload.message,
            payload.transient,
        )
        return {"updated": updated}

    @app.post("/internal/jobs/{job_id}/diagnostics")
    async def record_spans(
        job_id: str,
        payload: RecordSpansRequest,
        x_internal_key: str = Header(default=""),
    ) -> dict[str, bool]:
        authorize(x_internal_key)
        return {"updated": store_for().record_spans(job_id, payload.lease_token, payload.spans)}

    @app.get("/internal/jobs/{job_id}/diagnostics", response_model=CaptureDiagnostics)
    async def diagnostics(
        job_id: str,
        x_internal_key: str = Header(default=""),
    ) -> CaptureDiagnostics:
        authorize(x_internal_key)
        result = store_for().diagnostics(job_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return result

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}


def create_storage_app(store: JobStore, internal_key: str) -> FastAPI:
    """Build the private API around a store owned by its caller."""
    app = FastAPI()
    app.state.store = store
    _register_routes(app, lambda: store, internal_key)
    return app


def create_runnable_storage_app() -> FastAPI:
    """Build the ASGI app whose lifespan owns the configured Turso store."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db_path = os.environ.get("TURSO_DB_PATH", DEFAULT_DB_PATH)
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        store = JobStore(
            db_path,
            lambda: datetime.now(timezone.utc),
            diagnostics_enabled=os.environ.get("LIVE_DIAGNOSTICS_ENABLED", "false").lower() == "true",
        )
        app.state.store = store
        try:
            yield
        finally:
            store.close()

    app = FastAPI(lifespan=lifespan)
    internal_key = os.environ.get("INTERNAL_API_KEY", "")
    _register_routes(app, lambda: app.state.store, internal_key)
    return app


app = create_runnable_storage_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "auto24_service.storage_api:app",
        host="127.0.0.1",
        port=8001,
        workers=1,
    )
