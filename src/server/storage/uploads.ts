import { measurePhotoPhase } from "@/diagnostics/photo-timings";
import { extractPdfText } from "./pdf-text";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from "@/config/image-policy";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { z } from "zod";

const BUCKET = "analysis-uploads";
const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES;
const SIGNED_URL_SECONDS = 10 * 60;
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const analysisIdSchema = z.string().uuid();

function requireAnalysisId(analysisId: string): string {
  if (!analysisIdSchema.safeParse(analysisId).success) {
    throw new Error("Analysis ID must be a valid UUID");
  }
  return analysisId;
}

export interface UploadFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface StoredUpload {
  textContent?: string;
  contentHash?: string;
  storageKey: string;
  mimeType: string;
  size: number;
}

async function stripImageMetadata(bytes: Uint8Array, mimeType: string): Promise<Uint8Array> {
  const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
  switch (mimeType) {
    case "image/jpeg":
      return new Uint8Array(await image.jpeg().toBuffer());
    case "image/png":
      return new Uint8Array(await image.png().toBuffer());
    case "image/webp":
      return new Uint8Array(await image.webp().toBuffer());
    default:
      return bytes;
  }
}

export class AnalysisUploads {
  constructor(private readonly client: SupabaseClient) {}

  async upload(analysisId: string, file: UploadFile, options: {contentAddressed?:boolean} = {}): Promise<StoredUpload> {
    const validAnalysisId = requireAnalysisId(analysisId);
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error("Upload exceeds the 12 MiB file limit");
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      throw new Error("Upload type must be JPEG, PNG, WebP, or PDF");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error("Upload exceeds the 12 MiB file limit");
    }

    const detected = await fileTypeFromBuffer(bytes);
    if (!detected || detected.mime !== file.type || !ALLOWED_MIME_TYPES.has(detected.mime)) {
      throw new Error("Upload content does not match its allowed MIME type");
    }

    const textContent = detected.mime === "application/pdf" ? await extractPdfText(bytes) : undefined;
    const persistedBytes = detected.mime.startsWith("image/")
      ? await measurePhotoPhase("normalization", () => stripImageMetadata(bytes, detected.mime))
      : bytes;
    if (persistedBytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error("Upload exceeds the 12 MiB file limit after image processing");
    }

    const contentHash = createHash("sha256").update(persistedBytes).digest("hex");
    const storageKey = `${validAnalysisId}/${options.contentAddressed ? contentHash : randomUUID()}.${detected.ext}`;
    await measurePhotoPhase("upload", async () => {
      const { error } = await this.client.storage.from(BUCKET).upload(storageKey, persistedBytes, {
        contentType: detected.mime,
        upsert: options.contentAddressed === true,
      });
      if (error) throw new Error("Could not store analysis upload", { cause: error });
    });

    return { storageKey, mimeType: detected.mime, size: persistedBytes.byteLength, contentHash, ...(textContent !== undefined ? { textContent } : {}) };
  }

  async remove(analysisId: string, storageKeys: string[]): Promise<void> {
    const validAnalysisId = requireAnalysisId(analysisId);
    const requiredPrefix = `${validAnalysisId}/`;
    if (storageKeys.some((key) => !key.startsWith(requiredPrefix) || key.length === requiredPrefix.length)) {
      throw new Error("Storage key does not belong to the authorized analysis");
    }
    if (storageKeys.length === 0) return;

    const { error } = await this.client.storage.from(BUCKET).remove(storageKeys);
    if (error) throw new Error("Could not remove analysis upload", { cause: error });
  }

  async getStoredContentHash(analysisId: string, storageKey: string): Promise<string> {
    const validAnalysisId = requireAnalysisId(analysisId);
    const requiredPrefix = `${validAnalysisId}/`;
    if (!storageKey.startsWith(requiredPrefix) || storageKey.length === requiredPrefix.length) {
      throw new Error("Storage key does not belong to the authorized analysis");
    }

    const { data, error } = await this.client.storage.from(BUCKET).download(storageKey);
    if (error || !data) throw new Error("Could not read analysis upload", { cause: error });
    if (data.size > MAX_UPLOAD_BYTES) throw new Error("Stored upload exceeds the 12 MiB file limit");
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("Stored upload exceeds the 12 MiB file limit");
    return createHash("sha256").update(bytes).digest("hex");
  }

  async readImage(analysisId: string, storageKey: string, expectedHash?: string): Promise<{bytes:Uint8Array;mimeType:string}> {
    const validAnalysisId = requireAnalysisId(analysisId);
    if (!storageKey.startsWith(`${validAnalysisId}/`) || storageKey.includes("..") || storageKey.includes("\\")) throw new Error("Storage key does not belong to the authorized analysis");
    const {data,error} = await this.client.storage.from(BUCKET).download(storageKey);
    if(error || !data || data.size > MAX_UPLOAD_BYTES) throw new Error("Image unavailable");
    const bytes = new Uint8Array(await data.arrayBuffer());
    if(bytes.byteLength > MAX_UPLOAD_BYTES || expectedHash && createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("Image unavailable");
    const detected = await fileTypeFromBuffer(bytes);
    if(!detected || !["image/jpeg","image/png","image/webp"].includes(detected.mime)) throw new Error("Image unavailable");
    return {bytes,mimeType:detected.mime};
  }

  async createSignedReadUrl(analysisId: string, storageKey: string): Promise<string> {
    return (await this.createSignedRead(analysisId, storageKey)).signedUrl;
  }

  async createSignedRead(
    analysisId: string,
    storageKey: string,
  ): Promise<{ signedUrl: string; expiresAt: string }> {
    const validAnalysisId = requireAnalysisId(analysisId);
    const requiredPrefix = `${validAnalysisId}/`;
    if (!storageKey.startsWith(requiredPrefix) || storageKey.length === requiredPrefix.length) {
      throw new Error("Storage key does not belong to the authorized analysis");
    }

    const { data, error } = await this.client.storage
      .from(BUCKET)
      .createSignedUrl(storageKey, SIGNED_URL_SECONDS);
    if (error) throw new Error("Could not sign analysis upload URL", { cause: error });
    return {
      signedUrl: data.signedUrl,
      expiresAt: new Date(Date.now() + (SIGNED_URL_SECONDS * 1000)).toISOString(),
    };
  }
}
