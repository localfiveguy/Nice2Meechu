// ---------- City label formatting (used by autocomplete + change-location) ----------
// Friendly short country names + state abbreviations for the US.
// Photon returns full state names ("New Jersey") and country names ("United States").
export function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return "";
  const A = 0x1f1e6;
  const c = cc.toLowerCase();
  return String.fromCodePoint(A + (c.charCodeAt(0) - 97), A + (c.charCodeAt(1) - 97));
}

export const COUNTRY_SHORT = {
  "United States": "USA",
  "United States of America": "USA",
  "United Kingdom": "UK",
  "United Arab Emirates": "UAE",
  "Russian Federation": "Russia",
  "Republic of Korea": "South Korea",
  "Democratic Republic of the Congo": "DR Congo",
  "Bolivia (Plurinational State of)": "Bolivia",
  "Venezuela (Bolivarian Republic of)": "Venezuela",
  "Iran (Islamic Republic of)": "Iran",
  "Czechia": "Czechia",
  // Photon sometimes returns native country names — normalize the common ones.
  "Deutschland": "Germany",
  "España": "Spain",
  "Italia": "Italy",
  "Brasil": "Brazil",
  "México": "Mexico",
  "Polska": "Poland",
  "Türkiye": "Turkey",
  "Suomi": "Finland",
  "Sverige": "Sweden",
  "Norge": "Norway",
  "Nederland": "Netherlands",
  "Österreich": "Austria",
  "Schweiz": "Switzerland",
  "Magyarország": "Hungary",
  "Ελλάδα": "Greece",
  "日本": "Japan",
  "中国": "China",
  "대한민국": "South Korea",
};

export const US_STATE_ABBR = {
  Alabama:"AL", Alaska:"AK", Arizona:"AZ", Arkansas:"AR", California:"CA", Colorado:"CO",
  Connecticut:"CT", Delaware:"DE", Florida:"FL", Georgia:"GA", Hawaii:"HI", Idaho:"ID",
  Illinois:"IL", Indiana:"IN", Iowa:"IA", Kansas:"KS", Kentucky:"KY", Louisiana:"LA",
  Maine:"ME", Maryland:"MD", Massachusetts:"MA", Michigan:"MI", Minnesota:"MN",
  Mississippi:"MS", Missouri:"MO", Montana:"MT", Nebraska:"NE", Nevada:"NV",
  "New Hampshire":"NH", "New Jersey":"NJ", "New Mexico":"NM", "New York":"NY",
  "North Carolina":"NC", "North Dakota":"ND", Ohio:"OH", Oklahoma:"OK", Oregon:"OR",
  Pennsylvania:"PA", "Rhode Island":"RI", "South Carolina":"SC", "South Dakota":"SD",
  Tennessee:"TN", Texas:"TX", Utah:"UT", Vermont:"VT", Virginia:"VA", Washington:"WA",
  "West Virginia":"WV", Wisconsin:"WI", Wyoming:"WY", "District of Columbia":"DC",
};

// Format Photon properties into "City, State, Country" — collapses
// "United States" → "USA", and US states into 2-letter abbreviations.
export function formatCityLabel(p = {}) {
  const country = COUNTRY_SHORT[p.country] || p.country || "";
  let state = p.state || "";
  if (country === "USA" && US_STATE_ABBR[state]) state = US_STATE_ABBR[state];
  const parts = [stripCityNoise(p.name), state, country].filter(Boolean);
  return parts.join(", ");
}

// Drop municipal-classification suffixes that don't help users identify
// where they live. Locals say "Voorhees" — never "Voorhees Township" —
// even though OSM (and therefore Photon) labels the place with the legal
// suffix. Same with `Twp.` / `Borough` / `City of` / `Town of`.
//
// Why this matters operationally: in our feed, the saved `city` string is
// the bucket key — so when a user picks "Voorhees Township, NJ, USA" they
// get bucketed separately from the user who picked "Voorhees, NJ, USA",
// even though both live on the same block. Stripping the suffix collapses
// both buckets into one ("Voorhees, NJ, USA") so neighbors actually meet.
const CITY_NOISE_SUFFIXES = [
  /\s+Township$/i,
  /\s+Twp\.?$/i,
  /\s+Borough$/i,
  /\s+Town\b/i,        // "Town of Cary" etc — only when standalone word
];
const CITY_NOISE_PREFIXES = [
  /^City of\s+/i,
  /^Town of\s+/i,
  /^Borough of\s+/i,
  /^Township of\s+/i,
];

export function stripCityNoise(name) {
  if (!name || typeof name !== "string") return name;
  let out = name.trim();
  for (const re of CITY_NOISE_PREFIXES) out = out.replace(re, "");
  for (const re of CITY_NOISE_SUFFIXES) out = out.replace(re, "");
  return out.trim();
}

// Collapse Photon-returned duplicates that point at the same physical
// place. When the API returns BOTH "Voorhees Township" AND "Voorhees" in
// the same state/country, keep the cleaner name and drop the suffix one.
// Falls back to keeping whichever has the shorter name when both look
// equivalent.
export function dedupeCitySuggestions(items) {
  const byKey = new Map();
  for (const item of items) {
    // We accept either { name, state, country } shape (Photon raw) or
    // { city, state, country } (ChangeLocationScreen shape) — normalize
    // both into a comparable key based on the noise-stripped name.
    const rawName = item.name || item.city || item.value || "";
    const clean = stripCityNoise(rawName).toLowerCase();
    const state = (item.state || "").toLowerCase();
    const country = (item.country || "").toLowerCase();
    const key = `${clean}|${state}|${country}`;
    if (!key.trim()) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    // Prefer the entry with the shorter/cleaner raw name — that's the one
    // WITHOUT the noise suffix. e.g. between "Voorhees" (8) and "Voorhees
    // Township" (18), we keep "Voorhees".
    const existingLen = (existing.name || existing.city || existing.value || "").length;
    const currentLen = rawName.length;
    if (currentLen < existingLen) byKey.set(key, item);
  }
  return Array.from(byKey.values());
}
