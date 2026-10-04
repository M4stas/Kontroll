import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveReviewConfig } from "@/config/review";
import { createAccessToken } from "@/server/access/tokens";
import { AnalysesRepository } from "@/server/repositories/analyses";
import {
  canonicalReviewJson,
  createReviewPassPins,
  reviewSnapshotInputHash,
  ReviewExecutionsRepository,
  type ReviewImageManifest,
  type ReviewLease,
  type ReviewRunSnapshot,
  type ReviewRunSnapshotDraft,
} from "@/server/repositories/review-executions";
import type { ReviewInput, ReviewPass, ReviewResult } from "@/insights/types";
import type { NormalizedVehicle } from "@/analysis/normalize";

interface LocalSupabaseCredentials {
  apiUrl: string;
  serviceRoleKey: string;
  anonKey: string;
}

interface AnalysisFixture {
  publicId: string;
  analysisId: string;
  initialRunId: string;
}

const CAPABILITIES = {
  responses: true,
  text: true,
  structuredOutput: true,
  imageInput: true,
  efforts: ["low", "medium"] as const,
};

const EMPTY_IMAGE_MANIFEST: ReviewImageManifest = {
  counts: { supplied: 0, selected: 0, accepted: 0, skipped: 0, rejected: 0, unavailable: 0 },
  images: [],
};

function readLocalSupabaseCredentials(): LocalSupabaseCredentials {
  const supabaseCliEntry = process.env.SUPABASE_CLI_ENTRY
    ?? "~/.npm/_npx/aa8e5c70f9d8d161/node_modules/supabase/dist/supabase.js";
  const output = execFileSync(process.execPath, [supabaseCliEntry, "status", "-o", "env"], { encoding: "utf8" });
  const values = Object.fromEntries(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as string];
  }));
  const serviceRoleKey = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  const anonKey = values.ANON_KEY ?? values.PUBLISHABLE_KEY;
  if (!values.API_URL || !serviceRoleKey || !anonKey) {
    throw new Error("Local Supabase credentials are unavailable");
  }
  return { apiUrl: values.API_URL, serviceRoleKey, anonKey };
}

function vehicleProjection(): NormalizedVehicle {
  return {
    provenance: {
      make: [], model: [], year: [], mileageKm: [], fuel: [], transmission: [],
      vin: [], registrationPlate: [], generation: [], engineVariant: [], gearboxVariant: [],
    },
    conflicts: [],
  };
}

function pinsFor(model: string, apiKey = "sk-proj-review-audit-fixture-secret"): ReviewRunSnapshotDraft["passes"] {
  const config = resolveReviewConfig({
    DATA_REVIEW_MODE: "unified",
    DATA_REVIEW_MODEL: model,
    OPENAI_API_KEY: apiKey,
  }, { openai: { [model]: CAPABILITIES } });
  const passPins = createReviewPassPins(config, "en").passes;
  if (Object.values(passPins).some((pin) => pin.availability !== "ready")) {
    throw new Error("Review audit fixture model must provide ready text, image, and final passes");
  }
  return passPins;
}

function sourceRecord(evidence: ReviewRunSnapshotDraft["input"]["evidence"][number]) {
  return {
    evidenceId: evidence.id,
    sourceId: evidence.sourceId,
    kind: "listing_text" as const,
    content: evidence.claim,
  };
}

function inputProjection(evidence: ReviewRunSnapshotDraft["input"]["evidence"]) {
  return {
    vehicle: vehicleProjection(),
    listing: null,
    sourceRecords: evidence.map(sourceRecord),
    evidence,
  };
}

function makeDraft(
  lease: ReviewLease,
  evidence: ReviewRunSnapshotDraft["input"]["evidence"] = [],
  imageManifest: ReviewImageManifest = EMPTY_IMAGE_MANIFEST,
  passes = pinsFor("audit-model-v1"),
): ReviewRunSnapshotDraft {
  return {
    analysisId: lease.analysisId,
    runId: lease.runId,
    preparationVersion: 1,
    schemaVersion: 1,
    locale: "en",
    mode: "unified",
    input: inputProjection(evidence),
    imageManifest,
    passes,
  };
}

