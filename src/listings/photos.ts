import { withPhotoTiming, measurePhotoPhase } from "@/diagnostics/photo-timings";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from "@/config/image-policy";
import { lookup } from "node:dns/promises";
import { get } from "node:https";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import type { AnalysisUploads, StoredUpload } from "@/server/storage/uploads";
import { captureCitationId } from "./captured-job";

/** Exact capture-fixture hosts. No credentials, redirects, nonstandard ports or IPv6. */
const PHOTO_HOSTS = new Set(["img-bcg.eu", "img.auto24.ee", "img13.img-bcg.eu"]);
export const LISTING_PHOTO_POLICY = Object.freeze({
  version: 1,
  maxCount: 24,
  maxBytes: MAX_IMAGE_BYTES,
  maxPixels: MAX_IMAGE_PIXELS,
  maxDimension: 12_000,
  timeoutMs: 10_000,
});
export interface PreparedListingPhoto {
  index: number;
  evidenceId: string;
  status: "accepted" | "skipped" | "rejected" | "unavailable";
  storageKey?: string;
  mimeType?: string;
  contentHash?: string;
}
export interface ListingPhotoPreparation {
  version: 1;
  counts: Record<"supplied" | "selected" | "accepted" | "skipped" | "rejected" | "unavailable", number>;
  images: PreparedListingPhoto[];
}
export interface PhotoDependencies {
  download(url: URL): Promise<Uint8Array>;
  upload: AnalysisUploads["upload"];
}
function approvedUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      PHOTO_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}
export function isPublicPhotoAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const parts = address.split(".").map(Number);
  const a = parts[0]!;
  const b = parts[1]!;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 ||
    a >= 224 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
/** Resolve all addresses once and pin the public IPv4 result to the TLS request. */
export async function downloadListingPhoto(url: URL): Promise<Uint8Array> {
  if (!approvedUrl(url.href)) throw new Error("Photo URL is not approved");
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, family: 4 }),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(() => reject(Error("Photo DNS timed out")), LISTING_PHOTO_POLICY.timeoutMs);
      dnsTimer.unref();
    }),
  ]).finally(() => {
    if (dnsTimer) clearTimeout(dnsTimer);
  });
  if (!addresses.length || addresses.some(({ address }) => !isPublicPhotoAddress(address)))
    throw new Error("Photo destination is not public IPv4");
  const pinned = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        agent: false,
        lookup: (_host, options, callback) =>
          options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          Number(response.headers["content-length"] ?? 0) > LISTING_PHOTO_POLICY.maxBytes
        ) {
          response.destroy();
          reject(Error("Photo response rejected"));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > LISTING_PHOTO_POLICY.maxBytes) {
            response.destroy(Error("Photo exceeds byte limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    const timer = setTimeout(() => request.destroy(Error("Photo timed out")), LISTING_PHOTO_POLICY.timeoutMs);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
  });
}
export async function prepareListingPhotos(
  analysisId: string,
  urls: readonly string[],
  dependencies: PhotoDependencies,
): Promise<ListingPhotoPreparation> {
  const counts = {
    supplied: urls.length,
    selected: Math.min(urls.length, LISTING_PHOTO_POLICY.maxCount),
    accepted: 0,
    skipped: 0,
    rejected: 0,
    unavailable: 0,
  };
  const images: PreparedListingPhoto[] = [];
  for (const [index, raw] of urls.entries()) {
    const photo: PreparedListingPhoto = {
      index,
      evidenceId: captureCitationId(`${analysisId}:listing-photo:${index}:${raw}`),
      status: "skipped",
    };
    images.push(photo);
    if (index >= LISTING_PHOTO_POLICY.maxCount) {
      counts.skipped++;
      continue;
    }
    await withPhotoTiming(photo.evidenceId, () => measurePhotoPhase("capture_prepare", async () => {
      const url = approvedUrl(raw);
      if (!url) {
        photo.status = "rejected";
        counts.rejected++;
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = await measurePhotoPhase("download", () => dependencies.download(url));
      } catch {
        photo.status = "unavailable";
        counts.unavailable++;
        return;
      }
      let mimeType: string;
      try {
        mimeType = await measurePhotoPhase("validation", async () => {
          if (bytes.length > LISTING_PHOTO_POLICY.maxBytes) throw Error("Photo too large");
          const detected = await fileTypeFromBuffer(new Uint8Array(bytes));
          if (!detected || !["image/jpeg", "image/png", "image/webp"].includes(detected.mime)) throw Error("Invalid image");
          const metadata = await sharp(bytes, { limitInputPixels: LISTING_PHOTO_POLICY.maxPixels }).metadata();
          if (
            !metadata.width ||
            !metadata.height ||
            metadata.width > LISTING_PHOTO_POLICY.maxDimension ||
            metadata.height > LISTING_PHOTO_POLICY.maxDimension ||
            metadata.width * metadata.height > LISTING_PHOTO_POLICY.maxPixels ||
            (metadata.pages ?? 1) > 1
          )
            throw Error("Invalid dimensions");
          return detected.mime;
        });
      } catch {
        photo.status = "rejected";
        counts.rejected++;
        return;
      }
      try {
        const stored: StoredUpload = await dependencies.upload(analysisId, {
          name: `listing-${index}`,
          type: mimeType,
          size: bytes.length,
          arrayBuffer: async () => Uint8Array.from(bytes).buffer,
        });
        photo.status = "accepted";
        photo.storageKey = stored.storageKey;
        photo.mimeType = stored.mimeType;
        photo.contentHash = stored.contentHash ?? createHash("sha256").update(bytes).digest("hex");
        counts.accepted++;
      } catch {
        photo.status = "unavailable";
        counts.unavailable++;
      }
    }));
  }
  return { version: 1, counts, images };
}
