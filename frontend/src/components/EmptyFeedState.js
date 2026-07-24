import React from "react";
import { toast } from "sonner";
import { MapPin, Share2 } from "lucide-react";
import { shareOrCopy } from "../lib/api";
import { track } from "../analytics";

// Feed empty state: "pick a city" / "you're first here" / "you've seen everyone",
// plus the notify-me retention action.
export function EmptyFeedState({ user, cityStats, onOpenLocation, onRefresh }) {
  if (!user.city) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center gap-4">
        <div className="text-5xl" aria-hidden>📍</div>
        <div className="font-display text-2xl font-black leading-tight">Pick a city to begin</div>
        <p className="text-sm text-white/60 max-w-[280px] leading-snug">
          Tell us where to look and we'll show you the people nearby.
        </p>
        <button className="btn-primary mt-2 flex items-center gap-2" onClick={onOpenLocation} data-testid="feed-change-location">
          <MapPin size={16} /> Set my city
        </button>
      </div>
    );
  }

  const cityShort = user.city.split(",")[0];
  const exhausted = cityStats && cityStats.total > 0;

  const share = async () => {
    const shareText = "Come meet the world at Nice2meechu.com";
    track("first_in_city_share_clicked", { city: cityShort });
    const result = await shareOrCopy({ title: "Nice2Meechu", text: shareText, copyText: shareText });
    if (result === "copied") toast.success("Invite copied — paste it anywhere!");
    else if (result === "failed") toast.error("Couldn't share. Try copying manually.");
  };

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center gap-4">
      {exhausted ? (
        <>
          <div className="text-6xl" aria-hidden>🏁</div>
          <div className="font-display text-2xl font-black leading-tight">
            That's everyone<br />in {cityShort}!
          </div>
          <p className="text-sm text-white/65 max-w-[290px] leading-snug">
            You've seen all {cityStats.total} {cityStats.total === 1 ? "person" : "people"} here for now.
            New intros will appear as people join. Try another city while you wait.
          </p>
        </>
      ) : (
        <>
          <div className="text-6xl" aria-hidden>🎉</div>
          <div className="font-display text-2xl font-black leading-tight">
            You're the first<br />in {cityShort}!
          </div>
          <p className="text-sm text-white/65 max-w-[290px] leading-snug">
            Congrats — your intro will be the very first face people see when they explore this city.
            Share Nice2Meechu with friends nearby, or hop to a busier city while you wait.
          </p>
        </>
      )}

      <button
        className="btn-primary mt-2 flex items-center gap-2"
        onClick={onOpenLocation}
        data-testid="feed-change-location"
      >
        <MapPin size={16} /> Explore another city
      </button>
      {!exhausted && (
        <button className="btn-ghost flex items-center gap-2 mt-1" onClick={share} data-testid="feed-first-share">
          <Share2 size={16} /> Share this app
        </button>
      )}
      <button className="text-xs text-white/45 underline" onClick={onRefresh} data-testid="feed-refresh">
        Check again
      </button>
    </div>
  );
}
