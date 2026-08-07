import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, MapPin } from "lucide-react";
import { api } from "../lib/api";
import { formatCityLabel, stripCityNoise } from "../lib/cityFormat";
import { CityAutocomplete } from "../components/CityAutocomplete";
import { track } from "../analytics";

export function Onboarding({ user, onDone }) {
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState(user.first_name || "");
  const [city, setCity] = useState(user.city || "");
  const [cityCoords, setCityCoords] = useState(null); // {lat, lng} when picked from autocomplete
  const [autoCityTried, setAutoCityTried] = useState(false);
  const [autoCityLoading, setAutoCityLoading] = useState(false);
  const [gpsTown, setGpsTown] = useState(null); // short town name from device location
  const [gpsLabel, setGpsLabel] = useState(null); // full "Town, State, Country" label
  const [mismatchPrompt, setMismatchPrompt] = useState(false);
  const [mismatchChecked, setMismatchChecked] = useState(false);
  const [age, setAge] = useState(user.age ? String(user.age) : "");
  const [loading, setLoading] = useState(false);

  // Reverse-geocode the user's device location when they land on the city
  // step (Photon, same provider as autocomplete). Two jobs:
  //   1. pre-fill the field when it's empty
  //   2. remember the GPS town so we can confirm "Is X your home town?" if
  //      what they type doesn't match where they actually are (John-from-
  //      Erial picked Marlton — this check stops that mistake).
  // Best-effort: any failure is silent, the user can still type it.
  useEffect(() => {
    if (step !== 1 || autoCityTried) return;
    const lat = user.lat;
    const lng = user.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return;
    setAutoCityTried(true);
    const fieldWasEmpty = city.trim().length === 0;
    if (fieldWasEmpty) setAutoCityLoading(true);
    (async () => {
      try {
        const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`);
        const j = await r.json();
        const p = j?.features?.[0]?.properties;
        if (!p) return;
        // Photon's nearest feature for a coord is usually a building/POI —
        // pick the human-readable place fields we know exist: city / town /
        // village fallback chain.
        const placeName = stripCityNoise(p.city || p.town || p.village || p.county || p.name);
        if (!placeName) return;
        const label = formatCityLabel({ ...p, name: placeName });
        setGpsTown(placeName);
        setGpsLabel(label);
        if (fieldWasEmpty) {
          setCity(label);
          setCityCoords({ lat, lng });
          track("onboarding_city_auto_filled", { source: "reverse_geocode" });
        }
      } catch {
        // SAST: intentional — reverse-geocode is a best-effort pre-fill;
        // network / parse failure silently falls back to manual typing.
      } finally {
        setAutoCityLoading(false);
      }
    })();
  }, [step, autoCityTried, city, user.lat, user.lng]);

  const total = 3;
  const next = () => setStep((s) => Math.min(total - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  // "Is X your home town?" gate: fires once when leaving the city step if the
  // typed town doesn't match where the device actually is.
  const townOf = (label) => stripCityNoise((label || "").split(",")[0]).trim().toLowerCase();
  const typedTown = stripCityNoise((city || "").split(",")[0]).trim();
  const cityContinue = () => {
    if (!mismatchChecked && gpsTown && townOf(city) && townOf(city) !== gpsTown.toLowerCase()) {
      setMismatchChecked(true);
      setMismatchPrompt(true);
      track("onboarding_hometown_mismatch_shown", { typed: typedTown, gps: gpsTown });
      return;
    }
    setMismatchPrompt(false);
    next();
  };
  const useGpsTown = () => {
    setCity(gpsLabel);
    setCityCoords({ lat: user.lat, lng: user.lng });
    setMismatchPrompt(false);
    track("onboarding_hometown_mismatch_used_gps");
    next();
  };
  const keepTypedTown = () => {
    setMismatchPrompt(false);
    track("onboarding_hometown_mismatch_kept_typed");
    next();
  };
  const ageNum = parseInt(age, 10);
  const canNext =
    (step === 0 && firstName.trim().length >= 1) ||
    (step === 1 && city.trim().length >= 2) ||
    (step === 2 && !isNaN(ageNum) && ageNum >= 13 && ageNum <= 120);

  // detect browser language for auto-translation
  const browserLang = (typeof navigator !== "undefined" && navigator.language?.slice(0, 2)) || "en";

  const submit = async () => {
    setLoading(true);
    try {
      const { data } = await api.post("/users/onboarding", {
        first_name: firstName.trim(),
        city: city.trim(),
        age: ageNum,
        language: browserLang,
        city_lat: cityCoords?.lat ?? null,
        city_lng: cityCoords?.lng ?? null,
      });
      track("onboarding_completed", { age: ageNum, language: browserLang, has_city_coords: !!cityCoords });
      toast.success(`Hey ${data.user.first_name} ✨`);
      onDone(data.user);
    } catch (e) {
      track("onboarding_failed");
      toast.error(e?.response?.data?.detail || "Couldn't save profile");
    } finally {
      setLoading(false);
    }
  };

  // Mobile keyboards bury the Continue button under the keyboard, so users
  // reach for the Enter key instead. Wire it up: Enter on any input runs the
  // same action as tapping Continue — next step on 0/1, submit on 2.
  const onEnterSubmit = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!canNext) return;
    if (step < total - 1) next();
    else if (!loading) submit();
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col px-7 pt-10 pb-8 bg-grain"
      initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      data-testid="onboarding-screen"
    >
      <div className="flex gap-1.5 mb-6">
        {Array.from({ length: total }).map((_, i) => (
          <div key={`progress-${i}`} className="flex-1 h-1 rounded-full bg-white/8" data-testid={`onboarding-progress-${i}`}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: i <= step ? "100%" : "0%", background: "linear-gradient(90deg,#FF4D4D,#00E5FF)" }}
            />
          </div>
        ))}
      </div>

      <div>
        <h2 className="font-display text-3xl font-black leading-tight">Create your<br/>profile<span style={{ color: "#FF4D4D" }}>.</span></h2>
        <p className="mt-3 text-sm text-white/55">Just the basics. Your name stays hidden until you match.</p>
      </div>

      {step === 0 && (
        <div className="mt-8">
          <p className="text-xs uppercase tracking-widest font-bold text-[#FF4D4D] mb-2">First name</p>
          <input
            autoFocus
            className="n2m-input"
            placeholder="e.g. Steven"
            value={firstName}
            maxLength={40}
            onChange={(e) => setFirstName(e.target.value)}
            onKeyDown={onEnterSubmit}
            enterKeyHint="next"
            data-testid="onboarding-name-input"
          />
        </div>
      )}

      {step === 1 && (
        <div className="mt-8">
          <p className="text-xs uppercase tracking-widest font-bold text-[#FF4D4D] mb-2">Home town</p>
          <p className="text-xs text-white/45 mb-3">Where you actually live — your intro video shows to people in this town.</p>
          <CityAutocomplete
            value={city}
            onChange={(v) => { setCity(v); setCityCoords(null); setMismatchPrompt(false); }}
            onPick={(item) => { setCity(item.value || ""); setCityCoords({ lat: item.lat, lng: item.lng }); }}
            biasLat={user.lat}
            biasLng={user.lng}
            onEnter={() => { if (canNext) cityContinue(); }}
          />
          {autoCityLoading && (
            <p className="mt-2 text-[11px] text-white/45 flex items-center gap-1" data-testid="onboarding-city-detecting">
              <MapPin size={11} className="text-white/45 animate-pulse" /> Detecting your city…
            </p>
          )}
          {!autoCityLoading && autoCityTried && cityCoords && !mismatchPrompt && (
            <p className="mt-2 text-[11px] text-white/55 flex items-center gap-1" data-testid="onboarding-city-detected">
              <MapPin size={11} className="text-[#00E5FF]" /> Detected from your location — change if wrong
            </p>
          )}
          {mismatchPrompt && (
            <div className="mt-4 rounded-2xl border border-[#00E5FF]/30 bg-[#08181b] p-4 relative z-40" data-testid="hometown-confirm-card">
              <p className="text-sm font-bold flex items-center gap-1.5">
                <MapPin size={14} className="text-[#00E5FF]" /> Is {gpsTown} your home town?
              </p>
              <p className="mt-1.5 text-xs text-white/60">
                Your location says you're in <span className="text-white/90 font-semibold">{gpsTown}</span>, but
                you picked <span className="text-white/90 font-semibold">{typedTown}</span>. Your video appears
                to people in your home town — pick where you really live.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                <button className="btn-primary py-2.5 text-sm" onClick={useGpsTown} data-testid="hometown-use-gps">
                  Yes — use {gpsTown}
                </button>
                <button className="btn-ghost py-2.5 text-sm" onClick={keepTypedTown} data-testid="hometown-keep-typed">
                  No — keep {typedTown}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="mt-8">
          <p className="text-xs uppercase tracking-widest font-bold text-[#FF4D4D] mb-2">Age</p>
          <input
            autoFocus
            className="n2m-input"
            inputMode="numeric"
            placeholder="18+"
            value={age}
            maxLength={3}
            onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))}
            onKeyDown={onEnterSubmit}
            enterKeyHint="done"
            data-testid="onboarding-age-input"
          />
          <p className="mt-3 text-xs text-white/40">You must be at least 13 to use Nice2Meechu.</p>
        </div>
      )}

      <div className="mt-auto flex gap-3 pt-6 relative z-40">
        {step > 0 && (
          <button className="btn-ghost" onClick={back} data-testid="onboarding-back">
            <ArrowLeft size={18} />
          </button>
        )}
        {step < total - 1 ? (
          <button
            className="btn-primary flex-1 flex items-center justify-center gap-2"
            disabled={!canNext}
            onClick={step === 1 ? cityContinue : next}
            data-testid="onboarding-next"
          >
            Continue <ArrowRight size={18} />
          </button>
        ) : (
          <button
            className="btn-primary flex-1 flex items-center justify-center gap-2"
            disabled={!canNext || loading}
            onClick={submit}
            data-testid="onboarding-finish"
          >
            {loading ? "Saving…" : (<>Continue <ArrowRight size={18} /></>)}
          </button>
        )}
      </div>
    </motion.div>
  );
}
