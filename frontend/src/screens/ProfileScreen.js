import React, { useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Globe, LogOut, MapPin, Video as VideoIcon } from "lucide-react";
import { api } from "../lib/api";
import { LANG_OPTIONS } from "../lib/constants";
import { AvatarThumb } from "../components/AvatarThumb";
import { BottomNav } from "../components/BottomNav";
import { CityAutocomplete } from "../components/CityAutocomplete";
import { ShareCard } from "../components/ShareCard";
import { VideoEl } from "../components/VideoEl";
import { SAFETY_CONTACT_URL } from "../legal/LegalPages";
import { track } from "../analytics";

export function ProfileScreen({ user, setUser, unreadMatches, onTab, onLogout, onChangeVideo }) {
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState(user.first_name || "");
  const [city, setCity] = useState(user.city || "");
  const [cityCoords, setCityCoords] = useState(null);
  const [age, setAge] = useState(user.age ? String(user.age) : "");
  const [language, setLanguage] = useState(user.language || "en");
  const [saving, setSaving] = useState(false);

  const ageNum = parseInt(age, 10);
  const canSave =
    firstName.trim().length >= 1 &&
    city.trim().length >= 2 &&
    !isNaN(ageNum) && ageNum >= 13 && ageNum <= 120;

  const save = async () => {
    if (!canSave) { toast.error("Check name, city, and age (13+)"); return; }
    setSaving(true);
    try {
      const { data } = await api.post("/users/onboarding", {
        first_name: firstName.trim(),
        city: city.trim(),
        age: ageNum,
        language,
        city_lat: cityCoords?.lat ?? null,
        city_lng: cityCoords?.lng ?? null,
      });
      setUser(data.user);
      setEditing(false);
      toast.success("Saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save");
    } finally { setSaving(false); }
  };

  // Mobile keyboards bury the Save button under the keyboard — let Enter
  // submit the form from any of the text inputs, same shortcut as onboarding.
  const onEnterSave = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!saving && canSave) save();
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col bg-black overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="profile-screen"
    >
      {user.video_url ? (
        <VideoEl src={user.video_url} autoPlay loop muted playsInline className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a0a0a] to-[#0a0a1a]" />
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-black/90 pointer-events-none" />

      <div className="relative z-10 flex-1 flex flex-col px-6 pt-12 pb-36 overflow-y-auto no-scrollbar">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-3xl font-black">You.</h2>
          <button className="text-white/60 text-sm font-bold uppercase tracking-widest" onClick={() => setEditing((v) => !v)} data-testid="profile-edit-toggle">
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>

        <div className="mt-auto glass-dark rounded-3xl p-5 mt-8">
          <div className="flex items-center gap-3">
            <AvatarThumb videoUrl={user.video_url} fallback={user.codename || user.handle} className="w-14 h-14 rounded-2xl" />
            <div>
              <div className="text-xs uppercase tracking-widest font-bold text-white/50">codename · {user.codename}</div>
              <div className="font-display text-xl font-black">@{user.handle}</div>
            </div>
          </div>

          {!editing ? (
            <>
              <div className="mt-4 text-sm text-white/80">
                <span className="font-bold text-white">{user.first_name}</span>
                {user.age ? <span className="text-white/60"> · {user.age}</span> : null}
              </div>
              <div className="mt-1 text-xs text-white/60 flex items-center gap-1.5">
                <MapPin size={12} /> {user.city || "Somewhere on Earth"}
              </div>
              <div className="mt-1 text-xs text-white/60 flex items-center gap-1.5">
                <Globe size={12} /> Native: {LANG_OPTIONS.find((l) => l.code === user.language)?.name || user.language}
              </div>

              <ShareCard user={user} />

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button className="btn-ghost text-sm" onClick={onChangeVideo} data-testid="profile-change-video">
                  <VideoIcon size={14} className="inline mr-1" /> Change intro
                </button>
                <button className="btn-ghost text-sm" onClick={onLogout} data-testid="profile-logout">
                  <LogOut size={14} className="inline mr-1" /> Log out
                </button>
              </div>

              <div className="mt-4 pt-4 border-t border-white/8 flex flex-col gap-2 text-xs text-white/55">
                <div className="flex gap-3 justify-center">
                  <a href="/privacy" className="hover:text-white underline" data-testid="profile-privacy-link">Privacy</a>
                  <span className="text-white/20">·</span>
                  <a href="/terms" className="hover:text-white underline" data-testid="profile-terms-link">Terms</a>
                  <span className="text-white/20">·</span>
                  <a href={SAFETY_CONTACT_URL} target="_blank" rel="noopener noreferrer" className="hover:text-white underline" data-testid="profile-safety-link">Report safety</a>
                </div>
                <button
                  className="text-white/70 hover:text-white text-xs underline mt-1"
                  onClick={async () => {
                    // GDPR Art. 20 — give the user a full JSON dump.
                    try {
                      track("data_export_requested");
                      const { data } = await api.get("/users/me/export");
                      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `nice2meechu-data-${data.exported_for_user_id}-${data.exported_at.slice(0, 10)}.json`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                      toast.success("Your data was downloaded");
                    } catch (err) {
                      console.error(err);
                      toast.error("Couldn't export — please submit our privacy form instead");
                    }
                  }}
                  data-testid="profile-data-export"
                >
                  Download my data
                </button>
                <button
                  className="text-[#FF4D4D]/80 hover:text-[#FF4D4D] text-xs underline mt-1"
                  onClick={async () => {
                    const ok = window.confirm(
                      "Delete your account? This permanently removes your profile, intro video, matches, and chat messages. This cannot be undone."
                    );
                    if (!ok) return;
                    try {
                      await api.delete("/users/me");
                      toast.success("Account deleted");
                      localStorage.removeItem("n2m_token");
                      setTimeout(() => { window.location.href = "/"; }, 500);
                    } catch (e) {
                      toast.error("Couldn't delete account — please submit our privacy form instead");
                    }
                  }}
                  data-testid="profile-delete-account"
                >
                  Delete my account
                </button>
              </div>
            </>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">First name</p>
                <input
                  className="n2m-input"
                  value={firstName}
                  maxLength={40}
                  onChange={(e) => setFirstName(e.target.value)}
                  onKeyDown={onEnterSave}
                  enterKeyHint="done"
                  data-testid="profile-firstname-input"
                />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">City</p>
                <CityAutocomplete
                  value={city}
                  onChange={(v) => { setCity(v); setCityCoords(null); }}
                  onPick={(item) => { setCity(item.value || ""); setCityCoords({ lat: item.lat, lng: item.lng }); }}
                  biasLat={user.city_lat || user.lat}
                  biasLng={user.city_lng || user.lng}
                  onEnter={() => { if (!saving && canSave) save(); }}
                />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">Age</p>
                <input
                  className="n2m-input"
                  inputMode="numeric"
                  value={age}
                  maxLength={3}
                  onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={onEnterSave}
                  enterKeyHint="done"
                  data-testid="profile-age-input"
                />
              </div>
              <select
                className="n2m-input"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                data-testid="profile-lang-select"
              >
                {LANG_OPTIONS.map((l) => <option key={l.code} value={l.code} className="bg-black">{l.name}</option>)}
              </select>
              <button className="btn-primary" onClick={save} disabled={saving || !canSave} data-testid="profile-save">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      </div>

      <BottomNav active="profile" onTab={onTab} userPicture={user?.picture} unreadCount={unreadMatches} />
    </motion.div>
  );
}
