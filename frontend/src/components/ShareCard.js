import React, { useState } from "react";
import { toast } from "sonner";
import { Sparkles, Share2, Copy, Check } from "lucide-react";
import { copyToClipboard, shareOrCopy } from "../lib/api";
import { track } from "../analytics";

export function ShareCard({ user }) {
  const [copied, setCopied] = useState(false);
  const handle = user.handle || user.codename?.toLowerCase().replace(/\s+/g, ".");
  const shareUrl = `${window.location.origin}/?ref=${encodeURIComponent(handle)}`;
  const shareText = `${user.codename} just invited you to Nice2Meechu — video-first, hyperlocal, anonymous until the spark.`;

  const onShare = async () => {
    const result = await shareOrCopy({
      title: "Nice2Meechu", text: shareText, url: shareUrl, copyText: shareUrl,
    });
    if (result === "shared") {
      track("share_started", { method: "web_share_api" });
    } else if (result === "copied") {
      track("share_started", { method: "clipboard_fallback" });
      setCopied(true);
      toast.success("Invite link copied");
      setTimeout(() => setCopied(false), 1800);
    } else {
      toast.error("Couldn't share — copy from the link below");
    }
  };

  const onCopy = async () => {
    const ok = await copyToClipboard(shareUrl);
    if (ok) {
      track("referral_link_copied");
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1800);
    } else {
      toast.error("Couldn't copy");
    }
  };

  const referralCount = user.referral_count || 0;

  return (
    <div className="mt-5 rounded-3xl overflow-hidden border border-white/10" data-testid="profile-share-card">
      {/* Preview strip */}
      <div className="relative px-5 py-4 flex items-center gap-3" style={{ background: "linear-gradient(135deg, rgba(255,77,77,0.18), rgba(0,229,255,0.12))" }}>
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-black/40 text-2xl">{user.avatar_emoji}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest font-bold text-white/55">your invite card</div>
          <div className="font-display font-black text-lg leading-tight truncate">{user.codename}</div>
          {referralCount > 0 && (
            <div className="text-[10px] text-[#00E5FF] font-bold uppercase tracking-widest mt-0.5">
              +{referralCount} friend{referralCount > 1 ? "s" : ""} joined
            </div>
          )}
        </div>
        <Sparkles size={20} className="text-[#FF4D4D]" />
      </div>
      {/* Actions */}
      <div className="bg-black/40 px-4 py-3 flex gap-2">
        <button
          className="btn-primary flex-1 flex items-center justify-center gap-2 text-sm py-3"
          onClick={onShare}
          data-testid="profile-share-button"
        >
          <Share2 size={16} /> Share invite
        </button>
        <button
          className="px-4 rounded-full bg-white/8 text-white border border-white/10 active:scale-95 transition"
          onClick={onCopy}
          data-testid="profile-copy-link-button"
          aria-label="Copy invite link"
        >
          {copied ? <Check size={16} className="text-[#00E5FF]" /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
}
