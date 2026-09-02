# Android Capacitor App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a signed Android APK that bundles the XiaoChu React UI, connects to a configurable HTTPS cloud server, stores authentication safely, and uses native camera, speech recognition, and speech synthesis.

**Architecture:** Capacitor 8 wraps a dedicated mobile Vite build without service-worker registration. A runtime adapter chooses same-origin cookie auth in browsers and configurable base-URL bearer auth on Android. Small Kotlin plugins bridge Android Keystore, SpeechRecognizer, and TextToSpeech; the official Camera plugin supplies fridge images.

**Tech Stack:** Capacitor 8, Android API 36, Kotlin, Gradle, React 19, Vite 8, Android Keystore, Vitest

---

### Task 1: Add Capacitor and a mobile-specific web build

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Create: `apps/web/capacitor.config.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/main.tsx`
- Create: `apps/web/src/mobile.tsx`
- Create: `apps/web/src/lib/runtime-platform.ts`
- Create: `apps/web/src/lib/runtime-platform.test.ts`

- [ ] **Step 1: Write runtime detection tests**

Test web/native detection through one injected adapter and assert native builds never register the PWA service worker.

- [ ] **Step 2: Install pinned Capacitor packages**

Install matching 8.x versions of `@capacitor/core`, `@capacitor/android`, `@capacitor/cli`, `@capacitor/camera`, `@capacitor/network`, and `@capacitor/splash-screen`.

- [ ] **Step 3: Configure the app**

Use app ID `com.xiaochu.cooking`, app name `小厨`, webDir `dist-mobile`, bundled scheme `https`, min SDK 24, target/compile SDK 36. Add `build:mobile` that runs TypeScript and Vite mobile mode without the PWA plugin.

- [ ] **Step 4: Run builds and commit**

Run: `npm run build -w @xiaochu/web && npm run build:mobile -w @xiaochu/web`

```powershell
git add apps/web package-lock.json
git commit -m "feat: add Capacitor mobile build"
```

### Task 2: Add configurable HTTPS server and native token storage

**Files:**
- Create: `apps/web/src/features/server/ServerSettingsPage.tsx`
- Create: `apps/web/src/features/server/server-address.ts`
- Create: `apps/web/src/features/server/server-address.test.ts`
- Create: `apps/web/src/lib/auth-token-store.ts`
- Create: `apps/web/src/lib/auth-token-store.test.ts`
- Modify: `apps/web/src/lib/api-client.ts`
- Modify: `apps/web/src/features/auth/AuthProvider.tsx`
- Modify: `apps/web/src/app/router.tsx`

- [ ] **Step 1: Write RED tests**

Test HTTPS IPv4/domain normalization, HTTP/userinfo/path/query rejection, health timeout, Android bearer injection, refresh rotation, 401 logout, web same-origin cookies, and absence of auth tokens from localStorage.

- [ ] **Step 2: Implement address handling**

Accept only origin URLs with `https:`, a valid IP or DNS hostname, and no username, password, non-root path, query, or fragment. Persist the normalized origin through the secure-store plugin and expose test/save/reset before login.

- [ ] **Step 3: Adapt the API client**

