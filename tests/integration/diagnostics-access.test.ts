import { DiagnosticsRepository } from "@/server/repositories/diagnostics";
import sharp from "sharp";
import { AnalysisUploads } from "@/server/storage/uploads";
import { issueInsightImageCapability } from "@/insights/image-capability";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, expect, it } from "vitest";
import { createStageHandlers } from "@/analysis/pipeline";
import { AnalysesRepository } from "@/server/repositories/analyses";
import { EvidenceRepository } from "@/server/repositories/evidence";
import { JobsRepository } from "@/server/repositories/jobs";
import { ReviewExecutionsRepository } from "@/server/repositories/review-executions";
import { createAccessToken } from "@/server/access/tokens";
import { processJob } from "@/worker/process-job";
import type { ReviewInput } from "@/insights/types";
let client: SupabaseClient;
const created: string[] = [];
const uploaded: Array<{ id: string; key: string }> = [];
beforeAll(() => {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  const values = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), JSON.parse(line.slice(i + 1))];
      }),
  );
  if (!["127.0.0.1", "localhost"].includes(new URL(values.API_URL).hostname))
    throw Error("Diagnostics integration tests require disposable local Supabase");
  client = createClient(values.API_URL, values.SERVICE_ROLE_KEY ?? values.SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
});
afterEach(async () => {
  for (const image of uploaded) await new AnalysisUploads(client).remove(image.id, [image.key]);
  uploaded.length = 0;
  for (const id of created) await client.from("analyses").delete().eq("id", id);
  created.length = 0;
});
const capabilities = { responses: true, text: true, structuredOutput: true, imageInput: true, efforts: [] };
async function fixture() {
  const analyses = new AnalysesRepository(client);
  const evidence = new EvidenceRepository(client);
  const jobs = new JobsRepository(client);
  const executions = new ReviewExecutionsRepository(client);
  const token = createAccessToken();
  const { publicId } = await analyses.create({
    accessTokenHash: token.hash,
    locale: "et",
    listingUrl: "https://example.test/manual",
    inputType: "pasted_text",
    pastedText: "Toyota Avensis 2017",
  });
  const id = await analyses.loadAnalysisId(publicId);
  if (!id) throw Error("Fixture missing");
  created.push(id);
  const calls: ReviewInput[] = [];
  const hooks: { onReview?: (input: ReviewInput) => Promise<void> } = {};
  const environment = {
    OPENAI_API_KEY: "fixture-only",
    DATA_REVIEW_MODEL: "fixture-model",
    DATA_REVIEW_CAPABILITIES: JSON.stringify({ openai: { "fixture-model": capabilities } }),
  };
  const stages = createStageHandlers({
    analyses,
    evidence,
    reviewExecutions: executions,
    workerId: "durable-fixture-worker",
    listingAdapter: {
      canHandle: () => true,
      capture: async () => {
        throw Error("Manual input must never capture");
      },
    },
    insightEnvironment: environment,
    reviewImageCapability: async (analysisId, evidenceId, key, hash) => {
      const uploads = new AnalysisUploads(client);
      if ((await uploads.getStoredContentHash(analysisId, key)) !== hash) throw Error("changed");
      return issueInsightImageCapability(
        { analysisId, evidenceId, storageKey: key, ...(await uploads.createSignedRead(analysisId, key)) },
        "integration-fixture-secret-at-least-32",
      );
    },
    dataReviewer: () => ({
      review: async (input) => {
        calls.push(input);
        await hooks.onReview?.(input);
        return {
          schemaVersion: 1,
          observations: [],
          warnings: [],
        };
      },
    }),
  });
  const drain = async () => {
    for (let i = 0; i < 12; i++) {
      const job = await jobs.leaseForAnalysis("durable-fixture-worker", 60, id);
      if (!job) return;
      await processJob(job, { workerId: "durable-fixture-worker", jobs, stages });
    }
    throw Error("Pipeline did not settle");
  };
  return { token, analyses, jobs, executions, id, publicId, calls, drain, hooks };
}

it("authorizes against durable access and rejects foreign run/execution membership", async () => {
  const f = await fixture();
  await f.drain();
  const foreign = await fixture();
  await foreign.drain();
  const repository = new DiagnosticsRepository(client);
  const own = await repository.load(f.publicId),
    other = await repository.load(foreign.publicId);
  expect(own?.runId).toBeTruthy();
  expect(other?.runId).toBeTruthy();
  expect(await repository.load(f.publicId, other!.runId!)).toBeNull();
  expect(await repository.result(f.publicId, own!.runId!, other!.reviews[0]!.executionId!)).toBeNull();
  const { createAnalysisAccessCookie, verifyAnalysisAccess } = await import("@/server/access/analysis-access");
  const { loadDiagnostics } = await import("@/features/diagnostics/load-diagnostics");
  const secret = "diagnostics-test-secret-at-least-32-characters";
  const dependencies = {
    enabled: true,
    repository,
    verifyAccess: (input: Parameters<typeof verifyAnalysisAccess>[0]) =>
      verifyAnalysisAccess(input, { analyses: f.analyses, secret }),
  };
  const cookie = createAnalysisAccessCookie(f.publicId, f.token.raw, secret);
  await expect(loadDiagnostics({ publicId: f.publicId, cookie }, dependencies)).resolves.toMatchObject({
    runId: own!.runId,
  });
  await expect(loadDiagnostics({ publicId: foreign.publicId, cookie }, dependencies)).rejects.toMatchObject({
    status: 401,
  });
  await expect(loadDiagnostics({ publicId: f.publicId, cookie: undefined }, dependencies)).rejects.toMatchObject({
    status: 401,
  });
  await expect(
    loadDiagnostics({ publicId: f.publicId, cookie }, { ...dependencies, enabled: false }),
  ).rejects.toMatchObject({ status: 404 });
});

