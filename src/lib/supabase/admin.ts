import { createClient } from "@supabase/supabase-js";

/**
 * Service role client, SERVER ONLY, used exclusively to send invite
 * emails through Supabase auth. Never import this from client code.
 * Returns null when SUPABASE_SERVICE_ROLE_KEY is not configured; the
 * invite flow then records the invite row (claimed at next sign-in)
 * and reports that no email went out.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
