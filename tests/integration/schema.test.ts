import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccessToken } from "@/server/access/tokens";
import { AnalysesRepository } from "@/server/repositories/analyses";
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

  beforeAll(() => {
    const credentials = readLocalSupabaseCredentials();
    const auth = { autoRefreshToken: false, persistSession: false };
    serviceClient = createClient(credentials.apiUrl, credentials.serviceRoleKey, { auth });
    anonymousClient = createClient(credentials.apiUrl, credentials.anonKey, { auth });
    analyses = new AnalysesRepository(serviceClient);
    jobs = new JobsRepository(serviceClient);
  });

  beforeEach(async () => {
    const { error } = await serviceClient
      .from("analyses")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    expect(error).toBeNull();
  });

  async function createAnalysis() {
    const token = createAccessToken();
    const created = await analyses.create({
      accessTokenHash: token.hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });

    return { ...created, token };
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
    expect(report?.sources[snapshot!.id]?.verification).toBe("not_checked");
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

  it("does not expose analyses through anonymous credentials", async () => {
    await createAnalysis();
    const { data, error } = await anonymousClient.from("analyses").select("id");

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
