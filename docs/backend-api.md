# Backend API

The extension talks to **one server** (the "Server URL" in its options). `server/` in this repo is the reference
implementation, but anything that speaks the HTTP contract below works: your own service, a different routing
engine, a shared instance run by a friend. All endpoints are plain HTTP + JSON; the server must send
`Access-Control-Allow-Origin: *` (and answer `OPTIONS`) because the extension calls it cross-origin.

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness and a status line for the options page's **Test server** button |
| `GET /geocode?q=TEXT` | Address/place text → coordinates |
| `POST /route` | Public-transport route between two points |
| `POST /ai-check` | Probability that up to 3 listing photos are AI-generated (optional; without it the photo check reports an error, everything else works) |
| `GET /tile/{z}/{x}/{y}.png` | Map tile (optional; without it the map is blank, everything else works) |

**Authentication (optional):** when the server sets `ACCESS_TOKEN`, every endpoint except `/health` requires
`Authorization: Bearer <token>` and answers `401 {"error":…, "fatal":true}` otherwise. `POST /route` requires
`Content-Type: application/json`.

## `GET /health`
```json
{ "ok": true, "routing": "google", "paidCallsThisMonth": 12, "monthlyLimit": 2000, "aiCheck": true, "aiCallsThisMonth": 6, "aiMonthlyLimit": 1500, "cache": { "entries": 340 } }
```
`ok` must be `true`. `routing` is a name of the routing backend, or `null` when none is configured (the options
page then reports that routing is not set up). The other fields are optional and only displayed.

## `GET /geocode?q=TEXT`
`q` is a free-text place, e.g. `Calle de Rodas 10, Madrid, España` (≤ 200 chars).
```json
{ "found": true, "lat": 40.4098, "lng": -3.7077, "label": "Calle de Rodas, Embajadores, Madrid" }
{ "found": false }
```
Return HTTP 5xx when your upstream failed (so the client retries later), never `found:false`: a miss is
remembered, an error is not.

## `POST /route`
Request body:
```json
{ "from": { "lat": 40.39, "lng": -3.69 }, "to": { "lat": 40.43, "lng": -3.71 }, "arriveBy": "09:00" }
```
`arriveBy` is the local arrival time (`HH:MM`); the reference server plans for the next Wednesday at that time.

Response:
```json
{
  "found": true,
  "minutes": 27,
  "transfers": 1,
  "provider": "Google Routes",
  "steps": [
    { "mode": "walk",   "minutes": 4,  "text": "Walk 4 min" },
    { "mode": "subway", "minutes": 18, "text": "Metro 3 · Legazpi → Moncloa · 8 stops (18 min)",
      "polys": ["<google encoded polyline>"], "board": [40.391, -3.695] },
    { "mode": "walk",   "minutes": 5,  "text": "Walk 5 min" }
  ]
}
```
- `mode`: `walk`, `subway`, `bus`, `rail` or `tram`: used for the icon and the line colour on the map.
- `polys` (optional): encoded polylines ([format](https://developers.google.com/maps/documentation/utilities/polylinealgorithm))
  that draw the step on the map. `board` (optional): `[lat, lng]` of the boarding stop.
- No route: `{ "found": false }`.
- Errors: a non-2xx status with `{ "error": "human readable message", "fatal": true|false }`. `fatal: true` means
  retrying cannot help (bad credentials, quota exhausted) and the extension stops and shows the message.

## `POST /ai-check`
Request (`Content-Type: application/json`): `{ "images": ["https://img4.idealista.com/....jpg", ...] }`, 1 to 3
`https://*.idealista.com` image URLs (anything else is `400`: the reference server is not an open scoring proxy).
```json
{ "provider": "Sightengine", "images": [ { "url": "https://img4.idealista.com/...jpg", "score": 0.97 }, { "url": "...", "error": "download failed" } ] }
```
`score` is 0 to 1, the probability that the photo is AI-generated. A photo that could not be scored carries `error`
instead (the others are still returned). When every photo fails, or the service is not configured (`503`), the
answer is an error body like `/route`'s. The reference server uses Sightengine's `genai` model
(`SIGHTENGINE_USER`, `SIGHTENGINE_SECRET`, `SIGHTENGINE_MONTHLY_LIMIT` in `server/.env`), caches each photo's score
for 30 days and counts only photos actually sent to Sightengine against the monthly limit.

## `GET /tile/{z}/{x}/{y}.png`
A standard slippy-map tile, zoom 1–17. The reference server proxies and caches OpenStreetMap tiles so the
browser never contacts a tile server itself; any tile source whose licence allows it will do.

## Swapping the routing engine without writing a server
The reference server delegates `POST /route` to a pluggable function. Write a module exporting
`async function route({ from, to, arriveBy })` that returns the response above, and start the server with
`ROUTER_MODULE=/routers/my-router.mjs`. `server/routers/example-router.mjs` is a commented, runnable template.
Caching, the monthly call cap, geocoding and tiles all keep working.
