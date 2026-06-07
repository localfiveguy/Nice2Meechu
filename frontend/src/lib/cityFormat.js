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
  const parts = [p.name, state, country].filter(Boolean);
  return parts.join(", ");
}
