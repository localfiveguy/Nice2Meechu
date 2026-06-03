/* eslint-disable react/no-unescaped-entities */
import React from "react";

// ---------------------------------------------------------------------------
// Privacy Policy + Terms of Service — DRAFT v1, 2026-06-03.
//
// ⚠️  IMPORTANT: These pages are a starting point drafted by Nice2Meechu's
// engineering team and HAVE NOT been reviewed by an attorney. They are
// published in good faith to give users the disclosures required by GDPR,
// CCPA, LGPD, and similar privacy regimes, but you should retain qualified
// counsel in your jurisdiction before relying on them for legal protection.
// ---------------------------------------------------------------------------

const Shell = ({ title, children, onBack }) => (
  <div className="min-h-screen bg-black text-white" data-testid={`legal-${title.toLowerCase().replace(/\s+/g, "-")}`}>
    <div className="max-w-2xl mx-auto px-6 py-10">
      <button
        onClick={onBack}
        className="text-white/60 hover:text-white text-sm font-bold uppercase tracking-widest mb-6"
        data-testid="legal-back"
      >
        ← Back
      </button>
      <h1 className="font-display text-4xl font-black mb-2">{title}<span className="text-[#FF4D4D]">.</span></h1>
      <p className="text-xs text-white/40 uppercase tracking-widest mb-8">Effective Jun 3, 2026 · Draft v1</p>
      <div className="prose prose-invert text-white/85 text-sm leading-relaxed space-y-4">{children}</div>
      <div className="mt-12 text-xs text-white/40 border-t border-white/10 pt-6">
        Contact: <a className="text-[#00E5FF] underline" href="mailto:privacy@nice2meechu.com">privacy@nice2meechu.com</a>
      </div>
    </div>
  </div>
);

const H2 = ({ children }) => <h2 className="font-display text-xl font-black mt-8 mb-2 text-white">{children}</h2>;
const P = ({ children }) => <p className="text-white/80">{children}</p>;
const UL = ({ children }) => <ul className="list-disc pl-5 text-white/80 space-y-1">{children}</ul>;

