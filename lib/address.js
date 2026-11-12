// Turns an idealista listing title into a geocodable query.
// idealista titles look like: "Piso en calle de Embajadores, Lavapiés-Embajadores, Madrid"

export function parseAddress(title, citySuffix = 'Madrid, España') {
  if (!title) return null;
  let t = String(title).replace(/\s+/g, ' ').trim();
  // Drop the property-type prefix ("Piso en", "Ático en", "Casa o chalet en", ...).
  const m = t.match(/^(.{1,40}?) en (.+)$/i);
  if (m && m[1].split(' ').length <= 4) t = m[2];
  // "Ático en venta en X" / "Piso en alquiler en X": drop the leftover "venta en" / "alquiler en".
  t = t.replace(/^(en\s+)?(venta|alquiler)\s+(en\s+)?/i, '').trim();
  if (!t) return null;
  const city = citySuffix.split(',')[0].trim().toLowerCase();
  if (city && !t.toLowerCase().includes(city)) t += ', ' + citySuffix;
  return t;
}

// Progressively simpler queries to try when the full text isn't found by the geocoder
// (idealista locations look like "Street, Neighbourhood, City" or "Area - Subarea, City").
export function addressCandidates(addr, citySuffix = 'Madrid, España') {
  if (!addr) return [];
  const out = [addr];
  const cityName = citySuffix.split(',')[0].trim();
  const parts = addr.split(',').map((p) => p.trim()).filter(Boolean);
  const place = parts.filter((p) => ![cityName.toLowerCase(), 'españa'].includes(p.toLowerCase()));
  // Area names written as "A - B": try each half on its own, then the "A B" spelling.
  for (const p of place) {
    if (p.includes(' - ')) {
      const halves = p.split(' - ').map((h) => h.trim());
      out.push(`${halves.join(' ')}, ${citySuffix}`, ...halves.map((h) => `${h}, ${citySuffix}`));
    }
  }
  // idealista writes Madrid-city listings as "street, neighbourhood, Madrid" (the city is explicit); anything
  // else ("calle del Pozo, San Martín de Valdeiglesias") had the default city appended by parseAddress, so its
  // last component is a TOWN. Falling back to "street, Madrid" for those would silently land in Madrid city.
  const townListing = addr.endsWith(citySuffix);
  if (townListing) {
    if (place.length >= 2) {
      const town = place[place.length - 1];
      out.push(`${town}, ${citySuffix}`, `${town}, España`); // approximate: the town centre
    }
  } else if (place.length >= 2) {
    out.push(`${place[0]}, ${citySuffix}`); // drop the neighbourhood: "Street, Neighbourhood, Madrid" -> "Street, Madrid"
  }
  return [...new Set(out)].slice(0, 7);
}

// Next weekday (Mon-Fri) at HH:MM local time, as a Date. Used as the "arrive by" time.
export function nextArrival(hhmm = '09:00', now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m || 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
