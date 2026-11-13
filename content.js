// Runs on idealista pages. It only reads the listing titles already rendered in YOUR browser
// and asks the background script for the commute; it never fetches idealista itself.
(() => {
  const t = (key, ...subs) => browser.i18n.getMessage(key, subs.map(String));
  // ---- Selectors live here so a site change is a one-line fix. ----
  // idealista result cards: <article class="item ..."> with <a class="item-link" title="Piso en calle X, Barrio, Madrid">
  const CARD = 'article.item, article[data-element-id]';
  const LINK = 'a.item-link, a[href*="/inmueble/"]';
  const HOST = '.item-info-container, .item-detail-container';

  const seen = new WeakSet();
  const jobs = new WeakMap(); // card -> promise of its commute result
  let stopped = false;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  // Line icons (one set, 16px, 1.5 stroke, colour = surrounding text), built with the DOM so nothing is parsed as HTML.
  const ICONS = { train: ['M7 3h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z', 'M4 11h16', 'M8 21l2-3M16 21l-2-3'], chevron: ['M6 9l6 6 6-6'] };
  function icon(name, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icm-ico' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }
  const headRow = (...kids) => { const h = el('div', 'icm-head'); h.append(icon('train'), ...kids); return h; };
  // Never let a click inside our UI reach idealista's own card/link handlers.
  const isolate = (n) => { n.addEventListener('click', (e) => e.stopPropagation()); return n; };

  function title(card) {
    const a = card.querySelector(LINK);
    return (a && (a.getAttribute('title') || a.textContent)) || '';
  }

  function badge(card) {
    let b = card.querySelector('.icm-badge');
    if (!b) {
      b = el('div', 'icm-badge icm-loading');
      b.append(headRow(el('span', 'icm-txt', t('calculating'))));;
      const host = card.querySelector(HOST) || card;
      // Cards with a fixed height would let the expanded panel run over the next listing; let them grow instead.
      host.classList.add('icm-host'); card.classList.add('icm-host');
      host.appendChild(b);
    }
    return b;
  }

  // Line colours, used only to draw the route on the map.
  const METRO = { 1: ['#2dbef0', '#000'], 2: ['#ff0000', '#fff'], 3: ['#ffdf00', '#000'], 4: ['#a65a21', '#fff'], 5: ['#7db82f', '#000'],
    6: ['#9e9e9e', '#000'], 7: ['#ff8200', '#000'], 8: ['#ff85b9', '#000'], 9: ['#b72e9a', '#fff'], 10: ['#00529b', '#fff'],
    11: ['#007f3b', '#fff'], 12: ['#a49800', '#fff'], R: ['#fff', '#000'] };
  const MODE = { subway: ['#1d4ed8', '#fff', 'Ⓜ'], bus: ['#c2410c', '#fff', '🚌'], rail: ['#15803d', '#fff', '🚆'], tram: ['#a21caf', '#fff', '🚊'] };

  // Step text is built here from the step's own fields so it follows the language; a server's ready-made text is the fallback.
  function stepText(st) {
    if (st.mode === 'walk') return /^Walk \d+ min$/.test(st.text || '') ? t('stepWalk', st.minutes) : st.text;
    if (typeof st.label !== 'string' || !st.minutes) return st.text;
    return [`${st.label} ${st.line || ''}`.trim(), st.from && st.to ? `${st.from} → ${st.to}` : '', st.headsign ? t('stepToward', st.headsign) : '',
      st.stops ? t('stepStops', st.stops) : ''].filter(Boolean).join(' · ') + ` (${st.minutes} min)`;
  }
  const colorOf = (s) => ((s.mode === 'subway' && METRO[s.line]) ? METRO[s.line] : (MODE[s.mode] || ['#444', '#fff']));

  const gmapsUrl = (r) => `https://www.google.com/maps/dir/?api=1&origin=${r.home.lat},${r.home.lng}&destination=${r.work.lat},${r.work.lng}&travelmode=transit`;

  // Interactive map (Leaflet in an extension iframe) right under the badge row; if the iframe can't start
  // (blocked by the page, extension reloaded...) a static SVG map is used instead.
  function mapBlock(r) {
    const wrap = el('div', 'icm-maps');
    const box = el('div', 'icm-mapbox');
    const open = el('a', 'icm-open', t('openMaps'));
    open.href = gmapsUrl(r);
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    wrap.append(box, open);

    const route = { home: r.home, work: r.work,
      steps: r.steps.map((s) => { const [bg, fg] = colorOf(s); return { ...s, bg, fg }; }) };
    // The route travels through extension storage (cross-window postMessage between a content script and an
    // extension iframe proved unreliable); the map page deletes it once drawn and signals back the same way.
    const id = Math.random().toString(36).slice(2);
    let drawn = false;
    const onChange = (ch) => {
      if (!ch['d:' + id]) return;
      drawn = true;
      browser.storage.onChanged.removeListener(onChange);
      browser.storage.local.remove(['m:' + id, 'd:' + id]);
    };
    browser.storage.onChanged.addListener(onChange);
    (async () => {
      await browser.storage.local.set({ ['m:' + id]: route });
      const frame = el('iframe', 'icm-iframe');
      frame.src = browser.runtime.getURL('map.html') + '#' + id;
      frame.title = t('mapTitle');
      box.append(frame);
    })();
    setTimeout(async () => { // fallback if the interactive map never reports back
      if (drawn) return;
      browser.storage.onChanged.removeListener(onChange);
      browser.storage.local.remove(['m:' + id, 'd:' + id]);
      try {
        const res = await ask({ type: 'map', route: { steps: r.steps, home: r.home, work: r.work } });
        if (!res?.svg) throw new Error(res?.error || 'map');
        const doc = new DOMParser().parseFromString(res.svg, 'image/svg+xml');
        box.replaceChildren(document.importNode(doc.documentElement, true));
      } catch (err) {
        box.replaceChildren(el('div', 'icm-ride-meta', t('mapUnavailable', err.message)));
      }
    }, 8000);
    return wrap;
  }

  function render(card, b, r) {
    b.className = 'icm-badge';
    b.replaceChildren();
    delete card.dataset.icmMin;
    if (r.status !== 'ok') {
      b.classList.add('icm-muted');
      const msg = r.status === 'noroute' ? t('noRoute')
        : r.status === 'noaddr' ? (r.address ? t('locNotFoundAt', r.address) : t('locNotFound'))
        : r.status === 'setup' ? r.message.replace(/\.$/, '')
        : (r.message || t('errorGeneric')).replace(/\.$/, '');
      const head = headRow(el('span', 'icm-txt', msg));
      if (r.status === 'setup' || r.fatal) {
        head.append(el('span', 'icm-link', t('openOptions')));
        head.classList.add('icm-click');
        head.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); browser.runtime.sendMessage({ type: 'openOptions' }); });
      }
      if (card.classList.contains('icm-detail') && r.status !== 'setup') head.append(aiField(idOf(card), true, card)); // photo check works without a route
      b.append(head);
      return;
    }
    card.dataset.icmMin = String(r.minutes);
    const head = headRow(el('strong', 'icm-min', `${r.minutes} min`),
      el('span', 'icm-txt', r.transfers === 0 ? t('direct') : r.transfers === 1 ? t('changeOne') : t('changeMany', r.transfers)),
      aiField(idOf(card), true, card),
      icon('chevron', 'icm-chev'));
    head.classList.add('icm-click');
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', 'false');
    head.tabIndex = 0;
    const panel = el('div', 'icm-panel');
    panel.hidden = true;
    const list = el('ol', 'icm-steps');
    for (const st of r.steps) list.append(el('li', null, stepText(st)));
    const where = r.source === 'pin' ? t('srcPin') : r.source === 'pin-approx' ? t('srcApprox') : t('srcAddress', r.address);
    list.append(el('div', 'icm-note', `${where} · ${r.provider}`));
    panel.append(list);
    let opened = false;
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } });
    let refined = false;
    head.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!opened && !refined && r.source === 'address') {
        refined = true;
        head.classList.add('icm-busy');
        const replaced = await refine(card, b).catch(() => false);
        head.classList.remove('icm-busy');
        if (replaced) return; // the refined row re-opened itself
      }
      panel.hidden = !panel.hidden;
      head.setAttribute('aria-expanded', String(!panel.hidden));
      head.classList.toggle('icm-open-head', !panel.hidden);
      if (!panel.hidden && !opened && r.home && r.work) { // the map is created on first expand, right under the row
        opened = true;
        panel.prepend(mapBlock(r));
      }
    });
    b.append(head, isolate(panel));
  }

  // The background script may still be starting when the first card asks (fresh install / browser start):
  // Firefox then answers "Receiving end does not exist". Retry briefly instead of showing an error.
  async function ask(msg) {
    for (let i = 0; ; i++) {
      try { return await browser.runtime.sendMessage(msg); }
      catch (e) {
        if (i >= 6 || !/Receiving end does not exist|Could not establish connection/i.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  }

  // ---- exact / approximate location from idealista's own map page (/inmueble/<id>/mapa) ----------------
  // Same-origin fetch from the page (your cookies, like opening the map yourself), slowly and one at a time;
  // results are kept for 30 days. If idealista shows a bot check we stop for 30 minutes and fall back to the
  // address geocoder, so a listing never fails just because the pin could not be read.
  let idl = null, pinPausedUntil = 0, pinChain = Promise.resolve();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let sorting = false; // while sorting many listings we skip the slow per-listing /mapa lookups (refined when you expand one)
  async function pinFor(card, force = false) {
    try {
      const { settings = {} } = await browser.storage.local.get('settings');
      if (settings.pinFromMap === false) return null;
      idl ||= await import(browser.runtime.getURL('lib/idealista.js'));
      const id = idl.listingId(card.querySelector(LINK)?.getAttribute('href'));
      if (!id) return null;
      const key = 'p:' + id;
      const hit = (await browser.storage.local.get(key))[key];
      if (hit && Date.now() - hit.ts < (hit.v ? 30 : 3) * 86400e3) return hit.v;
      if (sorting && !force) return null;
      if (Date.now() < pinPausedUntil) return null;
      const v = await (pinChain = pinChain.then(async () => {
        if (Date.now() < pinPausedUntil) return undefined;
        await sleep(1200 + Math.random() * 1000);
        const res = await fetch(`/inmueble/${id}/mapa`, { credentials: 'same-origin' });
        const html = await res.text();
        if (idl.looksBlocked(res.status, html)) { pinPausedUntil = Date.now() + 30 * 60e3; return undefined; }
        return res.ok ? idl.parseMapCoords(html) : null;
      }, () => undefined));
      if (v === undefined) return null; // blocked or paused: not cached
      await browser.storage.local.set({ [key]: { ts: Date.now(), v } });
      return v;
    } catch { return null; }
  }

  const sigOf = (settings) => [settings.workAddress, settings.arriveBy, settings.serverUrl, settings.pinFromMap].join('|');
  const idOf = (card) => /\/inmueble\/(\d+)/.exec(card.querySelector(LINK)?.getAttribute('href') || '')?.[1];
  async function saveResult(card, r) {
    const id = idOf(card);
    if (!id || r?.status !== 'ok') return;
    const { settings = {} } = await browser.storage.local.get('settings');
    await browser.storage.local.set({ ['l:' + id]: { ts: Date.now(), sig: sigOf(settings), r } });
  }
  // A result computed from the address (no pin yet) is refined with idealista's own pin the first time you open it.
  async function refine(card, b) {
    const pin = await pinFor(card, true);
    if (!pin) return false;
    const r2 = await ask({ type: 'commute', title: title(card), pin });
    if (r2?.status !== 'ok') return false;
    await saveResult(card, r2);
    render(card, b, r2);
    b.querySelector('.icm-head')?.click();
    return true;
  }

  function handle(card) {
    if (jobs.has(card)) return jobs.get(card);
    const t = title(card);
    if (!t || stopped) return Promise.resolve(); // card not fully rendered yet; a later mutation will retry
    seen.add(card);
    const b = badge(card);
    const job = (async () => {
      try {
        // Listings computed earlier (same work address/settings) come straight from the stored result:
        // no pin fetch, no server call, no API use. They are also skipped when sorting.
        const { settings = {} } = await browser.storage.local.get('settings');
        const sig = sigOf(settings);
        const id = idOf(card);
        const lkey = id && 'l:' + id;
        if (lkey) {
          const hit = (await browser.storage.local.get(lkey))[lkey];
          if (hit && hit.sig === sig && Date.now() - hit.ts < 12 * 3600e3) { render(card, b, hit.r); return; }
        }
        const pin = await pinFor(card);
        const r = await ask({ type: 'commute', title: t, pin });
        render(card, b, r || { status: 'error', message: t('noResponse') });
        await saveResult(card, r);
        if (r?.fatal || r?.status === 'setup') stopped = true; // don't hammer after a bad key / missing setup
      } catch (e) {
        render(card, b, { status: 'error', message: e.message });
      }
    })();
    jobs.set(card, job);
    return job;
  }

  // ---- sort by commute time ----------------------------------------------------------------------
  // Reorders the cards of the current page, plus the other result pages when that option is on (see loadPages).
  let sortOn = false, original = null, resortTimer = null;
  const cards = () => [...document.querySelectorAll(CARD)];
  const minutes = (c) => (c.dataset.icmMin ? Number(c.dataset.icmMin) : Infinity);

  function placeInOrder(list) { // put `list` into the DOM slots the cards currently occupy, leaving ads etc. in place
    const slots = cards().map((c) => { const m = document.createComment(''); c.before(m); return m; });
    list.forEach((c, i) => slots[i].replaceWith(c));
  }
  function applySort() {
    const cs = cards();
    if (!original) original = cs.slice();
    const sorted = cs.slice().sort((a, b) => minutes(a) - minutes(b));
    // Moving a card in the DOM reloads any iframe (the map) inside it, so only touch the page if the order changes.
    if (sorted.every((c, i) => c === cs[i])) return;
    placeInOrder(sorted);
  }
  // Optional (options page): the other result pages are fetched (same-origin, slowly, like opening them yourself) and their
  // listings are added under this page while the sort is on, so they take part in it. Removed again when the sort is turned off.
  let extras = [], extrasDone = false, extrasLoading = null;
  const lastCard = () => cards().filter((c) => !extras.includes(c)).pop();
  function attachExtras() {
    let anchor = lastCard();
    if (anchor) for (const n of extras) if (!n.isConnected) { anchor.after(n); anchor = n; }
  }
  async function loadPages(setStatus) {
    const { settings = {} } = await browser.storage.local.get('settings');
    if (!settings.sortAllPages) return;
    if (extrasDone) { attachExtras(); return; }
    idl ||= await import(browser.runtime.getURL('lib/idealista.js'));
    const build = idl.pageUrlBuilder([...document.querySelectorAll('.pagination a[href*="pagina-"]')].map((a) => a.getAttribute('href')), location.href);
    if (!build) { extrasDone = true; return; }
    const cur = idl.currentPage(location.pathname), max = Math.min(20, Math.max(2, Number(settings.sortPages) || 5));
    const known = new Set(cards().map(idOf));
    let anchor = lastCard(), blocked = false;
    for (let n = 1; n <= max && !blocked; n++) {
      if (n === cur) continue;
      setStatus(t('loadingPage', n));
      await sleep(1200 + Math.random() * 1000);
      let html = '';
      try {
        const res = await fetch(build(n), { credentials: 'same-origin' });
        html = await res.text();
        if (idl.looksBlocked(res.status, html)) { blocked = true; break; }
        if (!res.ok) continue;
      } catch { continue; }
      const fresh = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll(CARD)];
      if (!fresh.length && n > cur) break; // past the last page
      for (const a of fresh) {
        const id = idOf(a);
        if (!id || known.has(id)) continue;
        known.add(id);
        const node = document.importNode(a, true);
        node.dataset.icmExtra = n;
        extras.push(node); anchor.after(node); anchor = node;
      }
    }
    extrasDone = !blocked;
    if (blocked) setStatus(t('pagesBlocked'));
  }
  async function setSort(on, setStatus = () => {}) {
    sortOn = on;
    if (!on) {
      for (const n of extras) n.remove();
      if (original) placeInOrder(original.filter((c) => c.isConnected).concat(cards().filter((c) => !original.includes(c))));
      original = null;
      setStatus('');
      return;
    }
    sorting = true;
    try { await (extrasLoading ||= loadPages(setStatus).finally(() => { extrasLoading = null; })); } catch (e) { console.error('[idealista-commute] pages', e); }
    // Only listings without a result yet need work; those already computed (or cached) are just sorted.
    const todo = cards().filter((c) => !c.dataset.icmMin && !jobs.has(c));
    let done = 0;
    if (todo.length) setStatus(t('calcProgress', 0, todo.length));
    await Promise.all(todo.map((c) => handle(c).then(() => setStatus(t('calcProgress', ++done, todo.length)))));
    await Promise.all(cards().map((c) => jobs.get(c)).filter(Boolean)); // any still in flight from scrolling
    sorting = false;
    if (sortOn) { applySort(); setStatus(t('sortedStatus')); }
  }
  // New cards arriving while sorting (infinite scroll / filters) get computed and sorted in.
  function scheduleResort() {
    if (!sortOn) return;
    clearTimeout(resortTimer);
    resortTimer = setTimeout(async () => { await Promise.all(cards().map(handle)); if (sortOn) applySort(); }, 800);
  }

  // Preferred: add an entry to idealista's own "Ordenar" list. Fallback: our own small bar above the results.
  let barStatus = () => {};
  const ownText = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim().toLowerCase();
  const SORTWORD = /^(relevancia|recientes|más recientes|baratos|más baratos|precio)/i;
  function installNativeSort() {
    const done = document.querySelector('[data-icm-sort]');
    if (done) { if (done.isConnected) { document.querySelector('.icm-sortbar')?.remove(); return true; } }
    // 1) a real <select> with a Relevancia option
    for (const sel of document.querySelectorAll('select')) {
      const opts = [...sel.options];
      if (!opts.some((o) => /relevancia/i.test(o.textContent))) continue;
      const o = new Option(t('sortEntry'), 'icm-commute');
      o.setAttribute('data-icm-sort', '1');
      sel.append(o);
      sel.addEventListener('change', (e) => { if (sel.value === 'icm-commute') { e.stopImmediatePropagation(); setSort(true); } else if (sortOn) setSort(false); }, true);
      document.querySelector('.icm-sortbar')?.remove();
      return true;
    }
    // 2) a list/menu of options: find the "Relevancia" entry, then the container that also holds Recientes/Baratos
    const first = [...document.querySelectorAll('li, a, button, label, span, div, p')].find((n) => ownText(n) === 'relevancia');
    if (!first) return false;
    let item = first;
    while (item.parentElement && ![...item.parentElement.children].some((c) => c !== item && SORTWORD.test(c.textContent.trim()))) item = item.parentElement;
    const list = item.parentElement;
    if (!list || list === document.body) return false;
    const model = [...list.children].reverse().find((c) => SORTWORD.test(c.textContent.trim()));
    if (!model) return false;
    const clone = model.cloneNode(true);
    clone.setAttribute('data-icm-sort', '1');
    clone.removeAttribute('id');
    clone.querySelectorAll('[href]').forEach((a) => { a.removeAttribute('href'); a.style.cursor = 'pointer'; });
    clone.querySelectorAll('input').forEach((i) => { i.checked = false; i.removeAttribute('id'); });
    clone.querySelectorAll('[aria-selected],[aria-checked],[aria-current]').forEach((n) => { n.setAttribute('aria-selected', 'false'); n.setAttribute('aria-checked', 'false'); n.removeAttribute('aria-current'); });
    clone.className = clone.className.replace(/\b\S*(active|selected|current|checked)\S*\b/gi, '').trim() || clone.className;
    const leaf = [...clone.querySelectorAll('*')].reverse().find((n) => ownText(n)) || clone;
    [...leaf.childNodes].filter((c) => c.nodeType === 3).forEach((c) => c.remove());
    leaf.prepend(t('sortEntry'));
    clone.style.cursor = 'pointer';
    clone.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setSort(true, barStatus); }, true);
    list.append(clone);
    document.querySelector('.icm-sortbar')?.remove();
    return true;
  }
  function installBar() {
    if (document.querySelector('.icm-sortbar')) return;
    const first = cards()[0];
    if (!first?.parentElement) return;
    const bar = el('div', 'icm-sortbar');
    const btn = el('button', 'icm-sortbtn', t('sortBtn'));
    btn.type = 'button';
    const status = el('span', 'icm-sortstatus');
    barStatus = (t) => { status.textContent = t; };
    btn.addEventListener('click', () => { btn.classList.toggle('icm-on', !sortOn); btn.textContent = sortOn ? t('sortBtn') : t('sortedBtn'); setSort(!sortOn, barStatus); });
    bar.append(btn, status);
    first.parentElement.insertBefore(bar, first);
  }

  // Only compute for cards near the viewport so scrolling a long list doesn't burn API quota.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); handle(e.target); }
  }, { rootMargin: '300px' });

  // ---- a single listing page (/inmueble/<id>/): the same row, already expanded, under the title ----
  let detailDone = false;
  function initDetail() {
    if (detailDone) return;
    const m = /^\/inmueble\/(\d+)\/?$/.exec(location.pathname);
    const h1 = document.querySelector('h1');
    if (!m || !h1) return;
    detailDone = true;
    const main = document.querySelector('.main-info__title-main')?.textContent.trim() || h1.textContent.trim();
    const minor = document.querySelector('.main-info__title-minor')?.textContent.trim();
    // Same shape as a result-list title, so it goes through the same address parsing and pin lookup.
    const holder = el('div', 'icm-detail');
    const a = el('a', 'item-link');
    a.href = `/inmueble/${m[1]}/`;
    a.title = [main, minor].filter(Boolean).join(', ');
    a.hidden = true;
    holder.append(a);
    (h1.closest('.main-info__title') || h1).after(holder);
    detailHolder = holder;
    handle(holder).then(() => holder.querySelector('.icm-click.icm-head')?.click());
  }

  // ---- AI-generated photo check ------------------------------------------------------------------
  // The result is a field in the commute row ("28 min · 1 change | 97% AI"). On the listing page the field is also the
  // button that scans up to 3 random photos (Sightengine); result lists show it for listings scanned before.
  // Per-photo scores are cached (browser 30 days, server 30 days), so the same photo is never scanned twice.
  const verdict = (max) => (max >= 0.7 ? ['bad', t('aiLikely')] : max >= 0.3 ? ['warn', t('aiInconclusive')] : ['ok', t('aiReal')]);
  const pct = (x) => Math.round(x * 100) + '%';
  const aiRes = new Map(), aiFields = new Map(), aiBusy = new Set(), aiLoaded = new Set(), aiCards = new Map();
  let detailHolder = null;
  const scoredOf = (r) => (r?.images || []).filter((i) => typeof i.score === 'number');

  function paintField(id, f) {
    f.replaceChildren();
    f.className = 'icm-aifield';
    f.removeAttribute('role'); f.removeAttribute('tabindex'); f.removeAttribute('title');
    const r = aiRes.get(id), scored = scoredOf(r);
    if (aiBusy.has(id)) { f.append(el('span', 'icm-txt', t('scanning'))); return; }
    if (scored.length) {
      const max = Math.max(...scored.map((i) => i.score)), [level, label] = verdict(max);
      f.classList.add('icm-ai-' + level);
      f.title = t('aiTitle', label, scored.length, r.total, pct(max));
      f.append(el('strong', 'icm-min', pct(max)), el('span', 'icm-txt', t('aiShort')));
    } else if (r?.error) { f.title = r.error; f.append(el('span', 'icm-txt', t('aiFailed', r.error.length > 48 ? r.error.slice(0, 47) + '…' : r.error))); }
    else if (f._scan) f.append(el('span', 'icm-link', t('scanForAi')));
    if (f._scan && !scored.length) { f.classList.add('icm-click'); f.setAttribute('role', 'button'); f.tabIndex = 0; }
  }
  function paintAll(id) {
    for (const f of aiFields.get(id) || []) if (f.isConnected) paintField(id, f);
    renderAiDetails(id);
  }
  async function loadAi(id) {
    if (aiLoaded.has(id)) return;
    aiLoaded.add(id);
    const hit = (await browser.storage.local.get('ai:' + id))['ai:' + id];
    if (hit && !aiRes.has(id) && Date.now() - hit.ts < 7 * 86400e3) { aiRes.set(id, hit); paintAll(id); }
  }
  // The field for one listing; `canScan` (listing page only) makes it the button that starts the scan.
  function aiField(id, canScan, card) {
    if (id && card) aiCards.set(id, card);
    const f = el('span', 'icm-aifield');
    f._scan = canScan;
    (aiFields.get(id) || aiFields.set(id, new Set()).get(id)).add(f);
    const go = (e) => { e.preventDefault(); e.stopPropagation(); if (canScan && !aiBusy.has(id) && !scoredOf(aiRes.get(id)).length) runAi(id); };
    f.addEventListener('click', go);
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    paintField(id, f);
    if (id) loadAi(id).catch(() => {});
    return f;
  }

  async function listingHtml(id, card) {
    const own = card?.outerHTML || '';
    if (Date.now() < pinPausedUntil) return own;
    const html = await (pinChain = pinChain.then(async () => {
      if (Date.now() < pinPausedUntil) return null;
      await sleep(300 + Math.random() * 400);
      const res = await fetch(`/inmueble/${id}/`, { credentials: 'same-origin' });
      const text = await res.text();
      if (idl.looksBlocked(res.status, text)) { pinPausedUntil = Date.now() + 30 * 60e3; return null; }
      return res.ok ? text : null;
    }, () => null));
    return html || own;
  }

  // Thumbnails of the scanned photos (with their own %) under the commute row, listing page only.
  function renderAiDetails(id) {
    if (!detailHolder || idOf(detailHolder) !== id) return;
    let box = detailHolder.nextElementSibling;
    if (!box?.classList.contains('icm-ai')) { box = el('div', 'icm-badge icm-ai'); detailHolder.after(box); }
    const r = aiRes.get(id);
    box.replaceChildren();
    box.hidden = !r; // nothing to show until a scan has produced something
    if (!r) return;
    if (r.error) box.append(el('div', 'icm-note', r.error));
    const row = el('div', 'icm-ai-photos');
    for (const i of r.images || []) {
      const ok = typeof i.score === 'number';
      const fig = el('div', 'icm-ai-photo' + (ok ? ' icm-ai-' + verdict(i.score)[0] : ''));
      const img = el('img');
      img.src = i.url; img.alt = t('scannedAlt'); img.loading = 'lazy';
      fig.append(img, el('span', 'icm-ai-pct', ok ? pct(i.score) : '?'));
      row.append(fig);
    }
    if (row.childElementCount) box.append(row);
    box.append(el('div', 'icm-note', t('aiDisclaimer')));
    const a = el('a', 'icm-open', t('scanOther'));
    a.href = '#'; a.role = 'button';
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (!aiBusy.has(id)) runAi(id); });
    box.append(a);
  }

  async function runAi(id) {
    aiBusy.add(id); paintAll(id);
    try {
      idl ||= await import(browser.runtime.getURL('lib/idealista.js'));
      // On the listing page the photos are right here; from the results list the listing's own page is fetched (same
      // origin, one at a time, like the exact-pin lookup), falling back to the card's own thumbnails if idealista objects.
      const onPage = detailHolder && idOf(detailHolder) === id;
      const all = idl.photoUrls(onPage ? document.documentElement.outerHTML : await listingHtml(id, aiCards.get(id)));
      console.info('[idealista-commute] photo check: photos found on page:', all.length, all.slice(0, 3));
      if (!all.length) { aiRes.set(id, { error: t('noPhotos'), images: [] }); return; }
      // Per-photo cache: a photo scanned before is never sent again; new random picks prefer unscanned photos.
      const stored = await browser.storage.local.get(all.map((u) => 'aip:' + u));
      const known = (u) => { const h = stored['aip:' + u]; return h && Date.now() - h.ts < 30 * 86400e3 ? h.score : undefined; };
      const pick = idl.pickRandom(all.filter((u) => known(u) === undefined), 3);
      if (pick.length < 3) pick.push(...idl.pickRandom(all.filter((u) => !pick.includes(u)), 3 - pick.length));
      const todo = pick.filter((u) => known(u) === undefined);
      let scanned = [];
      if (todo.length) {
        console.info('[idealista-commute] photo check: scanning', todo);
        const res = await ask({ type: 'aicheck', images: todo });
        console.info('[idealista-commute] photo check: answer', res);
        if (!res || res.error) { aiRes.set(id, { error: res?.error || 'no response', images: [] }); return; }
        scanned = res.images;
        await browser.storage.local.set(Object.fromEntries(scanned.filter((i) => typeof i.score === 'number').map((i) => ['aip:' + i.url, { ts: Date.now(), score: i.score }])));
      }
      const byUrl = new Map(scanned.map((i) => [i.url, i]));
      const r = { images: pick.map((u) => byUrl.get(u) || { url: u, score: known(u) }), total: pick.length, ts: Date.now() };
      aiRes.set(id, r);
      await browser.storage.local.set({ ['ai:' + id]: r });
    } catch (e) { aiRes.set(id, { error: e.message, images: [] }); }
    finally { aiBusy.delete(id); paintAll(id); }
  }

  // Cards are picked up immediately; the (heavier) menu/bar installation is throttled and can never break the badges.
  let installTimer = null;
  function install() {
    installTimer = null;
    try { if (!installNativeSort()) installBar(); } catch (e) { console.error('[idealista-commute] sort menu', e); try { installBar(); } catch {} }
    try { initDetail(); } catch (e) { console.error('[idealista-commute] detail page', e); }
    try { scheduleResort(); } catch (e) { console.error('[idealista-commute] resort', e); }
  }
  function scan() {
    document.querySelectorAll(CARD).forEach((c) => { if (!seen.has(c)) io.observe(c); });
    if (!installTimer) installTimer = setTimeout(install, 500);
  }
  // Saved API keys are locked until the passphrase is typed once per browser session. The real toolbar popup is
  // opened for it. Firefox may only allow that from a user action, so if the first try is refused it is
  // retried on your first click or key press on the page.
  async function promptUnlock() {
    try { if (!(await ask({ type: 'needsUnlock' }))) return; } catch { return; }
    if (await ask({ type: 'openPopup' }).catch(() => false)) return;
    const retry = async () => {
      document.removeEventListener('pointerdown', retry, true); document.removeEventListener('keydown', retry, true);
      if (await ask({ type: 'needsUnlock' }).catch(() => false)) ask({ type: 'openPopup' }).catch(() => {});
    };
    document.addEventListener('pointerdown', retry, true); document.addEventListener('keydown', retry, true);
  }
  browser.runtime.onMessage.addListener((m) => { if (m?.type === 'unlocked') location.reload(); });
  promptUnlock();

  scan();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
})();
