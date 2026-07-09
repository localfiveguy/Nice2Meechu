import React from "react";
import { Heart, Share2, User as UserIcon, Video as VideoIcon } from "lucide-react";
import { toast } from "sonner";
import { shareOrCopy } from "../lib/api";
import { track } from "../analytics";

export function BottomNav({ active, onTab, userPicture, unreadCount = 0, userHandle, referralCount = 0 }) {
  const hasUnread = unreadCount > 0;

  const handleShare = async () => {
    // Attribute the invite to the sharer: ?ref=<handle> is captured on the
    // landing page, survives the Google OAuth round-trip via localStorage,
    // and increments the sharer's referral_count on the friend's sign-up.
    const link = userHandle ? `${window.location.origin}/?ref=${userHandle}` : "https://nice2meechu.com";
    const shareText = "Come meet the world at Nice2Meechu 👋";
    track("share_app_button_tapped", { from: "bottom_nav", has_ref: !!userHandle });
    const result = await shareOrCopy({
      title: "Nice2Meechu",
      text: shareText,
      url: link,
      copyText: `${shareText} ${link}`,
    });
    if (result === "copied") toast.success("Invite link copied — friends who join count as yours!");
    else if (result === "failed") toast.error("Couldn't share — try the Profile screen");
  };

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
    <div className="absolute bottom-0 left-0 right-0 z-40 glass-dark border-t border-white/8 flex flex-col pb-10 pt-1 px-4" data-testid="bottom-nav">
      <div className="flex">
        <Item id="feed" icon={VideoIcon} label="Feed" />
        <Item id="matches" icon={Heart} label="Matches" />
        <Item id="profile" icon={UserIcon} label="You" />
      </div>
      {/* Persistent share-app affordance — positioned directly under the FEED
          tab (left third) so it visually anchors to a primary action. Empty
          spacer flex slots reserve the middle/right thirds and keep the share
          pill aligned with the tab above it regardless of screen width. */}
      <div className="mt-1 flex">
        <div className="flex-1 flex justify-center">
          <button
            type="button"
            onClick={handleShare}
            className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold text-white/65 hover:text-white border border-white/10 hover:border-white/25 active:scale-95 transition"
            data-testid="bottom-nav-share"
            aria-label="Share Nice2Meechu with a friend"
          >
            <Share2 size={11} className="text-[#FF4D4D]" />
            <span>Share this app</span>
            {referralCount > 0 && (
              <span
                data-testid="bottom-nav-referral-count"
                className="text-[#5BE6C8]"
                aria-label={`${referralCount} friend${referralCount === 1 ? "" : "s"} joined from your link`}
              >
                · {referralCount} joined
              </span>
            )}
          </button>
        </div>
        <div className="flex-1" aria-hidden />
        <div className="flex-1" aria-hidden />
      </div>
    </div>
  );
}
