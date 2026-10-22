import { expect, it } from "vitest";
import { reviewerView } from "@/insights/reviewer-view";
import { citationIdentityReviewInput } from "../../fixtures/reviewer-identity";

const id = "0f3a9c12-4bee-4d21-9a7e-2c5f1b8e0d34";
const idKeys = ["id", "evidenceId", "evidenceIds", "sourceId", "imageEvidenceId", "executionId", "runId", "analysisId"];

it.each(idKeys.flatMap(key => [id, "BEE"].map(value => [key, value] as const)))("preserves opaque %s value %s recursively", (key, value) => {
  const input = citationIdentityReviewInput();
  const opaque = key === "evidenceIds" ? [value] : value;
  const record = { [key]: opaque, note: "BEE beef" };
  input.sourceRecords[0]!.content = { nested: [record], encoded: JSON.stringify(record) };
  const original = structuredClone(input);
  const view = reviewerView(input) as { sourceRecords: Array<{content: {nested: Array<Record<string, unknown>>; encoded: string}}> };
  const content = view.sourceRecords[0]!.content;
  expect(content.nested[0]![key]).toEqual(opaque);
  expect(JSON.parse(content.encoded)[key]).toEqual(opaque);
  expect(content.nested[0]!.note).toBe("[identity omitted] beef");
  expect(content.nested[0]).not.toBe(record);
  if (Array.isArray(opaque)) expect(content.nested[0]![key]).not.toBe(opaque);
  expect(input).toEqual(original);
});

it("redacts identity tokens with space and hyphen variants while preserving longer Unicode words", () => {
  const input = citationIdentityReviewInput();
  input.sourceRecords[0]!.content = "BEE B-EE b e e; beef xBEE BEE2 éBEE BEE中 ١BEE BEE٣ _BEE_";
  const view = reviewerView(input) as {sourceRecords: Array<{content: string}>};
  expect(view.sourceRecords[0]!.content).toBe("[identity omitted] [identity omitted] [identity omitted]; beef xBEE BEE2 éBEE BEE中 ١BEE BEE٣ _[identity omitted]_");
});

it("does not discover identity values inside opaque ID objects", () => {
  const input = citationIdentityReviewInput();
  delete input.vehicle.registrationPlate;
  input.sourceRecords[0]!.content = { id: JSON.stringify({ registrationPlate: "BEE" }), note: "BEE" };
  expect(reviewerView(input).sourceRecords).toEqual(input.sourceRecords);
});

it("omits revealed values that the capture copies into listing fact fields", () => {
  const input = citationIdentityReviewInput();
  input.vehicle.registrationPlate = undefined;
  input.listing = {...input.listing!, registration: {reg_number: "123ABC", reg_number_status: "revealed", vin: "WVWZZZ1KZAW000001", vin_status: "revealed", vin_format: "standard"}};
  input.sourceRecords[0]!.content = {otherFields: {"Reg. number": "123ABC", "VIN-kood": "WVWZZZ1KZAW000001", location: "Tallinn"}};
  const json = JSON.stringify(reviewerView(input));
  expect(json).not.toContain("123ABC");
  expect(json).not.toContain("WVWZZZ1KZAW000001");
  expect(json).toContain("Tallinn");
});
