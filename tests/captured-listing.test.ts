import { describe, expect, it } from 'vitest';
import { capturedJobSnapshot } from '@/listings/captured-job';
import { listingSchema } from '@/listings/contracts';

describe('service capture snapshot', () => {
  it('preserves service capture identity, facts and unverified claims', () => {
    const listing = listingSchema.parse({source_url:'https://www.auto24.ee/soidukid/123',listing_id:'123',make:'Volvo',model:'V90',year:2018,year_source:'first_registration',mileage_km:120000,seller_description:'Full service history',photo_urls:[]});
    const snapshot = capturedJobSnapshot({job_id:'service-123',status:'completed',submitted_at:'2026-09-30T10:00:00Z',parsed_at:'2026-09-30T10:01:00Z',listing,error:null,warnings:[]});
    expect(snapshot.type).toBe('snapshot');
    if(snapshot.type !== 'snapshot') return;
    expect(snapshot.facts).toContainEqual(expect.objectContaining({key:'mileage',value:'120000 km'}));
    expect(snapshot.capturedAt).toBe('2026-09-30T10:01:00Z');
    expect(snapshot.facts).toContainEqual(expect.objectContaining({key:'make',value:'Volvo',verification:'unverified'}));
    expect(snapshot.claims).toContainEqual({text:'Full service history',sourceClass:'seller',verification:'unverified'});
  });
  it('settles failed service capture to buyer fallback', () => {
    expect(capturedJobSnapshot({job_id:'service-123',status:'failed',submitted_at:'2026-09-30T10:00:00Z',parsed_at:null,listing:null,error:{code:'access_blocked'},warnings:[]})).toMatchObject({type:'fallback_required',reason:'blocked_response'});
  });
});

it('retains complete validated capture with typed unverified citation content', () => {
 const listing=listingSchema.parse({source_url:'https://www.auto24.ee/soidukid/123',listing_id:'123',title:'Car',price:{amount:18000,currency:'EUR'},year:2018,year_source:'first_registration',first_registration:'05/2018',equipment:{Safety:['ABS']},technical_specs:{Engine:'2L'},seller:{name:'Dealer',type:'business',location:null},photo_urls:['https://img-bcg.eu/car.jpg']});
 const result=capturedJobSnapshot({job_id:'j',status:'completed',submitted_at:'2026-09-30T10:00:00Z',parsed_at:'2026-09-30T10:01:00Z',listing,error:null,warnings:[]});
 expect(result).toMatchObject({listing,sourceRecords:[expect.objectContaining({kind:'listing_fact',content:expect.objectContaining({registrationYear:2018,yearSource:'first_registration',price:{amount:18000,currency:'EUR'},seller:listing.seller}),verification:'unverified'})]});
 if(result.type==='snapshot') expect(result.sourceRecords?.[0]?.evidenceId).toMatch(/^[a-f0-9-]{36}$/);
});

it.each(['listing_gone','unsupported_vehicle_type','parse_failed','temporary_failure'] as const)('preserves typed %s service failure metadata without upstream messages',code=>{
 const snapshot=capturedJobSnapshot({job_id:'failed',status:'failed',submitted_at:'2026-09-30T10:00:00Z',parsed_at:null,listing:null,error:{code,message:'secret upstream'} as never,warnings:['missing_title']});
 expect(snapshot).toMatchObject({serviceFailure:{status:'failed',code,submittedAt:'2026-09-30T10:00:00Z',parsedAt:null,warnings:['missing_title']}});
 expect(JSON.stringify(snapshot)).not.toContain('secret upstream');
});
