import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccessToken } from "@/server/access/tokens";
import { AnalysesRepository } from "@/server/repositories/analyses";

function credentials() {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  const values = Object.fromEntries(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as string];
  }));
  const serviceKey = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  const anonKey = values.ANON_KEY ?? values.PUBLISHABLE_KEY;
  if (!values.API_URL || !serviceKey || !anonKey) throw new Error("Local Supabase credentials unavailable");
  return { url: values.API_URL, serviceKey, anonKey };
}

describe("supplement submission persistence", () => {
  let service: SupabaseClient;
  let anonymous: SupabaseClient;
  let analyses: AnalysesRepository;

  beforeAll(() => {
    const local = credentials();
    const auth = { autoRefreshToken: false, persistSession: false };
    service = createClient(local.url, local.serviceKey, { auth });
    anonymous = createClient(local.url, local.anonKey, { auth });
    analyses = new AnalysesRepository(service);
  });

  beforeEach(async () => {
    const { error } = await service.from("analyses").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    expect(error).toBeNull();
  });

  async function createAnalysis() {
    const { publicId } = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
    const { data, error } = await service.from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single();
    if (error || !data?.current_run_id) throw new Error(error?.message ?? "Analysis was not created");
    return { publicId, analysisId: data.id as string, initialRunId: data.current_run_id as string };
  }

  it("accepts one idempotent group atomically and queues only affected jobs", async () => {
    const created = await createAnalysis();
    const idempotencyKey = randomUUID();
    const args = {
      p_analysis_id: created.analysisId,
      p_idempotency_key: idempotencyKey,
      p_submissions: [
        { kind: "seller_answer", provided_by: "seller", text_content: "Timing belt changed in 2024." },
        { kind: "document", provided_by: "seller", storage_key: `${created.analysisId}/service.pdf`, mime_type: "application/pdf" },
      ],
      p_stages: ["baseline_checks", "enrich", "assemble_report"],
    };

    const first = await service.rpc("accept_analysis_submission_group", args);
    const second = await service.rpc("accept_analysis_submission_group", args);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject([{
      run_id: (first.data as Array<{ run_id: string }>)[0]?.run_id,
      queued_stages: ["baseline_checks", "enrich", "assemble_report"],
      created: false,
    }]);
    const runId = (first.data as Array<{ run_id: string }>)[0]?.run_id;
    expect(runId).toBeTruthy();

    const [analysis, runs, submissions, jobs] = await Promise.all([
      service.from("analyses").select("current_run_id").eq("id", created.analysisId).single(),
      service.from("analysis_runs").select("id, trigger").eq("analysis_id", created.analysisId),
      service.from("submissions").select("run_id, kind, storage_key").eq("analysis_id", created.analysisId),
      service.from("analysis_jobs").select("run_id, stage").eq("run_id", runId).order("stage"),
    ]);
    expect(analysis.data?.current_run_id).toBe(runId);
    expect(runs.data).toEqual(expect.arrayContaining([
      { id: created.initialRunId, trigger: "initial" },
      { id: runId, trigger: "supplement" },
    ]));
    expect(runs.data).toHaveLength(2);
    expect(submissions.data).toHaveLength(2);
    expect(submissions.data?.every((row) => row.run_id === runId)).toBe(true);
    expect(jobs.data?.map((row) => row.stage).sort()).toEqual([
      "assemble_report",
      "baseline_checks",
      "enrich",
    ]);
    expect(JSON.stringify(jobs.data)).not.toContain("capture_listing");
  });

  it("rolls back every write when a submission group is invalid", async () => {
    const created = await createAnalysis();
    const result = await service.rpc("accept_analysis_submission_group", {
      p_analysis_id: created.analysisId,
      p_idempotency_key: randomUUID(),
      p_submissions: [{ kind: "seller_answer", provided_by: "seller" }],
      p_stages: ["baseline_checks", "enrich", "assemble_report"],
    });
    expect(result.error).not.toBeNull();

    const [analysis, runCount, submissionCount] = await Promise.all([
      service.from("analyses").select("current_run_id").eq("id", created.analysisId).single(),
      service.from("analysis_runs").select("id", { count: "exact", head: true }).eq("analysis_id", created.analysisId),
      service.from("submissions").select("id", { count: "exact", head: true }).eq("analysis_id", created.analysisId),
    ]);
    expect(analysis.data?.current_run_id).toBe(created.initialRunId);
    expect(runCount.count).toBe(1);
    expect(submissionCount.count).toBe(0);
  });

  it("exposes neither submission rows nor the acceptance function to anonymous clients", async () => {
    const created = await createAnalysis();
    const read = await anonymous.from("submissions").select("*").eq("analysis_id", created.analysisId);
    expect(read.data).toEqual([]);

    const write = await anonymous.rpc("accept_analysis_submission_group", {
      p_analysis_id: created.analysisId,
      p_idempotency_key: randomUUID(),
      p_submissions: [{ kind: "seller_answer", provided_by: "seller", text_content: "Private" }],
      p_stages: ["baseline_checks", "enrich", "assemble_report"],
    });
    expect(write.error).not.toBeNull();
  });
});