function manifestFor(image: ReviewImageManifest["images"][number]): ReviewImageManifest {
  return {
    counts: { supplied: 1, selected: 1, accepted: 1, skipped: 0, rejected: 0, unavailable: 0 },
    images: [image],
  };
}

function resultFor(evidenceId: string, severity: "context" | "important" = "context"): ReviewResult {
  return {
    schemaVersion: 1,
    observations: [{
      id: "observation-" + evidenceId.slice(0, 8),
      evidenceIds: [evidenceId],
      category: "listing_review",
      title: "Review observation",
      severity,
      explanation: "A persisted review observation for the integration fixture.",
      recommendedAction: {
        kind: "seller_question",
        title: "Ask the seller",
        instructions: "Please provide the supporting details.",
      },
      confidence: 0.7,
    }],
    warnings: [],
  };
}

function reviewInput(
  snapshot: ReviewRunSnapshot,
  pass: ReviewPass,
  imageEvidenceId?: string,
  priorReviews?: ReviewInput["priorReviews"],
): ReviewInput {
  return {
    analysisId: snapshot.analysisId,
    runId: snapshot.runId,
    locale: snapshot.locale,
    pass,
    ...(imageEvidenceId ? { imageEvidenceId } : {}),
    ...(priorReviews ? { priorReviews } : {}),
    vehicle: snapshot.input.vehicle,
    listing: snapshot.input.listing,
    sourceRecords: snapshot.input.sourceRecords,
    evidence: snapshot.input.evidence,
    images: imageEvidenceId
      ? [{ evidenceId: imageEvidenceId, capability: { version: 1, payload: "fixture-capability", signature: "fixture-signature" } }]
      : [],
  };
}

function requestProjection(input: ReviewInput): Record<string, unknown> {
  return {
    locale: input.locale,
    pass: input.pass,
    ...(input.imageEvidenceId ? { imageEvidenceId: input.imageEvidenceId } : {}),
    vehicle: input.vehicle,
    listing: input.listing,
    sourceRecords: input.sourceRecords,
    evidence: input.evidence,
    imageEvidenceIds: input.images.map((image) => image.evidenceId),
    ...(input.priorReviews ? { priorReviews: input.priorReviews } : {}),
  };
}

