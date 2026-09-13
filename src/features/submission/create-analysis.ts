import type { Locale } from "@/domain/analysis";
import { createAccessToken } from "@/server/access/tokens";
import type { AnalysesRepository } from "@/server/repositories/analyses";
import { isAuto24ListingUrl, parseHttpsListingUrl } from "@/features/submission/listing-url";

export interface CreateAnalysisInput {
  locale: Locale;
  listingUrl: string;
}

export interface CreateAnalysisResult {
  url: string;
}

interface CreateAnalysisDependencies {
  analyses: Pick<AnalysesRepository, "create">;
  createToken?: typeof createAccessToken;
}

async function defaultDependencies(): Promise<CreateAnalysisDependencies> {
  const [{ getServerSupabaseClient }, { AnalysesRepository }] = await Promise.all([
    import("@/server/db/client"),
    import("@/server/repositories/analyses"),
  ]);

  return { analyses: new AnalysesRepository(getServerSupabaseClient()) };
}

export async function createAnalysis(
  input: CreateAnalysisInput,
  dependencies?: CreateAnalysisDependencies,
): Promise<CreateAnalysisResult> {
  const listingUrl = parseHttpsListingUrl(input.listingUrl);
  if (!listingUrl) {
    throw new Error("Listing URL must be a valid http URL using HTTPS.");
  }

  const resolvedDependencies = dependencies ?? (await defaultDependencies());
  const token = (resolvedDependencies.createToken ?? createAccessToken)();
  const { publicId } = await resolvedDependencies.analyses.create({
    accessTokenHash: token.hash,
    locale: input.locale,
    listingUrl: listingUrl.href,
    inputType: isAuto24ListingUrl(listingUrl) ? "url" : "url_with_fallback",
  });

  return {
    url: `/${input.locale}/a/${publicId}#access=${encodeURIComponent(token.raw)}`,
  };
}
