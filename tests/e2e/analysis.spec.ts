import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAccessToken } from "../../src/server/access/tokens";
import { AnalysesRepository } from "../../src/server/repositories/analyses";

const listingUrl = "https://www.auto24.ee/soidukid/123456";

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Report E2E requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for seeded data.",
    );
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
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
      .update({ status: "complete", completed_at: capturedAt })
      .eq("id", runId),
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

  return { publicId, rawToken: token.raw };
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

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  } finally {
    const { error } = await client.from("analyses").delete().eq("public_id", seeded.publicId);
    if (error) throw new Error(`Clean up seeded report: ${error.message}`);
  }
});
