export function requireLoopbackSupabaseUrl(url: string, localApiUrl?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Report E2E requires a loopback Supabase URL");
  }
  if (!(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    && ["http:", "https:"].includes(parsed.protocol))) {
    throw new Error("Report E2E requires a loopback Supabase URL");
  }
  if (localApiUrl) {
    const local = new URL(localApiUrl);
    if (!(["localhost", "127.0.0.1", "[::1]"].includes(local.hostname))
      || parsed.protocol !== local.protocol || parsed.port !== local.port
      || parsed.pathname !== local.pathname || parsed.search !== local.search) {
      throw new Error("Report E2E requires the running local Supabase instance");
    }
  }
  return url;
}
