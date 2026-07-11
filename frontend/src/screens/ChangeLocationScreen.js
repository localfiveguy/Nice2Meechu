import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ArrowRight, MapPin, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";
import { dedupeCitySuggestions, formatCityLabel, stripCityNoise } from "../lib/cityFormat";
import { useDropdownPlacement } from "../lib/useDropdownDirection";
import { track } from "../analytics";

export function ChangeLocationScreen({ user, onClose, onChanged }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [popular, setPopular] = useState([]);
  const [center, setCenter] = useState({
    lat: user.city_lat || user.lat || 40.7128,
    lng: user.city_lng || user.lng || -74.0060,
    label: user.city || "Drop a pin",
  });
  const [busy, setBusy] = useState(null); // "geo" | "save" | "tap" | null
  // When ticked, the next pick ALSO moves the user's HOME city — where their
  // video appears to others. Unticked (default) = just browse another city.
  const [setAsHome, setSetAsHome] = useState(false);
  // Nearby-radius preference (10/25/50 km) — persisted immediately on tap.
  const [radius, setRadius] = useState(user.nearby_radius_km || 25);
  const [radiusDirty, setRadiusDirty] = useState(false);
  const [freshUser, setFreshUser] = useState(null);

  const pickRadius = async (km) => {
    if (km === radius) return;
    const prev = radius;
    setRadius(km);
    try {
      await api.post("/users/nearby-radius", { radius_km: km });
      const { data } = await api.get("/auth/me");
      setFreshUser(data.user);
      setRadiusDirty(true);
      track("nearby_radius_changed", { km });
      toast.success(`Nearby radius set to ${km} km`);
    } catch {
      setRadius(prev);
      toast.error("Couldn't update radius");
    }
  };

  // If only the radius changed, closing should still refresh the feed —
  // route through onChanged so the parent reloads with the new radius.
  const handleClose = () => {
    if (radiusDirty) onChanged(freshUser || user);
    else onClose();
  };
  const debounceRef = useRef(null);
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const heatLayerRef = useRef(null);
  // Leaflet's click handler is registered once — read busy through a ref so
  // the guard never goes stale.
  const busyRef = useRef(null);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const searchInputRef = useRef(null);
  const dropdownRef = useRef(null);
  const hasSuggestions = suggestions.length > 0;
  // Flip suggestions above the input on mobile when the keyboard would
  // otherwise cover them — the modal's header pins the input near the top
  // but on phones the keyboard pushes the viewport down so room-below
  // shrinks quickly. We also cap the dropdown height so it stays scrollable
  // inside the visible viewport.
  const { direction: dropDirection, maxHeight: dropMaxHeight } = useDropdownPlacement(searchInputRef, hasSuggestions);

  // Compute viewport-fixed coords for the dropdown. We can't use simple
  // `position: absolute` here because the input lives inside an
  // `overflow-y-auto` scroll container — an absolute child rendered above
  // (with `bottom-full`) gets clipped by the scroll container's overflow
  // box and becomes invisible. Position: fixed escapes that boundary entirely.
  const [dropdownStyle, setDropdownStyle] = useState({ display: "none" });
  useLayoutEffect(() => {
    if (!hasSuggestions || !searchInputRef.current) {
      setDropdownStyle({ display: "none" });
      return undefined;
    }
    const recompute = () => {
      const el = searchInputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const style = {
        position: "fixed",
        left: rect.left,
        width: rect.width,
        maxHeight: dropMaxHeight,
        zIndex: 60,
      };
      if (dropDirection === "up") style.bottom = window.innerHeight - rect.top + 4;
      else style.top = rect.bottom + 4;
      setDropdownStyle(style);
    };
    recompute();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", recompute);
    vv?.addEventListener("scroll", recompute);
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      vv?.removeEventListener("resize", recompute);
      vv?.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [hasSuggestions, dropDirection, dropMaxHeight, suggestions]);

  // When the dropdown opens upward, the best-match suggestion is rendered at
  // the BOTTOM (reversed below). If content overflows maxHeight, default
  // scroll position would clip the best match. Force-scroll to bottom so the
  // top-ranked match (closest to the input) is always visible.
  useLayoutEffect(() => {
    if (hasSuggestions && dropDirection === "up" && dropdownRef.current) {
      dropdownRef.current.scrollTop = dropdownRef.current.scrollHeight;
    }
  }, [hasSuggestions, dropDirection, suggestions, dropMaxHeight, dropdownStyle]);

  // Load popular cities once on mount
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/cities/popular");
        if (alive) setPopular(data.cities || []);
      } catch {
        if (alive) setPopular([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Debounced Photon city search
  const onQueryChange = (v) => {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.trim().length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        // Use the same broad OSM-tag set as the Onboarding CityAutocomplete
        // — `&layer=city` alone misses townships like "Voorhees Township"
        // and suburbs that don't carry the `place:city` tag, so the dropdown
        // would silently return zero results for partially-typed queries
        // and look "broken" to the user. Towns / villages / suburbs / hamlets
        // are all valid Nice2Meechu locales (we're hyperlocal, not metro-only).
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(v)}&limit=6&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village&osm_tag=place:suburb&osm_tag=place:hamlet`;
        const r = await fetch(url);
        const j = await r.json();
        const items = (j.features || []).map((f) => {
          const p = f.properties || {};
          return {
            value: formatCityLabel(p),                  // noise-stripped via helper
            city: stripCityNoise(p.name),               // saved name should be clean
            name: p.name,
            state: p.state,
            country: p.country,
            country_code: (p.countrycode || "").toLowerCase(),
            lat: f.geometry.coordinates[1],
            lng: f.geometry.coordinates[0],
          };
        });
        // Collapse "Voorhees Township" + "Voorhees" into a single suggestion
        // so neighbors don't get sorted into different city buckets.
        setSuggestions(dedupeCitySuggestions(items));
      } catch (err) {
        // Surface the error in console so production-only failures (Photon
        // outage, CORS, network) can be diagnosed from devtools without
        // changing UI state — the dropdown just stays empty.
        console.warn("city autocomplete failed", err);
      }
    }, 220);
  };

  // Save the new location to backend, then notify parent to refresh feed
  const persist = async (lat, lng, cityLabel) => {
    setBusy("save");
    try {
      await api.post("/users/location", { lat, lng, city: cityLabel || null, set_home: setAsHome });
      const { data } = await api.get("/auth/me");
      track("location_changed", { city: cityLabel || "(coords only)", set_home: setAsHome });
      const place = (cityLabel || "this area").split(",")[0];
      toast.success(
        setAsHome && cityLabel
          ? `Home updated — your video now appears in ${place} 🏠`
          : `Now exploring ${cityLabel || "nearby"} ✨`
      );
      onChanged(data.user);
    } catch (e) {
      toast.error("Couldn't update location");
    } finally {
      setBusy(null);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      toast.error("Geolocation isn't available in this browser");
      return;
    }
    // Detect the iframe sandbox case (Emergent Preview, etc.) — geolocation
    // requires the parent <iframe> to set allow="geolocation" which most
    // preview shells don't. The production site at nice2meechu.com is
    // top-level, so the API works fine there.
    const inIframe = (() => {
      try { return window.self !== window.top; } catch { return true; }
    })();

    setBusy("geo");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        // Reverse-geocode via Photon
        let cityLabel = null;
        try {
          const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`);
          const j = await r.json();
          const f = j.features?.[0]?.properties;
          if (f) {
            // Photon reverse uses `city` for the place name (instead of `name`).
            const p = { ...f, name: f.city || f.name };
            cityLabel = formatCityLabel(p);
          }
        } catch (err) { console.warn("reverse geocode failed", err); }
        setCenter({ lat, lng, label: cityLabel || "Your location" });
        await persist(lat, lng, cityLabel);
      },
      (err) => {
        const code = err && err.code;
        let msg = "Couldn't access your location";
        if (code === 1) {
          // PERMISSION_DENIED — could be user-blocked OR iframe sandboxing
          msg = inIframe
            ? "Geolocation is blocked in the preview window. It works on nice2meechu.com — or enter a city, tap the map, or pick a popular city below."
            : "Location permission denied. Enter a city, tap the map, or pick a popular city below.";
        } else if (code === 2) {
          msg = "Location unavailable right now. Enter a city, tap the map, or pick a popular city below.";
        } else if (code === 3) {
          msg = "Locating timed out. Enter a city, tap the map, or pick a popular city below.";
        }
        toast.error(msg);
        setBusy(null);
      },
      { timeout: 8000, maximumAge: 60_000 }
    );
  };

  const pickSuggestion = (item) => {
    setCenter({ lat: item.lat, lng: item.lng, label: item.value });
    setSuggestions([]);
    setQuery(item.value);
    persist(item.lat, item.lng, item.value);
  };

  const pickPopular = (c) => {
    const label = `${c.city}${c.country ? ", " + c.country : ""}`;
    setCenter({ lat: c.lat, lng: c.lng, label });
    persist(c.lat, c.lng, label);
  };

  // Real interactive Leaflet map — drag to pan, pinch/scroll to zoom. A
  // deliberate TAP picks that spot (Leaflet never fires "click" after a drag
  // or pinch, so browsing the map can't accidentally switch your city).
  const handleMapPick = async (lat, lng) => {
    if (busyRef.current) return;
    setBusy("tap");
    let cityLabel = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    try {
      const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`);
      const j = await r.json();
      const f = j.features?.[0]?.properties;
      if (f) {
        const name = f.city || f.name || f.county || f.state || "";
        if (name) {
          const p = { ...f, name };
          cityLabel = formatCityLabel(p);
        }
      }
    } catch (err) { console.warn("map-tap reverse geocode failed", err); }
    setCenter({ lat, lng, label: cityLabel });
    track("location_map_tapped", { lat, lng });
    await persist(lat, lng, cityLabel);
  };

  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return undefined;
    const map = L.map(mapDivRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView([center.lat, center.lng], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    // circleMarker instead of the default image marker — Leaflet's icon PNGs
    // don't resolve under CRA bundling without extra config. interactive:false
    // — it's purely visual; otherwise it swallows clicks/hovers meant for the
    // heat dot underneath (e.g. the current city's own dot) and bubbles them
    // to the map handler.
    const marker = L.circleMarker([center.lat, center.lng], {
      radius: 9, color: "#ffffff", weight: 2, fillColor: "#FF4D4D", fillOpacity: 1,
      interactive: false,
    }).addTo(map);
    map.on("click", (e) => {
      // Defensive: never let the raw-coords picker steal a heat-dot tap.
      if (e.originalEvent?.target?.classList?.contains("heat-dot-core")) return;
      handleMapPick(e.latlng.lat, e.latlng.lng);
    });
    mapRef.current = map;
    markerRef.current = marker;
    // The modal spring-animates in; re-measure once it settles so tiles
    // cover the full container.
    const t = setTimeout(() => map.invalidateSize(), 400);
    return () => {
      clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the selected point when it changes (search pick, popular city,
  // geolocate, or map tap) — keep the user's current zoom level.
  useEffect(() => {
    if (!mapRef.current) return;
    markerRef.current?.setLatLng([center.lat, center.lng]);
    mapRef.current.setView([center.lat, center.lng]);
  }, [center.lat, center.lng]);

  // Heat-dots: every city that already has people with intros gets a glowing
  // cyan dot (sized by headcount) so the map doubles as a discovery tool.
  // Tapping a dot jumps straight to that city — same instant-switch UX as
  // tapping the map, but snapped to the city center.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    if (heatLayerRef.current) {
      heatLayerRef.current.remove();
      heatLayerRef.current = null;
    }
    const group = L.layerGroup();
    popular.forEach((c) => {
      if (!c.people || c.lat == null || c.lng == null || (c.lat === 0 && c.lng === 0)) return;
      const label = `${c.city}${c.country ? ", " + c.country : ""}`;
      const r = Math.min(16, 6 + 2 * Math.sqrt(c.people));
      const halo = L.circleMarker([c.lat, c.lng], {
        radius: r * 1.9, stroke: false, fillColor: "#00E5FF", fillOpacity: 0.14, interactive: false,
      });
      const core = L.circleMarker([c.lat, c.lng], {
        radius: r, color: "#00E5FF", weight: 1, opacity: 0.9,
        fillColor: "#00E5FF", fillOpacity: 0.5,
        bubblingMouseEvents: false, className: "heat-dot-core",
      });
      core.bindTooltip(`${c.city} · ${c.people} ${c.people === 1 ? "person" : "people"}`, {
        direction: "top", offset: [0, -8],
      });
      core.on("click", (e) => {
        if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        if (busyRef.current) return;
        setCenter({ lat: c.lat, lng: c.lng, label });
        track("location_heat_dot_tapped", { city: c.city });
        persist(c.lat, c.lng, label);
      });
      group.addLayer(halo);
      group.addLayer(core);
    });
    group.addTo(map);
    heatLayerRef.current = group;
    // Keep the red "you are exploring here" pin painted above the dots.
    markerRef.current?.bringToFront();
    return () => { group.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popular]);

  return (
    <motion.div
      className="absolute inset-0 z-50 bg-black flex flex-col"
      initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      data-testid="change-location-screen"
    >
      <div className="flex items-center justify-between px-6 pt-12 pb-3">
        <h2 className="font-display text-2xl font-black">
          Change location<span style={{ color: "#FF4D4D" }}>.</span>
        </h2>
        <button
          onClick={handleClose}
          className="text-white/60 hover:text-white p-2 -mr-2"
          aria-label="Close"
          data-testid="change-location-close"
        >
          <X size={22} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-6 pb-10 flex flex-col gap-4">
        {/* Search input */}
        <div className="relative">
          <input
            ref={searchInputRef}
            className="n2m-input pr-10"
            placeholder="Search a city…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              // Enter picks the top suggestion — saves a tap on mobile where
              // the keyboard hides the rest of the screen.
              if (suggestions.length > 0) pickSuggestion(suggestions[0]);
            }}
            enterKeyHint="go"
            data-testid="change-location-search-input"
            autoComplete="off"
          />
          <Sparkles size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
          {hasSuggestions && (
            <div
              ref={dropdownRef}
              className={`glass-dark rounded-2xl border border-white/10 overflow-y-auto shadow-2xl`}
              style={dropdownStyle}
              data-testid={`change-location-suggestions-${dropDirection}`}
            >
              {/* When opening upward, reverse the list so the top-ranked
                  suggestion sits at the BOTTOM — closest to the input the
                  user is typing in. Matches expected mobile/macOS autocomplete UX. */}
              {(dropDirection === "up" ? [...suggestions].reverse() : suggestions).map((s, i) => (
                <button
                  key={`${s.value}-${i}`}
                  onClick={() => pickSuggestion(s)}
                  className="w-full text-left px-4 py-2.5 hover:bg-white/8 flex items-center justify-between gap-2"
                  data-testid={`change-location-suggestion-${i}`}
                >
                  <span className="text-sm">{s.value}</span>
                  <MapPin size={12} className="text-white/40 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Home vs browsing: picking a place normally only changes what YOU
            watch. Ticking this also moves where YOUR video appears. */}
        <label
          className={`flex items-start gap-2.5 rounded-2xl px-3 py-2.5 border cursor-pointer select-none transition ${setAsHome ? "bg-[#FF4D4D]/10 border-[#FF4D4D]/40" : "bg-white/5 border-white/10"}`}
          data-testid="change-location-set-home"
        >
          <input
            type="checkbox"
            checked={setAsHome}
            onChange={(e) => setSetAsHome(e.target.checked)}
            className="mt-0.5 accent-[#FF4D4D] w-4 h-4 shrink-0"
            data-testid="change-location-set-home-checkbox"
          />
          <span className="text-xs leading-snug text-white/80">
            <span className="font-bold text-white">Set as my home city</span> — where your video appears to others. Off = just browse.
            <span className="block text-white/45 mt-0.5" data-testid="change-location-home-label">
              🏠 Current home: {(user.home_city || user.city || "not set").split(",")[0]}
            </span>
          </span>
        </label>

        {/* Nearby radius — how far around the browsing city the feed reaches */}
        <div
          className="flex items-center justify-between gap-2 rounded-2xl px-3 py-2.5 bg-white/5 border border-white/10"
          data-testid="change-location-radius"
        >
          <div className="min-w-0">
            <div className="text-xs font-bold text-white">Nearby radius</div>
            <div className="text-[10px] text-white/45 leading-snug">How far around a city the feed reaches</div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            {[10, 25, 50].map((km) => (
              <button
                key={km}
                type="button"
                onClick={() => pickRadius(km)}
                disabled={busy !== null}
                className={`px-2.5 py-1.5 rounded-full text-[11px] font-bold transition ${radius === km ? "bg-[#00E5FF]/20 text-[#00E5FF] ring-1 ring-[#00E5FF]/50" : "bg-white/8 text-white/60 hover:bg-white/15"}`}
                data-testid={`change-location-radius-${km}`}
                aria-pressed={radius === km}
              >
                {km} km
              </button>
            ))}
          </div>
        </div>

        {/* Use my current location */}
        <button
          onClick={useMyLocation}
          disabled={busy !== null}
          className="w-full flex items-center justify-center gap-2 rounded-2xl py-3 bg-gradient-to-r from-[#FF4D4D]/15 to-[#00E5FF]/10 border border-white/12 hover:border-white/25 transition disabled:opacity-50"
          data-testid="change-location-use-mine"
        >
          <span className="text-lg">📡</span>
          <span className="font-bold text-sm">
            {busy === "geo" ? "Locating…" : "Use my current location"}
          </span>
        </button>

        {/* Interactive map — drag to pan, pinch to zoom, tap to pick a spot */}
        <div className="rounded-2xl overflow-hidden border border-white/10 bg-white/5 flex-shrink-0">
          {/* z-0 creates a stacking context so Leaflet's internal z-indexes
              (panes go up to 1000) can't paint over the fixed search dropdown. */}
          <div className="relative z-0" style={{ height: 230 }}>
            <div
              ref={mapDivRef}
              className="absolute inset-0"
              style={{ cursor: busy ? "wait" : "crosshair" }}
              aria-label="Map — drag to pan, tap to pick a spot"
              data-testid="change-location-map"
            />
            <div className="absolute top-2 right-2 z-[500] glass-dark px-2 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold text-white/85 pointer-events-none flex items-center gap-1">
              <MapPin size={10} className="text-[#FF4D4D]" />
              <span>{busy === "tap" ? "Resolving…" : "Drag to move · tap to pick"}</span>
            </div>
          </div>
          <div className="px-3 py-2 flex items-center gap-1.5 text-xs text-white/70">
            <MapPin size={12} className="text-[#FF4D4D]" />
            <span className="truncate">{center.label}</span>
          </div>
        </div>

        {/* Popular cities */}
        <div className="mt-1">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-base">🔥</span>
              <h3 className="font-display text-base font-black">Popular cities</h3>
            </div>
            <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">tap to jump</span>
          </div>

          <div className="flex flex-col gap-2">
            {popular.length === 0 && (
              <div className="text-xs text-white/40 py-3">Loading hotspots…</div>
            )}
            {popular.map((c, i) => (
              <button
                key={`${c.city}-${c.country}-${i}`}
                onClick={() => pickPopular(c)}
                disabled={busy !== null || c.lat == null}
                className="flex items-center gap-3 rounded-2xl px-3 py-2.5 bg-white/5 hover:bg-white/10 active:scale-[0.99] transition text-left disabled:opacity-50"
                data-testid={`change-location-popular-${i}`}
              >
                <div className="text-2xl shrink-0">{c.flag}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-display text-base font-black truncate">{c.city}</div>
                  <div className="text-xs text-white/45 truncate">{c.country || "—"}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] uppercase tracking-widest font-bold px-2 py-1 rounded-full ${c.people > 0 ? "bg-[#FF4D4D]/20 text-white" : "bg-white/8 text-white/55"}`}>
                    {c.people === 1 ? "1 person" : `${c.people} people`}
                  </span>
                  <ArrowRight size={14} className="text-white/35" />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
