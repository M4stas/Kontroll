import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../src/app/api/listings/route';
import { GET } from '../src/app/api/listings/[jobId]/route';
import { issueAccess, verifyAccess } from '../src/server/access';
import { canonicalListingUrl, jobSchema } from '../src/listings/contracts';
const id = 'job_123';
const queued = { job_id: id, status: 'queued', submitted_at: '2026-09-29T10:00:00Z' };
const request = (body: unknown = { listingUrl: 'https://auto24.ee/soidukid/123?test=1' }, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/listings', { method: 'POST', headers: { origin, host: 'localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const poll = (cookie?: string, jobId = id) => GET(new NextRequest(`http://localhost:3000/api/listings/${jobId}`, { headers: cookie ? {cookie} : {} }), { params: Promise.resolve({jobId}) });
beforeEach(() => { vi.stubEnv('AUTO24_SERVICE_URL', 'http://127.0.0.1:8000'); vi.stubEnv('AUTO24_SERVICE_API_KEY', 'private-service-key'); vi.stubEnv('ANALYSIS_COOKIE_SECRET', 'x'.repeat(32)); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('boundary validation', () => {
  it('canonicalizes supported hosts and rejects arbitrary targets/credentials/ports/fragments', () => {
    expect(canonicalListingUrl('https://eng.auto24.ee/soidukid/123/?x=1')).toBe('https://www.auto24.ee/soidukid/123');
    for (const url of ['http://auto24.ee/soidukid/123', 'https://evil.test/soidukid/123', 'https://user@auto24.ee/soidukid/123', 'https://auto24.ee:443/soidukid/123', 'https://auto24.ee/soidukid/123#']) expect(() => canonicalListingUrl(url)).toThrow();
  });
  it('requires coherent terminal data and zoned timestamps', () => {
    expect(jobSchema.safeParse(queued).success).toBe(true);
    for (const data of [{...queued, status:'completed'}, {...queued, status:'failed'}, {...queued, parsed_at:'2026-09-29T10:00:00Z'}, {...queued, submitted_at:'2026-09-29T10:00:00'}]) expect(jobSchema.safeParse(data).success).toBe(false);
  });
  it('binds expiring signed access to each job', () => {
    const token = issueAccess(id, 100);
    expect(verifyAccess(id, token, 101)).toBe(true);
    expect(verifyAccess('other', token, 101)).toBe(false);
    expect(verifyAccess(id, token+'x', 101)).toBe(false);
    expect(verifyAccess(id, token, 100+86400)).toBe(false);
  });
});
describe('private API', () => {
  it('submits once with server key and creates scoped HttpOnly access', async () => {
    const fetcher = vi.fn(async () => Response.json({...queued, status_url:'https://evil.test', unexpected:'secret'}, {status:202})); vi.stubGlobal('fetch', fetcher);
    const response = await POST(request());
    expect(response.status).toBe(202); expect(await response.json()).toEqual({jobId:id});
    expect(response.headers.get('cache-control')).toContain('no-store');
    const cookie=response.headers.get('set-cookie')!; expect(cookie).toContain(`kontroll_access_${id}=`); expect(cookie).toContain('HttpOnly'); expect(cookie.toLowerCase()).toContain('samesite=lax');
    const [url, options] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/v1/jobs'); expect(options.headers).toMatchObject({'X-API-Key':'private-service-key'}); expect(options.redirect).toBe('error'); expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body as string)).toEqual({url:'https://www.auto24.ee/soidukid/123'});
    expect(cookie).not.toContain('private-service-key');
  });
  it('rejects cross-origin mutations, invalid input and missing configuration before HTTP', async () => {
    const fetcher=vi.fn(); vi.stubGlobal('fetch',fetcher);
    expect((await POST(request({},'https://evil.test'))).status).toBe(403);
    expect((await POST(request({listingUrl:'https://evil.test'}))).status).toBe(400);
    vi.stubEnv('ANALYSIS_COOKIE_SECRET','short'); const response=await POST(request()); expect(response.status).toBe(503); expect(await response.json()).toEqual({error:{code:'configuration_error'}}); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not retry an ambiguous failed POST or expose diagnostics', async () => {
    const fetcher=vi.fn(async()=> { throw Error('private-service-key internal stack'); }); vi.stubGlobal('fetch',fetcher);
    const response=await POST(request()); expect(response.status).toBe(503); expect(await response.json()).toEqual({error:{code:'service_unavailable'}}); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('denies private reads without access or with access for another job', async () => {
    const fetcher=vi.fn(); vi.stubGlobal('fetch',fetcher);
    expect((await poll()).status).toBe(401); expect((await poll(`kontroll_access_${id}=${issueAccess('other')}`)).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  });
  it('polls only the known job and sanitizes failed service messages', async () => {
    const fetcher=vi.fn(async()=>Response.json({...queued,status:'failed', error:{code:'access_blocked',message:'private internal diagnostics'},status_url:'https://evil.test'})); vi.stubGlobal('fetch',fetcher);
    const response=await poll(`kontroll_access_${id}=${issueAccess(id)}`);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({...queued,submitted_at:'2026-09-29T10:00:00.000Z',status:'failed',listing:null,parsed_at:null,error:{code:'access_blocked'},warnings:[]});
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(`http://127.0.0.1:8000/v1/jobs/${id}`);
  });
  it.each([[401,'service_auth_error',503],[404,'job_not_found',404],[500,'service_unavailable',503]])('maps upstream %i explicitly',async(status,code,expected)=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('private detail',{status:Number(status)})));
    const response=await poll(`kontroll_access_${id}=${issueAccess(id)}`); expect(response.status).toBe(expected); expect(await response.json()).toEqual({error:{code}});
  });
  it('rejects invalid or mismatched service responses',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...queued,job_id:'other'})));
    expect((await poll(`kontroll_access_${id}=${issueAccess(id)}`)).status).toBe(502);
  });
});

