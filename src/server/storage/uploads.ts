import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";

const BUCKET = "analysis-uploads";
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
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
  storageKey: string;
  mimeType: string;
  size: number;
}

export class AnalysisUploads {
  constructor(private readonly client: SupabaseClient) {}

  async upload(analysisId: string, file: UploadFile): Promise<StoredUpload> {
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

    const storageKey = `${validAnalysisId}/${randomUUID()}.${detected.ext}`;
    const { error } = await this.client.storage.from(BUCKET).upload(storageKey, bytes, {
      contentType: detected.mime,
      upsert: false,
    });
    if (error) throw new Error("Could not store analysis upload", { cause: error });

    return { storageKey, mimeType: detected.mime, size: bytes.byteLength };
  }

  async createSignedReadUrl(analysisId: string, storageKey: string): Promise<string> {
    const validAnalysisId = requireAnalysisId(analysisId);
    const requiredPrefix = `${validAnalysisId}/`;
    if (!storageKey.startsWith(requiredPrefix) || storageKey.length === requiredPrefix.length) {
      throw new Error("Storage key does not belong to the authorized analysis");
    }

    const { data, error } = await this.client.storage
      .from(BUCKET)
      .createSignedUrl(storageKey, SIGNED_URL_SECONDS);
    if (error) throw new Error("Could not sign analysis upload URL", { cause: error });
    return data.signedUrl;
  }
}