describe("review execution audit persistence", () => {
  let serviceClient: SupabaseClient;
  let anonymousClient: SupabaseClient;
  let analyses: AnalysesRepository;
  let executions: ReviewExecutionsRepository;
  const createdPublicIds = new Set<string>();

  beforeAll(() => {
    const credentials = readLocalSupabaseCredentials();
    const auth = { autoRefreshToken: false, persistSession: false };
    serviceClient = createClient(credentials.apiUrl, credentials.serviceRoleKey, { auth });
    anonymousClient = createClient(credentials.apiUrl, credentials.anonKey, { auth });
    analyses = new AnalysesRepository(serviceClient);
    executions = new ReviewExecutionsRepository(serviceClient);
  });

  afterEach(async () => {
    for (const publicId of createdPublicIds) {
      const { error } = await serviceClient.from("analyses").delete().eq("public_id", publicId);
      expect(error).toBeNull();
    }
    createdPublicIds.clear();
  });

  async function createAnalysis(): Promise<AnalysisFixture> {
    const created = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
    createdPublicIds.add(created.publicId);
    const { data, error } = await serviceClient.from("analyses")
      .select("id, current_run_id")
      .eq("public_id", created.publicId)
      .single();
    if (error || !data?.current_run_id) {
      throw new Error(error?.message ?? "Created analysis has no current run");
    }
    return {
      publicId: created.publicId,
      analysisId: data.id as string,
      initialRunId: data.current_run_id as string,
    };
  }

  async function insertEvidence(
    fixture: AnalysisFixture,
    runId: string,
    claim: string,
  ): Promise<ReviewRunSnapshotDraft["input"]["evidence"][number]> {
    const { data: source, error: sourceError } = await serviceClient.from("source_snapshots")
      .insert({
        analysis_id: fixture.analysisId,
        run_id: runId,
        source_type: "auto24",
        source_url: "https://www.auto24.ee/soidukid/123456",
        extraction_status: "complete",
      })
      .select("id")
      .single();
    if (sourceError || !source) throw new Error(sourceError?.message ?? "Could not create fixture source snapshot");

    const { data: row, error } = await serviceClient.from("evidence")
      .insert({
        analysis_id: fixture.analysisId,
        run_id: runId,
        source_snapshot_id: source.id,
        source_class: "listing",
        claim,
        applicability: "original listing",
        confidence: 0.8,
        verification: "unverified",
      })
      .select("id, captured_at")
      .single();
    if (error || !row) throw new Error(error?.message ?? "Could not create fixture evidence");

    return {
      id: row.id as string,
      sourceId: source.id as string,
      sourceClass: "listing",
      sourceUrl: "https://www.auto24.ee/soidukid/123456",
      claim,
      applicability: "original listing",
      confidence: 0.8,
      verification: "unverified",
      capturedAt: row.captured_at as string,
    };
  }

  async function addPreparedImage(
    fixture: AnalysisFixture,
    runId: string,
    image: ReviewImageManifest["images"][number],
  ): Promise<void> {
    const { data: run, error: readError } = await serviceClient.from("analysis_runs")
      .select("stage_states")
      .eq("analysis_id", fixture.analysisId)
      .eq("id", runId)
      .single();
    if (readError || !run) throw new Error(readError?.message ?? "Could not load fixture run");
    const stageStates = (run.stage_states ?? {}) as Record<string, unknown>;
    const updated = await serviceClient.from("analysis_runs").update({
      stage_states: {
        ...stageStates,
        capture_listing: {
          version: 1,
          status: "complete",
          output: {
            snapshot: {
              photoPreparation: {
                images: [{
                  evidenceId: image.evidenceId,
                  selected: image.selected,
                  status: image.status,
                  storageKey: image.storageKey,
                  contentHash: image.contentHash,
                  mimeType: image.mimeType,
                }],
              },
            },
          },
          warnings: [],
          completedAt: new Date().toISOString(),
        },
      },
    }).eq("analysis_id", fixture.analysisId).eq("id", runId);
    expect(updated.error).toBeNull();
  }

  async function createEnrichLease(
    fixture: AnalysisFixture,
    runId: string,
    workerId = "review-audit-" + randomUUID(),
  ): Promise<ReviewLease> {
    // Keep the fixture's initial queue row terminal so no global worker can consume it.
    const captureJob = await serviceClient.from("analysis_jobs").update({
      status: "complete",
      completed_at: new Date().toISOString(),
      leased_by: null,
      lease_expires_at: null,
    }).eq("analysis_id", fixture.analysisId).eq("run_id", fixture.initialRunId).eq("stage", "capture_listing");
    expect(captureJob.error).toBeNull();

    const { data: job, error } = await serviceClient.from("analysis_jobs")
      .insert({
        analysis_id: fixture.analysisId,
        run_id: runId,
        stage: "enrich",
        status: "leased",
        attempts: 1,
        leased_by: workerId,
        lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
        idempotency_key: fixture.analysisId + ":" + runId + ":enrich",
      })
      .select("id")
      .single();
    if (error || !job) throw new Error(error?.message ?? "Could not create scoped enrich lease");
    return { analysisId: fixture.analysisId, runId, jobId: job.id as string, workerId };
  }

  async function createSupplementRun(
    fixture: AnalysisFixture,
    parentRunId: string,
  ): Promise<string> {
    const { data: run, error } = await serviceClient.from("analysis_runs")
      .insert({ analysis_id: fixture.analysisId, trigger: "supplement", parent_run_id: parentRunId })
      .select("id")
      .single();
    if (error || !run) throw new Error(error?.message ?? "Could not create fixture supplement run");
    const current = await serviceClient.from("analyses").update({ current_run_id: run.id })
      .eq("id", fixture.analysisId);
    expect(current.error).toBeNull();
    return run.id as string;
  }

  async function createSupersedingRun(fixture: AnalysisFixture, parentRunId: string): Promise<void> {
    await createSupplementRun(fixture, parentRunId);
  }

  it("pins ancestor evidence and image identity, retries immutable settings, and publishes once after the barrier", async () => {
    const owner = await createAnalysis();
    const listingEvidence = await insertEvidence(owner, owner.initialRunId, "The listing says the car has full service history.");
    const imageEvidence = await insertEvidence(owner, owner.initialRunId, "A supplied listing photo for this vehicle.");
    const selectedImage = {
      evidenceId: imageEvidence.id,
      selected: true,
      status: "accepted" as const,
      storageKey: owner.analysisId + "/listing/photo-1.jpg",
      contentHash: "a".repeat(64),
      mimeType: "image/jpeg" as const,
    };
    await addPreparedImage(owner, owner.initialRunId, selectedImage);
    const supplementRunId = await createSupplementRun(owner, owner.initialRunId);
    const lease = await createEnrichLease(owner, supplementRunId);

    const foreign = await createAnalysis();
    const foreignEvidence = await insertEvidence(foreign, foreign.initialRunId, "Evidence owned by a different analysis.");
    const imageWithoutOwnerMetadata = await insertEvidence(
      owner,
      owner.initialRunId,
      "A valid image evidence ID with no image metadata in this analysis.",
    );
    const foreignPhotoMetadata = {
      ...selectedImage,
      evidenceId: imageWithoutOwnerMetadata.id,
      storageKey: owner.analysisId + "/listing/foreign-photo.jpg",
      contentHash: "c".repeat(64),
    };
    await addPreparedImage(foreign, foreign.initialRunId, foreignPhotoMetadata);

    const draft = makeDraft(lease, [listingEvidence, imageEvidence], manifestFor(selectedImage));
    const wrongEvidenceDraft = makeDraft(lease, [foreignEvidence]);
    await expect(executions.pinRunSnapshot(lease, wrongEvidenceDraft))
      .rejects.toThrow("Could not pin review run snapshot");

    // The evidence identity and storage key are valid for this analysis, but matching photo metadata exists only under another analysis.
    const foreignImageDraft = makeDraft(
      lease,
      [listingEvidence, imageEvidence, imageWithoutOwnerMetadata],
      manifestFor(foreignPhotoMetadata),
    );
    await expect(executions.pinRunSnapshot(lease, foreignImageDraft))
      .rejects.toThrow("Could not pin review run snapshot");
    const foreignImageRpc = await serviceClient.rpc("pin_review_run_snapshot", {
      p_analysis_id: lease.analysisId,
      p_run_id: lease.runId,
      p_job_id: lease.jobId,
      p_worker_id: lease.workerId,
      p_input_hash: "d".repeat(64),
      p_snapshot: {
        ...foreignImageDraft,
        inputHash: "d".repeat(64),
      },
    });
    expect(foreignImageRpc.error).toBeTruthy();

    const duplicateManifest: ReviewImageManifest = {
      counts: { supplied: 2, selected: 2, accepted: 2, skipped: 0, rejected: 0, unavailable: 0 },
      images: [selectedImage, selectedImage],
    };
    await expect(executions.pinRunSnapshot(lease, makeDraft(lease, [listingEvidence, imageEvidence], duplicateManifest)))
      .rejects.toThrow("Review image evidence IDs must be unique");

    const snapshot = await executions.pinRunSnapshot(lease, draft);
    expect(snapshot.runId).toBe(supplementRunId);
    expect(snapshot.input.evidence.map((item) => item.id)).toEqual([listingEvidence.id, imageEvidence.id]);
    expect(canonicalReviewJson(snapshot)).not.toContain("review-audit-fixture-secret");

    const changedPins = pinsFor("audit-model-v2", "sk-proj-another-review-fixture-secret");
    const editedPrompt = "A developer edit made after this run was pinned.";
    changedPins.final.prompt = {
      content: editedPrompt,
      hash: createHash("sha256").update(editedPrompt).digest("hex"),
    };
    const sameInputRetry = await executions.pinRunSnapshot(lease, { ...draft, passes: changedPins });
    expect(sameInputRetry.inputHash).toBe(snapshot.inputHash);
    expect(sameInputRetry.passes.text.model).toBe(snapshot.passes.text.model);
    expect(sameInputRetry.passes.final.prompt.content).toBe(snapshot.passes.final.prompt.content);

    const changedInput = {
      ...draft,
      input: {
        ...draft.input,
        vehicle: { ...draft.input.vehicle, make: "Changed after the snapshot was pinned" },
      },
    };
    await expect(executions.pinRunSnapshot(lease, changedInput)).rejects.toThrow();

    const changedInputHash = reviewSnapshotInputHash({
      analysisId: snapshot.analysisId,
      runId: snapshot.runId,
      preparationVersion: snapshot.preparationVersion,
      schemaVersion: snapshot.schemaVersion,
      locale: snapshot.locale,
      projection: changedInput.input,
      imageManifest: snapshot.imageManifest,
    });
    const rpcChangedSnapshot = {
      analysisId: snapshot.analysisId,
      runId: snapshot.runId,
      preparationVersion: snapshot.preparationVersion,
      schemaVersion: snapshot.schemaVersion,
      locale: snapshot.locale,
      mode: snapshot.mode,
      input: changedInput.input,
      imageManifest: snapshot.imageManifest,
      passes: snapshot.passes,
      inputHash: changedInputHash,
    };
    const rpcRetry = await serviceClient.rpc("pin_review_run_snapshot", {
      p_analysis_id: lease.analysisId,
      p_run_id: lease.runId,
      p_job_id: lease.jobId,
      p_worker_id: lease.workerId,
      p_input_hash: changedInputHash,
      p_snapshot: rpcChangedSnapshot,
    });
    expect(rpcRetry.error).toBeTruthy();

    const textInput = reviewInput(snapshot, "text");
    const textExecution = await executions.ensureExecution(lease, snapshot.id, { input: textInput });
    const repeatedTextExecution = await executions.ensureExecution(lease, snapshot.id, { input: textInput });
    expect(repeatedTextExecution.id).toBe(textExecution.id);
    expect(repeatedTextExecution.fingerprint).toBe(textExecution.fingerprint);

    const firstAttempt = await executions.startAttempt(lease, textExecution.id);
    expect(firstAttempt.attemptNumber).toBe(1);
    await executions.commitAttempt(lease, firstAttempt.id, { outcome: "failure", warningCode: "invalid_output" });
    const retryAttempt = await executions.startAttempt(lease, textExecution.id);
    expect(retryAttempt.attemptNumber).toBe(2);

    await expect(executions.commitAttempt(lease, retryAttempt.id, { outcome: "success", result: {} }))
      .rejects.toThrow();
    const emptyResultRpc = await serviceClient.rpc("commit_review_attempt", {
      p_analysis_id: lease.analysisId,
      p_run_id: lease.runId,
      p_job_id: lease.jobId,
      p_worker_id: lease.workerId,
      p_attempt_id: retryAttempt.id,
      p_outcome: "success",
      p_result: {},
      p_warning_code: null,
      p_provider_request_id: null,
      p_publication: null,
    });
    expect(emptyResultRpc.error).toBeTruthy();
    const { data: stillStarted, error: startedError } = await serviceClient.from("review_attempts")
      .select("state, completed_at")
      .eq("analysis_id", lease.analysisId)
      .eq("run_id", lease.runId)
      .eq("id", retryAttempt.id)
      .single();
    expect(startedError).toBeNull();
    expect(stillStarted).toMatchObject({ state: "started", completed_at: null });
    const { data: uncommittedText, error: uncommittedTextError } = await serviceClient.from("review_executions")
      .select("result, result_hash")
      .eq("analysis_id", lease.analysisId)
      .eq("run_id", lease.runId)
      .eq("id", textExecution.id)
      .single();
    expect(uncommittedTextError).toBeNull();
    expect(uncommittedText).toMatchObject({ result: null, result_hash: null });

    const textResult = resultFor(listingEvidence.id);
    await executions.commitAttempt(lease, retryAttempt.id, {
      outcome: "success",
      result: textResult,
      providerRequestId: "req-review-audit-text-1",
    });
    await executions.commitAttempt(lease, retryAttempt.id, {
      outcome: "success",
      result: textResult,
      providerRequestId: "req-review-audit-text-1",
    });

    const textRecord = (await executions.loadExecutions(lease.analysisId, lease.runId))
      .find((record) => record.id === textExecution.id);
    expect(textRecord?.resultHash).toMatch(/^[a-f0-9]{64}$/);

    const prematureFinalInput = reviewInput(snapshot, "final", undefined, [{
      executionId: textExecution.id,
      pass: "text",
      result: textResult,
    }]);
    await expect(executions.ensureExecution(lease, snapshot.id, { input: prematureFinalInput }))
      .rejects.toThrow("every selected image review");

    const prematureProjection = requestProjection(prematureFinalInput);
    const prematureRpc = await serviceClient.rpc("ensure_review_execution", {
      p_analysis_id: lease.analysisId,
      p_run_id: lease.runId,
      p_job_id: lease.jobId,
      p_worker_id: lease.workerId,
      p_snapshot_id: snapshot.id,
      p_pass: "final",
      p_image_evidence_id: null,
      p_fingerprint: createHash("sha256").update("premature-final").digest("hex"),
      p_evidence_ids: snapshot.input.evidence.map((item) => item.id),
      p_request_projection: prematureProjection,
      p_prior_execution_ids: [textExecution.id],
      p_prior_result_hashes: [{ executionId: textExecution.id, resultHash: textRecord!.resultHash! }],
    });
    expect(prematureRpc.error).toBeTruthy();

    const imageInput = reviewInput(snapshot, "image", imageEvidence.id);
    const imageExecution = await executions.ensureExecution(lease, snapshot.id, { input: imageInput });
    const imageAttempt = await executions.startAttempt(lease, imageExecution.id);
    const invalidImageResult = resultFor(listingEvidence.id, "important");
    await expect(executions.commitAttempt(lease, imageAttempt.id, {
      outcome: "success",
      result: invalidImageResult,
    })).rejects.toThrow("Could not commit review attempt");

    const imageResult = resultFor(imageEvidence.id, "important");
    await executions.commitAttempt(lease, imageAttempt.id, {
      outcome: "success",
      result: imageResult,
      providerRequestId: "req-review-audit-image-1",
    });

    const imageRecord = (await executions.loadExecutions(lease.analysisId, lease.runId))
      .find((record) => record.id === imageExecution.id);
    expect(imageRecord?.resultHash).toMatch(/^[a-f0-9]{64}$/);

    const finalInput = reviewInput(snapshot, "final", undefined, [
      { executionId: textExecution.id, pass: "text", result: textResult },
      { executionId: imageExecution.id, pass: "image", imageEvidenceId: imageEvidence.id, result: imageResult },
    ]);
    const finalExecution = await executions.ensureExecution(lease, snapshot.id, { input: finalInput });
    const finalAttempt = await executions.startAttempt(lease, finalExecution.id);
    const finalResult: ReviewResult = { schemaVersion: 1, observations: [], warnings: [] };
    const completedAt = new Date().toISOString();
    const assemblyResult = {
      version: 1,
      status: "complete",
      output: { reviewExecutionId: finalExecution.id,review:{state:'complete',text:'complete',images:{supplied:1,selected:1,complete:1,unavailable:0,skipped:0},final:'complete'} },
      warnings: [],
      completedAt,
    };
    const findingId = randomUUID();
    const actionId = randomUUID();
    const finding = {
      id: findingId,
      analysis_id: lease.analysisId,
      run_id: lease.runId,
      category: "service_history",
      severity: "context",
      state: "open",
      title: "Service records need confirmation",
      explanation: "The listing claim needs dated records.",
      next_action: "Ask the seller for dated service records.",
      origin: "agent",
      evidence_links: [{ evidence_id: listingEvidence.id, relation: "supports" }],
    };
    const action = {
      id: actionId,
      analysis_id: lease.analysisId,
      run_id: lease.runId,
      kind: "seller_question",
      title: "Ask about service history",
      instructions: "Please share dated service records.",
      status: "open",
      finding_id: findingId,
    };
    const publication = {
      assemblyResult,
      status: "complete" as const,
      verdict: "proceed_cautiously",
      confidence: "moderate",
      completedAt,
      findings: [finding],
      actions: [action],
    };

    const conflictingFindingId = randomUUID();
    const foreignFinding = await serviceClient.from("findings").insert({
      id: conflictingFindingId,
      analysis_id: foreign.analysisId,
      run_id: foreign.initialRunId,
      category: "fixture_conflict",
      severity: "context",
      state: "open",
      title: "Foreign fixture finding",
      explanation: "This row owns the chosen ID.",
      next_action: "Keep ownership isolated.",
      origin: "deterministic",
    });
    expect(foreignFinding.error).toBeNull();
    const collidingPublication = {
      ...publication,
      findings: [{
        ...finding,
        id: conflictingFindingId,
      }],
      actions: [{
        ...action,
        id: randomUUID(),
        finding_id: conflictingFindingId,
      }],
    };
    await expect(executions.commitAttempt(lease, finalAttempt.id, {
      outcome: "success",
      result: finalResult,
      publication: collidingPublication,
      providerRequestId: "req-review-audit-final-conflict",
    })).rejects.toThrow("Could not commit review attempt");

    const [{ data: rolledBackAttempt, error: rollbackAttemptError }, { data: rolledBackExecution, error: rollbackExecutionError }, { data: rolledBackRun, error: rollbackRunError }, { data: leakedFinding, error: leakedFindingError }, { data: leakedAction, error: leakedActionError }] = await Promise.all([
      serviceClient.from("review_attempts").select("state, result_hash, publication_hash")
        .eq("analysis_id", lease.analysisId).eq("run_id", lease.runId).eq("id", finalAttempt.id).single(),
      serviceClient.from("review_executions").select("result, result_hash")
        .eq("analysis_id", lease.analysisId).eq("run_id", lease.runId).eq("id", finalExecution.id).single(),
      serviceClient.from("analysis_runs").select("stage_states")
        .eq("analysis_id", lease.analysisId).eq("id", lease.runId).single(),
      serviceClient.from("findings").select("id")
        .eq("analysis_id", lease.analysisId).eq("run_id", lease.runId).eq("id", conflictingFindingId),
      serviceClient.from("actions").select("id")
        .eq("analysis_id", lease.analysisId).eq("run_id", lease.runId).eq("id", collidingPublication.actions[0]!.id),
    ]);
    expect(rollbackAttemptError).toBeNull();
    expect(rolledBackAttempt).toMatchObject({ state: "started", result_hash: null, publication_hash: null });
    expect(rollbackExecutionError).toBeNull();
    expect(rolledBackExecution).toMatchObject({ result: null, result_hash: null });
    expect(rollbackRunError).toBeNull();
    expect((rolledBackRun?.stage_states as Record<string, unknown>).assemble_report).toBeUndefined();
    expect(leakedFindingError).toBeNull();
    expect(leakedFinding).toEqual([]);
    expect(leakedActionError).toBeNull();
    expect(leakedAction).toEqual([]);

    await executions.commitAttempt(lease, finalAttempt.id, {
      outcome: "success",
      result: finalResult,
      publication,
      providerRequestId: "req-review-audit-final-1",
    });
    await executions.commitAttempt(lease, finalAttempt.id, {
      outcome: "success",
      result: finalResult,
      publication,
      providerRequestId: "req-review-audit-final-1",
    });

    const [{ data: attempts, error: attemptsError }, { data: finalRun, error: runError }, { data: analysis, error: analysisError }, { data: savedFinding, error: findingError }, { data: savedLink, error: linkError }, { data: savedAction, error: actionError }] = await Promise.all([
      serviceClient.from("review_attempts").select("attempt_number, state, publication_hash")
        .eq("analysis_id", lease.analysisId).eq("run_id", lease.runId).eq("execution_id", finalExecution.id),
      serviceClient.from("analysis_runs").select("status, stage_states")
        .eq("analysis_id", lease.analysisId).eq("id", lease.runId).single(),
      serviceClient.from("analyses").select("status, current_run_id")
        .eq("id", lease.analysisId).single(),
      serviceClient.from("findings").select("id, analysis_id, run_id")
        .eq("analysis_id", lease.analysisId).eq("run_id", lease.runId).eq("id", findingId).single(),
      serviceClient.from("finding_evidence").select("finding_id, evidence_id, relation")
        .eq("finding_id", findingId).eq("evidence_id", listingEvidence.id).single(),
      serviceClient.from("actions").select("id, analysis_id, run_id, finding_id")
        .eq("analysis_id", lease.analysisId).eq("run_id", lease.runId).eq("id", actionId).single(),
    ]);
    expect(attemptsError).toBeNull();
    expect(attempts).toEqual([expect.objectContaining({
      attempt_number: 1,
      state: "success",
      publication_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    expect(runError).toBeNull();
    expect(finalRun?.status).toBe("complete");
    expect((finalRun?.stage_states as Record<string, unknown>).assemble_report).toEqual(assemblyResult);
    expect(analysisError).toBeNull();
    expect(analysis).toMatchObject({ status: "complete", current_run_id: lease.runId });
    expect(findingError).toBeNull();
    expect(savedFinding).toMatchObject({ id: findingId, analysis_id: lease.analysisId, run_id: lease.runId });
    expect(linkError).toBeNull();
    expect(savedLink).toEqual({ finding_id: findingId, evidence_id: listingEvidence.id, relation: "supports" });
    expect(actionError).toBeNull();
    expect(savedAction).toMatchObject({ id: actionId, analysis_id: lease.analysisId, run_id: lease.runId, finding_id: findingId });

    const serviceRead = await serviceClient.from("review_run_snapshots").select("id")
      .eq("analysis_id", lease.analysisId).eq("run_id", lease.runId);
    expect(serviceRead.error).toBeNull();
    expect(serviceRead.data).toHaveLength(1);
    const anonymousRead = await anonymousClient.from("review_run_snapshots").select("id")
      .eq("analysis_id", lease.analysisId).eq("run_id", lease.runId);
    expect(Boolean(anonymousRead.error) || anonymousRead.data?.length === 0).toBe(true);
  });

  it("accepts a selected manifest-only image as the image execution's sole extra evidence ID", async () => {
    const fixture = await createAnalysis();
    const lease = await createEnrichLease(fixture, fixture.initialRunId);
    const imageEvidenceId = randomUUID();
    const image = {
      evidenceId: imageEvidenceId,
      selected: true,
      status: "accepted" as const,
      storageKey: fixture.analysisId + "/listing/manifest-only.jpg",
      contentHash: "b".repeat(64),
      mimeType: "image/jpeg" as const,
    };
    await addPreparedImage(fixture, fixture.initialRunId, image);

    const snapshot = await executions.pinRunSnapshot(lease, makeDraft(lease, [], manifestFor(image)));
    expect(snapshot.input.evidence).toEqual([]);
    const execution = await executions.ensureExecution(lease, snapshot.id, {
      input: reviewInput(snapshot, "image", imageEvidenceId),
    });
    expect(execution.evidenceIds).toEqual([imageEvidenceId]);
  });

  it("rejects wrong workers, expired leases, and commits after the run is superseded", async () => {
    const fixture = await createAnalysis();
    const lease = await createEnrichLease(fixture, fixture.initialRunId);
    const draft = makeDraft(lease);

    await expect(executions.pinRunSnapshot({ ...lease, workerId: "different-review-worker" }, draft))
      .rejects.toThrow("Could not pin review run snapshot");

    const expired = await serviceClient.from("analysis_jobs").update({
      lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    }).eq("analysis_id", lease.analysisId).eq("run_id", lease.runId).eq("id", lease.jobId);
    expect(expired.error).toBeNull();
    await expect(executions.pinRunSnapshot(lease, draft)).rejects.toThrow("Could not pin review run snapshot");

    const restored = await serviceClient.from("analysis_jobs").update({
      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    }).eq("analysis_id", lease.analysisId).eq("run_id", lease.runId).eq("id", lease.jobId);
    expect(restored.error).toBeNull();

    const snapshot = await executions.pinRunSnapshot(lease, draft);
    const textExecution = await executions.ensureExecution(lease, snapshot.id, {
      input: reviewInput(snapshot, "text"),
    });
    const attempt = await executions.startAttempt(lease, textExecution.id);
    await createSupersedingRun(fixture, lease.runId);

    await expect(executions.commitAttempt(lease, attempt.id, { outcome: "failure", warningCode: "timeout" }))
      .rejects.toThrow("Could not commit review attempt");
  });
});
