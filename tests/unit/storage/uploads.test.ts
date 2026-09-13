import { describe, expect, it, vi } from "vitest";
import { AnalysisUploads } from "@/server/storage/uploads";

const ANALYSIS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ANALYSIS_ID = "22222222-2222-4222-8222-222222222222";

function uploadFile(name: string, type: string, bytes: Uint8Array, size = bytes.byteLength) {
  return {
    name,
    type,
    size,
    arrayBuffer: vi.fn().mockResolvedValue(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ),
  };
}

function storageClient() {
  const upload = vi.fn().mockResolvedValue({ data: { path: "stored" }, error: null });
  const createSignedUrl = vi.fn().mockResolvedValue({
    data: { signedUrl: "http://127.0.0.1/signed" },
    error: null,
  });
  const from = vi.fn().mockReturnValue({ upload, createSignedUrl });

  return { client: { storage: { from } }, from, upload, createSignedUrl };
}

describe("private analysis uploads", () => {
  it("rejects files larger than 12 MiB before reading them", async () => {
    const storage = storageClient();
    const file = uploadFile(
      "large.pdf",
      "application/pdf",
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      12 * 1024 * 1024 + 1,
    );

    await expect(
      new AnalysisUploads(storage.client as never).upload(ANALYSIS_ID, file),
    ).rejects.toThrow("12 MiB");
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects unsupported content even when its declared MIME type is allowed", async () => {
    const storage = storageClient();
    const file = uploadFile(
      "pretend.pdf",
      "application/pdf",
      new TextEncoder().encode("not a pdf"),
    );

    await expect(
      new AnalysisUploads(storage.client as never).upload(ANALYSIS_ID, file),
    ).rejects.toThrow("content does not match");
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("uploads a validated PDF to the private bucket", async () => {
    const storage = storageClient();
    const file = uploadFile(
      "inspection.pdf",
      "application/pdf",
      new TextEncoder().encode("%PDF-1.7\n%%EOF"),
    );

    const result = await new AnalysisUploads(storage.client as never).upload(
      ANALYSIS_ID,
      file,
    );

    expect(result).toMatchObject({ mimeType: "application/pdf", size: 14 });
    expect(result.storageKey).toMatch(
      /^11111111-1111-4111-8111-111111111111\/[0-9a-f-]+\.pdf$/,
    );
    expect(storage.from).toHaveBeenCalledWith("analysis-uploads");
    expect(storage.upload).toHaveBeenCalledWith(
      result.storageKey,
      expect.any(Uint8Array),
      { contentType: "application/pdf", upsert: false },
    );
  });

  it("rejects a non-UUID analysis ID before reading or storing the upload", async () => {
    const storage = storageClient();
    const file = uploadFile(
      "inspection.pdf",
      "application/pdf",
      new TextEncoder().encode("%PDF-1.7\n%%EOF"),
    );

    await expect(
      new AnalysisUploads(storage.client as never).upload("../another-analysis", file),
    ).rejects.toThrow("valid UUID");
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(storage.from).not.toHaveBeenCalled();
  });

  it("creates signed read URLs that expire after 10 minutes", async () => {
    const storage = storageClient();
    const uploads = new AnalysisUploads(storage.client as never);
    const storageKey = `${ANALYSIS_ID}/file.pdf`;

    await expect(uploads.createSignedReadUrl(ANALYSIS_ID, storageKey)).resolves.toBe(
      "http://127.0.0.1/signed",
    );
    expect(storage.createSignedUrl).toHaveBeenCalledWith(storageKey, 600);
  });

  it("refuses to sign a key owned by another analysis", async () => {
    const storage = storageClient();
    const uploads = new AnalysisUploads(storage.client as never);

    await expect(
      uploads.createSignedReadUrl(ANALYSIS_ID, `${OTHER_ANALYSIS_ID}/file.pdf`),
    ).rejects.toThrow("does not belong");
    expect(storage.from).not.toHaveBeenCalled();
  });
});
