import { describe, it, expect, vi } from "vitest";
import { loadDiagnostics } from "@/features/diagnostics/load-diagnostics";
const id = "11111111-1111-4111-8111-111111111111";
const input = {
  publicId: id,
  cookie: "cookie",
};
const deps = () => ({
  enabled: true,
  verifyAccess: vi.fn(async () => true),
  repository: {
    load: vi.fn(async () => null),
    result: vi.fn(async () => null),
  },
});
describe("diagnostics authorization", () => {
  it("gates disabled reads before access and database", async () => {
    const d = deps();
    d.enabled = false;
    await expect(loadDiagnostics(input, d)).rejects.toMatchObject({
      status: 404,
    });
    expect(d.repository.load).not.toHaveBeenCalled();
    expect(d.verifyAccess).not.toHaveBeenCalled();
  });
  it("rejects missing cookie before access", async () => {
    const d = deps();
    await expect(
      loadDiagnostics(
        {
          ...input,
          cookie: undefined,
        },
        d,
      ),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(d.repository.load).not.toHaveBeenCalled();
  });
  it("rejects denied cookies", async () => {
    const d = deps();
    d.verifyAccess.mockResolvedValue(false);
    await expect(loadDiagnostics(input, d)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("rejects invalid run/execution UUIDs and cursors", async () => {
    for (const extra of [
      {
        runId: "bad",
      },
      {
        executionId: "bad",
      },
      {
        cursor: "-1",
      },
    ])
      await expect(
        loadDiagnostics(
          {
            ...input,
            ...extra,
          },
          deps(),
        ),
      ).rejects.toMatchObject({
        status: 404,
      });
  });
  it("passes only authorized owner/run/result identifiers", async () => {
    const d = deps();
    await loadDiagnostics(
      {
        ...input,
        runId: id,
        executionId: id,
      },
      d,
    );
    expect(d.repository.result).toHaveBeenCalledWith(id, id, id);
  });
});
