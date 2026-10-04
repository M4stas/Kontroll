import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAccessToken } from "@/server/access/tokens";
import { AnalysesRepository } from "@/server/repositories/analyses";
import { JobsRepository } from "@/server/repositories/jobs";

function localServiceClient(): SupabaseClient {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], {
    encoding: "utf8",
  });
  const values = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as string];
      }),
  );
  const url = values.API_URL;
  const key = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  if (!url || !key) throw new Error("Local Supabase service credentials are unavailable");

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

describe("durable job leasing", () => {
  let client: SupabaseClient;
  let analyses: AnalysesRepository;
  let jobs: JobsRepository;
  const createdPublicIds = new Set<string>();

  beforeAll(() => {
    client = localServiceClient();
    analyses = new AnalysesRepository(client);
    jobs = new JobsRepository(client);
  });

  afterEach(async () => {
    for (const publicId of createdPublicIds) {
      const { error } = await client.from("analyses").delete().eq("public_id", publicId);
      expect(error).toBeNull();
    }
    createdPublicIds.clear();
  });

  async function createAnalysis() {
    const token = createAccessToken();
    const created = await analyses.create({
      accessTokenHash: token.hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
    createdPublicIds.add(created.publicId);
    return created;
  }

  async function expectNoForeignQueuedJobs(analysisIds: string[]) {
    const { count, error } = await client.from("analysis_jobs")
      .select("id", { count: "exact", head: true })
      .in("status", ["queued", "leased"])
      .not("analysis_id", "in", `(${analysisIds.join(",")})`);
    expect(error).toBeNull();
    expect(count, "Global lease requires no jobs from other analyses").toBe(0);
  }

  it("leases different jobs to concurrent workers", async () => {
    const created = await Promise.all([createAnalysis(), createAnalysis()]);
    const { data: fixtureAnalyses, error } = await client.from("analyses")
      .select("id").in("public_id", created.map((analysis) => analysis.publicId));
    expect(error).toBeNull();
    expect(fixtureAnalyses).toHaveLength(2);
    // Keep both fixtures ahead of jobs that another local process may enqueue after the guard.
    const { error: priorityError } = await client.from("analysis_runs")
      .update({ created_at: "0001-01-01T00:00:00+00:00" })
      .in("analysis_id", fixtureAnalyses!.map((analysis) => analysis.id));
    expect(priorityError).toBeNull();
    await expectNoForeignQueuedJobs(fixtureAnalyses!.map((analysis) => analysis.id));

    const [first, second] = await Promise.all([
      jobs.lease("worker-a", 60),
      jobs.lease("worker-b", 60),
    ]);

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBeTruthy();
    expect(first?.id).not.toBe(second?.id);
    expect(fixtureAnalyses!.map((analysis) => analysis.id)).toContain(first?.analysisId);
    expect(fixtureAnalyses!.map((analysis) => analysis.id)).toContain(second?.analysisId);
  });

  it("leases only the requested analysis while preserving another queued job", async () => {
    const first = await createAnalysis();
    const second = await createAnalysis();
    const { data: firstRow } = await client.from("analyses").select("id").eq("public_id", first.publicId).single();
    const { data: secondRow } = await client.from("analyses").select("id").eq("public_id", second.publicId).single();
    const leased = await jobs.leaseForAnalysis("scoped-worker", 60, secondRow!.id);
    expect(leased?.analysisId).toBe(secondRow!.id);
    const { data: untouched } = await client.from("analysis_jobs").select("status")
      .eq("analysis_id", firstRow!.id).single();
    expect(untouched?.status).toBe("queued");
  });

  it("enqueues a dependent job idempotently", async () => {
    const { publicId } = await createAnalysis();
    const { data: analysis, error: analysisError } = await client.from("analyses")
      .select("id").eq("public_id", publicId).single();
    expect(analysisError).toBeNull();
    const parent = await jobs.leaseForAnalysis("worker-a", 60, analysis!.id);
    if (!parent) throw new Error("Expected initial job");

    const dependent = {
      analysisId: parent.analysisId,
      runId: parent.runId,
      stage: "normalize_identity" as const,
    };
    await jobs.enqueue(dependent);
    await jobs.enqueue(dependent);

    const { data, error } = await client
      .from("analysis_jobs")
      .select("stage, idempotency_key")
      .eq("analysis_id", parent.analysisId)
      .eq("run_id", parent.runId)
      .eq("stage", dependent.stage);
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        stage: "normalize_identity",
        idempotency_key: `${parent.analysisId}:${parent.runId}:normalize_identity`,
      },
    ]);
  });

  it("does not overtake an earlier retry whose backoff is still in the future", async () => {
    const { publicId } = await createAnalysis();
    const { data: analysis, error: analysisError } = await client
      .from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single();
    expect(analysisError).toBeNull();
    if (!analysis?.current_run_id) throw new Error("Expected initial run");

    const now = new Date();
    const states = {
      capture_listing: { version: 1, status: "complete", output: {}, warnings: [], completedAt: now.toISOString() },
      normalize_identity: { version: 1, status: "complete", output: {}, warnings: [], completedAt: now.toISOString() },
      baseline_checks: { version: 1, status: "complete", output: {}, warnings: [], completedAt: now.toISOString() },
    };
    const future = new Date(now.getTime() + 60_000).toISOString();
    const [stateWrite, initialJobWrite, jobsWrite] = await Promise.all([
      client.from("analysis_runs").update({ stage_states: states }).eq("id", analysis.current_run_id),
      client.from("analysis_jobs").update({ status: "complete", completed_at: now.toISOString() }).eq("run_id", analysis.current_run_id),
      client.from("analysis_jobs").insert([
        { analysis_id: analysis.id, run_id: analysis.current_run_id, stage: "research", available_at: future, idempotency_key: `${analysis.id}:${analysis.current_run_id}:delayed-research` },
        { analysis_id: analysis.id, run_id: analysis.current_run_id, stage: "enrich", available_at: now.toISOString(), idempotency_key: `${analysis.id}:${analysis.current_run_id}:delayed-enrich` },
        { analysis_id: analysis.id, run_id: analysis.current_run_id, stage: "assemble_report", available_at: now.toISOString(), idempotency_key: `${analysis.id}:${analysis.current_run_id}:delayed-assembly` },
      ]),
    ]);
    expect(stateWrite.error).toBeNull();
    expect(initialJobWrite.error).toBeNull();
    expect(jobsWrite.error).toBeNull();

    const partialAssembly = await jobs.leaseForAnalysis("partial-worker", 60, analysis.id);
    expect(partialAssembly?.stage).toBe("assemble_report");
    if (!partialAssembly) throw new Error("Expected first partial assembly lease");
    expect((await client.from("analysis_runs").update({ stage_states: {
      ...states,
      assemble_report: { version: 1, status: "complete", output: { status: "partial", advanceToResearch: true }, warnings: [], completedAt: now.toISOString() },
    } }).eq("id", analysis.current_run_id)).error).toBeNull();
    await jobs.complete(partialAssembly.id, "partial-worker");

    await expect(jobs.leaseForAnalysis("delayed-worker", 60, analysis.id)).resolves.toBeNull();

    const makeResearchRunnable = await client.from("analysis_jobs")
      .update({ available_at: new Date(now.getTime() - 1_000).toISOString() })
      .eq("analysis_id", analysis.id)
      .eq("run_id", analysis.current_run_id)
      .eq("stage", "research");
    expect(makeResearchRunnable.error).toBeNull();
    const research = await jobs.leaseForAnalysis("research-worker", 60, analysis.id);
    expect(research?.stage).toBe("research");
    if (!research) throw new Error("Expected research lease");
    const completeResearch = await client.from("analysis_runs").update({
      stage_states: { ...states, research: { version: 1, status: "complete", output: {}, warnings: [], completedAt: now.toISOString() } },
    }).eq("id", analysis.current_run_id);
    expect(completeResearch.error).toBeNull();
    await jobs.complete(research.id, "research-worker");

    await expect(jobs.leaseForAnalysis("enrich-worker", 60, analysis.id)).resolves.toMatchObject({ stage: "enrich" });
  });
});
