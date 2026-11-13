// Direct Sightengine access from the extension (optional; the alternative is the server's /ai-check).
// Used only when the user typed their OWN Sightengine credentials into the options. The secret is sent in the POST
// body (never in a URL) and only ever leaves the browser towards api.sightengine.com.
import { ProviderError } from './throttle.js';

export const ORIGIN = 'https://api.sightengine.com/*';
const ENDPOINT = 'https://api.sightengine.com/1.0/check.json';

// -> number 0..1 (probability the image is AI-generated). Throws ProviderError; fatal for credential/plan problems.
export async function scoreImage(url, { user, secret }, fetchImpl = fetch) {
  const body = new FormData();
  body.set('url', url); body.set('models', 'genai'); body.set('api_user', user); body.set('api_secret', secret);
  let r;
  try { r = await fetchImpl(ENDPOINT, { method: 'POST', body, signal: AbortSignal.timeout(30000) }); }
  catch { throw new ProviderError('Sightengine not reachable (permission refused, or offline).', { retryable: true }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 'success') {
    const fatal = r.status === 401 || r.status === 403 || /credential|usage_limit|subscription/i.test(j?.error?.type || '');
    throw new ProviderError(j?.error?.message || `Sightengine ${r.status}`, { fatal, retryable: !fatal && r.status >= 500 });
  }
  const score = j?.type?.ai_generated;
  if (typeof score !== 'number') throw new ProviderError('Sightengine returned no ai_generated score');
  return Math.min(1, Math.max(0, score));
}
