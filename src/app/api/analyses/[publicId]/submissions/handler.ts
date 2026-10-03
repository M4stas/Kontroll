import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  addSubmission as persistSubmission,
  type AddSubmissionInput,
  type SupplementItem,
} from "@/features/supplements/add-submission";
import {
  analysisAccessCookieName,
  verifyAnalysisAccess,
} from "@/server/access/analysis-access";
import type { AnalysisUploads, UploadFile } from "@/server/storage/uploads";

const MAX_MULTIPART_BYTES = (8 * 12 * 1024 * 1024) + (1024 * 1024);

const PublicIdSchema = z.uuid();
const IdempotencyKeySchema = z.uuid();
const privateNoStore = { "Cache-Control": "private, no-store" };

interface RouteContext {
  params: Promise<{ publicId: string }>;
}

interface SubmissionHandlerDependencies {
  verifyAccess(input: { publicId: string; cookie: string | undefined }): Promise<boolean>;
  loadAnalysisId(publicId: string): Promise<string | null>;
  uploads: Pick<AnalysisUploads, "upload" | "remove">;
  addSubmission(input: AddSubmissionInput): Promise<{
    runId: string;
    queuedStages: string[];
    created: boolean;
  }>;
  reconcileSubmission(analysisId: string, idempotencyKey: string): Promise<{
    runId: string;
    queuedStages: string[];
    referencedStorageKeys: string[];
  } | null>;
}

async function defaultDependencies(): Promise<SubmissionHandlerDependencies> {
  const [dbModule, analysesModule, jobsModule, uploadsModule] = await Promise.all([
    import("@/server/db/client"),
    import("@/server/repositories/analyses"),
    import("@/server/repositories/jobs"),
    import("@/server/storage/uploads"),
  ]);
  const { getServerSupabaseClient } = dbModule;
  const { AnalysesRepository } = analysesModule;
  const { JobsRepository } = jobsModule;
  const { AnalysisUploads } = uploadsModule;
  const client = getServerSupabaseClient();
  const analyses = new AnalysesRepository(client);
  const jobs = new JobsRepository(client);
  return {
    verifyAccess: verifyAnalysisAccess,
    loadAnalysisId: analyses.loadAnalysisId.bind(analyses),
    uploads: new AnalysisUploads(client),
    addSubmission: (input) => persistSubmission(input, { jobs }),
    reconcileSubmission: jobs.findAcceptedSubmissionGroup.bind(jobs),
  };
}

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

async function bestEffortCleanup(
  uploads: Pick<AnalysisUploads, "remove">,
  analysisId: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await uploads.remove(analysisId, keys);
  } catch {
    // Persistence outcome must not be changed by a best-effort storage cleanup failure.
  }
}

