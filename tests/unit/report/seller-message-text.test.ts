import { describe, expect, it } from "vitest";
import type { Action } from "@/domain/analysis";
import { composeSellerMessage } from "@/features/report/seller-message-text";

const labels = { questions: "Questions for the seller", requests: "Please send" };
const action = (kind: Action["kind"], instructions: string): Action => ({
  id: instructions, kind, title: "Check", instructions, status: "open",
});

describe("composeSellerMessage", () => {
  it("groups questions before requests and preserves instructions and request order", () => {
    expect(composeSellerMessage([
      action("photo_request", "Photo of VIN."),
      action("seller_question", "Any previous repairs?"),
      action("document_request", "Service history."),
    ], labels)).toEqual({
      questions: "- Any previous repairs?",
      requests: "- Photo of VIN.\n- Service history.",
      message: "Questions for the seller\n- Any previous repairs?\n\nPlease send\n- Photo of VIN.\n- Service history.",
      count: 3,
    });
  });

  it("includes identical instructions only once within each group", () => {
    expect(composeSellerMessage([
      action("seller_question", "Any repairs?"), action("seller_question", "Any repairs?"),
      action("photo_request", "VIN."), action("document_request", "VIN."),
    ], labels)).toEqual({
      questions: "- Any repairs?", requests: "- VIN.",
      message: "Questions for the seller\n- Any repairs?\n\nPlease send\n- VIN.", count: 2,
    });
  });

  it("gives questions precedence for duplicates across kinds even when a request comes first", () => {
    expect(composeSellerMessage([
      action("photo_request", "Confirm VIN."), action("seller_question", "Confirm VIN."),
    ], labels)).toEqual({
      questions: "- Confirm VIN.", requests: "",
      message: "Questions for the seller\n- Confirm VIN.", count: 1,
    });
  });

  it("ignores non-seller actions", () => {
    expect(composeSellerMessage([action("inspection_task", "Check brakes.")], labels))
      .toEqual({ questions: "", requests: "", message: "", count: 0 });
  });

  it("returns empty text and zero count for no actions", () => {
    expect(composeSellerMessage([], labels))
      .toEqual({ questions: "", requests: "", message: "", count: 0 });
  });
});