describe('service safety and completed payload',()=>{
  it('returns the full validated listing and UTC capture time',async()=>{
    const listing={source_url:'https://www.auto24.ee/soidukid/123',listing_id:'123',title:'Volvo V60',year:2020,year_source:'first_registration',equipment:{Safety:['ABS']}, technical_specs:{Engine:'1969 cm³'},other_fields:{Warranty:'Seller claim'},photo_urls:['https://img.auto24.ee/car.jpg'],price:{amount:18000,currency:'EUR'}};
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...queued,status:'completed',parsed_at:'2026-09-29T13:00:00+03:00',listing,warnings:['Some listing fields were unavailable']})));
    const response=await poll(`kontroll_access_${id}=${issueAccess(id)}`); const data=await response.json();
    expect(response.status).toBe(200); expect(data.parsed_at).toBe('2026-09-29T10:00:00.000Z'); expect(data.listing).toMatchObject(listing); expect(data.listing.mileage_km).toBeNull(); expect(data.warnings).toEqual(['Some listing fields were unavailable']);
  });
  it('times out a stuck service request and returns recoverable failure',async()=>{
    vi.useFakeTimers();
    vi.stubGlobal('fetch',(_url: string,options: RequestInit)=>new Promise((_,reject)=>options.signal?.addEventListener('abort',()=>reject(Error('aborted')))));
    const result=poll(`kontroll_access_${id}=${issueAccess(id)}`); await vi.advanceTimersByTimeAsync(10000);
    const response=await result; expect(response.status).toBe(503); expect(await response.json()).toEqual({error:{code:'service_unavailable'}});
  });
  it('identifies malformed JSON as an invalid service response',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('not JSON',{status:200})));
    const response=await poll(`kontroll_access_${id}=${issueAccess(id)}`); expect(response.status).toBe(502); expect(await response.json()).toEqual({error:{code:'invalid_service_response'}});
  });
  it('rejects unsafe service configuration before calling HTTP',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    for(const value of ['file:///tmp/secret','http://user:pass@localhost:8000','http://localhost:8000/path','http://localhost:8000/?secret=1']) { vi.stubEnv('AUTO24_SERVICE_URL',value); expect((await POST(request())).status).toBe(503); }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never follows a redirect that could leak the service key',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(_url: string,options: RequestInit)=>{ expect(options.redirect).toBe('error'); throw new TypeError('redirect blocked'); }));
    const response=await POST(request()); expect(response.status).toBe(503);
  });
  it('can retain independent access for multiple jobs',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url: string)=>Response.json({...queued,job_id:url.endsWith('/other')?'other':id})));
    const both=`kontroll_access_${id}=${issueAccess(id)}; kontroll_access_other=${issueAccess('other')}`;
    expect((await poll(both)).status).toBe(200); expect((await poll(both,'other')).status).toBe(200);
  });
});

