import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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

  beforeAll(() => {
    client = localServiceClient();
    analyses = new AnalysesRepository(client);
    jobs = new JobsRepository(client);
  });

  beforeEach(async () => {
    const { error } = await client
      .from("analyses")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    expect(error).toBeNull();
  });

  async function createAnalysis() {
    const token = createAccessToken();
    return analyses.create({
      accessTokenHash: token.hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
  }

  it("leases different jobs to concurrent workers", async () => {
    await Promise.all([createAnalysis(), createAnalysis()]);

    const [first, second] = await Promise.all([
      jobs.lease("worker-a", 60),
      jobs.lease("worker-b", 60),
    ]);

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBeTruthy();
    expect(first?.id).not.toBe(second?.id);
  });

  it("enqueues a dependent job idempotently", async () => {
    await createAnalysis();
    const parent = await jobs.lease("worker-a", 60);
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

    await expect(jobs.lease("delayed-worker", 60)).resolves.toBeNull();

    const makeResearchRunnable = await client.from("analysis_jobs")
      .update({ available_at: new Date(now.getTime() - 1_000).toISOString() })
      .eq("analysis_id", analysis.id)
      .eq("run_id", analysis.current_run_id)
      .eq("stage", "research");
    expect(makeResearchRunnable.error).toBeNull();
    const research = await jobs.lease("research-worker", 60);
    expect(research?.stage).toBe("research");
    if (!research) throw new Error("Expected research lease");
    const completeResearch = await client.from("analysis_runs").update({
      stage_states: { ...states, research: { version: 1, status: "complete", output: {}, warnings: [], completedAt: now.toISOString() } },
    }).eq("id", analysis.current_run_id);
    expect(completeResearch.error).toBeNull();
    await jobs.complete(research.id, "research-worker");

    await expect(jobs.lease("enrich-worker", 60)).resolves.toMatchObject({ stage: "enrich" });
  });
});
