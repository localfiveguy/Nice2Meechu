import React from "react";
import { Heart, User as UserIcon, Video as VideoIcon } from "lucide-react";

export function BottomNav({ active, onTab, userPicture, unreadCount = 0 }) {
  const hasUnread = unreadCount > 0;
  const Item = ({ id, icon: Icon, label }) => {
    const isYouTabWithPic = id === "profile" && userPicture;
    const showDotHere = id === "profile" && hasUnread;
    return (
      <button
        onClick={() => onTab(id)}
        className="flex flex-col items-center gap-1 flex-1 py-2"
        data-testid={`nav-${id}`}
      >
        <div className="relative">
          {isYouTabWithPic ? (
            // Google profile picture as the "You" tab affordance — ringed when active.
            // referrerPolicy avoids Google CDN blocking the request from our origin.
            <img
              src={userPicture}
              alt=""
              referrerPolicy="no-referrer"
              data-testid="nav-profile-avatar"
              className={`w-[26px] h-[26px] rounded-full object-cover ${
                active === id ? "ring-2 ring-[#FF4D4D] ring-offset-2 ring-offset-black" : "opacity-70"
              }`}
            />
          ) : (
            <Icon size={22} color={active === id ? "#FF4D4D" : "rgba(255,255,255,0.6)"} fill={active === id && id === "feed" ? "#FF4D4D" : "transparent"} />
          )}
          {showDotHere && (
            <span
              data-testid="nav-profile-unread-dot"
              aria-label={`${unreadCount} new match${unreadCount === 1 ? "" : "es"}`}
              className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#22C55E] ring-2 ring-black animate-pulse"
            />
          )}
        </div>
        <span className={`text-[10px] uppercase tracking-widest font-bold ${active === id ? "text-white" : "text-white/45"}`}>{label}</span>
      </button>
    );
  };
  return (
    <div className="absolute bottom-0 left-0 right-0 z-40 glass-dark border-t border-white/8 flex pb-10 pt-1 px-4" data-testid="bottom-nav">
      <Item id="feed" icon={VideoIcon} label="Feed" />
      <Item id="matches" icon={Heart} label="Matches" />
      <Item id="profile" icon={UserIcon} label="You" />
    </div>
  );
}
