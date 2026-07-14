# Nice2Meechu — iOS App (App Store)

Native iOS wrapper for https://nice2meechu.com, based on the open-source
`ios-pwa-wrap` shell (same template PWABuilder uses). Configured for:

- Bundle ID: `com.nice2meechu.app`
- Team ID: `J99N4XLB3D`
- App name: `Nice2Meechu`
- Loads: `https://nice2meechu.com/` (auth popups allowed for appleid.apple.com + accounts.google.com)
- Camera/mic permissions declared (intro video recording works in-app)
- HealthKit removed; Firebase push stubbed with a placeholder plist (native push can be added later with a real `GoogleService-Info.plist`)

## How it gets built (no Mac needed)

Built in the cloud by **Codemagic** using `/codemagic.yaml` at the repo root.
Codemagic compiles, signs, and uploads the app to App Store Connect/TestFlight
automatically.

## One-time setup checklist (all from a browser)

1. **App Store Connect — create the app record**
   - appstoreconnect.apple.com → My Apps → ➕ → New App
   - Platform iOS · Name `Nice2Meechu` · Bundle ID `com.nice2meechu.app` · SKU `nice2meechu`
2. **App Store Connect — API key for Codemagic**
   - appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API → ➕
   - Name `codemagic`, Access `App Manager` → download the `.p8` file (only downloadable once!)
   - Note the **Issuer ID** and **Key ID** shown on that page
3. **Push this repo to GitHub** — use the "Save to GitHub" button in Emergent
4. **Codemagic — connect and build**
   - codemagic.io → sign up with GitHub → add this repository
   - Team settings → Integrations → **Developer Portal** → add the API key
     from step 2, name it exactly `nice2meechu-asc`
   - Start a build of the `ios-appstore` workflow → the signed app lands in
     TestFlight automatically
5. **Submit for review**
   - App Store Connect → your app → add screenshots (from an iPhone), description,
     privacy policy URL (https://nice2meechu.com/privacy), and pick the TestFlight
     build → Submit for Review

## Review notes Apple will care about

- Sign in with Apple is offered alongside Google ✔ (guideline 4.8)
- Camera/mic usage strings are set in `pwa-shell/Info.plist`
- Account deletion exists in-app (Settings → Delete account) ✔ (guideline 5.1.1(v))
- User-generated content: report/block features exist in-app ✔ (guideline 1.2)
