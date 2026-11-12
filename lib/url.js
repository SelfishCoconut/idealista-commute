export const DEFAULT_URL = 'http://127.0.0.1:8085';
export const DEFAULT_PORT = '8085';

// "192.168.1.50" -> "http://192.168.1.50:8085"; "http://host:9000/" -> "http://host:9000"; invalid -> null.
export function normalizeServerUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return DEFAULT_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    if (!u.port && u.protocol === 'http:') u.port = DEFAULT_PORT; // bare IP/hostname: assume our default port
    return u.origin;
  } catch {
    return null;
  }
}
