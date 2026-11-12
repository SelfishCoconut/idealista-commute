// TEMPLATE for a custom routing backend. Copy this file, replace the body of `route`, and point the server at it:
//   ROUTER_MODULE=/routers/my-router.mjs   (in server/.env; server/routers/ is mounted at /routers)
//
// Contract: receives {from:{lat,lng}, to:{lat,lng}, arriveBy:"HH:MM"} and returns either
//   { found: false }                                   no route
//   { found: true, minutes, transfers, provider?, steps: [{ mode, minutes, text, polys?, board? }] }
// where mode is "walk" | "subway" | "bus" | "rail" | "tram", `polys` are Google-encoded polylines for the map
// and `board` is [lat,lng] of the boarding stop. Throw an Error with `.status` (HTTP code) on failure; add
// `.fatal = true` for errors the user must fix (bad credentials) so the extension stops retrying.
// Answers are cached by the server, so keep this function simple and stateless.
//
// This example needs no external service: it estimates a walk in a straight line at 5 km/h.
export default async function route({ from, to }) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(to.lat - from.lat) / 2) ** 2 +
    Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(rad(to.lng - from.lng) / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(a)) * 1.3; // x1.3: streets are not straight
  const minutes = Math.max(1, Math.round((km / 5) * 60));
  return { found: true, minutes, transfers: 0, provider: 'Example router (walking estimate)',
    steps: [{ mode: 'walk', minutes, text: `Walk ${minutes} min` }] };
}
export const routerName = 'example';
