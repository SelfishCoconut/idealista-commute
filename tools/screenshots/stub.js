// A stand-in for Firefox's `browser` API, only for taking screenshots. ?lang=es|en picks the language and
// ?state=fresh|locked|unlocked the key state; the commute and photo answers are canned demo data.
(() => {
  const q = new URLSearchParams(location.search);
  if (window === window.top) localStorage.setItem('stub:lang', q.get('lang') || 'es');
  const lang = q.get('lang') || localStorage.getItem('stub:lang') || 'es', state = q.get('state') || 'unlocked';
  const x = new XMLHttpRequest(); x.open('GET', `/_locales/${lang}/messages.json`, false); x.send();
  const msgs = JSON.parse(x.responseText);
  document.documentElement.lang = lang;

  const listeners = [];
  const settings = { workAddress: 'Paseo de la Castellana 100, Madrid', arriveBy: '09:00', citySuffix: 'Madrid, España', backend: 'browser', aiSource: 'browser', pinFromMap: true, googleLimit: 2000, sightengineLimit: 1500 };
  const demo = { googleKey: 'demo-not-a-real-key', sightengineUser: 'demo', sightengineSecret: 'demo-secret' };
  const month = new Date().toISOString().slice(0, 7);
  // Storage lives in localStorage so the page and its map iframe (same origin) see each other's writes, like real extension storage.
  const KEY = (n) => 'stub:' + n;
  const read = (n) => { try { return JSON.parse(localStorage.getItem(KEY(n)) || '{}'); } catch { return {}; } };
  const write = (n, v) => localStorage.setItem(KEY(n), JSON.stringify(v));
  if (window === window.top) {
    const local = { settings: state === 'fresh' ? { ...settings, workAddress: '' } : settings, usage: { routes: { [month]: 137 }, ai: { [month]: 24 } } };
    if (state !== 'fresh') local.vault = { v: 1 };
    for (const [id, sc] of [['105000002', [0.04, 0.09, 0.12]], ['105000004', [0.93, 0.88, 0.71]]]) {
      local['ai:' + id] = { ts: Date.now(), total: 3, images: sc.map((score, i) => ({ url: `/tools/screenshots/photo.svg#${i}`, score })) };
    }
    write('local', local);
    write('session', state === 'unlocked' ? { secrets: demo } : {});
  }
  const fire = (ch, name) => listeners.forEach((l) => l(ch, name));
  addEventListener('storage', (e) => {
    if (!e.key?.startsWith('stub:')) return;
    const o = JSON.parse(e.oldValue || '{}'), nw = JSON.parse(e.newValue || '{}'), ch = {};
    for (const k of new Set([...Object.keys(o), ...Object.keys(nw)])) if (JSON.stringify(o[k]) !== JSON.stringify(nw[k])) ch[k] = { oldValue: o[k], newValue: nw[k] };
    if (Object.keys(ch).length) fire(ch, e.key.slice(5));
  });
  const area = (name) => ({
    async get(keys) {
      const a = read(name);
      if (keys == null) return a;
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in a).map((k) => [k, a[k]]));
      return { ...keys, ...a };
    },
    async set(o) { const a = read(name), ch = {}; for (const [k, v] of Object.entries(o)) { ch[k] = { oldValue: a[k], newValue: v }; a[k] = v; } write(name, a); fire(ch, name); },
    async remove(ks) { const a = read(name), ch = {}; for (const k of [].concat(ks)) { ch[k] = { oldValue: a[k] }; delete a[k]; } write(name, a); fire(ch, name); },
  });

  const route = (title) => {
    let h = 0; for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 997;
    const minutes = 18 + (h % 30);
    return { status: 'ok', address: title, source: 'pin', minutes, transfers: h % 3, provider: 'Google Routes',
      home: { lat: 40.3987, lng: -3.6772 }, work: { lat: 40.4509, lng: -3.6905 },
      steps: [
        { mode: 'walk', minutes: 6, text: 'Walk 6 min' },
        { mode: 'subway', label: 'Metro', line: '6', from: 'Pacífico', to: 'Nuevos Ministerios', headsign: 'Circular', stops: 9, minutes: minutes - 10, text: 'x',
          path: [[40.3987, -3.6772], [40.4210, -3.6850], [40.4509, -3.6905]], board: [40.3987, -3.6772] },
        { mode: 'walk', minutes: 4, text: 'Walk 4 min' }] };
  };
  const tile = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eef1ed"/><path d="M0 128h256M128 0v256M0 64h256M0 192h256M64 0v256M192 0v256" stroke="#dfe4dc" stroke-width="2"/><path d="M20 230 230 40" stroke="#f6e7b4" stroke-width="9"/></svg>');
  const handle = (m) => {
    switch (m?.type) {
      case 'commute': return route(m.title);
      case 'needsUnlock': return state === 'locked';
      case 'openPopup': return false;
      case 'tile': return { url: tile };
      case 'map': return { error: 'demo' };
      case 'aicheck': return { images: m.images.map((url, i) => ({ url, score: [0.04, 0.09, 0.12][i % 3] })) };
      default: return undefined;
    }
  };
  window.browser = {
    i18n: { getMessage(key, subs = []) {
      const m = msgs[key]; if (!m) return '';
      let s = m.message;
      for (const [name, p] of Object.entries(m.placeholders || {})) s = s.replace(new RegExp('\\$' + name + '\\$', 'gi'), () => subs[+p.content.slice(1) - 1] ?? '');
      return s;
    } },
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: (l) => listeners.push(l), removeListener: (l) => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); } } },
    runtime: { sendMessage: async (m) => handle(m), getURL: (p) => '/' + p, onMessage: { addListener() {} }, openOptionsPage: async () => {} },
    permissions: { request: async () => true },
    action: { openPopup: async () => {}, setBadgeText: async () => {} },
  };
})();
