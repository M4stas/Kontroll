import { expect, it, vi } from "vitest";
import sharp from "sharp";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
const network = vi.hoisted(() => ({
  status: 200,
  body: Buffer.alloc(0),
  addresses: [{ address: "8.8.8.8", family: 4 }],
}));
vi.mock("node:dns/promises", () => ({
  default: { lookup: async () => network.addresses },
  lookup: async () => network.addresses,
}));
vi.mock("node:https", () => {
  const get = (_url: unknown, options: unknown, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { destroy: (error: Error) => void };
    request.destroy = (error) => {
      request.emit("error", error);
      request.emit("close");
    };
    queueMicrotask(() => {
      const lookup = (
        options as {
          lookup?: (
            host: string,
            options: { all: boolean; family: number },
            callback: (error: Error | null, result: unknown) => void,
          ) => void;
        }
      ).lookup;
      if (!lookup) {
        request.destroy(Error("Expected pinned lookup"));
        return;
      }
      lookup("img13.img-bcg.eu", { all: true, family: 4 }, (error, result) => {
        if (error) {
          request.destroy(error);
          return;
        }
        if (!Array.isArray(result)) {
          const invalidAddress = Object.assign(
            new TypeError(`Invalid IP address: ${String((result as { address?: string })?.address)}`),
            { code: "ERR_INVALID_IP_ADDRESS" },
          );
          request.destroy(invalidAddress);
          return;
        }
        const response = Readable.from([network.body]) as Readable & { statusCode: number; headers: object };
        response.statusCode = network.status;
        response.headers = {};
        callback(response);
        response.on("close", () => request.emit("close"));
      });
    });
    return request;
  };
  return { get, default: { get } };
});
import { prepareListingPhotos, isPublicPhotoAddress, downloadListingPhoto } from "@/listings/photos";

it("selects deterministic bounded photos and distinguishes failure from absence", async () => {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
    .jpeg()
    .toBuffer();
  const urls = [
    "https://img13.img-bcg.eu/ok.jpg",
    "https://img-bcg.eu/down.jpg",
    "http://img-bcg.eu/no.jpg",
    "https://evil.test/car.jpg",
    ...Array.from({ length: 25 }, (_, i) => `https://img-bcg.eu/${i}.jpg`),
  ];
  const result = await prepareListingPhotos("550e8400-e29b-41d4-a716-446655440000", urls, {
    download: async (url) => {
      if (url.pathname === "/down.jpg") throw Error("down");
      return bytes;
    },
    upload: async () => ({
      storageKey: "550e8400-e29b-41d4-a716-446655440000/photo.jpg",
      mimeType: "image/jpeg",
      size: bytes.length,
      contentHash: "a".repeat(64),
    }),
  });
  expect(result.counts).toEqual({ supplied: 29, selected: 24, accepted: 21, skipped: 5, rejected: 2, unavailable: 1 });
  expect(result.images[0]).toMatchObject({ status: "accepted", contentHash: "a".repeat(64) });
  expect(result.images[1]).toMatchObject({ status: "unavailable" });
});
it("rejects reserved network destinations", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.1.2",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
  ])
    expect(isPublicPhotoAddress(ip)).toBe(false);
  expect(isPublicPhotoAddress("8.8.8.8")).toBe(true);
});
it("rejects invalid images before private storage", async () => {
  let stored = false;
  const result = await prepareListingPhotos(
    "550e8400-e29b-41d4-a716-446655440000",
    ["https://img-bcg.eu/invalid.jpg"],
    {
      download: async () => Buffer.from("not an image"),
      upload: async () => {
        stored = true;
        throw Error("unexpected");
      },
    },
  );
  expect(result.images[0]?.status).toBe("rejected");
  expect(stored).toBe(false);
});

it("supports Node all-result lookup callbacks while pinning the public address", async () => {
  network.body = Buffer.from("photo bytes");
  const bytes = await downloadListingPhoto(new URL("https://img13.img-bcg.eu/photo.jpg"));
  expect(Buffer.from(bytes)).toEqual(Buffer.from("photo bytes"));
  network.body = Buffer.alloc(0);
});
it("refuses redirects and oversized response streams without following another host", async () => {
  network.status = 302;
  await expect(downloadListingPhoto(new URL("https://img13.img-bcg.eu/photo.jpg"))).rejects.toThrow(
    "Photo response rejected",
  );
  network.status = 200;
  network.body = Buffer.alloc(12 * 1024 * 1024 + 1);
  await expect(downloadListingPhoto(new URL("https://img13.img-bcg.eu/photo.jpg"))).rejects.toThrow("byte limit");
  network.body = Buffer.alloc(0);
});
it("refuses mixed public/private DNS answers", async () => {
  network.addresses = [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await expect(downloadListingPhoto(new URL("https://img13.img-bcg.eu/photo.jpg"))).rejects.toThrow("not public IPv4");
  network.addresses = [{ address: "8.8.8.8", family: 4 }];
});
