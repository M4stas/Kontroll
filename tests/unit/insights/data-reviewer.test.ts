import { citationIdentityReviewInput, citationReviewResult, identityReviewInput, normalizedCorrectionReviewInput } from "../../fixtures/reviewer-identity";
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

it.each(["revealed", "listed_in_full", "correction"] as const)("projects identity privacy for OpenAI %s", async status => {
 const input = identityReviewInput(status);
 const original = structuredClone(input);
 const create = vi.fn().mockResolvedValue({output_text: JSON.stringify(empty), output: []});
 const reviewer = createDataReviewer(pin, {OPENAI_API_KEY: "private-key"}, {}, {responses: {create}} as unknown as Pick<OpenAI, "responses">);
 expect(await reviewer.review(input)).toEqual(empty);
 const content = JSON.stringify(create.mock.calls[0]![0]);
 expect(content.toUpperCase()).not.toContain("123ABC");
 expect(content.toUpperCase()).not.toContain("WVWZZZ1KZAW000001");
 expect(content).not.toContain("vin-fact");
 expect(content).not.toContain("plate-fact");
 expect(content).toContain("fuel-fact");
 expect(content).toContain("hybrid");
 expect(content).toContain("service history available");
 const view = JSON.parse(create.mock.calls[0]![0].input[1].content[0].text.split("\n")[1]);
 expect(view.vehicle.conflicts).toEqual([]);
 expect(view.vehicle).not.toHaveProperty("vin");
 expect(view.vehicle).not.toHaveProperty("registrationPlate");
 expect(view.listing).not.toHaveProperty("registration");
 expect(view.listing).not.toHaveProperty("photo_urls");
 expect(view.listing.technical_specs).not.toHaveProperty("VIN");
 expect(view.listing.other_fields).not.toHaveProperty("registration_plate");
 expect(view.sourceRecords.find((item: {evidenceId: string}) => item.evidenceId === "mixed").content).toBe('{"fuel":"hybrid"}');
 expect(input).toEqual(original);
});

it("redacts normalized correction identities from raw notes for OpenAI", async () => {
 const input = normalizedCorrectionReviewInput();
 const original = structuredClone(input);
 const create = vi.fn().mockResolvedValue({output_text: JSON.stringify(empty), output: []});
 const reviewer = createDataReviewer(pin, {OPENAI_API_KEY: "private-key"}, {}, {responses: {create}} as unknown as Pick<OpenAI, "responses">);
 expect(await reviewer.review(input)).toEqual(empty);
 const content = JSON.stringify(create.mock.calls[0]![0]);
 const compact = content.replace(/[\s-]/g, "").toUpperCase();
 expect(compact).not.toContain("123ABC");
 expect(compact).not.toContain("WVWZZZ1KZAW000001");
 const view = JSON.parse(create.mock.calls[0]![0].input[1].content[0].text.split("\n")[1]);
 expect(view.listing).toBeNull();
 expect(view.sourceRecords[0].content).toContain("service history available");
 expect(view.evidence[0].claim).toContain("service history available");
 expect(view.priorReviews[0].result.warnings[0].message).toContain("service history available");
 expect(input).toEqual(original);
});

it("preserves evidence UUID citations in the OpenAI reviewer view and accepts the cited observation", async () => {
 const create = vi.fn().mockResolvedValue({output_text: JSON.stringify(citationReviewResult), output: []});
 const reviewer = createDataReviewer(pin, {OPENAI_API_KEY: "private-key"}, {}, {responses: {create}} as unknown as Pick<OpenAI, "responses">);
 expect(await reviewer.review(citationIdentityReviewInput())).toEqual(citationReviewResult);
 const view = JSON.parse(create.mock.calls[0]![0].input[1].content[0].text.split("\n")[1]);
 expect(view.evidence[0].id).toBe("0f3a9c12-4bee-4d21-9a7e-2c5f1b8e0d34");
  expect(view.evidence[0].claim).toBe("beef [identity omitted] [identity omitted]; service history available");
 expect(view.sourceRecords[0].evidenceId).toBe("0f3a9c12-4bee-4d21-9a7e-2c5f1b8e0d34");
});
