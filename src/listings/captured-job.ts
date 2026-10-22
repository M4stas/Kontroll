import { hashRawContent, type ListingCaptureResult, type ListingSnapshot, type CapturedSourceContent } from './adapter';
import { listingSchema, type ListingJob } from './contracts';
import { stableId } from '@/lib/stable-id';

/** Consume the scraper service result; this boundary never fetches a listing. */
export function capturedJobSnapshot(job: ListingJob): ListingCaptureResult {
  if (job.status !== 'completed' || !job.listing || !job.parsed_at) {
    return {type:'fallback_required',reason:job.error?.code === 'access_blocked' ? 'blocked_response' : 'fetch_failed',listingUrl:'',serviceFailure:{status:job.status,code:job.error?.code ?? null,submittedAt:job.submitted_at,parsedAt:job.parsed_at,warnings:[...job.warnings]}};
  }
  const listing = listingSchema.parse(job.listing);
  const sourceId = `auto24-service:${job.job_id}`;
  const values: Record<string,string | number | null> = {
    make:listing.make,model:listing.model,year:listing.year,mileage:listing.mileage_km === null ? null : `${listing.mileage_km} km`,
    fuel:listing.fuel,gearbox:listing.gearbox,body:listing.body_type,
    power:listing.power_kw,drivetrain:listing.drivetrain,
  };
  const facts = Object.entries(values).flatMap(([key,value])=>value === null ? [] : [{key,value:String(value),sourceId,verification:'unverified' as const,confidence:0.8}]);
  for (const [key,value] of Object.entries({...listing.technical_specs,...listing.other_fields})) {
    if (/^vin$/i.test(key.trim())) facts.push({key:'vin',value,sourceId,verification:'unverified',confidence:0.8});
    if (/^(registration plate|registreerimisnumber)$/i.test(key.trim())) facts.push({key:'registration plate',value,sourceId,verification:'unverified',confidence:0.8});
  }
  const registration = listing.registration;
  // The report shows these Auto24 fields; replace their masked teasers with the full values.
  const otherFields = {...listing.other_fields};
  for (const [key, field, value, status] of [
    ['vin', 'VIN-kood', registration?.vin, registration?.vin_status],
    ['registration plate', 'Reg. number', registration?.reg_number, registration?.reg_number_status],
  ] as const) {
    if (value == null || (status !== 'revealed' && status !== 'listed_in_full')) continue;
    for (let index = facts.length - 1; index >= 0; index--) {
      if (facts[index]?.key === key) facts.splice(index, 1);
    }
    facts.push({key,value,sourceId,verification:'unverified',confidence:0.9});
    otherFields[field] = value;
  }
  const description = listing.seller_description ?? '';
  const sourceRecords: CapturedSourceContent[] = [{evidenceId:stableId(`${sourceId}:facts`),sourceId,kind:'listing_fact' as const,
    content:{title:listing.title,make:listing.make,model:listing.model,firstRegistration:listing.first_registration,registrationYear:listing.year,yearSource:listing.year_source,mileageKm:listing.mileage_km,price:listing.price,equipment:listing.equipment,technicalSpecs:listing.technical_specs,otherFields,seller:listing.seller},verification:'unverified' as const}];
  if(description) sourceRecords.push({evidenceId:stableId(`${sourceId}:text`),sourceId,kind:'listing_text',content:description.slice(0,20000),verification:'unverified'});
  return {type:'snapshot',marketplace:'auto24',sourceId,sourceUrl:listing.source_url,capturedAt:job.parsed_at,
    listing,sourceRecords,contentHash:hashRawContent(JSON.stringify(listing)),description,imageUrls:listing.photo_urls,screenshotRefs:[],facts,
    claims:description ? [{text:description,sourceClass:'seller',verification:'unverified'}] : [],warnings:job.warnings} satisfies ListingSnapshot;
}
