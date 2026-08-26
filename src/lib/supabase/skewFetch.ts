/**
 * Supabase occasionally mints an access token whose "issued at" stamp
 * sits a few seconds ahead of the clock on the API that validates it
 * (auth and data run on separate machines). Until real time catches
 * up, every request is rejected with "JWT issued at future", and users
 * hit that window at the worst moment: right after signing in or
 * resetting a password. This fetch wrapper absorbs it. When a request
 * comes back 401 with that specific error, it waits briefly and tries
 * again, so small skews never surface anywhere in the app. Retrying is
 * safe for any request type: a 401 means the request was rejected
 * before anything executed.
 */

const SKEW_RE =
  /issued at future|issued in the future|token used before issued/i;

/** Streamed bodies cannot be resent; everything else supabase-js uses
 * (strings, Blobs, FormData) can. */
function retriable(init?: RequestInit): boolean {
  const b = init?.body;
  if (b == null || typeof b === "string") return true;
  return (
    typeof ReadableStream === "undefined" || !(b instanceof ReadableStream)
  );
}

export async function skewTolerantFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let res = await fetch(input, init);
  if (res.status !== 401 || !retriable(init)) return res;
  for (const delayMs of [1000, 2000, 3000]) {
    let body = "";
    try {
      body = await res.clone().text();
    } catch {
      return res;
    }
    if (!SKEW_RE.test(body)) return res;
    await new Promise((r) => setTimeout(r, delayMs));
    res = await fetch(input, init);
    if (res.status !== 401) return res;
  }
  return res;
}
