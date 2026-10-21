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

describe('registration report facts', () => {
  function factsFor(registration: unknown, other_fields: Record<string, string> = {}, technical_specs: Record<string, string> = {}) {
    const listing = listingSchema.parse({source_url:'https://www.auto24.ee/soidukid/123',listing_id:'123',make:'Volvo',registration,other_fields,technical_specs});
    const result = capturedJobSnapshot({job_id:'identity',status:'completed',submitted_at:'2026-10-21T10:00:00Z',parsed_at:'2026-10-21T10:01:00Z',listing,error:null,warnings:[]});
    if (result.type !== 'snapshot') throw new Error('Expected a snapshot');
    return result.facts;
  }

  it.each(['revealed', 'listed_in_full'])('%s reg number becomes an unverified fact', status => {
    expect(factsFor({reg_number:'123ABC',reg_number_status:status,vin:null,vin_status:'not_listed',vin_format:null})).toContainEqual({key:'registration plate',value:'123ABC',sourceId:'auto24-service:identity',verification:'unverified',confidence:0.9});
  });

  it.each(['revealed', 'listed_in_full'])('%s VIN becomes an unverified fact', status => {
    expect(factsFor({reg_number:null,reg_number_status:'not_listed',vin:'WVWZZZ1KZAW000001',vin_status:status,vin_format:'standard'})).toContainEqual({key:'vin',value:'WVWZZZ1KZAW000001',sourceId:'auto24-service:identity',verification:'unverified',confidence:0.9});
  });

  it.each(['pending', 'not_listed', 'unavailable'])('%s identity adds no fact', status => {
    const facts = factsFor({reg_number:null,reg_number_status:status,vin:null,vin_status:status,vin_format:null});
    expect(facts.map(fact => fact.key)).toEqual(['make']);
  });

  it('replaces equivalent legacy VIN and plate facts without duplicates', () => {
    const facts = factsFor({reg_number:'123ABC',reg_number_status:'revealed',vin:'WVWZZZ1KZAW000001',vin_status:'listed_in_full',vin_format:'standard'}, {' VIN ':'WVWZZZ1KZAW000001',Registreerimisnumber:'123ABC'}, {vin:'WVWZZZ1KZAW000001','Registration Plate':'123ABC'});
    expect(facts.filter(fact => fact.key === 'vin')).toEqual([{key:'vin',value:'WVWZZZ1KZAW000001',sourceId:'auto24-service:identity',verification:'unverified',confidence:0.9}]);
    expect(facts.filter(fact => fact.key === 'registration plate')).toEqual([{key:'registration plate',value:'123ABC',sourceId:'auto24-service:identity',verification:'unverified',confidence:0.9}]);
    expect(facts).toContainEqual(expect.objectContaining({key:'make',value:'Volvo',confidence:0.8}));
  });

  it('preserves legacy identity facts when registration has no values', () => {
    expect(factsFor(null, {VIN:'WVWZZZ1KZAW000001','registration plate':'123ABC'})).toEqual([
      {key:'make',value:'Volvo',sourceId:'auto24-service:identity',verification:'unverified',confidence:0.8},
      {key:'vin',value:'WVWZZZ1KZAW000001',sourceId:'auto24-service:identity',verification:'unverified',confidence:0.8},
      {key:'registration plate',value:'123ABC',sourceId:'auto24-service:identity',verification:'unverified',confidence:0.8},
    ]);
  });
});
