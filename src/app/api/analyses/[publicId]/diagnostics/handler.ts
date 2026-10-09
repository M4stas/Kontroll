import { NextRequest, NextResponse } from "next/server";
import { analysisAccessCookieName } from "@/server/access/analysis-access";
import { loadDiagnostics, DiagnosticsAccessError } from "@/features/diagnostics/load-diagnostics";
const headers = {
  "Cache-Control": "private, no-store",
};
export async function diagnosticsResponse(
  request: NextRequest,
  context: {
    params: Promise<{
      publicId: string;
    }>;
  },
  results = false,
) {
  const { publicId } = await context.params;
  try {
    const query = request.nextUrl.searchParams;
    if (results && (!query.get("runId") || !query.get("executionId")))
      return NextResponse.json(
        {
          error: "Not found",
        },
        {
          status: 404,
          headers,
        },
      );
    const data = await loadDiagnostics({
      publicId,
      cookie: request.cookies.get(analysisAccessCookieName(publicId))?.value,
      runId: query.get("runId") ?? undefined,
      executionId: results ? (query.get("executionId") ?? undefined) : undefined,
      cursor: query.get("cursor") ?? undefined,
    });
    return data
      ? NextResponse.json(data, {
          headers,
        })
      : NextResponse.json(
          {
            error: "Not found",
          },
          {
            status: 404,
            headers,
          },
        );
  } catch (error) {
    const status = error instanceof DiagnosticsAccessError ? error.status : 503;
    return NextResponse.json(
      {
        error: status === 401 ? "Access denied" : status === 404 ? "Not found" : "Diagnostics unavailable",
      },
      {
        status,
        headers,
      },
    );
  }
}
