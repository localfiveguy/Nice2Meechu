import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { flagEmoji } from "../lib/cityFormat";

// Full A-Z city list for the Change Location screen.
//
// Rows come from /cities.json (a static file built by
// scripts/build_city_directory.py: US towns >= 10k people + world cities
// >= 100k), merged with the live /api/cities/popular counts. A town that has
// people keeps the exact entry the server returned, so tapping it browses the
// same label/coordinates as before. Towns with people that aren't in the
// static file (small towns) are added as their own rows.
//
// The list renders in pages of PAGE rows and loads more as you scroll, so a
// phone never has to draw ~10,000 buttons at once.

const PAGE = 60;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
// Curated server names that differ from the GeoNames name.
const NAME_ALIASES = { "new york": "new york city" };

// Accent- and punctuation-insensitive key ("São Paulo" -> "sao paulo").
// Letters with no accent-free form in Unicode ("Đà Lạt", "Łódź", "Diyarbakır").
const SPECIAL_LETTERS = { "Đ": "D", "đ": "d", "Ð": "D", "ð": "d", "Ł": "L", "ł": "l", "ı": "i", "Ø": "O", "ø": "o", "ß": "ss", "Æ": "AE", "æ": "ae" };
const fold = (s) =>
  (s || "")
    .replace(/[ĐđÐðŁłıØøßÆæ]/g, (ch) => SPECIAL_LETTERS[ch])
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .toLowerCase()
    .trim();

const firstLetter = (name) => {
  const ch = fold(name).charAt(0).toUpperCase();
  return ch >= "A" && ch <= "Z" ? ch : "#";
};

const byName = (a, b) =>
  a.sortKey.localeCompare(b.sortKey) || (a.country || "").localeCompare(b.country || "");

function mergeCities(directoryRows, popular) {
  const rows = directoryRows.map(([name, region, country, cc, lat, lng]) => ({
    city: name,
    country: region ? `${region}, ${country}` : country,
    country_code: cc,
    flag: flagEmoji(cc) || "🌍",
    lat,
    lng,
    people: 0,
  }));

  // Index directory rows by "name|country line" and by "name|country code".
  const byLabel = new Map();
  const byCode = new Map();
  rows.forEach((r, i) => {
    const n = fold(r.city);
    byLabel.set(`${n}|${fold(r.country)}`, i);
    const codeKey = `${n}|${r.country_code}`;
    if (!byCode.has(codeKey)) byCode.set(codeKey, i);
  });

  const extras = [];
  (popular || []).forEach((p) => {
    const n = fold(p.city);
    let idx = byLabel.get(`${n}|${fold(p.country)}`);
    if (idx === undefined && NAME_ALIASES[n]) idx = byLabel.get(`${NAME_ALIASES[n]}|${fold(p.country)}`);
    if (idx === undefined && p.country_code) {
      idx = byCode.get(`${NAME_ALIASES[n] || n}|${p.country_code}`);
    }
    if (idx !== undefined) {
      const d = rows[idx];
      // Keep the directory's display text, but browse exactly what the
      // server listed (its label + coordinates) when the town has people.
      rows[idx] = {
        ...d,
        people: (d.people || 0) + (p.people || 0),
        pick: p.people > 0 ? p : d.pick,
      };
    } else {
      extras.push({ ...p, flag: p.flag || "🌍" });
    }
  });

  return [...rows, ...extras].map((r) => ({ ...r, sortKey: fold(r.city), letter: firstLetter(r.city) }));
}