export function PrivacyPolicyPage({ onBack }) {
  return (
    <Shell title="Privacy" onBack={onBack}>
      <P>This Privacy Policy explains what personal data Nice2Meechu ("we", "us", "the Service") collects, why, how long we keep it, who we share it with, and the rights you have. It applies worldwide. If you are in the EEA/UK, Brazil, California, or another jurisdiction with extra rights, those are listed below.</P>

      <H2>1. Data we collect</H2>
      <UL>
        <li><b>Account & profile:</b> email address, Google account ID, name, profile picture URL (from Google OAuth); first name, codename, age, city, language, vibes, avatar emoji.</li>
        <li><b>Location:</b> the city you choose plus optional approximate latitude/longitude derived from your IP, browser geolocation, or the map preview.</li>
        <li><b>Content you create:</b> recorded intro video, transcript, chat messages, swipe actions, signature image, community-rules acceptance.</li>
        <li><b>Biometric data (special category):</b> a single still frame extracted from your intro video is sent to OpenAI's content-safety vision model to verify there is a single human face and no prohibited content. The image is not stored after the check.</li>
        <li><b>Device & log:</b> IP address, user agent, timestamps of requests, cookies.</li>
        <li><b>Analytics:</b> Google Analytics 4 events (page views, key actions) — only if you accept the cookie banner.</li>
      </UL>

      <H2>2. Why we use it (lawful bases)</H2>
      <UL>
        <li>To run the Service (GDPR Art. 6(1)(b) — contract).</li>
        <li>To keep users safe via AI face-check and human review of reports (Art. 6(1)(f) — legitimate interests; Art. 9(2)(a) — explicit consent for biometric processing, given via the Community Rules screen).</li>
        <li>To comply with legal obligations such as responding to law-enforcement requests, CSAM reporting, and DSA notices (Art. 6(1)(c)).</li>
        <li>To improve the Service via aggregated analytics (Art. 6(1)(a) — consent).</li>
      </UL>

      <H2>3. Who we share data with (subprocessors)</H2>
      <UL>
        <li>Google (OAuth sign-in, Analytics)</li>
        <li>OpenAI (content-safety face check, live translation, demo-video generation)</li>
        <li>Komoot / OpenStreetMap (geocoding via Photon)</li>
        <li>Cloudflare (CDN & DNS)</li>
        <li>MongoDB Atlas (managed database)</li>
        <li>Emergent (hosting & platform)</li>
      </UL>
      <P>We do not sell personal data. We do not transfer data to advertisers.</P>

      <H2>4. International transfers</H2>
      <P>Some subprocessors are located in the United States. Where required by law, we rely on Standard Contractual Clauses or equivalent transfer mechanisms.</P>

      <H2>5. Retention</H2>
      <UL>
        <li>Account, profile, videos, messages: kept until you delete your account.</li>
        <li>Reports & moderation logs: kept up to 2 years after creation.</li>
        <li>Analytics events: GA4 default (up to 14 months) unless you withdraw consent.</li>
      </UL>

      <H2>6. Your rights</H2>
      <UL>
        <li><b>Access</b> — request a copy of your data (write to <a className="text-[#00E5FF] underline" href="mailto:privacy@nice2meechu.com">privacy@nice2meechu.com</a>).</li>
        <li><b>Erasure</b> — tap "Delete my account" inside the app; we wipe your profile, videos, messages, matches and sessions immediately.</li>
        <li><b>Rectification</b> — edit your profile any time.</li>
        <li><b>Portability</b> — request a JSON export of your data.</li>
        <li><b>Withdraw consent</b> — clear cookies / revoke the analytics consent any time.</li>
        <li><b>Lodge a complaint</b> with your local supervisory authority (e.g., your country's data-protection regulator).</li>
      </UL>

      <H2>7. Children</H2>
      <P>The Service is not for users under 13. Users between 13 and 17 must have a parent/guardian's permission where required by local law. We rely on self-declared age at signup and may take additional verification steps. If we learn we have collected data from a child under 13, we delete it.</P>

      <H2>8. AI disclosure</H2>
      <P>Some intro videos and profiles in the feed are AI-generated personas created with OpenAI Sora 2, clearly labelled "AI demo" on the card. They exist to seed the experience and may auto-match with you. They do not represent real people.</P>

      <H2>9. Safety & illegal content</H2>
      <P>To report suspected child sexual abuse material (CSAM), terrorism, immediate harm, or any DSA-actionable content, email <a className="text-[#00E5FF] underline" href="mailto:safety@nice2meechu.com">safety@nice2meechu.com</a> or use the in-app Report button.</P>

      <H2>10. Changes</H2>
      <P>We will notify you in-app and via the email on file before material changes take effect.</P>
    </Shell>
  );
}

export function TermsOfServicePage({ onBack }) {
  return (
    <Shell title="Terms" onBack={onBack}>
      <H2>1. Eligibility</H2>
      <P>You must be at least 13 years old (16 in the EEA where required by national law) and have a real Google account to use the Service. Dating-specific features may require you to be 18+.</P>

      <H2>2. Your conduct</H2>
      <P>By using Nice2Meechu you agree to the Community Rules you accepted on signup, which prohibit impersonation, harassment, hate, sexual or violent content, spam, scams, and any unlawful behaviour.</P>

      <H2>3. Content</H2>
      <P>You keep ownership of the intro video and chat messages you create. You grant us a worldwide, royalty-free license to store and display that content as needed to operate the Service. We may remove content that violates these Terms or applicable law without notice.</P>

      <H2>4. AI-generated demo profiles</H2>
      <P>Some profiles in your feed are clearly-labelled AI-generated demo personas. Their messages, when auto-replied, are AI-generated and not from a human.</P>

      <H2>5. Safety reports & DSA</H2>
      <P>We provide an in-app Report button and an email channel for notice-and-action requests under the EU Digital Services Act. We log every action and reason and may share moderation outcomes with the affected user.</P>

      <H2>6. Termination</H2>
      <P>You can delete your account inside the app at any time. We may suspend or terminate accounts that violate these Terms or the Community Rules.</P>

      <H2>7. Disclaimers</H2>
      <P>The Service is provided "as is". We do not promise the AI face-check or translation is error-free. To the maximum extent allowed by law we disclaim all implied warranties.</P>

      <H2>8. Limitation of liability</H2>
      <P>To the maximum extent allowed by law, our aggregate liability is limited to the amount you paid us in the prior twelve months (USD 0 for free users) or USD 100, whichever is greater. Nothing limits liability for gross negligence, wilful misconduct, or rights that cannot be waived by law.</P>

      <H2>9. Governing law & disputes</H2>
      <P>These Terms are governed by the laws of the State of Delaware, USA, without regard to conflict-of-laws principles. Mandatory consumer-protection rights in your country of residence remain unaffected. Disputes will be resolved in the state or federal courts of Delaware unless local law gives you the right to sue in your home jurisdiction.</P>

      <H2>10. Contact</H2>
      <P>Questions? <a className="text-[#00E5FF] underline" href="mailto:hello@nice2meechu.com">hello@nice2meechu.com</a></P>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Cookie consent banner — GDPR/UK PECR style. Defaults to "no analytics"
// until the user clicks Accept. The banner reads/writes localStorage so we
// don't re-prompt on every visit.
// ---------------------------------------------------------------------------
const CONSENT_KEY = "n2m_cookie_consent_v1";

export function getCookieConsent() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CONSENT_KEY);
}

export function CookieConsentBanner({ onChange }) {
  const [decided, setDecided] = React.useState(() => {
    if (typeof window === "undefined") return true;
    return !!localStorage.getItem(CONSENT_KEY);
  });
  if (decided) return null;
  const decide = (value) => {
    try { localStorage.setItem(CONSENT_KEY, value); } catch { /* ignore */ }
    setDecided(true);
    onChange?.(value);
  };
  return (
    <div
      className="fixed inset-x-3 bottom-3 z-[100] glass-dark rounded-2xl border border-white/12 shadow-2xl p-4 max-w-md mx-auto sm:left-auto sm:right-3 sm:bottom-3 sm:max-w-sm"
      role="dialog"
      aria-label="Cookie consent"
      data-testid="cookie-banner"
    >
      <div className="text-sm font-bold mb-1">🍪 Cookies</div>
      <p className="text-xs text-white/70 leading-snug">
        We use cookies that are essential to sign you in. With your permission we also load
        Google Analytics so we can improve the app. You can change your mind any time.
        <a
          href="/privacy"
          className="underline text-[#00E5FF] ml-1"
          onClick={(e) => { e.preventDefault(); onChange?.("__view_privacy"); }}
        >Learn more</a>.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          className="flex-1 btn-ghost text-xs"
          onClick={() => decide("rejected")}
          data-testid="cookie-reject"
        >Reject non-essential</button>
        <button
          className="flex-1 btn-primary text-xs py-2"
          onClick={() => decide("accepted")}
          data-testid="cookie-accept"
        >Accept</button>
      </div>
    </div>
  );
}
