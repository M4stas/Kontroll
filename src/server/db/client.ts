import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/config/env";

let serverClient: SupabaseClient | undefined;

export function getServerSupabaseClient(): SupabaseClient {
  if (!serverClient) {
    const env = getServerEnv();
    serverClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }

  return serverClient;
}
