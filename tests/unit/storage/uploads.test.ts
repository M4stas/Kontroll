import { createHash } from "node:crypto";
import sharp from "sharp";
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
  const remove = vi.fn().mockResolvedValue({ data: [], error: null });
  const createSignedUrl = vi.fn().mockResolvedValue({
    data: { signedUrl: "http://127.0.0.1/signed" },
    error: null,
  });
  const from = vi.fn().mockReturnValue({ upload, createSignedUrl, remove });

  return { client: { storage: { from } }, from, upload, createSignedUrl, remove };
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
      new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n5 0 obj << /Length 54 >> stream\nBT /F1 12 Tf 10 100 Td (Vehicle history) Tj ET\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF"),
    );

    const result = await new AnalysisUploads(storage.client as never).upload(
      ANALYSIS_ID,
      file,
    );

    expect(result).toMatchObject({ mimeType: "application/pdf" });
    expect(result.textContent).toContain("[Page 1]");
    expect(result.textContent).toContain("Vehicle history");
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


  it("hashes downloaded persisted bytes for a private analysis upload", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255]);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const download = vi.fn().mockResolvedValue({
      data: { arrayBuffer: vi.fn().mockResolvedValue(buffer) },
      error: null,
    });
    const from = vi.fn().mockReturnValue({ download });
    const uploads = new AnalysisUploads({ storage: { from } } as never);
    const getStoredContentHash = (uploads as unknown as {
      getStoredContentHash?: (analysisId: string, storageKey: string) => Promise<string>;
    }).getStoredContentHash;

    expect(typeof getStoredContentHash).toBe("function");
    if (!getStoredContentHash) return;
    await expect(getStoredContentHash.call(uploads, ANALYSIS_ID, `${ANALYSIS_ID}/photo.webp`)).resolves.toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(from).toHaveBeenCalledWith("analysis-uploads");
    expect(download).toHaveBeenCalledWith(`${ANALYSIS_ID}/photo.webp`);
  });

  it("does not download stored bytes through a cross-analysis storage key", async () => {
    const download = vi.fn();
    const from = vi.fn().mockReturnValue({ download });
    const uploads = new AnalysisUploads({ storage: { from } } as never);
    const getStoredContentHash = (uploads as unknown as {
      getStoredContentHash?: (analysisId: string, storageKey: string) => Promise<string>;
    }).getStoredContentHash;

    expect(typeof getStoredContentHash).toBe("function");
    if (!getStoredContentHash) return;
    await expect(getStoredContentHash.call(uploads, ANALYSIS_ID, `${OTHER_ANALYSIS_ID}/photo.webp`)).rejects.toThrow("does not belong");
    expect(from).not.toHaveBeenCalled();
  });

  it("refuses to sign a key owned by another analysis", async () => {
    const storage = storageClient();
    const uploads = new AnalysisUploads(storage.client as never);

    await expect(
      uploads.createSignedReadUrl(ANALYSIS_ID, `${OTHER_ANALYSIS_ID}/file.pdf`),
    ).rejects.toThrow("does not belong");
    expect(storage.from).not.toHaveBeenCalled();
  });

  it("applies EXIF orientation and strips metadata before storing an image", async () => {
    const storage = storageClient();
    const original = await sharp({
      create: { width: 2, height: 3, channels: 3, background: "red" },
    }).jpeg().withMetadata({
      orientation: 6,
      exif: { IFD0: { ImageDescription: "private seller metadata" } },
    }).toBuffer();
    const file = uploadFile("seller-photo.jpg", "image/jpeg", original);

    await new AnalysisUploads(storage.client as never).upload(ANALYSIS_ID, file);

    const stored = storage.upload.mock.calls[0]?.[1] as Uint8Array;
    const metadata = await sharp(stored).metadata();
    expect(metadata.width).toBe(3);
    expect(metadata.height).toBe(2);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.comments).toBeUndefined();
  });

  it("removes only keys scoped to the authorized analysis", async () => {
    const storage = storageClient();
    const uploads = new AnalysisUploads(storage.client as never);
    const ownKey = `${ANALYSIS_ID}/file.pdf`;

    await uploads.remove(ANALYSIS_ID, [ownKey]);

    expect(storage.remove).toHaveBeenCalledWith([ownKey]);
    await expect(
      uploads.remove(ANALYSIS_ID, [`${OTHER_ANALYSIS_ID}/file.pdf`]),
    ).rejects.toThrow("does not belong");
  });
});

it("reuses private content-addressed image storage across capture retries",async()=>{
 const storage=storageClient();
 const uploads=new AnalysisUploads(storage.client as never);
 const bytes=new Uint8Array(await sharp({create:{width:2,height:2,channels:3,background:"red"}}).jpeg().toBuffer());
 const file=uploadFile("photo.jpg","image/jpeg",bytes);
 const first=await uploads.upload(ANALYSIS_ID,file,{contentAddressed:true});
 const retry=await uploads.upload(ANALYSIS_ID,file,{contentAddressed:true});
 expect(first.storageKey).toBe(retry.storageKey);
 expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
 expect(storage.upload).toHaveBeenLastCalledWith(first.storageKey,expect.any(Uint8Array),{contentType:"image/jpeg",upsert:true});
});

// Catches foreign paths, replaced image bytes, and documents served as photos.
it("only reads owned image bytes matching the pinned content", async () => {
 const bytes = await sharp({create:{width:2,height:2,channels:3,background:"red"}}).png().toBuffer();
 const download = vi.fn().mockResolvedValue({data:new Blob([bytes]),error:null});
 const uploads = new AnalysisUploads({storage:{from:()=>({download})}} as never);
 await expect(uploads.readImage(ANALYSIS_ID,`${OTHER_ANALYSIS_ID}/photo.png`)).rejects.toThrow("authorized analysis");
 expect(download).not.toHaveBeenCalled();
 await expect(uploads.readImage(ANALYSIS_ID,`${ANALYSIS_ID}/photo.png`, "wrong-hash")).rejects.toThrow("Image unavailable");
 const image = await uploads.readImage(ANALYSIS_ID,`${ANALYSIS_ID}/photo.png`,createHash("sha256").update(bytes).digest("hex"));
 expect(image.mimeType).toBe("image/png"); expect(Buffer.from(image.bytes)).toEqual(bytes);
 download.mockResolvedValue({data:new Blob([new Uint8Array([0x25,0x50,0x44,0x46,0x2d,0x31,0x2e,0x37])]),error:null});
 await expect(uploads.readImage(ANALYSIS_ID,`${ANALYSIS_ID}/document.pdf`)).rejects.toThrow("Image unavailable");
});

 it("rejects corrupt PDFs before storing them", async () => {
 const storage = storageClient();
 await expect(new AnalysisUploads(storage.client as never).upload(ANALYSIS_ID, uploadFile("broken.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.7\n%%EOF")))).rejects.toThrow("PDF");
 expect(storage.upload).not.toHaveBeenCalled();
 });
