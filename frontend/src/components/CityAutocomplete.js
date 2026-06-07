import React, { useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { formatCityLabel } from "../lib/cityFormat";
import { useDropdownPlacement } from "../lib/useDropdownDirection";

export function CityAutocomplete({ value, onChange, onPick, biasLat, biasLng, onEnter }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);
  const inputRef = useRef(null);
  const showDropdown = open && suggestions.length > 0;
  // Flip the dropdown above the input on mobile when the keyboard would
  // otherwise cover the suggestions (common on Android where the input sits
  // mid-screen and the keyboard takes the bottom 40-50%). The hook also
  // returns a maxHeight so the dropdown stays scrollable inside the
  // visible viewport instead of clipping the top items.
  const { direction, maxHeight } = useDropdownPlacement(inputRef, showDropdown);

  const onInput = (e) => {
    const v = e.target.value;
    onChange(v);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!v || v.trim().length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        // Geographic bias — if we have the user's coords (captured from
        // navigator.geolocation after sign-in, see App effect), pass them so
        // results near them rank first. e.g. typing "Berlin" in Brandenburg
        // surfaces Berlin, Germany; in New Hampshire surfaces Berlin, NH.
        // location_bias_scale=0.6 is a moderate bias (not exclusive), and
        // zoom=10 corresponds to roughly a city-region focus area.
        let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(v)}&limit=5&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village&osm_tag=place:suburb&osm_tag=place:hamlet`;
        if (typeof biasLat === "number" && typeof biasLng === "number") {
          url += `&lat=${biasLat}&lon=${biasLng}&location_bias_scale=0.6&zoom=10`;
        }
        const r = await fetch(url);
        const data = await r.json();
        const items = (data?.features || []).map((f) => {
          const p = f.properties || {};
          const coords = f.geometry?.coordinates || []; // [lng, lat]
          return {
            label: formatCityLabel(p),
            value: p.name,
            lat: coords[1] ?? null,
            lng: coords[0] ?? null,
          };
        });
        setSuggestions(items);
      } catch (err) {
        console.error("city autocomplete failed", err);
      }
    }, 280);
  };

  const pick = (item) => {
    onChange(item.value || item.label);
    if (onPick) onPick(item);
    setSuggestions([]);
    setOpen(false);
  };

  const hasBias = typeof biasLat === "number" && typeof biasLng === "number";

  return (
    <div className="relative" data-testid="city-autocomplete">
      <input
        ref={inputRef}
        autoFocus
        className="n2m-input"
        placeholder="Start typing your city…"
        value={value}
        onChange={onInput}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          // Mobile-keyboard Enter behavior: prefer the top suggestion if the
          // autocomplete dropdown is open & has results, otherwise hand off
          // to the parent (advances the onboarding step).
          if (open && suggestions.length > 0) {
            pick(suggestions[0]);
          } else if (onEnter) {
            onEnter();
          }
        }}
        enterKeyHint="next"
        data-testid="onboarding-city-input"
      />
      {hasBias && (
        <p
          className="mt-1.5 text-[10px] text-white/45 flex items-center gap-1"
          data-testid="city-autocomplete-bias-hint"
        >
          <MapPin size={10} className="text-[#00E5FF]" /> Sorted by closest to you
        </p>
      )}
      {showDropdown && (
        <div
          className={`absolute z-30 left-0 right-0 rounded-2xl border border-white/10 bg-[#0c0c10] overflow-y-auto shadow-2xl ${
            direction === "up" ? "bottom-full mb-2" : "top-full mt-2"
          }`}
          style={{ maxHeight: `${maxHeight}px` }}
          data-testid={`city-autocomplete-dropdown-${direction}`}
        >
          {suggestions.map((s, i) => (
            <button
              key={`${s.label}-${i}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              className="w-full text-left px-4 py-3 hover:bg-white/8 active:bg-white/10 border-b border-white/5 last:border-none"
              data-testid={`city-suggestion-${i}`}
            >
              <div className="font-semibold text-sm">{s.value}</div>
              <div className="text-xs text-white/45 truncate">{s.label}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
