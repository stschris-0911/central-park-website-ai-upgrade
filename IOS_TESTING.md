# iOS App Testing Guide

This zip is a source-code package, not a directly installable iPhone app.

## Option 1: Test on a Mac with Xcode Simulator

Requirements:

- macOS
- Xcode installed from the Mac App Store
- Node.js 22 or newer
- Python 3.10 or newer, only if running the backend locally

Steps:

```bash
unzip central-park-website-ai-upgrade-fixed.zip
cd central-park-website-ai-upgrade
cd frontend
npm install
npm run build
npx cap sync ios
open ios/App/App.xcodeproj
```

In Xcode:

1. Select an iPhone Simulator.
2. Press Run.
3. Test search, map tap start point, route, bottom drag panels, and voice navigation.

The current production build uses:

```bash
VITE_API_BASE_URL=https://central-park-website-ai-upgrade.onrender.com/api
```

Vision Test can also override this at runtime from the app, so you do not need
to rebuild every time your Mac backend URL changes.

## If Testing With A Local Backend

Start the backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

For iOS Simulator, set this before building:

```bash
cd frontend
echo "VITE_API_BASE=http://127.0.0.1:8000/api" > .env.production
npm run build
npx cap sync ios
open ios/App/App.xcodeproj
```

For a real iPhone using the local backend, replace `127.0.0.1` with the Mac's local network IP address, for example:

```bash
VITE_API_BASE_URL=http://192.168.1.23:8000/api
```

## If Testing Away From The Mac Wi-Fi

The iPhone cannot reach `127.0.0.1` or `192.168.x.x` when it is away from the
same network. To keep the backend on your Mac and test from anywhere, expose the
Mac backend through a temporary HTTPS tunnel.

Start the backend on the Mac:

```bash
./scripts/start_home_vision_backend.sh
```

Start a Cloudflare Tunnel in a second terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

Copy the generated `https://...trycloudflare.com` URL. In the app, open
**More** → **Vision Test**, paste that URL into **Backend URL**, then tap
**Save** and **Test**. Vision requests will use the saved tunnel URL from
localStorage and fall back to `VITE_API_BASE_URL` when reset.

For testing from any network, keep both Mac terminal windows open, keep the Mac
awake, and keep the tunnel URL active. A quick Cloudflare Tunnel URL can change
after restart; use a named tunnel or reserved domain when you need a stable URL.

## Option 2: Share With Non-Developer Testers

Use TestFlight.

Requirements:

- Apple Developer Program account
- App Store Connect access
- A public HTTPS backend API

Steps:

1. Open `frontend/ios/App/App.xcodeproj` in Xcode.
2. Set your Apple developer team under Signing & Capabilities.
3. Select Any iOS Device.
4. Choose Product > Archive.
5. In Organizer, choose Distribute App.
6. Upload to App Store Connect.
7. Add testers in TestFlight.

Testers then install Apple's TestFlight app and open the invite link.

## Important Notes

- You cannot simply send an `.ipa` to anyone and expect it to install. iOS apps must be signed.
- Simulator testing is easiest for developers.
- TestFlight is best for real iPhone testers.
- Real-device location and voice navigation require location permission and audio enabled.
