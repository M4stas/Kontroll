import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createBackgroundCheckPdfHandler } from '@/features/report/background-check-pdf';
import { analysisAccessCookieName } from '@/server/access/analysis-access';
const publicId='7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1';
const context={params:Promise.resolve({publicId})};
it('refuses access before reading PDF bytes',async()=>{
 const loadPdf=vi.fn();
 const response=await createBackgroundCheckPdfHandler({verifyAccess:async()=>false,loadPdf})(new NextRequest('https://example.test/pdf'),context);
 expect(response.status).toBe(401);expect(loadPdf).not.toHaveBeenCalled();
});
it('passes the analysis cookie and serves a private PDF',async()=>{
 let access:unknown;
 const response=await createBackgroundCheckPdfHandler({verifyAccess:async input=>{access=input;return true;},loadPdf:async()=>new TextEncoder().encode('%PDF-1.7\nfake')})(new NextRequest('https://example.test/pdf',{headers:{cookie:`${analysisAccessCookieName(publicId)}=token`}}),context);
 expect(access).toEqual({publicId,cookie:'token'});
 expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('application/pdf');expect(response.headers.get('cache-control')).toBe('private, no-store');expect(await response.text()).toBe('%PDF-1.7\nfake');
});
it('returns unavailable when no fetched PDF exists',async()=>{
 const response=await createBackgroundCheckPdfHandler({verifyAccess:async()=>true,loadPdf:async()=>null})(new NextRequest('https://example.test/pdf'),context);
 expect(response.status).toBe(404);
});
