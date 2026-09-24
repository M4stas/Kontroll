import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAccessToken } from "@/server/access/tokens";
import { AnalysesRepository } from "@/server/repositories/analyses";
import { EvidenceRepository } from "@/server/repositories/evidence";
import { JobsRepository } from "@/server/repositories/jobs";

interface LocalSupabaseCredentials {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

function requireCredential(
  values: Record<string, string>,
  ...names: string[]
): string {
  const value = names.map((name) => values[name]).find(Boolean);
  if (!value) throw new Error(`Supabase status did not return ${names.join(" or ")}`);
  return value;
}

function readLocalSupabaseCredentials(): LocalSupabaseCredentials {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], {
    encoding: "utf8",
  });
  const values = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator);
        const value = JSON.parse(line.slice(separator + 1)) as string;
        return [key, value];
      }),
  );

  return {
    apiUrl: requireCredential(values, "API_URL"),
    anonKey: requireCredential(values, "ANON_KEY", "PUBLISHABLE_KEY"),
    serviceRoleKey: requireCredential(values, "SERVICE_ROLE_KEY", "SECRET_KEY"),
  };
}

describe("Supabase analysis persistence", () => {
  let serviceClient: SupabaseClient;
  let anonymousClient: SupabaseClient;
  let analyses: AnalysesRepository;
  let jobs: JobsRepository;
  const createdPublicIds = new Set<string>();

  beforeAll(() => {
    const credentials = readLocalSupabaseCredentials();
    const auth = { autoRefreshToken: false, persistSession: false };
    serviceClient = createClient(credentials.apiUrl, credentials.serviceRoleKey, { auth });
    anonymousClient = createClient(credentials.apiUrl, credentials.anonKey, { auth });
    analyses = new AnalysesRepository(serviceClient);
    jobs = new JobsRepository(serviceClient);
  });

  afterEach(async () => {
    for (const publicId of createdPublicIds) {
      const { error } = await serviceClient.from("analyses").delete().eq("public_id", publicId);
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

    return { ...created, token };
  }

  async function createAndLease(workerId: string) {
    await createAnalysis();
    const job = await jobs.lease(workerId, 60);
    if (!job) throw new Error("Expected leased analysis job");
    return job;
  }

  it("creates the analysis, initial run, and first job atomically", async () => {
    const { publicId } = await createAnalysis();
    const { data: analysis, error: analysisError } = await serviceClient
      .from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single();

    expect(analysisError).toBeNull();
    expect(analysis?.current_run_id).toBeTruthy();

    const [{ count: inputCount }, { data: runs }, { data: jobs }] = await Promise.all([
      serviceClient
        .from("analysis_inputs")
        .select("id", { count: "exact", head: true })
        .eq("analysis_id", analysis!.id),
      serviceClient
        .from("analysis_runs")
        .select("id, trigger, status")
        .eq("analysis_id", analysis!.id),
      serviceClient
        .from("analysis_jobs")
        .select("run_id, stage, status, attempts")
        .eq("analysis_id", analysis!.id),
    ]);

    expect(inputCount).toBe(1);
    expect(runs).toEqual([
      { id: analysis!.current_run_id, trigger: "initial", status: "queued" },
    ]);
    expect(jobs).toEqual([
      {
        run_id: analysis!.current_run_id,
        stage: "capture_listing",
        status: "queued",
        attempts: 0,
      },
    ]);

    await expect(analyses.loadReport(publicId)).resolves.toMatchObject({
      publicId,
      status: "queued",
      locale: "en",
      verdict: null,
      confidence: null,
      vehicleFacts: [],
      evidence: [],
      findings: [],
      actions: [],
      sources: {},
      warnings: [],
    });

    const { data: snapshot, error: snapshotError } = await serviceClient
      .from("source_snapshots")
      .insert({
        analysis_id: analysis!.id,
        run_id: analysis!.current_run_id,
        source_type: "official_registry",
        extraction_status: "unavailable",
      })
      .select("id")
      .single();
    expect(snapshotError).toBeNull();

    const { error: evidenceError } = await serviceClient.from("evidence").insert({
      analysis_id: analysis!.id,
      run_id: analysis!.current_run_id,
      source_snapshot_id: snapshot!.id,
      source_class: "official_registry",
      claim: "Previous official result",
      applicability: "exact vehicle",
      confidence: 1,
      verification: "official",
    });
    expect(evidenceError).toBeNull();

    const report = await analyses.loadReport(publicId);
    expect(report?.sources[snapshot!.id]).toBeUndefined();
  });

  it("rejects cross-analysis artifact references and mismatched replacement scope", async () => {
    const first = await createAnalysis();
    const second = await createAnalysis();
    const rows = await Promise.all([first, second].map(async ({ publicId }) => {
      const { data, error } = await serviceClient.from("analyses").select("id,current_run_id")
        .eq("public_id", publicId).single();
      expect(error).toBeNull();
      return data!;
    }));
    const a = rows[0]!;
    const b = rows[1]!;
    const source = await serviceClient.from("source_snapshots").insert({
      analysis_id: b.id, run_id: b.current_run_id, source_type: "auto24", extraction_status: "complete",
    }).select("id").single();
    expect(source.error).toBeNull();
    const fact = await serviceClient.rpc("save_stage_vehicle_facts", {
      p_analysis_id: a.id, p_run_id: a.current_run_id,
      p_facts: [{ id: randomUUID(), analysis_id: a.id, run_id: a.current_run_id,
        source_snapshot_id: source.data!.id, fact_key: "vin", fact_value: "CROSS",
        verification: "unverified", match_confidence: 0.5 }],
    });
    expect(fact.error).not.toBeNull();
    const finding = await serviceClient.rpc("save_findings", {
      p_replace_analysis_id: a.id, p_replace_run_id: b.current_run_id,
      p_findings: [{ id: randomUUID(), analysis_id: a.id, run_id: a.current_run_id,
        category: "history", severity: "important", state: "open", title: "Wrong scope",
        explanation: "Wrong scope", next_action: "Check", evidence_links: [] }],
    });
    expect(finding.error).not.toBeNull();
    const foreignEvidence = await serviceClient.from("evidence").insert({
      analysis_id: b.id, run_id: b.current_run_id, source_snapshot_id: source.data!.id,
      source_class: "seller", claim: "Foreign claim", applicability: "exact vehicle", confidence: 0.5,
    }).select("id").single();
    expect(foreignEvidence.error).toBeNull();
    const foreignLink = await serviceClient.rpc("save_findings", {
      p_replace_analysis_id: a.id, p_replace_run_id: a.current_run_id,
      p_findings: [{ id: randomUUID(), analysis_id: a.id, run_id: a.current_run_id,
        category: "history", severity: "important", state: "open", title: "Foreign link",
        explanation: "Foreign link", next_action: "Check",
        evidence_links: [{ evidence_id: foreignEvidence.data!.id, relation: "supports" }] }],
    });
    expect(foreignLink.error).not.toBeNull();
    const foreignFinding = await serviceClient.from("findings").insert({
      analysis_id: b.id, run_id: b.current_run_id, category: "history", severity: "important",
      state: "open", title: "Foreign finding", explanation: "Foreign finding", next_action: "Check",
    }).select("id").single();
    expect(foreignFinding.error).toBeNull();
    const foreignAction = await serviceClient.rpc("save_actions", {
      p_replace_analysis_id: a.id, p_replace_run_id: a.current_run_id,
      p_actions: [{ id: randomUUID(), analysis_id: a.id, run_id: a.current_run_id,
        kind: "seller_question", title: "Foreign action", instructions: "Check",
        status: "open", finding_id: foreignFinding.data!.id }],
    });
    expect(foreignAction.error).not.toBeNull();
  });

  it("empty scoped artifact replacement clears stale producer rows after response loss", async () => {
    const { publicId } = await createAnalysis();
    const { data: analysis } = await serviceClient.from("analyses").select("id,current_run_id")
      .eq("public_id", publicId).single();
    const source = await serviceClient.from("source_snapshots").insert({
      analysis_id: analysis!.id, run_id: analysis!.current_run_id,
      source_type: "auto24", extraction_status: "complete", producer_stage: "capture_listing",
    }).select("id").single();
    expect(source.error).toBeNull();
    const repository = new EvidenceRepository(serviceClient);
    await repository.saveVehicleFacts([{ id: randomUUID(), analysisId: analysis!.id,
      runId: analysis!.current_run_id, key: "vin", value: "STALE", sourceId: source.data!.id,
      verification: "unverified", confidence: 0.5 }]);
    await repository.saveVehicleFacts([], { analysisId: analysis!.id, runId: analysis!.current_run_id });
    const { data: facts } = await serviceClient.from("vehicle_facts").select("id")
      .eq("analysis_id", analysis!.id).eq("run_id", analysis!.current_run_id);
    expect(facts).toEqual([]);
    await repository.saveEvidence([{ id: randomUUID(), analysisId: analysis!.id,
      runId: analysis!.current_run_id, sourceId: source.data!.id, sourceClass: "seller",
      claim: "Stale claim", applicability: "exact vehicle", confidence: 0.5,
      verification: "unverified", capturedAt: new Date().toISOString() }],
    { analysisId: analysis!.id, runId: analysis!.current_run_id, producerStage: "baseline_checks" });
    await repository.saveEvidence([], { analysisId: analysis!.id, runId: analysis!.current_run_id,
      producerStage: "baseline_checks" });
    expect((await serviceClient.from("evidence").select("id").eq("analysis_id", analysis!.id)).data).toEqual([]);
    await repository.saveSourceSnapshots([], "capture_listing", { analysisId: analysis!.id, runId: analysis!.current_run_id });
    expect((await serviceClient.from("source_snapshots").select("id").eq("id", source.data!.id)).data).toEqual([]);
  });

  it("persists the access-token hash and never the raw token", async () => {
    const { publicId, token } = await createAnalysis();
    const { data, error } = await serviceClient
      .from("analyses")
      .select("*")
      .eq("public_id", publicId)
      .single();

    expect(error).toBeNull();
    expect(data.access_token_hash).toBe(token.hash);
    expect(Object.values(data)).not.toContain(token.raw);
    expect(data).not.toHaveProperty("access_token");
  });

  it("persists finding evidence links as supporting evidence", async () => {
    const { publicId } = await createAnalysis();
    const { data: analysis, error: analysisError } = await serviceClient
      .from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single();
    expect(analysisError).toBeNull();

    const { data: snapshot, error: snapshotError } = await serviceClient
      .from("source_snapshots")
      .insert({
        analysis_id: analysis!.id,
        run_id: analysis!.current_run_id,
        source_type: "listing",
        extraction_status: "complete",
      })
      .select("id")
      .single();
    expect(snapshotError).toBeNull();

    const evidence = new EvidenceRepository(serviceClient);
    const [supportingEvidenceId, contradictingEvidenceId] = await evidence.saveEvidence([
      {
        analysisId: analysis!.id,
        runId: analysis!.current_run_id,
        sourceId: snapshot!.id,
        sourceClass: "listing",
        claim: "The listing states a recent service.",
        applicability: "exact vehicle",
        confidence: 0.8,
        verification: "unverified",
        capturedAt: new Date().toISOString(),
      },
      {
        analysisId: analysis!.id,
        runId: analysis!.current_run_id,
        sourceId: snapshot!.id,
        sourceClass: "listing",
        claim: "The listing photo contradicts the service claim.",
        applicability: "exact vehicle",
        confidence: 0.7,
        verification: "contradicted",
        capturedAt: new Date().toISOString(),
      },
    ]);
    if (!supportingEvidenceId || !contradictingEvidenceId) {
      throw new Error("Expected saved evidence");
    }
    const [findingId] = await evidence.saveFindings([
      {
        analysisId: analysis!.id,
        runId: analysis!.current_run_id,
        category: "maintenance",
        severity: "important",
        state: "open",
        title: "Recent service needs corroboration",
        explanation: "The claim comes from the listing.",
        nextAction: "Request the service invoice.",
        evidenceLinks: [
          { evidenceId: supportingEvidenceId, relation: "supports" },
          { evidenceId: contradictingEvidenceId, relation: "contradicts" },
        ],
        origin: "deterministic",
      },
    ]);

    const { data: links, error: linkError } = await serviceClient
      .from("finding_evidence")
      .select("finding_id, evidence_id, relation")
      .eq("finding_id", findingId);

    expect(linkError).toBeNull();
    expect(links).toEqual(
      expect.arrayContaining([
        {
          finding_id: findingId,
          evidence_id: supportingEvidenceId,
          relation: "supports",
        },
        {
          finding_id: findingId,
          evidence_id: contradictingEvidenceId,
          relation: "contradicts",
        },
      ]),
    );
  });

  it("rolls back findings when an evidence relation is invalid", async () => {
    const { publicId } = await createAnalysis();
    const { data: analysis } = await serviceClient
      .from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single();
    const evidence = new EvidenceRepository(serviceClient);

    await expect(
      evidence.saveFindings([
        {
          analysisId: analysis!.id,
          runId: analysis!.current_run_id,
          category: "maintenance",
          severity: "important",
          state: "open",
          title: "Must not persist partially",
          explanation: "The relation is invalid.",
          nextAction: "Reject the write.",
          evidenceLinks: [{ evidenceId: randomUUID(), relation: "invalid" as never }],
          origin: "deterministic",
        },
      ]),
    ).rejects.toThrow();

    const { count, error } = await serviceClient
      .from("findings")
      .select("id", { count: "exact", head: true })
      .eq("analysis_id", analysis!.id);
    expect(error).toBeNull();
    expect(count).toBe(0);
  });

  it("never leases the same available job to two workers", async () => {
    await createAnalysis();
    const firstLease = await jobs.lease("worker-a", 60);
    const secondLease = await jobs.lease("worker-b", 60);

    expect(firstLease).not.toBeNull();
    expect(secondLease).toBeNull();
  });

  it("makes an expired lease available to another worker", async () => {
    await createAnalysis();
    const leasedJob = await jobs.lease("worker-a", 60);
    expect(leasedJob).toBeTruthy();

    const { error: expireError } = await serviceClient
      .from("analysis_jobs")
      .update({ lease_expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", leasedJob!.id);
    expect(expireError).toBeNull();

    const secondLease = await jobs.lease("worker-b", 60);

    expect(secondLease).toMatchObject({
      id: leasedJob!.id,
      leasedBy: "worker-b",
      attempts: 2,
    });
  });

  it("rejects every stale-worker transition after a job is re-leased", async () => {
    const staleLease = await createAndLease("worker-a");
    const { error: expireError } = await serviceClient
      .from("analysis_jobs")
      .update({ lease_expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", staleLease.id);
    expect(expireError).toBeNull();

    const currentLease = await jobs.lease("worker-b", 60);
    if (!currentLease) throw new Error("Expected replacement lease");

    await expect(jobs.renew(currentLease.id, "worker-a", 60)).rejects.toThrow("active lease");
    await expect(jobs.complete(currentLease.id, "worker-a")).rejects.toThrow("active lease");
    await expect(
      jobs.retry(currentLease.id, "worker-a", new Date(), "retry"),
    ).rejects.toThrow("active lease");
    await expect(jobs.fail(currentLease.id, "worker-a", "failed")).rejects.toThrow(
      "active lease",
    );

    await jobs.complete(currentLease.id, "worker-b");
    const { data: completed } = await serviceClient
      .from("analysis_jobs")
      .select("status, leased_by, lease_expires_at")
      .eq("id", currentLease.id)
      .single();
    expect(completed).toEqual({ status: "complete", leased_by: null, lease_expires_at: null });
  });

  it("rejects every transition after the current worker lease expires", async () => {
    const expiredLease = await createAndLease("worker-a");
    const { error: expireError } = await serviceClient
      .from("analysis_jobs")
      .update({ lease_expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", expiredLease.id);
    expect(expireError).toBeNull();

    await expect(jobs.renew(expiredLease.id, "worker-a", 60)).rejects.toThrow("active lease");
    await expect(jobs.complete(expiredLease.id, "worker-a")).rejects.toThrow("active lease");
    await expect(
      jobs.retry(expiredLease.id, "worker-a", new Date(), "retry"),
    ).rejects.toThrow("active lease");
    await expect(jobs.fail(expiredLease.id, "worker-a", "failed")).rejects.toThrow(
      "active lease",
    );
  });

  it("allows the live lease owner to renew, retry, and fail jobs", async () => {
    const retryJob = await createAndLease("worker-a");
    await jobs.renew(retryJob.id, "worker-a", 120);
    const availableAt = new Date(Date.now() + 30_000);
    await jobs.retry(retryJob.id, "worker-a", availableAt, "try later");

    const { data: retried } = await serviceClient
      .from("analysis_jobs")
      .select("status, available_at, leased_by, last_error")
      .eq("id", retryJob.id)
      .single();
    expect(retried).toMatchObject({
      status: "queued",
      leased_by: null,
      last_error: { message: "try later" },
    });
    expect(new Date(retried!.available_at).toISOString()).toBe(availableAt.toISOString());

    const failedJob = await createAndLease("worker-b");
    await jobs.fail(failedJob.id, "worker-b", "permanent failure");
    const { data: failed } = await serviceClient
      .from("analysis_jobs")
      .select("status, leased_by, last_error")
      .eq("id", failedJob.id)
      .single();
    expect(failed).toEqual({
      status: "failed",
      leased_by: null,
      last_error: { message: "permanent failure" },
    });
  });

  it("rejects non-positive and overlong lease renewals", async () => {
    const job = await createAndLease("worker-a");

    await expect(jobs.renew(job.id, "worker-a", 0)).rejects.toThrow("between 1 and 3600");
    await expect(jobs.renew(job.id, "worker-a", 3_601)).rejects.toThrow(
      "between 1 and 3600",
    );
  });

  it("does not expose persistence mutation RPCs to anonymous credentials", async () => {
    const jobId = randomUUID();
    const results = await Promise.all([
      anonymousClient.rpc("renew_analysis_job", {
        p_job_id: jobId,
        p_worker_id: "worker-a",
        p_lease_seconds: 60,
      }),
      anonymousClient.rpc("complete_analysis_job", {
        p_job_id: jobId,
        p_worker_id: "worker-a",
      }),
      anonymousClient.rpc("retry_analysis_job", {
        p_job_id: jobId,
        p_worker_id: "worker-a",
        p_available_at: new Date().toISOString(),
        p_message: "retry",
      }),
      anonymousClient.rpc("fail_analysis_job", {
        p_job_id: jobId,
        p_worker_id: "worker-a",
        p_message: "failed",
      }),
      anonymousClient.rpc("save_findings", { p_findings: [] }),
    ]);

    for (const result of results) expect(result.error).not.toBeNull();
  });

  it("does not expose analyses through anonymous credentials", async () => {
    await createAnalysis();
    const { data, error } = await anonymousClient.from("analyses").select("id");

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
