// UI text lives in _locales/<lang>/messages.json (es is the default; Firefox picks en when the browser is in English).
// Outside the extension (unit tests under Node) there is no browser.i18n, so t() returns "key:arg1:arg2".
export const t = (key, ...subs) => {
  const m = globalThis.browser?.i18n?.getMessage(key, subs.map(String));
  return m || [key, ...subs].join(':');
};

// Fills the page from data-i18n="key" (text), data-i18n-placeholder / -title / -aria-label (attributes).
// Text may contain <c>code</c> and <a>link text</a>; the link reuses the element's own <a> (so its href stays).
export function applyI18n(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) {
    const link = n.querySelector('a');
    const msg = t(n.dataset.i18n);
    const nodes = [];
    for (const part of msg.split(/(<c>.*?<\/c>|<a>.*?<\/a>)/)) {
      const m = /^<(c|a)>(.*)<\/\1>$/.exec(part);
      if (!m) { if (part) nodes.push(document.createTextNode(part)); continue; }
      const el = m[1] === 'a' && link ? link : document.createElement('code');
      el.textContent = m[2];
      nodes.push(el);
    }
    n.replaceChildren(...nodes);
  }
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    for (const n of root.querySelectorAll(`[data-i18n-${attr}]`)) n.setAttribute(attr, t(n.getAttribute(`data-i18n-${attr}`)));
  }
}
