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
});
