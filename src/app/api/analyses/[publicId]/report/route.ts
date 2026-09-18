import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { analysisAccessCookieName } from "@/server/access/analysis-access";
import { loadReport, ReportAccessError } from "@/features/report/load-report";

const PublicIdSchema = z.uuid();
const privateNoStore = { "Cache-Control": "private, no-store" };

interface ReportRouteContext {
  params: Promise<{ publicId: string }>;
}

export async function GET(request: NextRequest, context: ReportRouteContext) {
  const { publicId } = await context.params;
  const parsedPublicId = PublicIdSchema.safeParse(publicId);
  if (!parsedPublicId.success) {
    return NextResponse.json({ error: "Access denied" }, { status: 401, headers: privateNoStore });
  }
  try {
    const report = await loadReport({
      publicId: parsedPublicId.data,
      cookie: request.cookies.get(analysisAccessCookieName(parsedPublicId.data))?.value,
    });
    if (!report) return NextResponse.json({ error: "Not found" }, { status: 404, headers: privateNoStore });
    return NextResponse.json(report, { headers: privateNoStore });
  } catch (error) {
    if (error instanceof ReportAccessError) {
      return NextResponse.json({ error: "Access denied" }, { status: 401, headers: privateNoStore });
    }
    return NextResponse.json({ error: "Report unavailable" }, { status: 500, headers: privateNoStore });
  }
}
