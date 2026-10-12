import type { Action } from "@/domain/analysis";

export function composeSellerMessage(
  actions: Action[],
  labels: { questions: string; requests: string },
): { questions: string; requests: string; message: string; count: number } {
  const questionInstructions = new Set(
    actions.filter((action) => action.kind === "seller_question").map((action) => action.instructions),
  );
  const requestInstructions = new Set(
    actions.filter((action) => action.kind === "photo_request" || action.kind === "document_request")
      .map((action) => action.instructions)
      .filter((instructions) => !questionInstructions.has(instructions)),
  );
  const questions = [...questionInstructions].map((instructions) => `- ${instructions}`).join("\n");
  const requests = [...requestInstructions].map((instructions) => `- ${instructions}`).join("\n");
  const message = [
    questions ? `${labels.questions}\n${questions}` : "",
    requests ? `${labels.requests}\n${requests}` : "",
  ].filter(Boolean).join("\n\n");

  return { questions, requests, message, count: questionInstructions.size + requestInstructions.size };
}
