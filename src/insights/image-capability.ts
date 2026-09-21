import { createHmac, timingSafeEqual } from "node:crypto";
import type { InsightImageUrlVerifier, VerifiedInsightImage } from "@/insights/provider";

interface SignedCapability {
  version: 1;
  payload: string;
  signature: string;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueInsightImageCapability(
  image: VerifiedInsightImage,
  secret: string,
): SignedCapability {
  const payload = Buffer.from(JSON.stringify(image), "utf8").toString("base64url");
  return { version: 1, payload, signature: sign(payload, secret) };
}

export function createInsightImageCapabilityVerifier(secret: string): InsightImageUrlVerifier {
  return {
    verifyServerIssuedCapability(capability: unknown): VerifiedInsightImage | null {
      if (!capability || typeof capability !== "object") return null;
      const candidate = capability as Partial<SignedCapability>;
      if (candidate.version !== 1 || typeof candidate.payload !== "string" || typeof candidate.signature !== "string") {
        return null;
      }
      const expected = Buffer.from(sign(candidate.payload, secret));
      const actual = Buffer.from(candidate.signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      try {
        const parsed = JSON.parse(Buffer.from(candidate.payload, "base64url").toString("utf8")) as Record<string, unknown>;
        return typeof parsed.evidenceId === "string"
          && typeof parsed.analysisId === "string"
          && typeof parsed.storageKey === "string"
          && typeof parsed.signedUrl === "string"
          && typeof parsed.expiresAt === "string"
          ? parsed as unknown as VerifiedInsightImage
          : null;
      } catch {
        return null;
      }
    },
  };
}
