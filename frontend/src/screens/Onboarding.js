import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, MapPin } from "lucide-react";
import { api } from "../lib/api";
import { stripCityNoise } from "../lib/cityFormat";
import { CityAutocomplete } from "../components/CityAutocomplete";
import { track } from "../analytics";

export function Onboarding({ user, onDone }) {
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState(user.first_name || "");
  const [city, setCity] = useState(user.city || "");
  const [cityCoords, setCityCoords] = useState(null); // {lat, lng} when picked from autocomplete
  const [autoCityTried, setAutoCityTried] = useState(false);
  const [autoCityLoading, setAutoCityLoading] = useState(false);
  const [age, setAge] = useState(user.age ? String(user.age) : "");
  const [loading, setLoading] = useState(false);

  // Try to auto-fill the city from the user's geolocation when they land on
  // the city step. Reverse-geocodes lat/lng → "City, Country" via Photon
  // (same provider as autocomplete, no extra dep). Only fires:
  //   - on first visit to step 1
  //   - if the city field is empty (don't overwrite a manual entry)
  //   - if we have user.lat/lng from the App-level geolocation grab
  // Best-effort: any failure is silent, the user can still type it.
  useEffect(() => {
    if (step !== 1 || autoCityTried || city.trim().length > 0) return;
    const lat = user.lat;
    const lng = user.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return;
    setAutoCityTried(true);
    setAutoCityLoading(true);
    (async () => {
      try {
        const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`);
        const j = await r.json();
        const p = j?.features?.[0]?.properties;
        if (!p) return;
        // Photon's nearest feature for a coord is usually a building/POI —
        // pick the human-readable place fields we know exist: city / town /
        // village fallback chain. Country gets appended so the user sees the
        // full disambiguated label, matching what autocomplete returns.
        const placeName = stripCityNoise(p.city || p.town || p.village || p.county || p.name);
        const country = p.country;
        if (!placeName) return;
        const label = country ? `${placeName}, ${country}` : placeName;
        setCity(label);
        setCityCoords({ lat, lng });
        track("onboarding_city_auto_filled", { source: "reverse_geocode" });
      } catch {
        // network / parse failure — silently fall back to manual typing
      } finally {
        setAutoCityLoading(false);
      }
    })();
  }, [step, autoCityTried, city, user.lat, user.lng]);

  const total = 3;
  const next = () => setStep((s) => Math.min(total - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
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
          <p className="text-xs uppercase tracking-widest font-bold text-[#FF4D4D] mb-2">City</p>
          <CityAutocomplete
            value={city}
            onChange={(v) => { setCity(v); setCityCoords(null); }}
            onPick={(item) => { setCity(item.value || ""); setCityCoords({ lat: item.lat, lng: item.lng }); }}
            biasLat={user.lat}
            biasLng={user.lng}
            onEnter={() => { if (canNext) next(); }}
          />
          {autoCityLoading && (
            <p className="mt-2 text-[11px] text-white/45 flex items-center gap-1" data-testid="onboarding-city-detecting">
              <MapPin size={11} className="text-white/45 animate-pulse" /> Detecting your city…
            </p>
          )}
          {!autoCityLoading && autoCityTried && cityCoords && (
            <p className="mt-2 text-[11px] text-white/55 flex items-center gap-1" data-testid="onboarding-city-detected">
              <MapPin size={11} className="text-[#00E5FF]" /> Detected from your location — change if wrong
            </p>
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

      <div className="mt-auto flex gap-3 pt-6">
        {step > 0 && (
          <button className="btn-ghost" onClick={back} data-testid="onboarding-back">
            <ArrowLeft size={18} />
          </button>
        )}
        {step < total - 1 ? (
          <button
            className="btn-primary flex-1 flex items-center justify-center gap-2"
            disabled={!canNext}
            onClick={next}
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
