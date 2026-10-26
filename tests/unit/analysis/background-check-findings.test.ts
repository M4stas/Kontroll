// @vitest-environment node
import { expect, it } from 'vitest';
import { extractPdfText } from '@/server/storage/pdf-text';
import { extractBackgroundCheckVin, runBackgroundCheckFindings } from '@/analysis/background-check-findings';
import type { Evidence } from '@/domain/analysis';

const listingVin = 'WVWZZZ1JZXW000001';
const officialVin = 'WVWZZZ1JZXW000002';
const listingEvidence: Evidence = {id:'listing',sourceId:'listing-source',sourceClass:'listing',claim:listingVin,applicability:'Listing VIN',confidence:0.5,verification:'unverified',capturedAt:'2026-10-24T00:00:00Z'};
const pdfEvidence: Evidence = {...listingEvidence,id:'official',sourceId:'owned-pdf',sourceClass:'official_registry',verification:'official',sourceUrl:'/api/analyses/fake/background-check/pdf',claim:'Official PDF'};
function pdf(text:string) {
 return new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [5 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n4 0 obj << /Length ${text.length+40} >> stream\nBT /F1 12 Tf 10 100 Td (${text}) Tj ET\nendstream endobj\n5 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 300] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF`);
}
it.each(['en','et'] as const)('finds a deterministic VIN mismatch from a generated PDF in %s',async locale=>{
 const pdfText=await extractPdfText(pdf(`VIN: ${officialVin}`));
 const input={listingVin,listingEvidence,pdfEvidence,pdfText,locale};
 const result=runBackgroundCheckFindings(input);
 expect(result).toEqual(runBackgroundCheckFindings(input));
 expect(result.findings).toHaveLength(1);
 expect(result.findings[0]).toMatchObject({category:'background_check_vin_mismatch',origin:'deterministic',state:'confirmed',evidenceIds:['listing','official']});
 expect(result.findings[0]!.explanation).toContain(listingVin);
 expect(result.findings[0]!.explanation).toContain(officialVin);
 expect(result.findings[0]!.title).toBe(locale==='en'?'Listing and Transpordiamet VINs differ':'Kuulutuse ja Transpordiameti VINid erinevad');
 expect(result.evidence).toEqual([listingEvidence,pdfEvidence]);
 expect(result.actions[0]!.findingId).toBe(result.findings[0]!.id);
});
it.each([`VIN: ${listingVin.toLowerCase()}`,'Vehicle history without a VIN'])('does not invent a mismatch for %s',async text=>{
 expect(runBackgroundCheckFindings({listingVin,listingEvidence,pdfEvidence,pdfText:await extractPdfText(pdf(text))}).findings).toEqual([]);
});
it.each(['','WVWZZZ1JZXW0000019','VIN: IIIIIIIIIIIIIIIII',`${listingVin} ${officialVin}`])('rejects missing, malformed, or ambiguous VIN text %s',text=>{
 expect(extractBackgroundCheckVin(text)).toBeUndefined();
});
it('does not compare without a usable listing VIN',()=>{
 expect(runBackgroundCheckFindings({listingEvidence,pdfEvidence,pdfText:officialVin}).findings).toEqual([]);
});
it('accepts repeated copies of the same VIN',()=>{
 expect(extractBackgroundCheckVin(`VIN ${officialVin}\n${officialVin}`)).toBe(officialVin);
});

it('ignores alphabetic tokens alongside a usable identity',()=>{
 expect(extractBackgroundCheckVin(`ABCDEFGHJKLMNPRST ${officialVin}`) === officialVin).toBe(true);
 expect(extractBackgroundCheckVin('ABCDEFGHJKLMNPRST')).toBeUndefined();
});
