# Firefox Add-ons (AMO) listing

The extension is Spanish by default and English when Firefox is in English. Fill the listing in both languages
(Spanish first, it is the default locale), then copy the shared sections below.

## Name
- es: Tiempo al trabajo para Idealista
- en: Commute Time for Idealista

## Summary (max 250 characters)
- es: Mira en cada anuncio de idealista cuánto tardas en transporte público hasta tu trabajo, con pasos, mapa y orden por trayecto. Comprobación opcional de fotos con IA. Funciona con tu servidor o en el navegador; tus claves, cifradas.
- en: See the public-transport commute time to your work on every idealista listing, with route steps, a map and sorting by commute. Optional AI-photo check. Runs on your own server or in your browser; your API keys stay encrypted.

## Categories
Travel & Maps (or Shopping)

## Tags
idealista, commute, real estate, transit, map, housing, spain

## Support
- Homepage / support site: https://github.com/SelfishCoconut/idealista-commute
- Support issues: https://github.com/SelfishCoconut/idealista-commute/issues
- Privacy policy: paste the text of `PRIVACY.md`
- License: MIT (choose it from the list)

## Description (Spanish)

**¿Cuánto tardas desde cada piso hasta tu trabajo? La respuesta, en la propia página de resultados.**

Tiempo al trabajo para Idealista añade una línea a cada anuncio: `28 min · 1 trasbordo`. Haz clic para ver un mapa
interactivo con casa, trabajo y ruta, los pasos numerados y un enlace para abrirla en Google Maps.

- Ordena los resultados por tiempo al trabajo desde la propia lista «Ordenar» de idealista
- Usa la ubicación exacta del anuncio en lugar de adivinarla por el título
- Comprobación opcional de fotos falsas: analiza hasta 3 fotos al azar con Sightengine y muestra la probabilidad de que sean generadas por IA
- Todo se guarda en caché y los límites mensuales controlan las llamadas de pago

**Tú decides dónde se ejecuta**
- *Mi servidor*: un pequeño backend autoalojable (Docker o Node) guarda la clave de Google
- *Este navegador*: sin servidor; la extensión llama a Google Routes (con tu clave) y a OpenStreetMap directamente

**Tus claves, a salvo**
Las claves de API se cifran con una contraseña que eliges y se desbloquean una vez por sesión desde el icono de la
barra. Sin analíticas ni cuentas.

Pensada para España (la geocodificación está limitada a España y los valores por defecto son de Madrid). Sin
afiliación con idealista. Código abierto: https://github.com/SelfishCoconut/idealista-commute

## Description (English)

**How far is each flat from your work? Answered on the results page.**

Idealista Commute adds a line to every listing: `28 min · 1 change`. Click it for an interactive map with home,
work and the route, the numbered steps, and a link to open it in Google Maps.

- Sort the results by commute time, from idealista's own *Ordenar* list
- Uses the listing's exact map pin instead of guessing from the title
- Optional fake-photo check: scans up to 3 random photos with Sightengine and shows the chance each is AI-generated
- Every answer is cached, and monthly limits keep paid calls under control

**You choose where it runs**
- *My server*: a small self-hostable backend (Docker or Node) holds the Google key
- *This browser*: no server; the extension calls Google Routes (your own key) and OpenStreetMap directly

**Your keys stay safe**
API keys are encrypted with a passphrase you choose and unlocked once per browser session from the toolbar icon.
No analytics, no accounts.

Spain-focused (geocoding is restricted to Spain, defaults assume Madrid). Not affiliated with idealista.
Open source: https://github.com/SelfishCoconut/idealista-commute

## Notes to reviewers

- **No build step.** Plain JavaScript; the zip is the source tree.
- **Third-party code:** Leaflet (BSD-2-Clause) in `lib/vendor/leaflet/`, unmodified.
- **Permissions.** `storage`; `webRequest`/`webRequestBlocking` only to set the identifying `User-Agent` that
  OpenStreetMap's tile policy requires on tile requests made by the extension. The idealista content script reads
  listing titles and photo addresses. Other hosts (your server, Google, OpenStreetMap, Sightengine) are optional host
  permissions requested from the options page only when you enable that feature.
- **Data collection.** None by the extension (`data_collection_permissions.required: ["none"]`); data goes only to
  services the user configures, described in PRIVACY.md.
- **Encryption.** `lib/vault.js`: WebCrypto PBKDF2-SHA256 (600k) → AES-256-GCM; decrypted keys only in `storage.session`.
- **Testing.** `npm test`; the server has its own tests.

## Screenshots (store/screenshots/)
Made with `tools/screenshots/` (a stub of the browser API runs the real content script and pages in headless Firefox;
`node tools/screenshots/serve.mjs 8099 &` then `node tools/screenshots/shoot.mjs`). The listings are demo data.
1. `1-resultados-es.png`: commute line, map and steps on a results page (Spanish)
2. `2-results-en.png`: the same in English
3. `3-opciones-es.png`: options page (Spanish)
4. `4-options-en.png`: options page (English)
5. `5-bloqueado-es.png`: options page while the keys are locked
