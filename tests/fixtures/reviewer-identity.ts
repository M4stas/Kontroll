import type { ReviewInput } from "@/insights/types";
import { reviewerEvaluationCases } from "./reviewer-evaluations";

export function identityReviewInput(status: "revealed" | "listed_in_full" | "correction"): ReviewInput {
  const input = structuredClone(reviewerEvaluationCases.find(item => item.id === "normal-listing-en")!.input);
  const plate = "123ABC", vin = "WVWZZZ1KZAW000001";
  input.listing!.registration = status === "correction" ? null : {
    reg_number: plate, reg_number_status: status, vin, vin_status: status, vin_format: "standard",
  };
  input.listing!.technical_specs.VIN = vin;
  input.listing!.other_fields.registration_plate = plate;
  input.listing!.seller_description = `Serviced regularly; ${plate} ${vin}`;
  input.vehicle.vin = vin;
  input.vehicle.registrationPlate = plate;
  input.vehicle.conflicts.push({field: "vin", values: [{value: vin, sourceIds: ["buyer"]}]});
  const add = (id: string, content: string | Record<string, string>, claim: string) => {
    input.evidence = [...input.evidence, {...input.evidence[0]!, id, sourceId: id, claim}];
    input.sourceRecords = [...input.sourceRecords, {evidenceId: id, sourceId: id, kind: id === "buyer" ? "buyer_note" : "listing_fact", content}];
  };
  add("vin-fact", {key: "vin", value: vin}, JSON.stringify({key: "vin", value: vin}));
  add("plate-fact", JSON.stringify({key: "registrationPlate", value: plate}), JSON.stringify({key: "registration plate", value: plate}));
  add("buyer", `Buyer corrected identity to ${plate} ${vin} (${plate.toLowerCase()} ${vin.toLowerCase()}); service history available`, "Buyer supplied a correction");
  add("mixed", JSON.stringify({vin, registrationPlate: plate, fuel: "hybrid"}), JSON.stringify({vin, fuel: "hybrid"}));
  add("fuel-fact", {key: "fuel", value: "hybrid"}, "Hybrid engine");
  input.pass = "final";
  input.priorReviews = [{executionId: "prior", pass: "text", result: {schemaVersion: 1, observations: [], warnings: [{code: "unavailable", message: `Previous context ${plate} ${vin}; service history available`}]}}];
  return input;
}

/** Correction passes retain raw buyer notes but only normalized vehicle identities. */
export function normalizedCorrectionReviewInput(): ReviewInput {
  const input = structuredClone(reviewerEvaluationCases.find(item => item.id === "normal-listing-en")!.input);
  input.listing = null;
  input.vehicle.vin = "WVWZZZ1KZAW000001";
  input.vehicle.registrationPlate = "123 ABC";
  input.vehicle.conflicts = [];
  const note = "Buyer correction: 123ABC, 123 ABC, 123-ABC, 123abc, 1 2-3 a-b c; WVWZZZ1KZAW000001, wvwzzz1kzaw000001, WVW-ZZZ 1KZ-AW000001; service history available";
  input.sourceRecords = [{evidenceId: "buyer", sourceId: "buyer", kind: "buyer_note", content: note}];
  input.evidence = [{...input.evidence[0]!, id: "buyer", sourceId: "buyer", sourceClass: "buyer", claim: note}];
  input.pass = "final";
  input.priorReviews = [{executionId: "prior", pass: "text", result: {schemaVersion: 1, observations: [], warnings: [{code: "unavailable", message: note}]}}];
  return input;
}

/** A short fake plate must never corrupt an opaque evidence citation. */
export function citationIdentityReviewInput(): ReviewInput {
  const input = structuredClone(reviewerEvaluationCases.find(item => item.id === "normal-listing-en")!.input);
  const id = "0f3a9c12-4bee-4d21-9a7e-2c5f1b8e0d34";
  input.vehicle.registrationPlate = "BEE";
  input.sourceRecords = [{evidenceId: id, sourceId: id, kind: "buyer_note", content: "BEE; service history available"}];
  input.evidence = [{...input.evidence[0]!, id, sourceId: id, claim: "beef BEE B-EE; service history available"}];
  return input;
}

export const citationReviewResult = {
  schemaVersion: 1 as const,
  observations: [{
    id: "observation-1", evidenceIds: ["0f3a9c12-4bee-4d21-9a7e-2c5f1b8e0d34"],
    category: "condition" as const, title: "Check service history", severity: "important" as const,
    explanation: "Service history available", confidence: 0.9,
    recommendedAction: {kind: "inspection_task" as const, title: "Inspect", instructions: "Check records"},
  }],
  warnings: [],
};
