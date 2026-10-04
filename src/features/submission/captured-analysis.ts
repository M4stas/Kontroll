import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { capturedJobSnapshot } from "@/listings/captured-job";
import { jobIdSchema } from "@/listings/contracts";
import { serviceRequest } from "@/listings/auto24-service";
import { cookieName, readAccessSourceUrl, verifyAccess } from "@/server/access";
import { createAccessToken } from "@/server/access/tokens";
import type { AnalysesRepository } from "@/server/repositories/analyses";

interface Dependencies {
  create: AnalysesRepository["create"];
  service: typeof serviceRequest;
}
const headers = { "Cache-Control": "private, no-store" };
const bodySchema = z.object({ locale: z.enum(["et", "en"]), pastedText: z.string().max(10000).optional() }).strict();
export function createCapturedAnalysisHandler(dependencies?: Dependencies) {
  return async (request: NextRequest, context: { params: Promise<{ jobId: string }> }) => {
    const { jobId } = await context.params;
    const cookie = request.cookies.get(cookieName(jobId))?.value;
    if (!jobIdSchema.safeParse(jobId).success || !verifyAccess(jobId, cookie))
      return NextResponse.json({ error: "Access denied" }, { status: 401, headers });
    const host = request.headers.get("host");
    let requestOrigin: string | null = null;
    try {
      if (host && !/[/\\?#@\s,]/.test(host))
        requestOrigin = new URL(`${new URL(request.url).protocol}//${host}`).origin;
    } catch {
      /* Invalid Host cannot establish same-origin access. */
    }
    if (
      requestOrigin === null ||
      request.headers.get("origin") !== requestOrigin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return NextResponse.json({ error: "Access denied" }, { status: 403, headers });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400, headers });
    const sourceUrl = readAccessSourceUrl(jobId, cookie);
    if (!sourceUrl) return NextResponse.json({ error: "Listing unavailable" }, { status: 400, headers });
    try {
      const service = dependencies?.service ?? serviceRequest;
      const job = await service(jobId);
      if (job.job_id !== jobId) throw new Error("Capture job identity mismatch");
      if (job.status === "queued" || job.status === "running")
        return NextResponse.json({ error: "Capture is still pending" }, { status: 409, headers });
      const snapshot = capturedJobSnapshot(job);
      if (snapshot.type === "fallback_required") snapshot.listingUrl = sourceUrl;
      const token = createAccessToken();
      let create = dependencies?.create;
      if (!create) {
        const [{ getServerSupabaseClient }, { AnalysesRepository }] = await Promise.all([
          import("@/server/db/client"),
          import("@/server/repositories/analyses"),
        ]);
        const repository = new AnalysesRepository(getServerSupabaseClient());
        create = repository.create.bind(repository);
      }
      const { publicId } = await create({
        accessTokenHash: token.hash,
        locale: parsed.data.locale,
        listingUrl: sourceUrl,
        serviceJobId: jobId,
        captureSnapshot: snapshot,
        inputType: snapshot.type === "fallback_required" ? "url_with_fallback" : "url",
        ...(parsed.data.pastedText?.trim() ? { pastedText: parsed.data.pastedText.trim() } : {}),
      });
      return NextResponse.json(
        { url: `/${parsed.data.locale}/r/${publicId}#access=${encodeURIComponent(token.raw)}` },
        { status: 201, headers },
      );
    } catch {
      return NextResponse.json(
        {
          error:
            parsed.data.locale === "et"
              ? "Analüüsi loomine ebaõnnestus. Proovi uuesti."
              : "Could not create the report. Try again.",
        },
        { status: 503, headers },
      );
    }
  };
}
