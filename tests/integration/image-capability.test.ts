import { resolveReviewConfig } from "@/config/review";
import { createReviewPassPins } from "@/server/repositories/review-executions";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createDataReviewer } from "@/insights/provider";
import { createInsightImageCapabilityVerifier, issueInsightImageCapability } from "@/insights/image-capability";
import { supplementEvidenceId } from "@/lib/stable-id";
import { createAccessToken } from "@/server/access/tokens";
import { AnalysesRepository } from "@/server/repositories/analyses";
import { JobsRepository } from "@/server/repositories/jobs";
import { AnalysisUploads } from "@/server/storage/uploads";

const responseCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({ default: class OpenAI { responses = { create: responseCreate }; } }));

function localClient() {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  const values = Object.fromEntries(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as string];
  }));
  const key = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  if (!values.API_URL || !key) throw new Error("Local Supabase credentials unavailable");
  return { client: createClient(values.API_URL, key, { auth: { autoRefreshToken: false, persistSession: false } }), url: values.API_URL };
}

describe("private image capability path", () => {
  it("sends a real private upload through a server-issued capability to the production provider", async () => {
    const { client, url } = localClient();
    const secret = "test-image-capability-secret-with-32-bytes";
    const analyses = new AnalysesRepository(client);
    const uploads = new AnalysisUploads(client);
    const { publicId } = await analyses.create({
      accessTokenHash: createAccessToken().hash, locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/image-capability",
    });
    const { data: analysis } = await client.from("analyses").select("id").eq("public_id", publicId).single();
    if (!analysis) throw new Error("Missing test analysis");
    let storageKey: string | undefined;
    try {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3,
        background: { r: 42, g: 53, b: 64 } } }).png().toBuffer();
      const uploaded = await uploads.upload(analysis.id, {
        name: "private.png", type: "image/png", size: bytes.length,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      });
      storageKey = uploaded.storageKey;
      const accepted = await new JobsRepository(client).enqueueMany({
        analysisId: analysis.id, idempotencyKey: crypto.randomUUID(),
        submissions: [{ kind: "image", providedBy: "buyer", storageKey, mimeType: uploaded.mimeType }],
        stages: ["enrich", "assemble_report"],
      });
      const context = await analyses.loadRunContext(analysis.id, accepted.runId, { hydrateImageCapabilities: true });
      const supplement = context.supplements.find((item) => item.kind === "image");
      expect(supplement?.contentHash).toBeTruthy();
      const evidenceId = supplementEvidenceId(analysis.id, accepted.runId, supplement!);
      // Mirrors the worker's reviewImageCapability boundary.
      const capability = issueInsightImageCapability({
        evidenceId, analysisId: analysis.id, storageKey,
        ...await uploads.createSignedRead(analysis.id, storageKey),
      }, secret);
      const verified = createInsightImageCapabilityVerifier(secret).verifyServerIssuedCapability(capability);
      expect(verified).toMatchObject({ analysisId: analysis.id, storageKey });
      const signedRead = await fetch(verified!.signedUrl);
      expect(signedRead.status).toBe(200);
      expect(signedRead.headers.get("content-type")).toContain("image/png");
      expect(await sharp(Buffer.from(await signedRead.arrayBuffer())).metadata())
        .toMatchObject({ width: 2, height: 2 });
      responseCreate.mockReset();
      responseCreate.mockResolvedValue({ output_text: JSON.stringify({
        schemaVersion: 1, observations: [], warnings: [],
      }) });
      const env={OPENAI_API_KEY:'test-key',DATA_REVIEW_MODEL:'test-model'};
      const pin=createReviewPassPins(resolveReviewConfig(env,{openai:{'test-model':{responses:true,text:true,structuredOutput:true,imageInput:true,efforts:[]}}}),'en').passes.image;
      const provider=createDataReviewer(pin,env,{imageUrlVerifier:createInsightImageCapabilityVerifier(secret),allowedStorageOrigins:[url]});
      await provider.review({
        runId:accepted.runId,locale:"en",pass:"image",listing:null,sourceRecords:[],imageEvidenceId:evidenceId,
        analysisId: analysis.id,
        vehicle: { make: "Toyota", model: "Avensis", year: 2016,
          provenance: { make: [], model: [], year: [], mileageKm: [], fuel: [], transmission: [], vin: [],
            registrationPlate: [], generation: [], engineVariant: [], gearboxVariant: [] }, conflicts: [] },
        evidence: [], images: [{ evidenceId, capability }],
      });
      const [request] = responseCreate.mock.calls[0] ?? [];
      expect(JSON.stringify(request.input)).toContain("input_image");
      expect(JSON.stringify(request.input)).toContain(storageKey);
    } finally {
      try {
        if (storageKey) await uploads.remove(analysis.id, [storageKey]);
      } finally {
        const { error } = await client.from("analyses").delete().eq("id", analysis.id);
        expect(error).toBeNull();
      }
    }
  });
});
