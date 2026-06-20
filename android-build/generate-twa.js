// Programmatic TWA project generator for Nice2Meechu using @bubblewrap/core.
// Skips interactive prompts and writes a fully-formed Android Studio project
// + twa-manifest.json into /app/android-build/twa-project.
const fs = require('fs');
const path = require('path');
const { TwaGenerator, TwaManifest, ConsoleLog } = require('@bubblewrap/core');

(async () => {
  const targetDir = path.resolve(__dirname, 'twa-project');
  fs.mkdirSync(targetDir, { recursive: true });

  // Use the locally-generated 512x512 icon as the source. Bubblewrap will
  // resize it into all required Android densities + adaptive icon layers.
  // We expose it via the file:// URL — TwaGenerator uses node-fetch which
  // supports file://.
  const iconUrl = 'http://127.0.0.1:9123/icon-512.png';
  const maskableUrl = 'http://127.0.0.1:9123/icon-maskable-512.png';

  const data = {
    packageId: 'com.nice2meechu.app',
    host: 'nice2meechu.com',
    name: 'Nice2Meechu',
    launcherName: 'Nice2Meechu',
    display: 'standalone',
    themeColor: '#000000',
    themeColorDark: '#000000',
    navigationColor: '#000000',
    navigationColorDark: '#000000',
    navigationDividerColor: '#000000',
    navigationDividerColorDark: '#000000',
    backgroundColor: '#000000',
    enableNotifications: false,
    startUrl: '/',
    iconUrl,
    maskableIconUrl: maskableUrl,
    splashScreenFadeOutDuration: 300,
    signingKey: {
      path: path.resolve(targetDir, 'android.keystore'),
      alias: 'android',
    },
    appVersion: '1.0.0',
    appVersionCode: 1,
    shortcuts: [],
    generatorApp: 'bubblewrap-cli',
    webManifestUrl: 'http://127.0.0.1:9123/manifest.json',
    fallbackType: 'customtabs',
    features: {},
    alphaDependencies: { enabled: false },
    enableSiteSettingsShortcut: true,
    isChromeOSOnly: false,
    isMetaQuest: false,
    orientation: 'default',
    fingerprints: [],
    minSdkVersion: 23,
  };

  const twaManifest = new TwaManifest(data);
  // Persist twa-manifest.json so `bubblewrap build` can be re-run later.
  await twaManifest.saveToFile(path.join(targetDir, 'twa-manifest.json'));

  const log = new ConsoleLog('twa');
  const generator = new TwaGenerator();
  await generator.createTwaProject(targetDir, twaManifest, log);
  console.log('TWA project generated at', targetDir);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
