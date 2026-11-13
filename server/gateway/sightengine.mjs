// Sightengine "genai" model behind the gateway: the API credentials live only on this server, and each image
// is scored once (answers are cached by the caller). Sightengine downloads the image itself from the URL.
const ENDPOINT = 'https://api.sightengine.com/1.0/check.json';

// Only idealista's own image hosts (img3.idealista.com, ...) may be scored: this is not an open image-scoring proxy.
export const isListingImage = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && /^([a-z0-9-]+\.)*idealista\.com$/i.test(x.hostname) && u.length <= 500;
  } catch { return false; }
};

// -> { score } with score in 0..1 (probability that the image is AI-generated). Throws Error with .status
// (401/403 = bad credentials or plan problem: not retryable) when Sightengine refuses.
export async function scoreImage({ user, secret, url, fetchImpl = fetch, endpoint = ENDPOINT }) {
  const p = new URLSearchParams({ url, models: 'genai', api_user: user, api_secret: secret });
  const r = await fetchImpl(`${endpoint}?${p}`, { signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 'success') {
    const msg = j?.error?.message || `Sightengine ${r.status}`;
    const e = new Error(msg);
    // Credential and usage-limit problems cannot be fixed by retrying.
    e.status = r.status === 401 || r.status === 403 || /credential|usage_limit|subscription/i.test(j?.error?.type || '') ? 403 : (r.ok ? 502 : r.status);
    throw e;
  }
  const score = j?.type?.ai_generated;
  if (typeof score !== 'number') throw Object.assign(new Error('Sightengine returned no ai_generated score'), { status: 502 });
  return { score: Math.min(1, Math.max(0, score)) };
}
