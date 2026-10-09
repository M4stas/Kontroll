import type { NextRequest } from "next/server";
import { diagnosticsResponse } from "../handler";
export function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      publicId: string;
    }>;
  },
) {
  return diagnosticsResponse(request, context, true);
}
