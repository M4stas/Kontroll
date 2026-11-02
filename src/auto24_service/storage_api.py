"""Private HTTP boundary that owns the local Turso job store."""

from __future__ import annotations

import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Callable

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from auto24_service.contracts import (
    BackgroundCheckState,
    CaptureDiagnostics,
    CaptureSpan,
    JobError,
    JobErrorCode,
    JobResponse,
    ListingResult,
    Registration,
    RevealDiagnostics,
)
from auto24_service.store import (
    BackgroundCheckFinish,
    BackgroundCheckRefused,
    ClaimedBackgroundCheck,
    ClaimedJob,
    JobRecord,
    JobStore,
)


DEFAULT_DB_PATH = "/data/auto24.db"


class CreateJobRequest(BaseModel):
    url: str


class CompleteJobRequest(BaseModel):
    lease_token: str
    listing: ListingResult
    warnings: list[str]
    reveal_diagnostics: RevealDiagnostics | None = None
    diagnostic_omitted: int = Field(default=0, ge=0)
    reveal_token: str | None = None


class SetRegistrationRequest(BaseModel):
    reveal_token: str
    registration: Registration
    reveal_diagnostics: RevealDiagnostics | None = None


class RecordSpansRequest(BaseModel):
    lease_token: str
    spans: list[CaptureSpan] = Field(max_length=16)
    omitted: int = Field(default=0, ge=0)


class FailJobRequest(BaseModel):
    lease_token: str
    code: JobErrorCode
    message: str
    transient: bool
    diagnostic_omitted: int = Field(default=0, ge=0)


class FinishBackgroundCheckRequest(BackgroundCheckFinish):
    lease_token: str


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
        reveal_diagnostics=job.reveal_diagnostics if job.status == "completed" else None,
    )


def _register_routes(
    app: FastAPI,
    store_for: Callable[[], JobStore],
    internal_key: str,
) -> None:
    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # The default body echoes the submitted input, which can hold a plate or VIN.
        detail = [{"loc": e["loc"], "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": detail})

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
            reveal_diagnostics=(
                None
                if payload.reveal_diagnostics is None
                else payload.reveal_diagnostics.model_dump(mode="json")
            ),
            diagnostic_omitted=payload.diagnostic_omitted,
            reveal_token=payload.reveal_token,
        )
        return {"updated": updated}

    @app.post("/internal/jobs/{job_id}/registration")
    async def set_registration(
        job_id: str,
        payload: SetRegistrationRequest,
        x_internal_key: str = Header(default=""),
    ) -> dict[str, bool]:
        authorize(x_internal_key)
        updated = store_for().set_registration(
            job_id,
            payload.reveal_token,
            payload.registration.model_dump(mode="json"),
            None
            if payload.reveal_diagnostics is None
            else payload.reveal_diagnostics.model_dump(mode="json"),
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
            diagnostic_omitted=payload.diagnostic_omitted,
        )
        return {"updated": updated}

    @app.post("/internal/jobs/{job_id}/diagnostics")
    async def record_spans(
        job_id: str,
        payload: RecordSpansRequest,
        x_internal_key: str = Header(default=""),
    ) -> dict[str, bool]:
        authorize(x_internal_key)
        return {"updated": store_for().record_spans(job_id, payload.lease_token, payload.spans, omitted=payload.omitted)}

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

    @app.post("/internal/jobs/{job_id}/background-check", response_model=BackgroundCheckState)
    async def request_background_check(
        job_id: str,
        x_internal_key: str = Header(default=""),
    ) -> BackgroundCheckState:
        authorize(x_internal_key)
        try:
            state = store_for().request_background_check(job_id)
        except BackgroundCheckRefused as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if state is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return state

    @app.get("/internal/jobs/{job_id}/background-check", response_model=BackgroundCheckState)
    async def background_check(
        job_id: str,
        x_internal_key: str = Header(default=""),
    ) -> BackgroundCheckState:
        authorize(x_internal_key)
        state = store_for().background_check(job_id)
        if state is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return state

    @app.get("/internal/jobs/{job_id}/background-check/pdf-path")
    async def background_check_pdf_path(
        job_id: str,
        x_internal_key: str = Header(default=""),
    ) -> dict[str, str | None]:
        authorize(x_internal_key)
        return {"pdf_path": store_for().background_check_pdf_path(job_id)}

    @app.post("/internal/background-checks/heartbeat")
    async def lookup_worker_heartbeat(x_internal_key: str = Header(default="")) -> dict[str, bool]:
        authorize(x_internal_key)
        store_for().lookup_worker_heartbeat()
        return {"updated": True}

    @app.post("/internal/background-checks/claim")
    async def claim_background_check(
        x_internal_key: str = Header(default=""),
    ) -> Response:
        authorize(x_internal_key)
        claimed: ClaimedBackgroundCheck | None = store_for().claim_background_check()
        if claimed is None:
            return Response(status_code=204)
        return JSONResponse(content=claimed.model_dump(mode="json"))

    @app.post("/internal/jobs/{job_id}/background-check/finish")
    async def finish_background_check(
        job_id: str,
        payload: FinishBackgroundCheckRequest,
        x_internal_key: str = Header(default=""),
    ) -> dict[str, bool]:
        authorize(x_internal_key)
        outcome = BackgroundCheckFinish.model_validate(payload.model_dump(exclude={"lease_token"}))
        return {"updated": store_for().finish_background_check(job_id, payload.lease_token, outcome)}

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
