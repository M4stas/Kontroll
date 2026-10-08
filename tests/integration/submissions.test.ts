import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAccessToken } from "@/server/access/tokens";
import { addSubmission } from "@/features/supplements/add-submission";
import { JobsRepository } from "@/server/repositories/jobs";
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
  const createdPublicIds = new Set<string>();

  beforeAll(() => {
    const local = credentials();
    const auth = { autoRefreshToken: false, persistSession: false };
    service = createClient(local.url, local.serviceKey, { auth });
    anonymous = createClient(local.url, local.anonKey, { auth });
    analyses = new AnalysesRepository(service);
  });

  afterEach(async () => {
    for (const publicId of createdPublicIds) {
      const { error } = await service.from("analyses").delete().eq("public_id", publicId);
      expect(error).toBeNull();
    }
    createdPublicIds.clear();
  });

  async function createAnalysis() {
    const { publicId } = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
    createdPublicIds.add(publicId);
    const { data, error } = await service.from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single();
    if (error || !data?.current_run_id) throw new Error(error?.message ?? "Analysis was not created");
    return { publicId, analysisId: data.id as string, initialRunId: data.current_run_id as string };
  }

  it.each(["buyer_note", "screenshot"] as const)("accepts capture refresh for buyer %s at the existing report", async (kind) => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    const accepted = await addSubmission({ analysisId:created.analysisId, items:[{kind,providedBy:"buyer",...(kind === "buyer_note" ? {textContent:"Updated listing description"} : {storageKey:`${created.analysisId}/test.jpg`,mimeType:"image/jpeg"})}] }, {jobs:new JobsRepository(service)});
    expect(accepted.queuedStages).toEqual(["capture_listing","normalize_identity","baseline_checks","research","enrich","assemble_report"]);
    expect(await analyses.loadAnalysisId(created.publicId)).toBe(created.analysisId);
  });

  async function completeInitialRun(created: Awaited<ReturnType<typeof createAnalysis>>) {
    const completedAt = "2026-09-20T10:00:00.000Z";
    const states = Object.fromEntries([
      "capture_listing", "normalize_identity", "baseline_checks", "research", "enrich", "assemble_report",
    ].map((stage) => [stage, {
      version: 1, status: "complete", output: {}, warnings: [], completedAt,
    }]));
    const writes = await Promise.all([
      service.from("analysis_runs").update({ status: "complete", stage_states: states, completed_at: completedAt }).eq("id", created.initialRunId),
      service.from("analysis_jobs").update({ status: "complete", completed_at: completedAt }).eq("run_id", created.initialRunId),
      service.from("analyses").update({ status: "complete", verdict: "worth_viewing", confidence: "moderate" }).eq("id", created.analysisId),
    ]);
    for (const write of writes) expect(write.error).toBeNull();
  }

  async function seedReportArtifacts(created: Awaited<ReturnType<typeof createAnalysis>>) {
    const source = await service.from("source_snapshots").insert({
      analysis_id: created.analysisId,
      run_id: created.initialRunId,
      source_type: "auto24",
      source_url: "https://www.auto24.ee/soidukid/123456",
      extraction_status: "complete",
    }).select("id").single();
    expect(source.error).toBeNull();
    const sourceId = source.data?.id as string;
    const evidence = await service.from("evidence").insert({
      analysis_id: created.analysisId,
      run_id: created.initialRunId,
      source_snapshot_id: sourceId,
      source_class: "seller",
      claim: "Original seller claim",
      applicability: "Original listing",
      confidence: 0.5,
      verification: "unverified",
    }).select("id").single();
    expect(evidence.error).toBeNull();
    const finding = await service.from("findings").insert({
      analysis_id: created.analysisId,
      run_id: created.initialRunId,
      category: "history",
      severity: "important",
      state: "open",
      title: "Original finding",
      explanation: "Original explanation",
      next_action: "Original next action",
    }).select("id").single();
    expect(finding.error).toBeNull();
    const writes = await Promise.all([
      service.from("vehicle_facts").insert({
        analysis_id: created.analysisId,
        run_id: created.initialRunId,
        source_snapshot_id: sourceId,
        fact_key: "make",
        fact_value: "Toyota",
        verification: "unverified",
        match_confidence: 0.9,
      }),
      service.from("finding_evidence").insert({
        finding_id: finding.data?.id,
        evidence_id: evidence.data?.id,
        relation: "supports",
      }),
      service.from("actions").insert({
        analysis_id: created.analysisId,
        run_id: created.initialRunId,
        finding_id: finding.data?.id,
        kind: "seller_question",
        title: "Original action",
        instructions: "Ask the original question",
      }),
    ]);
    for (const write of writes) expect(write.error).toBeNull();
  }

  it("retains a manual-only official source across a supplement that does not rerun research", async () => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    await seedReportArtifacts(created);
    const official = await service.from("source_snapshots").insert({
      analysis_id: created.analysisId,
      run_id: created.initialRunId,
      source_type: "transportAdministration",
      source_url: "https://eteenindus.mnt.ee/public/soidukTaustakontroll.jsf",
      extraction_status: "unavailable",
    });
    expect(official.error).toBeNull();
    expect((await analyses.loadReport(created.publicId))?.sources.transportAdministration?.verification).toBe("not_checked");

    const accepted = await service.rpc("accept_analysis_submission_group", {
      p_analysis_id: created.analysisId,
      p_idempotency_key: randomUUID(),
      p_submissions: [{ kind: "seller_answer", provided_by: "seller", text_content: "Service record offered." }],
      p_stages: ["baseline_checks", "enrich", "assemble_report"],
    });
    expect(accepted.error).toBeNull();
    expect((await analyses.loadReport(created.publicId))?.sources.transportAdministration?.verification).toBe("not_checked");
  });

  it("accepts one idempotent group atomically and queues only affected jobs", async () => {
    const created = await createAnalysis();
    await completeInitialRun(created);
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

  it.each([
    ["seller answer", { kind: "seller_answer", provided_by: "seller", text_content: "Timing belt changed." }, ["baseline_checks", "enrich", "assemble_report"]],
    ["buyer note", { kind: "buyer_note", provided_by: "buyer", text_content: "Cold-start rattle." }, ["baseline_checks", "enrich", "assemble_report"]],
    ["document", { kind: "document", provided_by: "seller", storage_key: "FILE/service.pdf", mime_type: "application/pdf" }, ["baseline_checks", "enrich", "assemble_report"]],
    ["image", { kind: "image", provided_by: "seller", storage_key: "FILE/photo.jpg", mime_type: "image/jpeg" }, ["enrich", "assemble_report"]],
    ["screenshot", { kind: "screenshot", provided_by: "buyer", storage_key: "FILE/shot.png", mime_type: "image/png" }, ["enrich", "assemble_report"]],
    ["identity correction", { kind: "seller_answer", provided_by: "seller", text_content: "123ABC", identity_correction: "registrationPlate" }, ["normalize_identity", "baseline_checks", "research", "enrich", "assemble_report"]],
  ] as const)("preserves every original report section after a %s supplement", async (_label, rawSubmission, stages) => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    await seedReportArtifacts(created);
    const submission = Object.fromEntries(Object.entries(rawSubmission).map(([key, value]) => [
      key,
      typeof value === "string" ? value.replace("FILE", created.analysisId) : value,
    ]));
    const accepted = await service.rpc("accept_analysis_submission_group", {
      p_analysis_id: created.analysisId,
      p_idempotency_key: randomUUID(),
      p_submissions: [submission],
      p_stages: stages,
    });
    expect(accepted.error).toBeNull();

    const report = await analyses.loadReport(created.publicId);

    expect(report?.vehicleFacts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "make", value: "Toyota" })]));
    expect(report?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ claim: "Original seller claim" })]));
    expect(report?.findings).toEqual(expect.arrayContaining([expect.objectContaining({
      title: "Original finding", evidenceIds: [expect.any(String)],
    })]));
    expect(report?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Original action" })]));
    expect(Object.values(report?.sources ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://www.auto24.ee/soidukid/123456" }),
    ]));
  });

  it("serializes distinct concurrent groups into cumulative runnable lineage and supersedes old jobs", async () => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    const imagePath = `${created.analysisId}/photo.jpg`;
    const upload = await service.storage.from("analysis-uploads").upload(
      imagePath,
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      { contentType: "image/jpeg" },
    );
    expect(upload.error).toBeNull();
    const answerKey = randomUUID();
    const imageKey = randomUUID();
    const [answer, image] = await Promise.all([
      service.rpc("accept_analysis_submission_group", {
        p_analysis_id: created.analysisId,
        p_idempotency_key: answerKey,
        p_submissions: [{ kind: "seller_answer", provided_by: "seller", text_content: "Changed in 2024." }],
        p_stages: ["baseline_checks", "enrich", "assemble_report"],
      }),
      service.rpc("accept_analysis_submission_group", {
        p_analysis_id: created.analysisId,
        p_idempotency_key: imageKey,
        p_submissions: [{ kind: "image", provided_by: "seller", storage_key: imagePath, mime_type: "image/jpeg" }],
        p_stages: ["enrich", "assemble_report"],
      }),
    ]);
    expect(answer.error).toBeNull();
    expect(image.error).toBeNull();

    const current = await service.from("analyses").select("current_run_id").eq("id", created.analysisId).single();
    const runs = await service.from("analysis_runs")
      .select("id, parent_run_id, submission_idempotency_key")
      .eq("analysis_id", created.analysisId);
    const currentRun = runs.data?.find((run) => run.id === current.data?.current_run_id);
    expect(currentRun?.parent_run_id).toBeTruthy();
    const currentJobs = await service.from("analysis_jobs").select("stage, status").eq("run_id", currentRun?.id);
    expect(currentJobs.data?.map((job) => job.stage).sort()).toEqual([
      "assemble_report", "baseline_checks", "enrich",
    ]);
    const supersededRun = runs.data?.find((run) => run.id === currentRun?.parent_run_id);
    const supersededJobs = await service.from("analysis_jobs").select("status").eq("run_id", supersededRun?.id);
    expect(supersededJobs.data?.every((job) => job.status === "failed")).toBe(true);

    const context = await analyses.loadRunContext(created.analysisId, currentRun?.id as string);
    expect(context.supplements).toHaveLength(2);
    const persisted = await service.from("submissions").select("id, run_id").eq("analysis_id", created.analysisId);
    expect(persisted.error).toBeNull();
    expect(context.supplements.map((item) => [item.id, item.acceptedRunId]).sort()).toEqual(
      (persisted.data ?? []).map((item) => [item.id, item.run_id]).sort(),
    );
  });

  it("coalesces truly concurrent retries with the same UUID into one run", async () => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    const key = randomUUID();
    const args = {
      p_analysis_id: created.analysisId,
      p_idempotency_key: key,
      p_submissions: [{ kind: "seller_answer", provided_by: "seller", text_content: "Same answer." }],
      p_stages: ["baseline_checks", "enrich", "assemble_report"],
    };

    const results = await Promise.all([
      service.rpc("accept_analysis_submission_group", args),
      service.rpc("accept_analysis_submission_group", args),
    ]);

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(new Set(results.map((result) => (result.data as Array<{ run_id: string }>)[0]?.run_id)).size).toBe(1);
    const runs = await service.from("analysis_runs").select("id", { count: "exact" })
      .eq("analysis_id", created.analysisId).eq("submission_idempotency_key", key);
    expect(runs.count).toBe(1);
  });

  it("leases one supplement stage per run in DAG order under concurrent workers", async () => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    const accepted = await service.rpc("accept_analysis_submission_group", {
      p_analysis_id: created.analysisId,
      p_idempotency_key: randomUUID(),
      p_submissions: [{ kind: "seller_answer", provided_by: "seller", text_content: "New answer." }],
      p_stages: ["baseline_checks", "enrich", "assemble_report"],
    });
    expect(accepted.error).toBeNull();

    const runId = (accepted.data as Array<{ run_id: string }>)[0]?.run_id as string;
    const leaseConcurrently = async (prefix: string) => {
      const leases = await Promise.all([0, 1, 2].map((index) => service.rpc("lease_analysis_job_scoped", {
        p_analysis_id: created.analysisId,
        worker_id: `${prefix}-${index}`,
        lease_seconds: 60,
      })));
      expect(leases.every((lease) => lease.error === null)).toBe(true);
      return leases.flatMap((lease) => (lease.data as Array<{ id: string; run_id: string; stage: string; leased_by: string }> | null) ?? []);
    };
    const completeStage = async (job: { id: string; stage: string; leased_by: string }) => {
      const run = await service.from("analysis_runs").select("stage_states").eq("id", runId).single();
      expect(run.error).toBeNull();
      const stageStates = {
        ...run.data?.stage_states,
        [job.stage]: { version: 1, status: "complete", output: {}, warnings: [], completedAt: new Date().toISOString() },
      };
      expect((await service.from("analysis_runs").update({ stage_states: stageStates }).eq("id", runId)).error).toBeNull();
      const completed = await service.rpc("complete_analysis_job", { p_job_id: job.id, p_worker_id: job.leased_by });
      expect(completed.error).toBeNull();
    };

    const baselineLeases = await leaseConcurrently("baseline");
    expect(baselineLeases.map((job) => job.stage)).toEqual(["baseline_checks"]);
    await completeStage(baselineLeases[0]!);

    const enrichLeases = await leaseConcurrently("enrich");
    expect(enrichLeases.map((job) => job.stage)).toEqual(["enrich"]);
    await completeStage(enrichLeases[0]!);

    const assemblyLeases = await leaseConcurrently("assembly");
    expect(assemblyLeases.map((job) => job.stage)).toEqual(["assemble_report"]);
  });

  it("orders identity supplement stages through research before enrichment and assembly", async () => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    const accepted = await service.rpc("accept_analysis_submission_group", {
      p_analysis_id: created.analysisId,
      p_idempotency_key: randomUUID(),
      p_submissions: [{ kind: "seller_answer", provided_by: "seller", text_content: "123ABC", identity_correction: "registrationPlate" }],
      p_stages: ["normalize_identity", "baseline_checks", "research", "enrich", "assemble_report"],
    });
    expect(accepted.error).toBeNull();
    const runId = (accepted.data as Array<{ run_id: string }>)[0]?.run_id as string;
    const expected = ["normalize_identity", "baseline_checks", "research", "enrich", "assemble_report"];

    for (const [index, stage] of expected.entries()) {
      const leases = await Promise.all([0, 1].map((worker) => service.rpc("lease_analysis_job_scoped", {
        p_analysis_id: created.analysisId,
        worker_id: `identity-${index}-${worker}`,
        lease_seconds: 60,
      })));
      const jobs = leases.flatMap((lease) => (lease.data as Array<{ id: string; stage: string; leased_by: string }> | null) ?? []);
      expect(jobs.map((job) => job.stage)).toEqual([stage]);
      const run = await service.from("analysis_runs").select("stage_states").eq("id", runId).single();
      expect(run.error).toBeNull();
      expect((await service.from("analysis_runs").update({ stage_states: {
        ...run.data?.stage_states,
        [stage]: { version: 1, status: "complete", output: {}, warnings: [], completedAt: new Date().toISOString() },
      } }).eq("id", runId)).error).toBeNull();
      expect((await service.rpc("complete_analysis_job", {
        p_job_id: jobs[0]!.id,
        p_worker_id: jobs[0]!.leased_by,
      })).error).toBeNull();
    }
  });

  it("treats an explicit empty terminal snapshot as authoritative instead of reviving stale artifacts", async () => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    await seedReportArtifacts(created);
    const accepted = await service.rpc("accept_analysis_submission_group", {
      p_analysis_id: created.analysisId,
      p_idempotency_key: randomUUID(),
      p_submissions: [{ kind: "seller_answer", provided_by: "seller", text_content: "Issue resolved." }],
      p_stages: ["baseline_checks", "enrich", "assemble_report"],
    });
    expect(accepted.error).toBeNull();
    const runId = (accepted.data as Array<{ run_id: string }>)[0]?.run_id as string;
    const currentRun = await service.from("analysis_runs").select("stage_states").eq("id", runId).single();
    expect(currentRun.error).toBeNull();
    const updated = await service.from("analysis_runs").update({
      stage_states: {
        ...currentRun.data?.stage_states,
        assemble_report: {
          version: 1,
          status: "complete",
          output: { status: "complete", advanceToResearch: false, evidenceIds: [] },
          warnings: [],
          completedAt: new Date().toISOString(),
        },
      },
    }).eq("id", runId);
    expect(updated.error).toBeNull();

    const report = await analyses.loadReport(created.publicId);

    expect(report?.findings).toEqual([]);
    expect(report?.actions).toEqual([]);
    expect(report?.vehicleFacts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "make" })]));
    expect(report?.evidence).toEqual([]);
  });

  it("keeps an empty terminal normalization authoritative after a supplement rerun", async () => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    await seedReportArtifacts(created);
    const accepted = await service.rpc("accept_analysis_submission_group", {
      p_analysis_id: created.analysisId,
      p_idempotency_key: randomUUID(),
      p_submissions: [{ kind: "seller_answer", provided_by: "seller", text_content: "Updated VIN",
        identity_correction: "vin" }],
      p_stages: ["normalize_identity", "baseline_checks", "research", "enrich", "assemble_report"],
    });
    expect(accepted.error).toBeNull();
    const runId = (accepted.data as Array<{ run_id: string }>)[0]!.run_id;
    const { data: current } = await service.from("analysis_runs").select("stage_states").eq("id", runId).single();
    const { error } = await service.from("analysis_runs").update({
      stage_states: { ...current!.stage_states, normalize_identity: {
        version: 1, status: "complete", output: { vehicle: {} }, warnings: [], completedAt: new Date().toISOString(),
      } },
    }).eq("id", runId);
    expect(error).toBeNull();
    expect((await analyses.loadReport(created.publicId))?.vehicleFacts).toEqual([]);
  });

  it("keeps empty terminal baseline evidence authoritative before assembly publishes", async () => {
    const created = await createAnalysis();
    await completeInitialRun(created);
    await seedReportArtifacts(created);
    const accepted = await service.rpc("accept_analysis_submission_group", {
      p_analysis_id: created.analysisId, p_idempotency_key: randomUUID(),
      p_submissions: [{ kind: "seller_answer", provided_by: "seller", text_content: "Updated answer" }],
      p_stages: ["baseline_checks", "enrich", "assemble_report"],
    });
    expect(accepted.error).toBeNull();
    const runId = (accepted.data as Array<{ run_id: string }>)[0]!.run_id;
    const { data: current } = await service.from("analysis_runs").select("stage_states").eq("id", runId).single();
    expect((await service.from("analysis_runs").update({ stage_states: {
      ...current!.stage_states,
      baseline_checks: { version: 1, status: "complete", output: { evidence: [], findings: [], actions: [] },
        warnings: [], completedAt: new Date().toISOString() },
    } }).eq("id", runId)).error).toBeNull();
    expect((await analyses.loadReport(created.publicId))?.evidence).toEqual([]);
  });
});
