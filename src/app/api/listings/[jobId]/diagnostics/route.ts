import { NextRequest, NextResponse } from "next/server";
import { cookieName } from "@/server/access";
import { loadCaptureDiagnostics } from "@/features/diagnostics/load-capture-diagnostics";
import { DiagnosticsAccessError } from "@/features/diagnostics/load-diagnostics";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const data = await loadCaptureDiagnostics({ jobId, cookie: request.cookies.get(cookieName(jobId))?.value });
    return NextResponse.json(data, { headers });
  } catch (error) {
    const status = error instanceof DiagnosticsAccessError ? error.status : 503;
    return NextResponse.json({ error: status === 401 ? "Access denied" : status === 404 ? "Not found" : "Diagnostics unavailable" }, { status, headers });
  }
}
