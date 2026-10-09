import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { projectDiagnostics } from "@/diagnostics/project";
import { diagnosticsResponse } from "@/app/api/analyses/[publicId]/diagnostics/handler";
import { DiagnosticsAccessError, loadDiagnostics } from "@/features/diagnostics/load-diagnostics";

vi.mock("@/features/diagnostics/load-diagnostics", async (original) => ({
  ...(await original<typeof import("@/features/diagnostics/load-diagnostics")>()),
  loadDiagnostics: vi.fn(),
}));
const context = { params: Promise.resolve({ publicId: "11111111-1111-4111-8111-111111111111" }) };
const request = () => new NextRequest("http://localhost/api/analyses/11111111-1111-4111-8111-111111111111/diagnostics");
beforeEach(() => {
  vi.mocked(loadDiagnostics).mockReset();
});
it("keeps successful diagnostic responses private and uncached", async () => {
  vi.mocked(loadDiagnostics).mockResolvedValue(
    projectDiagnostics(
      {
        publicId: "11111111-1111-4111-8111-111111111111",
        analysisId: "analysis",
        currentRunId: null,
        run: null,
        snapshot: null,
        executions: [],
        attempts: [],
        jobs: [],
        origins: [],
      },
      "2026-10-09T12:00:00Z",
    ),
  );
  const response = await diagnosticsResponse(request(), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("keeps denied and unavailable responses private without database error details", async () => {
  for (const [error, status] of [
    [new DiagnosticsAccessError(401), 401],
    [new DiagnosticsAccessError(404), 404],
    [new Error("DATABASE_PASSWORD_SENTINEL"), 503],
  ] as const) {
    vi.mocked(loadDiagnostics).mockRejectedValue(error);
    const response = await diagnosticsResponse(request(), context);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).not.toContain("DATABASE_PASSWORD_SENTINEL");
  }
});
it("rejects incomplete result queries with a private not-found response", async () => {
  const response = await diagnosticsResponse(request(), context, true);
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(loadDiagnostics).not.toHaveBeenCalled();
});
