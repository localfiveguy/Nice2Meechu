# Nice2Meechu — Android APK Build

This folder contains everything needed to (re)build a signed Android APK for
**Nice2Meechu**. The APK is a **Trusted Web Activity (TWA)** that wraps
`https://nice2meechu.com` and runs the live web app full-screen, using the
device's system Chrome engine — so Google Sign-in, camera, microphone and
geolocation all behave exactly like they do in the browser.

---

## Artifacts produced

| File | Purpose | Size |
| --- | --- | --- |
| `twa-project/app-release-signed.apk` | Sideload-ready signed APK | ~1.6 MB |
| `twa-project/app-release-bundle.aab` | Upload to Google Play Console | ~1.8 MB |
| `twa-project/android.keystore` | **KEEP SAFE** — needed for every future update | 2.7 KB |

The same APK and AAB are also copied to `/app/frontend/public/` so they are
downloadable from the deployed site:

* `https://nice2meechu.com/nice2meechu.apk`
* `https://nice2meechu.com/nice2meechu.aab`

---

## App identity

| Field | Value |
| --- | --- |
| Application name | Nice2Meechu |
| Package id | `com.nice2meechu.app` |
| Version | `1.0.0` (versionCode `1`) |
| Min SDK | 23 (Android 6.0+) |
| Signing keystore | `twa-project/android.keystore` |
| Keystore / key password | `nice2meechu` |
| Key alias | `android` |
| **SHA-256 fingerprint** | `02:65:F5:AC:B1:A9:BE:9C:D6:AE:D8:77:F8:6F:B9:79:DA:40:85:5D:67:3A:DF:F6:61:D7:F9:EC:1B:72:03:71` |

> ⚠️ Treat the keystore as a **production secret**. If lost, Google Play will
> refuse to accept updates with a new key (you'd have to publish a new
> package id, which means a fresh install for every user). Back it up.

---

## Full-screen TWA verification

For Android to remove the URL bar and run the app full-screen (instead of
falling back to a Chrome Custom Tab), the website must publish a
Digital Asset Links file that lists the APK's signing fingerprint.

The file is already committed at:

```
frontend/public/.well-known/assetlinks.json
```

After the next production deploy it will be live at:

```
https://nice2meechu.com/.well-known/assetlinks.json
```

You can verify in Chrome on Android with the Digital Asset Links tool, or in
Logcat with `adb logcat | grep OriginVerifier`.

Until the deploy lands, the APK still **works** — it just falls back to a
Custom Tab (a Chrome window with a slim URL bar at the top).

---

## Rebuilding the APK

```bash
# One-time host setup (already done in this pod):
apt-get install -y openjdk-17-jdk-headless qemu-user-static
dpkg --add-architecture amd64 && apt-get update
apt-get install -y libc6:amd64 libstdc++6:amd64 zlib1g:amd64

# Wrap the x86_64 Android build-tools binaries so they run under qemu on ARM64
# (only needed in this aarch64 pod; not needed on a normal x86_64 dev box).

cd /app/android-build/twa-project
export BUBBLEWRAP_KEYSTORE_PASSWORD=nice2meechu
export BUBBLEWRAP_KEY_PASSWORD=nice2meechu
printf 'n\nn\n' | npx --prefix /app/android-build bubblewrap build --skipPwaValidation
```

The build writes:

* `app-release-signed.apk`
* `app-release-bundle.aab`

To bump the version, edit `twa-project/twa-manifest.json` (`appVersion`,
`appVersionCode`) and re-run the build.

---

## Installing on a device for testing

1. Download `https://nice2meechu.com/nice2meechu.apk` on the Android phone.
2. The system will warn the APK is from an "unknown source" — tap "Allow"
   / "Install anyway". This is expected for any APK that isn't from the
   Play Store.
3. Once installed, the app icon appears as "Nice2Meechu".
4. First launch will briefly show a Chrome splash and then transition into
   the live site. Google Sign-in, camera, location all work natively.

---

## Publishing to Google Play

1. Create the app in Google Play Console using the package id
   `com.nice2meechu.app`.
2. Enable **Play App Signing** (recommended) and upload
   `app-release-bundle.aab`.
3. Google will provide the *App signing key SHA-256* — add that fingerprint
   to `assetlinks.json` **in addition** to the upload key fingerprint above.
4. Redeploy the website so the updated `assetlinks.json` is live before you
   roll out the production track.
