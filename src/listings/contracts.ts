import { z } from "zod";
export const jobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export function canonicalListingUrl(raw: string): string {
  const url = new URL(raw);
  const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1]?.toLowerCase();
  if (!['auto24.ee', 'www.auto24.ee', 'eng.auto24.ee', 'rus.auto24.ee'].includes(url.hostname) || authority !== url.hostname || url.protocol !== 'https:' || raw.includes('#') || !/^\/soidukid\/\d+\/?$/.test(url.pathname)) throw Error('invalid URL');
  return `https://www.auto24.ee${url.pathname.replace(/\/$/, '')}`;
}
const nullableText = z.string().nullable().default(null);
const nullableInt = z.number().int().nullable().default(null);
export const listingSchema = z.object({
  source_url: z.string().refine(value => { try { return canonicalListingUrl(value) === value; } catch { return false; } }), listing_id: z.string(),
  title: nullableText, make: nullableText, model: nullableText, first_registration: nullableText,
  year: nullableInt, year_source: z.literal('first_registration').nullable().default(null),
  price: z.object({amount: z.number().nullable().default(null), currency: nullableText}).nullable().default(null),
  mileage_km: nullableInt, body_type: nullableText, fuel: nullableText, power_kw: nullableInt,
  gearbox: nullableText, drivetrain: nullableText, colour: nullableText, seller_description: nullableText,
  seller: z.object({name: nullableText, type: nullableText, location: nullableText}).nullable().default(null),
  equipment: z.record(z.string(), z.array(z.string())).default({}), technical_specs: z.record(z.string(), z.string()).default({}),
  other_fields: z.record(z.string(), z.string()).default({}), photo_urls: z.array(z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol))).default([]),
}).refine(value => (value.year === null) === (value.year_source === null));
export const jobErrorCodeSchema = z.enum(['listing_gone', 'access_blocked', 'unsupported_vehicle_type', 'parse_failed', 'temporary_failure']);
const timestamp = z.iso.datetime({offset: true}).transform(value => new Date(value).toISOString());
export const jobSchema = z.object({
  job_id: jobIdSchema, status: z.enum(['queued', 'running', 'completed', 'failed']), submitted_at: timestamp,
  parsed_at: timestamp.nullable().default(null), listing: listingSchema.nullable().default(null),
  error: z.object({code: jobErrorCodeSchema, message: z.string()}).nullable().default(null), warnings: z.array(z.string()).default([]),
}).refine(value => value.status === 'completed' ? value.listing !== null && value.parsed_at !== null && value.error === null : value.listing === null && value.parsed_at === null && (value.status === 'failed' ? value.error !== null : value.error === null));
export type Listing = z.infer<typeof listingSchema>;
export type ServiceJob = z.infer<typeof jobSchema>;
export type ListingJob = Omit<ServiceJob, 'error'> & {error: {code: z.infer<typeof jobErrorCodeSchema>} | null};
export type ApiErrorCode = 'invalid_url' | 'invalid_request' | 'configuration_error' | 'forbidden' | 'unauthorized' | 'service_auth_error' | 'service_unavailable' | 'job_not_found' | 'invalid_service_response';
