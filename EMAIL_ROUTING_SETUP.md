# Cloudflare Email Routing — `safety@` and `privacy@` Setup (5-minute checklist)

These mailboxes are referenced in our Privacy Policy, Terms, and in the
"Delete my account" error path — they MUST resolve to a real inbox you
read regularly. This is a DNS-only task; no code changes are involved.

## Prerequisites
- `nice2meechu.com` is on Cloudflare DNS (the nameservers point to Cloudflare).
- A primary inbox you actually read (e.g. `you@gmail.com`).

## Steps

1. **Cloudflare Dashboard** → pick the `nice2meechu.com` zone.
2. Left sidebar → **Email** → **Email Routing**.
3. Click **Get started** if you haven't already — Cloudflare adds 3 MX records and 1 TXT (SPF) record automatically. Confirm the changes.
4. **Destination addresses** tab → **Add destination address** → enter `you@gmail.com` (or your real address). Open the verification mail Cloudflare sends and click the link. Wait until the address shows ✓ Verified.
5. **Routing rules** tab → **Custom address** → **Create address**:
   - `safety` → forward to your verified address. Save.
   - `privacy` → forward to your verified address. Save.
6. (Optional but recommended) Under **Routing rules** → **Catch-all** → set "Catch-all address" to your verified inbox, so typos like `safty@…` still reach you.

## Verify
```bash
# From any machine:
dig +short MX nice2meechu.com   # should list 3 *.mx.cloudflare.net hosts
```

Then send a test email:
```
to: safety@nice2meechu.com
subject: routing test
body: any
```
You should receive it at your destination inbox within ~30 seconds.

## What's already wired up in the app
- `/app/frontend/src/legal/LegalPages.jsx` references `safety@nice2meechu.com` and `privacy@nice2meechu.com`.
- `/app/frontend/src/App.js` Profile screen has a "Report safety" link that opens `mailto:safety@nice2meechu.com`.
- Delete-account error toast points users to `privacy@nice2meechu.com`.
- "Download my data" error toast also points to `privacy@nice2meechu.com`.

Nothing else needs to change in code once routing is live.