it("keeps uncommitted results private and persists manifest order through out-of-order commits", async () => {
  const f = await fixture();
  await f.drain();
  const submissions = [];
  for (let i = 0; i < 4; i++) {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 30 + i * 40, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const stored = await new AnalysisUploads(client).upload(f.id, {
      name: `diagnostic-${i}.png`,
      type: "image/png",
      size: bytes.length,
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    });
    uploaded.push({ id: f.id, key: stored.storageKey });
    submissions.push({
      kind: "image" as const,
      providedBy: "buyer" as const,
      storageKey: stored.storageKey,
      mimeType: stored.mimeType,
    });
  }
  const { runId } = await f.jobs.enqueueMany({
    analysisId: f.id,
    idempotencyKey: crypto.randomUUID(),
    submissions,
    stages: ["enrich", "assemble_report"],
  });
  const repository = new DiagnosticsRepository(client);
  const startOrder: string[] = [];
  const commitOrder: string[] = [];
  const release = new Map<string, () => void>();
  let signal!: () => void;
  let changed = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const notify = () => {
    signal();
    changed = new Promise<void>((resolve) => {
      signal = resolve;
    });
  };
  const commit = f.executions.commitAttempt.bind(f.executions);
  f.executions.commitAttempt = async (...args) => {
    const value = await commit(...args);
    notify();
    return value;
  };
  f.hooks.onReview = async (input) => {
    if (input.pass === "image") {
      startOrder.push(input.imageEvidenceId!);
      const gate = new Promise<void>((resolve) => release.set(input.imageEvidenceId!, resolve));
      notify();
      await gate;
    }
  };
  const draining = f.drain();
  const wait = async (predicate: () => Promise<boolean>) => {
    const limit = Date.now() + 15000;
    while (!(await predicate())) {
      if (Date.now() > limit) throw Error("Controlled diagnostics fixture stalled");
      await Promise.race([changed, new Promise((resolve) => setTimeout(resolve, 20))]);
    }
  };
  try {
    await wait(async () => startOrder.length === 3);
    const before = await repository.load(f.publicId, runId);
    const canonical = before!.reviews.filter((x) => x.pass === "image").map((x) => x.evidenceId);
    expect(before!.reviews.filter((x) => x.pass === "image" && x.state === "running")).toHaveLength(3);
    const active = before!.reviews.find((x) => x.pass === "image" && x.state === "running")!;
    expect(await repository.result(f.publicId, runId, active.executionId!)).toMatchObject({ result: null });
    for (const index of [1, 3, 0, 2]) {
      if (index === 3) await wait(async () => startOrder.length === 4);
      const id = startOrder[index]!;
      release.get(id)!();
      await wait(async () =>
        Boolean((await repository.load(f.publicId, runId))?.reviews.find((x) => x.evidenceId === id)?.resultAvailable),
      );
      commitOrder.push(id);
      const snapshot = await repository.load(f.publicId, runId);
      expect(snapshot!.reviews.filter((x) => x.pass === "image").map((x) => x.evidenceId)).toEqual(canonical);
      if (index !== 2) expect(snapshot!.reviews.find((x) => x.pass === "final")?.resultAvailable).toBe(false);
    }
    await draining;
    expect(commitOrder).not.toEqual(canonical);
    const snapshot = await repository.load(f.publicId, runId);
    for (const review of snapshot!.reviews) {
      expect((await repository.result(f.publicId, runId, review.executionId!))?.result).toMatchObject({
        observations: [],
        warnings: [],
      });
    }
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      "fixture-only",
      "Toyota Avensis",
      "storageKey",
      "sourceRecords",
      "imageManifest",
      "capabilities",
      "prompt",
      "raw_output",
    ])
      expect(serialized).not.toContain(secret);
  } finally {
    for (const resolve of release.values()) resolve();
    await draining;
  }
});

it("discovers a PDF child and labels reused results without new provider durations", async () => {
  const f = await fixture();
  await f.drain();
  const repository = new DiagnosticsRepository(client);
  const parent = await repository.load(f.publicId);
  f.calls.length = 0;
  const { runId } = await f.jobs.enqueueMany({
    analysisId: f.id,
    idempotencyKey: crypto.randomUUID(),
    submissions: [
      {
        kind: "document",
        providedBy: "buyer",
        storageKey: `${f.id}/${crypto.randomUUID()}.pdf`,
        mimeType: "application/pdf",
        textContent: "Page 1: PRIVATE PDF SENTINEL",
      },
    ],
    stages: ["enrich", "assemble_report"],
  });
  expect((await repository.load(f.publicId))?.runId).toBe(runId);
  expect(await repository.load(f.publicId, parent!.runId!)).toBeNull();
  await f.drain();
  expect(f.calls.map((input) => input.pass)).toEqual(["final"]);
  const current = await repository.load(f.publicId);
  const text = current!.reviews.find((x) => x.pass === "text")!;
  expect(text).toMatchObject({
    state: "reused",
    durationMs: null,
    resultAvailable: true,
    reusedFrom: { runId: parent!.runId },
  });
  expect(text.completedAt).toBe(parent!.reviews.find((x) => x.pass === "text")!.completedAt);
  expect(JSON.stringify(current)).not.toContain("PRIVATE PDF SENTINEL");
});