export function createSubmissionHandler(dependencies?: SubmissionHandlerDependencies) {
  return async function POST(request: NextRequest, context: RouteContext) {
    const { publicId } = await context.params;
    const parsedPublicId = PublicIdSchema.safeParse(publicId);
    if (!parsedPublicId.success) {
      return NextResponse.json({ error: "Access denied" }, { status: 401, headers: privateNoStore });
    }

    const host = request.headers.get("host");
    let origin: string | null = null;
    try {
      if (host && !/[/\\?#@\s,]/.test(host)) {
        origin = new URL(`${new URL(request.url).protocol}//${host}`).origin;
      }
    } catch {
      // Invalid Host cannot establish same-origin access.
    }
    if (!origin || request.headers.get("origin") !== origin
      || request.headers.get("sec-fetch-site") === "cross-site") {
      return NextResponse.json({ error: "Access denied" }, { status: 403, headers: privateNoStore });
    }

    const hasAccess = await (dependencies?.verifyAccess ?? verifyAnalysisAccess)({
      publicId: parsedPublicId.data,
      cookie: request.cookies.get(analysisAccessCookieName(parsedPublicId.data))?.value,
    });
    if (!hasAccess) {
      return NextResponse.json({ error: "Access denied" }, { status: 401, headers: privateNoStore });
    }

    const deps = dependencies ?? await defaultDependencies();

    const analysisId = await deps.loadAnalysisId(parsedPublicId.data);
    if (!analysisId) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: privateNoStore });
    }

    const contentLengthValue = request.headers.get("content-length");
    const contentLength = contentLengthValue ? Number(contentLengthValue) : Number.NaN;
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_MULTIPART_BYTES) {
      return NextResponse.json({ error: "Submission is too large" }, { status: 413, headers: privateNoStore });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: "Invalid submission" }, { status: 400, headers: privateNoStore });
    }

    const allowedFields = new Set(['idempotencyKey', 'sellerAnswer', 'listingText', 'identityCorrection', 'identityValue', 'files', 'listingScreenshots']);
    if ([...form.keys()].some(key => !allowedFields.has(key) || (!['files', 'listingScreenshots'].includes(key) && form.getAll(key).length !== 1))) {
      return NextResponse.json({ error: "Invalid submission" }, { status: 400, headers: privateNoStore });
    }

    const idempotency = IdempotencyKeySchema.safeParse(textField(form, "idempotencyKey"));
    const sellerAnswer = textField(form, "sellerAnswer");
    const listingText = textField(form, "listingText");
    const correctionType = textField(form, "identityCorrection");
    const correctionValue = textField(form, "identityValue");
    const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
    const listingScreenshots = form.getAll("listingScreenshots").filter((value): value is File => value instanceof File && value.size > 0);

    if (!idempotency.success || sellerAnswer.length > 10_000 || listingText.length > 10_000
      || files.length + listingScreenshots.length > 8
      || listingScreenshots.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
      return NextResponse.json({ error: "Invalid submission" }, { status: 400, headers: privateNoStore });
    }
    if ((correctionType && !["vin", "registrationPlate"].includes(correctionType))
      || Boolean(correctionType) !== Boolean(correctionValue)) {
      return NextResponse.json({ error: "Invalid identity correction" }, { status: 400, headers: privateNoStore });
    }

    const items: SupplementItem[] = [];
    if (sellerAnswer) {
      items.push({ kind: "seller_answer", providedBy: "seller", textContent: sellerAnswer });
    }
    if (listingText) {
      items.push({ kind: "buyer_note", providedBy: "buyer", textContent: listingText });
    }
    if (correctionType && correctionValue) {
      items.push({
        kind: "seller_answer",
        providedBy: "seller",
        textContent: correctionValue,
        identityCorrection: correctionType as "vin" | "registrationPlate",
      });
    }
    if (items.length === 0 && files.length + listingScreenshots.length === 0) {
      return NextResponse.json({ error: "Add an answer or at least one file" }, { status: 400, headers: privateNoStore });
    }

    const stored: Array<{ storageKey: string; mimeType: string; size: number; buyerScreenshot: boolean }> = [];
    let persistenceAttempted = false;
    try {
      for (const file of files) {
        stored.push({ ...await deps.uploads.upload(analysisId, file as UploadFile), buyerScreenshot: false });
      }
      for (const file of listingScreenshots) {
        stored.push({ ...await deps.uploads.upload(analysisId, file as UploadFile), buyerScreenshot: true });
      }
      items.push(...stored.map((file): SupplementItem => ({
        kind: file.buyerScreenshot ? "screenshot" : file.mimeType === "application/pdf" ? "document" : "image",
        providedBy: file.buyerScreenshot ? "buyer" : "seller",
        storageKey: file.storageKey,
        mimeType: file.mimeType,
      })));

      persistenceAttempted = true;
      const accepted = await deps.addSubmission({
        analysisId,
        idempotencyKey: idempotency.data,
        items,
      });
      if (!accepted.created) {
        await bestEffortCleanup(deps.uploads, analysisId, stored.map((file) => file.storageKey));
      }

      return NextResponse.json({
        runId: accepted.runId,
        queuedStages: accepted.queuedStages,
        files: stored.map((file) => ({ type: file.mimeType, state: "processing" })),
      }, { status: 202, headers: privateNoStore });
    } catch {
      if (!persistenceAttempted) {
        await bestEffortCleanup(deps.uploads, analysisId, stored.map((file) => file.storageKey));
        return NextResponse.json({ error: "Submission could not be accepted" }, { status: 500, headers: privateNoStore });
      }
      try {
        const reconciled = await deps.reconcileSubmission(analysisId, idempotency.data);
        if (reconciled) {
          const referenced = new Set(reconciled.referencedStorageKeys);
          await bestEffortCleanup(
            deps.uploads,
            analysisId,
            stored.map((file) => file.storageKey).filter((key) => !referenced.has(key)),
          );
          return NextResponse.json({
            runId: reconciled.runId,
            queuedStages: reconciled.queuedStages,
            files: stored.map((file) => ({ type: file.mimeType, state: "processing" })),
          }, { status: 202, headers: privateNoStore });
        }
        // A null read immediately after a transport failure is still ambiguous: the
        // original transaction may commit later. Preserve objects for orphan cleanup.
      } catch {
        // An indeterminate reconciliation must preserve possible committed objects.
      }
      return NextResponse.json({ error: "Submission could not be accepted" }, { status: 500, headers: privateNoStore });
    }
  };
}
