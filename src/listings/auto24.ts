import * as cheerio from "cheerio";
import {
  hashRawContent,
  normalizeWhitespace,
  type ListingAdapter,
  type ListingCaptureInput,
  type ListingCaptureResult,
  type ListingFact,
  type ListingFallbackRequired,
  type ListingSnapshot,
} from "@/listings/adapter";

const AUTO24_HOSTNAMES = new Set(["auto24.ee", "www.auto24.ee"]);
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Kontroll used-car analysis prototype listing capture";

type ListingFieldKey =
  | "title"
  | "price"
  | "make"
  | "model"
  | "year"
  | "mileage"
  | "fuel"
  | "gearbox";

type ExtractedFields = Partial<Record<ListingFieldKey, string>>;

export interface Auto24AdapterDependencies {
  fetch?: typeof globalThis.fetch;
  fetchEnabled?: boolean;
}

function readText($: cheerio.CheerioAPI, selector: string): string | undefined {
  const element = $(selector).first();
  if (element.length === 0) return undefined;

  return normalizeWhitespace(element.attr("content") ?? element.text()) || undefined;
}

function readImages($: cheerio.CheerioAPI): string[] {
  return [...new Set($("[itemprop='image'], [data-testid='listing-image']").map((_, element) => {
    const image = $(element);
    return image.attr("src") ?? image.attr("content") ?? "";
  }).get().filter(Boolean))];
}

function readInspectionImages($: cheerio.CheerioAPI): NonNullable<ListingSnapshot["inspectionImages"]> {
  const images: NonNullable<ListingSnapshot["inspectionImages"]> = [];
  $("[itemprop='image'], [data-testid='listing-image']").each((_, element) => {
    const image = $(element);
    const url = image.attr("src") ?? image.attr("content");
    const label = normalizeWhitespace(image.attr("alt") ?? image.attr("title") ?? "").toLocaleLowerCase("et");
    if (!url || !label) return;
    const category = /\b(?:underside|underbody)\b|põhjaalune/.test(label) ? "underside"
      : /\bengine bay\b|mootoriruum/.test(label) ? "engine_bay"
      : /\binstrument cluster\b|armatuurlaud|näidikuplokk/.test(label) ? "instrument_cluster"
      : /\bservice (?:document|record|invoice)\b|hooldusarve|hooldusraamat/.test(label) ? "service_document" : null;
    if (category) images.push({ url, category });
  });
  return images;
}

function semanticFields($: cheerio.CheerioAPI): ExtractedFields {
  return {
    title: readText($, "[itemprop='name'], h1"),
    price: readText($, "[itemprop='price'], [data-testid='price'], .price"),
    make: readText($, "[itemprop='brand']"),
    model: readText($, "[itemprop='model']"),
    year: readText($, "[itemprop='productionDate'], [itemprop='vehicleModelDate']"),
    mileage: readText($, "[itemprop='mileageFromOdometer']"),
    fuel: readText($, "[itemprop='fuelType']"),
    gearbox: readText($, "[itemprop='vehicleTransmission']"),
  };
}

function collectJsonLd(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(collectJsonLd);
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectJsonLd)];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return normalizeWhitespace(String(value)) || undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return stringValue(record.name ?? record.value);
  }
  return undefined;
}

function jsonLdFields($: cheerio.CheerioAPI): ExtractedFields {
  const entries = $("script[type='application/ld+json']")
    .map((_, element) => {
      try {
        return JSON.parse($(element).text()) as unknown;
      } catch {
        return undefined;
      }
    })
    .get()
    .flatMap(collectJsonLd);
  const vehicle = entries.find((entry) => {
    const type = entry["@type"];
    return type === "Car" || type === "Vehicle" || (Array.isArray(type) && type.includes("Car"));
  });
  if (!vehicle) return {};

  const offers = vehicle.offers as Record<string, unknown> | undefined;
  return {
    title: stringValue(vehicle.name),
    price: stringValue(offers?.price),
    make: stringValue(vehicle.brand),
    model: stringValue(vehicle.model),
    year: stringValue(vehicle.vehicleModelDate ?? vehicle.dateVehicleFirstRegistered),
    mileage: stringValue(vehicle.mileageFromOdometer),
    fuel: stringValue(vehicle.fuelType),
    gearbox: stringValue(vehicle.vehicleTransmission),
  };
}

function fieldsFromLabel(label: string, value: string): ExtractedFields {
  switch (label.toLocaleLowerCase("et")) {
    case "mark":
      return { make: value };
    case "mudel":
      return { model: value };
    case "mark ja mudel": {
      const [make, ...model] = value.split(" ");
      return make && model.length > 0 ? { make, model: model.join(" ") } : { title: value };
    }
    case "aasta":
      return { year: value };
    case "läbisõit":
      return { mileage: value };
    case "kütus":
      return { fuel: value };
    case "käigukast":
      return { gearbox: value };
    case "hind":
      return { price: value };
    default:
      return {};
  }
}

