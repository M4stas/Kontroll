import { expect, it, vi } from 'vitest';
import {createDataReviewer} from '@/insights/provider';
import type OpenAI from 'openai';
import type {ReviewPassPin} from '@/server/repositories/review-executions';
import { normalizeVehicle } from '@/analysis/normalize';
import { createFallbackSnapshot } from '@/listings/fallback';

const input = {analysisId:'analysis-1',runId:'run-1',locale:'en' as const,pass:'text' as const,
 vehicle:normalizeVehicle(createFallbackSnapshot({originalListingUrl:new URL('https://example.test/car'),pastedDescription:'',screenshotRefs:[]})),listing:null,sourceRecords:[],evidence:[],images:[]};
const pin = {availability:'ready',provider:'openai',model:'pinned-model',prompt:{content:'Pinned developer instruction.',hash:'a'.repeat(64)},options:{timeoutMs:500}} as ReviewPassPin;
const empty={schemaVersion:1,observations:[],warnings:[]};
it('uses pinned model and prompt with the strict provider-independent result schema',async()=>{
 const create=vi.fn().mockResolvedValue({output_text:JSON.stringify(empty),output:[]});
 const factory=createDataReviewer;
 expect(factory).toBeTypeOf('function');
 if(!factory)return;
 const reviewer=factory(pin,{OPENAI_API_KEY:'private-key'}, {},{responses:{create}} as unknown as Pick<OpenAI,'responses'>);
 expect(await reviewer.review(input)).toEqual(empty);
 expect(create.mock.calls[0]![0].model).toBe('pinned-model');
 expect(create.mock.calls[0]![0].input[0].content[0].text).toBe(pin.prompt.content);
 expect(create.mock.calls[0]![0].text.format.schema.properties).toHaveProperty('observations');
});
it('rejects fabricated references before any result can commit',async()=>{
 const factory=createDataReviewer;
 expect(factory).toBeTypeOf('function');if(!factory)return;
 const observations=[{id:'fake',evidenceIds:['foreign'],category:'condition',title:'Defect',severity:'important',explanation:'Claim',recommendedAction:{kind:'inspection_task',title:'Inspect',instructions:'Inspect'},confidence:0.9}];
 const reviewer=factory(pin,{OPENAI_API_KEY:'private-key'}, {},{responses:{create:async()=>({output_text:JSON.stringify({...empty,observations}),output:[]})}} as unknown as Pick<OpenAI,'responses'>);
 expect((await reviewer.review(input)).warnings[0]!.code).toBe('invalid_output');
});
it('treats forged image capability as unavailable without calling provider',async()=>{
 const factory=createDataReviewer;
 expect(factory).toBeTypeOf('function');if(!factory)return;
 const create=vi.fn();const reviewer=factory(pin,{OPENAI_API_KEY:'private-key'}, {},{responses:{create}} as unknown as Pick<OpenAI,'responses'>);
 const result=await reviewer.review({...input,pass:'image',imageEvidenceId:'image-1',images:[{evidenceId:'image-1',capability:{version:1,payload:'forged',signature:'forged'}}]});
 expect(result.warnings[0]!.code).toBe('unavailable');expect(create).not.toHaveBeenCalled();
});

it('keeps missing credentials unavailable without constructing a client',async()=>{
 const factory=createDataReviewer;
 expect(factory).toBeTypeOf('function');if(!factory)return;
 const reviewer=factory(pin,{});
 expect((await reviewer.review(input)).warnings[0]!.code).toBe('unavailable');
});
