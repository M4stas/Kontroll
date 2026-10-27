import { describe, expect, it } from "vitest";
import {
  SourceSummarySchema,
  ActionSchema,
  ConfidenceInputSchema,
  EvidenceSchema,
  FindingSchema,
} from "@/domain/schemas";

const finding = {
  id: "finding-1",
  category: "mechanical",
  severity: "important",
  state: "open",
  title: "Service history is incomplete",
  explanation: "The listing does not include supporting invoices.",
  nextAction: "Ask for service invoices.",
  evidenceIds: ["evidence-1"],
} as const;

const evidence = (sourceClass: string, verification: string) => ({
  id: "evidence-1",
  sourceId: "source-1",
  sourceClass,
  claim: "Evidence-backed claim.",
  applicability: "exact_vehicle",
  confidence: 0.8,
  verification,
  capturedAt: "2026-09-12T12:00:00.000Z",
});

describe("domain schemas", () => {
  it("rejects unknown object keys", () => {
    expect(() =>
      ActionSchema.parse({
        id: "action-1",
        kind: "seller_question",
        title: "Ask about servicing",
        instructions: "Request dated invoices.",
        status: "open",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects confidence dimensions outside the inclusive zero-to-one range", () => {
    expect(() =>
      ConfidenceInputSchema.parse({
        identity: 1.01,
        coverage: 0.8,
        agreement: 0.8,
        freshness: 0.8,
      }),
    ).toThrow();
    expect(() =>
      ConfidenceInputSchema.parse({
        identity: 0.8,
        coverage: -0.01,
        agreement: 0.8,
        freshness: 0.8,
      }),
    ).toThrow();
  });

  it("requires evidence for critical and important findings", () => {
    expect(() => FindingSchema.parse({ ...finding, evidenceIds: [] })).toThrow();
    expect(() =>
      FindingSchema.parse({ ...finding, severity: "critical", evidenceIds: [] }),
    ).toThrow();
    expect(
      FindingSchema.parse({ ...finding, severity: "context", evidenceIds: [] }),
    ).toMatchObject({ severity: "context", evidenceIds: [] });
  });

  it.each(["listing", "seller", "buyer"])(
    "rejects official verification for %s evidence",
    (sourceClass) => {
      expect(() => EvidenceSchema.parse(evidence(sourceClass, "official"))).toThrow();
    },
  );

  it.each(["listing", "seller", "buyer"])(
    "allows non-official verification states for %s evidence",
    (sourceClass) => {
      for (const verification of ["unverified", "corroborated", "contradicted", "not_checked"]) {
        expect(EvidenceSchema.parse(evidence(sourceClass, verification))).toMatchObject({
          sourceClass,
          verification,
        });
      }
    },
  );

  it.each(["official_registry", "manufacturer", "independent", "forum"])(
    "does not restrict official verification for %s evidence",
    (sourceClass) => {
      expect(EvidenceSchema.parse(evidence(sourceClass, "official"))).toMatchObject({
        sourceClass,
        verification: "official",
      });
    },
  );
});

it.each(['https://example.test/photo.jpg','/api/analyses/report-1/images/photo-1'])('accepts image evidence URL %s',imageUrl=>{
 expect(EvidenceSchema.parse({...evidence('listing','unverified'),imageUrl})).toMatchObject({imageUrl});
});
it.each(['//evil.test/photo','/api/../secret','/api/images/%2e%2e/secret','javascript:alert(1)','/api/images/photo?redirect=https://evil.test'])('rejects unsafe image URL %s',imageUrl=>{
 expect(EvidenceSchema.safeParse({...evidence('listing','unverified'),imageUrl}).success).toBe(false);
});


it('accepts only the exact same-origin background PDF route alongside absolute source URLs',()=>{
 const path='/api/analyses/22222222-2222-4222-8222-222222222222/background-check/pdf';
 expect(SourceSummarySchema.safeParse({verification:'official',url:path}).success).toBe(true);
 expect(EvidenceSchema.safeParse({...evidence('official_registry','official'),sourceUrl:path}).success).toBe(true);
 for(const url of ['//example.test/pdf','/other','/api/analyses/../../background-check/pdf',path+'?secret=value',path+'#fragment']){
  expect(SourceSummarySchema.safeParse({verification:'official',url}).success).toBe(false);
  expect(EvidenceSchema.safeParse({...evidence('official_registry','official'),sourceUrl:url}).success).toBe(false);
 }
});