describe('review regressions', () => {
  it('preserves HTTP and HTTPS gallery URLs in completed service jobs', async () => {
    const listing = { source_url: 'https://www.auto24.ee/soidukid/123', listing_id: '123', photo_urls: ['http://images.auto24.ee/car.jpg', 'https://images.auto24.ee/car2.jpg'] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...queued, status: 'completed', parsed_at: '2026-09-29T10:00:00Z', listing })));
    const response = await poll(`kontroll_access_${id}=${issueAccess(id)}`);
    expect(response.status).toBe(200);
    expect((await response.json()).listing.photo_urls).toEqual(listing.photo_urls);
    expect(jobSchema.safeParse({ ...queued, status: 'completed', parsed_at: '2026-09-29T10:00:00Z', listing: { ...listing, photo_urls: ['javascript:alert(1)'] } }).success).toBe(false);
  });

  it('returns a recoverable service error when the response body exceeds the request deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      const body = new ReadableStream({ start(controller) {
        options.signal?.addEventListener('abort', () => controller.error(new DOMException('Body aborted', 'AbortError')));
      } });
      return new Response(body, { status: 200 });
    }));
    const result = poll(`kontroll_access_${id}=${issueAccess(id)}`);
    await vi.advanceTimersByTimeAsync(10000);
    const response = await result;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } });
  });
});


describe('production Next request regressions', () => {
  const proxiedRequest = (cookie?: string) => new Proxy(new NextRequest(`http://localhost:3000/api/listings/${id}`, { headers: cookie ? { cookie } : {} }), {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  it('denies an unauthenticated Next request proxy before service access', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await GET(proxiedRequest(), { params: Promise.resolve({ jobId: id }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'unauthorized' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reads access from the supplied Next proxy and polls the existing job', async () => {
    const fetcher = vi.fn(async () => Response.json(queued)); vi.stubGlobal('fetch', fetcher);
    const response = await GET(proxiedRequest(`kontroll_access_${id}=${issueAccess(id)}`), { params: Promise.resolve({ jobId: id }) });
    expect(response.status).toBe(200);
    expect((await response.json()).job_id).toBe(id);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('uses the actual Host for same-origin checks instead of Next internal hostname', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(queued, { status: 202 })));
    const incoming = request();
    incoming.headers.set('host', '127.0.0.1:3000');
    incoming.headers.set('origin', 'http://127.0.0.1:3000');
    expect((await POST(incoming)).status).toBe(202);
  });
  it('rejects an Origin matching only the internal hostname and does not trust forwarded-host', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const incoming = request();
    incoming.headers.set('host', '127.0.0.1:3000');
    incoming.headers.set('x-forwarded-host', 'localhost:3000');
    expect((await POST(incoming)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});


describe('submitted source URL recovery', () => {
  it.each(['queued', 'running', 'failed'])('returns the submitted URL to an authorized %s job reader', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => Response.json({ ...queued, status: options?.method === 'POST' ? 'queued' : status, ...(options?.method !== 'POST' && status === 'failed' ? {error: {code: 'parse_failed', message: 'private'}} : {}) }, {status: options?.method === 'POST' ? 202 : 200})));
    const submitted = await POST(request());
    const cookie = submitted.headers.get('set-cookie')!.split(';')[0];
    const response = await poll(cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).source_url).toBe('https://www.auto24.ee/soidukid/123');
  });
});


describe('source URL cookie integrity', () => {
  it('rejects a substituted source URL without service access', async () => {
    const token = issueAccess(id, undefined, 'https://www.auto24.ee/soidukid/123');
    const tampered = token.split('.').slice(0, 2).join('.') + '.' + Buffer.from('https://www.auto24.ee/soidukid/999').toString('base64url');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await poll(`kontroll_access_${id}=${tampered}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({error: {code: 'unauthorized'}});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('binds URL-bearing access to the job and its expiry', () => {
    const token = issueAccess(id, 100, 'https://www.auto24.ee/soidukid/123');
    expect(verifyAccess(id, token, 101)).toBe(true);
    expect(verifyAccess('other', token, 101)).toBe(false);
    expect(verifyAccess(id, token, 100 + 86400)).toBe(false);
  });
});