export function CityDirectoryList({ popular, onPick, disabled }) {
  const [directory, setDirectory] = useState(null); // null = loading
  const [sortMode, setSortMode] = useState("az"); // "az" | "people"
  const [letter, setLetter] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const sentinelRef = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch("/cities.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => { if (alive) setDirectory(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setDirectory([]); });
    return () => { alive = false; };
  }, []);

  const merged = useMemo(() => mergeCities(directory || [], popular), [directory, popular]);

  const list = useMemo(() => {
    let l = letter ? merged.filter((c) => c.letter === letter) : merged.slice();
    if (sortMode === "people") l.sort((a, b) => (b.people || 0) - (a.people || 0) || byName(a, b));
    else l.sort(byName);
    return l;
  }, [merged, letter, sortMode]);

  // Start from the top whenever the view changes.
  useEffect(() => { setShown(PAGE); }, [letter, sortMode]);

  // Load the next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || shown >= list.length) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((s) => Math.min(s + PAGE, list.length));
      },
      { rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, list.length]);

  const loading = directory === null && (!popular || popular.length === 0);

  return (
    <div className="mt-1" data-testid="change-location-city-list">
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">🌎</span>
          <h3 className="font-display text-base font-black truncate">
            All cities{merged.length ? ` (${merged.length.toLocaleString()})` : ""}
          </h3>
        </div>
        <div className="flex shrink-0 rounded-full bg-white/8 p-0.5 text-[10px] uppercase tracking-widest font-bold">
          <button
            type="button"
            onClick={() => setSortMode("az")}
            className={`px-2.5 py-1 rounded-full transition ${sortMode === "az" ? "bg-white text-black" : "text-white/60"}`}
            aria-pressed={sortMode === "az"}
            data-testid="change-location-sort-az"
          >
            A–Z
          </button>
          <button
            type="button"
            onClick={() => setSortMode("people")}
            className={`px-2.5 py-1 rounded-full transition ${sortMode === "people" ? "bg-white text-black" : "text-white/60"}`}
            aria-pressed={sortMode === "people"}
            data-testid="change-location-sort-people"
          >
            Most people
          </button>
        </div>
      </div>

      {/* Letter jump bar — tap a letter to show only cities starting with it. */}
      <div className="flex gap-1 overflow-x-auto pb-2 -mx-1 px-1" data-testid="change-location-letters">
        <button
          type="button"
          onClick={() => setLetter(null)}
          className={`shrink-0 min-w-[2.25rem] h-8 px-2 rounded-full text-xs font-bold transition ${letter === null ? "bg-[#FF4D4D] text-white" : "bg-white/8 text-white/70"}`}
          data-testid="change-location-letter-all"
        >
          All
        </button>
        {LETTERS.map((L) => (
          <button
            key={L}
            type="button"
            onClick={() => setLetter(letter === L ? null : L)}
            className={`shrink-0 w-8 h-8 rounded-full text-xs font-bold transition ${letter === L ? "bg-[#FF4D4D] text-white" : "bg-white/8 text-white/70"}`}
            data-testid={`change-location-letter-${L}`}
          >
            {L}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {loading && <div className="text-xs text-white/40 py-3">Loading cities…</div>}
        {!loading && list.length === 0 && (
          <div className="text-xs text-white/40 py-3">No cities under this letter. Try the search box above.</div>
        )}
        {list.slice(0, shown).map((c, i) => (
          <button
            key={`${c.city}-${c.country}-${c.lat}-${c.lng}`}
            onClick={() => onPick(c.pick || c)}
            disabled={disabled || c.lat == null}
            className="flex items-center gap-3 rounded-2xl px-3 py-2.5 bg-white/5 hover:bg-white/10 active:scale-[0.99] transition text-left disabled:opacity-50"
            data-testid={`change-location-popular-${i}`}
          >
            <div className="text-2xl shrink-0">{c.flag}</div>
            <div className="flex-1 min-w-0">
              <div className="font-display text-base font-black truncate">{c.city}</div>
              <div className="text-xs text-white/45 truncate">{c.country || "—"}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {c.people > 0 && (
                <span className="text-[10px] uppercase tracking-widest font-bold px-2 py-1 rounded-full bg-[#FF4D4D]/20 text-white">
                  {c.people === 1 ? "1 person" : `${c.people} people`}
                </span>
              )}
              <ArrowRight size={14} className="text-white/35" />
            </div>
          </button>
        ))}
        {shown < list.length && (
          <div ref={sentinelRef} className="text-center text-xs text-white/35 py-3">Loading more…</div>
        )}
      </div>
      <p className="mt-3 text-[10px] text-white/30 text-center">
        Can't find your town? Use the search box above. City list from{" "}
        <a href="https://www.geonames.org" target="_blank" rel="noopener noreferrer" className="underline">GeoNames</a>{" "}
        (CC BY 4.0).
      </p>
    </div>
  );
}