function labeledFields($: cheerio.CheerioAPI): ExtractedFields {
  const fields: ExtractedFields = {};
  $("tr").each((_, row) => {
    const cells = $(row).find("th, td");
    const label = normalizeWhitespace(cells.first().text());
    const value = normalizeWhitespace(cells.last().text());
    if (label && value && cells.length >= 2) Object.assign(fields, fieldsFromLabel(label, value));
  });
  $("dt").each((_, term) => {
    const label = normalizeWhitespace($(term).text());
    const value = normalizeWhitespace($(term).next("dd").text());
    if (label && value) Object.assign(fields, fieldsFromLabel(label, value));
  });
  return fields;
}

function mergeFields(...sources: ExtractedFields[]): ExtractedFields {
  const fields: ExtractedFields = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value) fields[key as ListingFieldKey] = value;
    }
  }
  return fields;
}

function listingFacts(fields: ExtractedFields, sourceId: string): ListingFact[] {
  return Object.entries(fields)
    .filter((entry): entry is [ListingFieldKey, string] => Boolean(entry[1]))
    .map(([key, value]) => ({
      key,
      value,
      sourceId,
      verification: "unverified" as const,
      confidence: 0.5,
    }));
}

function fallbackRequired(
  reason: ListingFallbackRequired["reason"],
  listingUrl: URL,
): ListingFallbackRequired {
  return { type: "fallback_required", reason, listingUrl: listingUrl.href };
}

function isBlocked(response: Response, html: string): boolean {
  if ([401, 403, 429, 503].includes(response.status)) return true;
  return /captcha|access denied|temporarily blocked/i.test(html);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup failures must not replace the adapter's typed fallback outcome.
  }
}

function hasRequiredIdentity(snapshot: ListingSnapshot): boolean {
  const identity = new Set(snapshot.facts.map((fact) => fact.key));
  return identity.has("make") && identity.has("model");
}

async function isFetchEnabled(dependencies: Auto24AdapterDependencies): Promise<boolean> {
  if (dependencies.fetchEnabled !== undefined) return dependencies.fetchEnabled;

  const { getServerEnv } = await import("@/config/env");
  return getServerEnv().AUTO24_FETCH_ENABLED;
}

export function parseAuto24Html(html: string, url: URL): ListingSnapshot {
  const $ = cheerio.load(html);
  const description = readText($, "[itemprop='description'], [data-testid='description'], .description") ?? "";
  const contentHash = hashRawContent(html);
  const sourceId = `auto24:${contentHash.slice(0, 16)}`;
  const fields = mergeFields(labeledFields($), jsonLdFields($), semanticFields($));

  return {
    type: "snapshot",
    marketplace: "auto24",
    sourceId,
    sourceUrl: url.href,
    capturedAt: new Date().toISOString(),
    contentHash,
    description,
    imageUrls: readImages($),
    inspectionImages: readInspectionImages($),
    screenshotRefs: [],
    facts: listingFacts(fields, sourceId),
    claims: description
      ? [{ text: description, sourceClass: "seller", verification: "unverified" }]
      : [],
    warnings: [],
  };
}

export class Auto24ListingAdapter implements ListingAdapter {
  constructor(private readonly dependencies: Auto24AdapterDependencies = {}) {}

  canHandle(url: URL): boolean {
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      AUTO24_HOSTNAMES.has(url.hostname)
    );
  }

  async capture(input: ListingCaptureInput): Promise<ListingCaptureResult> {
    if (!this.canHandle(input.url)) return fallbackRequired("unsupported_url", input.url);

    const fetchEnabled = await isFetchEnabled(this.dependencies);
    if (!fetchEnabled) return fallbackRequired("fetch_disabled", input.url);

    let response: Response;
    try {
      response = await (this.dependencies.fetch ?? globalThis.fetch)(input.url, {
        credentials: "omit",
        cache: "no-store",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return fallbackRequired("fetch_failed", input.url);
    }

    if (isBlocked(response, "")) {
      await cancelResponseBody(response);
      return fallbackRequired("blocked_response", input.url);
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      return fallbackRequired("fetch_failed", input.url);
    }

    let html: string;
    try {
      html = await response.text();
    } catch {
      return fallbackRequired("fetch_failed", input.url);
    }
    if (isBlocked(response, html)) return fallbackRequired("blocked_response", input.url);

    const snapshot = parseAuto24Html(html, input.url);
    return hasRequiredIdentity(snapshot)
      ? snapshot
      : fallbackRequired("missing_required_identity", input.url);
  }
}