Resolve `/api` paths against the saved native origin only on Android. Add bearer access, one serialized refresh attempt, no automatic retry of mutations after ambiguous failures, and preserve same-origin cookie/CSRF behavior for web.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run src/features/server/server-address.test.ts src/lib/auth-token-store.test.ts src/lib/api-client.test.ts`

```powershell
git add apps/web/src
git commit -m "feat: connect Android to configurable cloud server"
```

### Task 3: Generate Android and implement secure storage

**Files:**
- Create: `apps/web/android/**`
- Create: `apps/web/android/app/src/main/java/com/xiaochu/cooking/SecureStorePlugin.kt`
- Create: `apps/web/android/app/src/androidTest/java/com/xiaochu/cooking/SecureStorePluginTest.kt`
- Create: `apps/web/src/native/secure-store.ts`
- Modify: `apps/web/android/app/src/main/java/com/xiaochu/cooking/MainActivity.kt`
- Modify: `apps/web/android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Generate and pin platform files**

Run `npx cap add android` from `apps/web`, set target/compile SDK 36 and min SDK 24, and commit the Gradle wrapper and Android project.

- [ ] **Step 2: Implement secure storage**

Create Android Keystore AES/GCM key alias `xiaochu-auth-v1`; encrypt server origin and refresh token with independent nonces; store ciphertext in app-private SharedPreferences; expose `get`, `set`, `remove`, and `clearAuth`. Never return the encryption key.

- [ ] **Step 3: Register and test**

Register the plugin in `MainActivity`. Add instrumentation tests for round trip, tamper rejection, logout removal, and Activity recreation persistence.

- [ ] **Step 4: Sync and compile**

```powershell
npm run build:mobile -w @xiaochu/web
npx cap sync android
Set-Location apps/web/android
.\gradlew.bat assembleDebug
```

Expected: debug APK is produced.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/android apps/web/src/native
git commit -m "feat: add Android secure runtime"
```

### Task 4: Integrate native camera and network state

**Files:**
- Modify: `apps/web/src/features/inventory/ImageInput.tsx`
- Create: `apps/web/src/features/inventory/native-image-source.ts`
- Create: `apps/web/src/features/inventory/native-image-source.test.ts`
- Create: `apps/web/src/features/network/NetworkNotice.tsx`
- Modify: `apps/web/src/app/AppShell.tsx`
- Modify: `apps/web/android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Write adapter tests**

Test camera capture, photo picker fallback, cancellation, permission denial, conversion to upload `Blob`, 10 MiB rejection, offline notice, and no broad storage permission.

- [ ] **Step 2: Implement native adapters**

Use `@capacitor/camera` with camera prompt and photo-library fallback. Use `@capacitor/network` for connectivity state. Keep the file input for browsers and return the upload contract expected by the vision API.

- [ ] **Step 3: Configure permissions**

Declare only `INTERNET`, `CAMERA`, and `RECORD_AUDIO`. Do not declare location, contacts, SMS, phone, background microphone, `MANAGE_EXTERNAL_STORAGE`, or legacy broad storage permissions.

- [ ] **Step 4: Test, compile, and commit**

Run: `npm test -w @xiaochu/web && npm run build:mobile -w @xiaochu/web && .\apps\web\android\gradlew.bat -p apps/web/android assembleDebug`

```powershell
git add apps/web/src apps/web/android/app/src/main/AndroidManifest.xml
git commit -m "feat: add Android camera and network handling"
```

### Task 5: Add native speech recognition and synthesis

**Files:**
- Create: `apps/web/android/app/src/main/java/com/xiaochu/cooking/SpeechAssistantPlugin.kt`
- Create: `apps/web/android/app/src/androidTest/java/com/xiaochu/cooking/SpeechAssistantPluginTest.kt`
- Create: `apps/web/src/native/speech-assistant.ts`
- Modify: `apps/web/src/features/assistant/speech-recognition.ts`
- Modify: `apps/web/src/features/assistant/speech-synthesis.ts`
- Modify: `apps/web/src/features/assistant/AssistantPage.tsx`
- Modify: `apps/web/android/app/src/main/java/com/xiaochu/cooking/MainActivity.kt`

- [ ] **Step 1: Write web adapter tests**

Test start/result/end/error, permission denial, missing recognizer, TTS speak/stop, user interruption, Activity pause cleanup, and browser fallback.

- [ ] **Step 2: Implement the Kotlin plugin**

Wrap Android `SpeechRecognizer` for one-shot `zh-CN` recognition and `TextToSpeech` for Chinese output. Expose `isAvailable`, `startListening`, `cancelListening`, `speak`, and `stopSpeaking`; emit partial/final/error events; destroy recognizer and TTS on teardown. Never listen in the background.

- [ ] **Step 3: Wire the assistant**

Select the native adapter only under Capacitor. Preserve “tap to speak, stream answer, read answer, interrupt” and text fallback.

- [ ] **Step 4: Test, compile, and commit**

Run: `npm test -w @xiaochu/web && npm run build:mobile -w @xiaochu/web && .\apps\web\android\gradlew.bat -p apps/web/android assembleDebug`

```powershell
git add apps/web/src apps/web/android/app/src
git commit -m "feat: add Android voice assistant bridge"
```

### Task 6: Add resources, signing, and build artifacts

**Files:**
- Create: `apps/web/resources/icon.png`
- Create: `apps/web/resources/splash.png`
- Modify: `apps/web/android/app/src/main/res/**`
- Create: `apps/web/android/keystore.properties.example`
- Modify: `apps/web/android/app/build.gradle`
- Modify: `.gitignore`
- Create: `scripts/build-android.ps1`
- Create: `scripts/android-checksum.ps1`

- [ ] **Step 1: Generate Android resources**

Use the existing XiaoChu mark for adaptive foreground/background icons, launcher icons, and splash resources. Verify square and round masks do not clip the mark.

- [ ] **Step 2: Configure signing safely**

Load release keystore path, alias, store password, and key password from untracked `keystore.properties` or environment variables; fail release builds when missing. Ignore `.jks`, `.keystore`, `keystore.properties`, and release outputs.

- [ ] **Step 3: Add deterministic build script**

`build-android.ps1` verifies Node 24 and Android SDK/API 36, builds mobile web, runs `cap sync`, assembles debug/release, copies APK/AAB to `artifacts/android`, and writes SHA-256 sidecars. It never creates or prints signing passwords.

- [ ] **Step 4: Build debug and commit**

Run: `powershell -File scripts/build-android.ps1 -Configuration Debug`

Expected: debug APK and SHA-256 under `artifacts/android`.

```powershell
git add apps/web/resources apps/web/android scripts/build-android.ps1 scripts/android-checksum.ps1 .gitignore
git commit -m "feat: package signed Android builds"
```

### Task 7: Verify a real device and document distribution

**Files:**
- Create: `docs/operations/android-build-and-test.md`
- Modify: `docs/acceptance/manual-smoke.md`
- Modify: `README.md`

- [ ] **Step 1: Document toolchain and signing**

Document Android Studio 2025.2.1+, API 36 SDK, USB debugging, release-key creation and two offline backups, server address entry, APK installation, checksum comparison, and same-signature upgrades.

- [ ] **Step 2: Run repository verification**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run build:mobile -w @xiaochu/web`

- [ ] **Step 3: Run physical-device smoke**

Install with `adb install -r`, configure HTTPS IP, register via invitation, log in, search/open/favorite a recipe, photograph inventory, edit shopping, ask AI by text and voice, interrupt TTS, relaunch and confirm session persistence, deny/regrant camera and microphone, and verify account isolation.

- [ ] **Step 4: Produce release APK/AAB**

Run: `powershell -File scripts/build-android.ps1 -Configuration Release`

Expected: release APK, release AAB, and SHA-256 sidecars. Do not commit binaries or signing materials.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md docs/operations/android-build-and-test.md docs/acceptance/manual-smoke.md
git commit -m "docs: add Android build and test runbook"
```
