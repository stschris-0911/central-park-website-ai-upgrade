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
VITE_API_BASE=https://central-park-website-ai-upgrade.onrender.com/api
```

So testers do not need to run the backend if that deployed API is online.

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
VITE_API_BASE=http://192.168.1.23:8000/api
```

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
