import { describe, expect, it, vi } from "vitest";
import { ReportAccessError, loadReport } from "@/features/report/load-report";

const publicId = "7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1";

describe("loadReport", () => {
  // Catches a report lookup that reads report rows before validating its analysis-specific cookie.
  it("rejects missing access without loading the report", async () => {
    const analyses = { loadReport: vi.fn() };

    await expect(loadReport({ publicId, cookie: undefined }, {
      analyses,
      verifyAccess: vi.fn().mockResolvedValue(false),
    })).rejects.toBeInstanceOf(ReportAccessError);

    expect(analyses.loadReport).not.toHaveBeenCalled();
  });

  // Catches storage or raw run payloads reaching the public route through an unvalidated repository result.
  it("validates the private repository report before returning it", async () => {
    await expect(loadReport({ publicId, cookie: "valid-cookie" }, {
      analyses: { loadReport: vi.fn().mockResolvedValue({ publicId, storageKey: "private/raw" }) },
      verifyAccess: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow();
  });
});

it('adds a fetched PDF link without exposing storage metadata', async () => {
  const { sampleReport } = await import('../../fixtures/sample-report');
  const report = await loadReport({ publicId, cookie: 'valid' }, {
    analyses: {loadReport: vi.fn().mockResolvedValue(sampleReport)},
    verifyAccess: async () => true,
    readBackgroundCheck: async () => ({status:'fetched',reason:null,fetched_at:'2026-10-22T12:00:00Z',storage_key:'private/key'}),
  });
  expect(report?.backgroundCheck).toEqual({status:'fetched',reason:null,fetchedAt:'2026-10-22T12:00:00Z',pdfUrl:`/api/analyses/${publicId}/background-check/pdf`});
});
it('keeps old reports without a background check unchanged', async () => {
  const { sampleReport } = await import('../../fixtures/sample-report');
  const report = await loadReport({ publicId, cookie: 'valid' }, {analyses:{loadReport:async()=>sampleReport},verifyAccess:async()=>true,readBackgroundCheck:async()=>null});
  expect(report).not.toHaveProperty('backgroundCheck');
});
