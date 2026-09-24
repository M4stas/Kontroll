import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { createAccessToken } from "../../src/server/access/tokens";
import { createStageHandlers } from "../../src/analysis/pipeline";
import type { InsightProvider } from "../../src/insights/provider";
import type { ListingSnapshot } from "../../src/listings/adapter";
import { AnalysesRepository } from "../../src/server/repositories/analyses";
import { EvidenceRepository } from "../../src/server/repositories/evidence";
import { JobsRepository } from "../../src/server/repositories/jobs";
import { AnalysisUploads } from "../../src/server/storage/uploads";
import { processJob } from "../../src/worker/process-job";
import { requireLoopbackSupabaseUrl } from "./local-supabase";

const listingUrl = "https://www.auto24.ee/soidukid/123456";

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Report E2E requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for seeded data.",
    );
  }
  const localStatus = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  const apiLine = localStatus.split("\n").find((line) => line.startsWith("API_URL="));
  if (!apiLine) throw new Error("Report E2E requires a running local Supabase instance");
  const localApiUrl = JSON.parse(apiLine.slice("API_URL=".length)) as string;
  return createClient(requireLoopbackSupabaseUrl(url, localApiUrl), key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function requireRow<T>(
  result: { data: unknown; error: { message: string } | null },
  operation: string,
): Promise<T> {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  if (!result.data) throw new Error(`${operation}: no row returned`);
  return result.data as T;
}

async function seedCompleteReport(client: SupabaseClient) {
  const token = createAccessToken();
  const analyses = new AnalysesRepository(client);
  const { publicId } = await analyses.create({
    accessTokenHash: token.hash,
    locale: "et",
    listingUrl,
  });
  try {
    return await seedReportRows(client, publicId, token.raw);
  } catch (error) {
    const cleanup = await client.from("analyses").delete().eq("public_id", publicId);
    if (cleanup.error) throw new AggregateError([error, cleanup.error], "Could not clean failed E2E seed");
    throw error;
  }
}

async function seedReportRows(client: SupabaseClient, publicId: string, rawToken: string) {
  const analysis = await requireRow<{ id: string; current_run_id: string | null }>(
    await client
      .from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single(),
    "Load seeded analysis",
  );
  if (!analysis.current_run_id) throw new Error("Seeded analysis has no current run");
  const analysisId = analysis.id as string;
  const runId = analysis.current_run_id as string;
  const capturedAt = "2026-09-19T08:00:00.000Z";

  const source = await requireRow<{ id: string }>(
    await client
      .from("source_snapshots")
      .insert({
        analysis_id: analysisId,
        run_id: runId,
        source_type: "auto24",
        source_url: listingUrl,
        captured_at: capturedAt,
        extraction_status: "complete",
      })
      .select("id")
      .single(),
    "Seed listing source",
  );
  const sourceId = source.id as string;

  const evidence = await requireRow<{ id: string }>(
    await client
      .from("evidence")
      .insert({
        analysis_id: analysisId,
        run_id: runId,
        source_snapshot_id: sourceId,
        source_class: "seller",
        claim: "Hooldusraamat olemas ja auto on avariivaba.",
        applicability: "Kuulutuse väide selle auto kohta.",
        confidence: 0.72,
        verification: "unverified",
        captured_at: capturedAt,
      })
      .select("id")
      .single(),
    "Seed seller evidence",
  );
  const finding = await requireRow<{ id: string }>(
    await client
      .from("findings")
      .insert({
        analysis_id: analysisId,
        run_id: runId,
        category: "history",
        severity: "important",
        state: "open",
        title: "Service history is claimed but not documented",
        explanation: "The listing mentions a service book, but no dated pages are visible.",
        next_action: "Ask for photos of the service book and matching VIN page.",
        origin: "deterministic",
      })
      .select("id")
      .single(),
    "Seed unresolved finding",
  );
  const snapshot: ListingSnapshot = {
    type: "snapshot",
    marketplace: "auto24",
    sourceId,
    sourceUrl: listingUrl,
    capturedAt,
    contentHash: "seeded-e2e-listing",
    description: "Hooldusraamat olemas ja auto on avariivaba.",
    imageUrls: [],
    screenshotRefs: [],
    facts: [
      { key: "make", value: "Toyota", sourceId, verification: "unverified", confidence: 0.9 },
      { key: "model", value: "Avensis", sourceId, verification: "unverified", confidence: 0.9 },
      { key: "year", value: "2016", sourceId, verification: "unverified", confidence: 0.9 },
    ],
    claims: [{ text: "Hooldusraamat olemas ja auto on avariivaba.", sourceClass: "seller", verification: "unverified" }],
    warnings: [],
  };
  const completedStage = (output: unknown) => ({
    version: 1, status: "complete", output, warnings: [], completedAt: capturedAt,
  });
  const stageStates = {
    capture_listing: completedStage({ snapshot }),
    normalize_identity: completedStage({
      vehicle: {
        make: "Toyota",
        model: "Avensis",
        year: 2016,
        provenance: {
          make: [sourceId], model: [sourceId], year: [sourceId], mileageKm: [], fuel: [], transmission: [],
          vin: [], registrationPlate: [], generation: [], engineVariant: [], gearboxVariant: [],
        },
        conflicts: [],
      },
    }),
    baseline_checks: completedStage({
      evidence: [{
        id: evidence.id,
        sourceId,
        sourceClass: "seller",
        claim: "Hooldusraamat olemas ja auto on avariivaba.",
        applicability: "Kuulutuse väide selle auto kohta.",
        confidence: 0.72,
        verification: "unverified",
        capturedAt,
      }],
      findings: [{
        id: finding.id,
        category: "history",
        severity: "important",
        state: "open",
        title: "Service history is claimed but not documented",
        explanation: "The listing mentions a service book, but no dated pages are visible.",
        nextAction: "Ask for photos of the service book and matching VIN page.",
        evidenceIds: [evidence.id],
        origin: "deterministic",
      }],
      actions: [{
        id: "33333333-3333-4333-8333-333333333333",
        kind: "seller_question",
        title: "Service history",
        instructions: "When and where was the car last serviced?",
        status: "open",
        findingId: finding.id,
      }],
    }),
    research: completedStage({ sourceStates: {} }),
    enrich: completedStage({ evidence: [], findings: [], actions: [] }),
    assemble_report: completedStage({ status: "complete", advanceToResearch: false, evidenceIds: [evidence.id] }),
  };

  const writes = await Promise.all([
    client.from("vehicle_facts").insert([
      {
        analysis_id: analysisId,
        run_id: runId,
        source_snapshot_id: sourceId,
        fact_key: "make_model",
        fact_value: "Toyota Avensis",
        verification: "unverified",
        match_confidence: 0.9,
      },
      {
        analysis_id: analysisId,
        run_id: runId,
        source_snapshot_id: sourceId,
        fact_key: "year",
        fact_value: "2016",
        verification: "unverified",
        match_confidence: 0.9,
      },
    ]),
    client.from("finding_evidence").insert({
      finding_id: finding.id,
      evidence_id: evidence.id,
      relation: "supports",
    }),
    client.from("actions").insert([
      {
        analysis_id: analysisId,
        run_id: runId,
        finding_id: finding.id,
        kind: "seller_question",
        title: "Service history",
        instructions: "When and where was the car last serviced?",
        status: "open",
      },
      {
        analysis_id: analysisId,
        run_id: runId,
        finding_id: finding.id,
        kind: "photo_request",
        title: "Service-book photos",
        instructions: "Please send dated service-book pages and the VIN page.",
        status: "open",
      },
      {
        analysis_id: analysisId,
        run_id: runId,
        finding_id: finding.id,
        kind: "inspection_task",
        title: "Cold start",
        instructions: "Start the engine from cold and listen for rattles.",
        status: "open",
      },
    ]),
    client
      .from("analysis_runs")
      .update({ status: "complete", stage_states: stageStates, completed_at: capturedAt })
      .eq("id", runId),
    client.from("analysis_jobs").update({ status: "complete", completed_at: capturedAt }).eq("run_id", runId),
    client
      .from("analyses")
      .update({
        status: "complete",
        verdict: "worth_viewing",
        confidence: "moderate",
        updated_at: capturedAt,
      })
      .eq("id", analysisId),
  ]);
  for (const write of writes) {
    if (write.error) throw new Error(`Seed report: ${write.error.message}`);
  }

  return { publicId, rawToken, analysisId, runId };
}

async function processSupplementRun(client: SupabaseClient, analysisId: string) {
  const analyses = new AnalysesRepository(client);
  const evidence = new EvidenceRepository(client);
  const jobs = new JobsRepository(client);
  const insightProvider: InsightProvider = {
    enrich: async (input) => ({
      schemaVersion: 1,
      sources: [],
      findings: [],
      imageObservations: input.images?.[0] ? [{
        imageEvidenceId: input.images[0].evidenceId,
        confidence: 0.82,
        observation: "Surface corrosion is visible near a lower body seam.",
        source: {
          id: "uploaded-image-source",
          url: "https://sources.example/uploaded-image",
          title: "Buyer-provided image",
          sourceClass: "seller",
          applicability: "exact",
          confidence: 0.82,
          observation: "Surface corrosion is visible near a lower body seam.",
        },
        recommendedAction: {
          kind: "inspection_task",
          title: "Inspect visible corrosion",
          instructions: "Inspect the lower body seam and underside in person.",
        },
      }] : [],
      warnings: [],
    }),
  };
  const stages = createStageHandlers({
    analyses,
    evidence,
    listingAdapter: { canHandle: () => true, capture: async () => { throw new Error("Supplement rerun must not recapture"); } },
    insightProvider,
    now: () => new Date("2026-09-20T09:00:00.000Z"),
  });

  for (let index = 0; index < 10; index += 1) {
    const job = await jobs.leaseForAnalysis("e2e-supplement-worker", 60, analysisId);
    if (!job) return;
    await processJob(job, { workerId: "e2e-supplement-worker", jobs, stages });
  }
  throw new Error("Supplement worker did not drain within ten jobs");
}

test("opens a seeded report and supports the buyer inspection flow", async ({ page }) => {
  const client = serviceClient();
  const seeded = await seedCompleteReport(client);

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/analyses", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.continue();
      expect(request.postDataJSON()).toEqual({ locale: "et", listingUrl });
      await route.fulfill({
        contentType: "application/json",
        status: 201,
        body: JSON.stringify({
          url: `/et/a/${seeded.publicId}#access=${encodeURIComponent(seeded.rawToken)}`,
        }),
      });
    });

    await page.goto("/et");
    await page.getByLabel("Kuulutuse URL").fill(listingUrl);
    await page.getByRole("button", { name: "Alusta analüüsi" }).click();

    const verdict = page.getByRole("heading", { name: "Tasub vaatama minna" });
    const findings = page.getByRole("heading", { name: "Vajab veel kontrollimist" });
    await expect(verdict).toBeVisible();
    await expect(findings).toBeVisible();
    expect(await verdict.evaluate((node) => {
      const findingsNode = document.querySelector("#findings-title");
      return findingsNode !== null && Boolean(
        node.compareDocumentPosition(findingsNode) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    })).toBe(true);

    await page.getByRole("button", { name: /Vaata tõendeid/ }).click();
    await expect(page.getByText("Hooldusraamat olemas ja auto on avariivaba.")).toBeVisible();

    await page.getByRole("link", { name: "EN" }).click();
    await expect(page.getByRole("heading", { name: "Worth a viewing" })).toBeVisible();

    const checklistItem = page.getByRole("checkbox", { name: /Start the engine from cold/ });
    await checklistItem.click();
    await expect(checklistItem).toBeChecked();

    await page.getByRole("button", { name: "Add seller information" }).click();
    const sellerImage = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 45, g: 58, b: 72 } },
    }).png().toBuffer();
    await page.getByLabel("Documents or images").setInputFiles({
      name: "seller-engine-bay.png",
      mimeType: "image/png",
      buffer: sellerImage,
    });
    await page.getByRole("button", { name: "Update analysis" }).click();
    await expect(page.getByText("Information added. The report is updating.")).toBeVisible();

    const { data: rerun, error: rerunError } = await client
      .from("analyses")
      .select("current_run_id")
      .eq("id", seeded.analysisId)
      .single();
    if (rerunError || !rerun?.current_run_id || rerun.current_run_id === seeded.runId) {
      throw new Error(rerunError?.message ?? "Supplement run was not selected");
    }
    const reportUrl = page.url();
    await processSupplementRun(client, seeded.analysisId);
    expect(page.url()).toBe(reportUrl);
    await expect(page.getByRole("heading", { name: "Proceed cautiously" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Image observation" })).toBeVisible();
    await expect(page.getByText("Processed", { exact: true })).toBeVisible();
    await expect(page.getByText("Information added. The report is up to date.")).toBeVisible();
    const preservedFinding = page.getByRole("heading", { name: "Service history is claimed but not documented" });
    await expect(preservedFinding).toBeVisible();
    const preservedArticle = preservedFinding.locator("xpath=ancestor::article[1]");
    await preservedArticle.getByRole("button", { name: /View evidence/ }).click();
    await expect(preservedArticle.getByText("Hooldusraamat olemas ja auto on avariivaba.")).toBeVisible();
    const processedRun = await requireRow<{ status: string }>(
      await client.from("analysis_runs").select("status").eq("id", rerun.current_run_id).single(),
      "Load processed supplement run",
    );
    expect(processedRun.status).toBe("complete");
    const currentReport = await new AnalysesRepository(client).loadReport(seeded.publicId);
    const imageFinding = currentReport?.findings.find((item) => item.title === "Image observation");
    expect(imageFinding?.evidenceIds).toHaveLength(1);
    expect(currentReport?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: imageFinding?.evidenceIds[0], sourceClass: "seller" }),
    ]));

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  } finally {
    try {
      const { data: files, error: filesError } = await client.from("submissions")
        .select("storage_key").eq("analysis_id", seeded.analysisId);
      if (filesError) throw new Error(`Find test uploads: ${filesError.message}`);
      const keys = (files ?? []).flatMap((row) => typeof row.storage_key === "string" ? [row.storage_key] : []);
      if (keys.length > 0) await new AnalysisUploads(client).remove(seeded.analysisId, keys);
    } finally {
      const { error } = await client.from("analyses").delete().eq("public_id", seeded.publicId);
      if (error) throw new Error(`Clean up seeded report: ${error.message}`);
    }
  }
});
