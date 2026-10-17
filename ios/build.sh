#!/bin/bash
# Build / run the native iPad app.
#   ./build.sh            → build for iOS Simulator (no signing needed)
#   ./build.sh device     → build Release for device, unsigned, and package an .ipa
#   ./build.sh run        → boot an iPad simulator, install & launch (needs runtime)
#   ./build.sh regenerate → regenerate Storyboarder.xcodeproj from project.yml
set -euo pipefail
cd "$(dirname "$0")"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
XCODEBUILD="$DEVELOPER_DIR/usr/bin/xcodebuild"
DD="$PWD/../.build/DerivedData"
MODE="${1:-simulator}"

sync_web() {
  rsync -a --delete \
    --exclude 'ios' --exclude '.build' --exclude '.cert' --exclude '.git' \
    --exclude 'node_modules' --exclude '.DS_Store' \
    --exclude 'README.md' --exclude 'LICENSE' --exclude '*.command' \
    --exclude 'compare.png' --exclude 'install.png' --exclude 'preview.png' \
    "$PWD/../" "$PWD/Storyboarder/www/"
}

if [ "$MODE" != "regenerate" ]; then sync_web; fi

if [ "$MODE" = "regenerate" ]; then
  XG="${XCODEGEN:-$(command -v xcodegen || true)}"
  if [ -z "$XG" ]; then echo "xcodegen not found (brew install xcodegen)"; exit 1; fi
  "$XG" generate --spec project.yml
  exit 0
fi

if [ "$MODE" = "device" ]; then
  "$XCODEBUILD" -project Storyboarder.xcodeproj -scheme Storyboarder -configuration Release \
    -sdk iphoneos -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO build
  APP="$DD/Build/Products/Release-iphoneos/Storyboarder.app"
  OUT="$PWD/../.build/ipa"
  rm -rf "$OUT" && mkdir -p "$OUT/Payload" && cp -R "$APP" "$OUT/Payload/"
  (cd "$OUT" && zip -qry Storyboarder-unsigned.ipa Payload)
  echo "app:  $APP"
  echo "ipa:  $OUT/Storyboarder-unsigned.ipa   (unsigned — sideload with your own signing)"
  exit 0
fi

if [ "$MODE" = "run" ]; then
  "$XCODEBUILD" -project Storyboarder.xcodeproj -scheme Storyboarder -configuration Debug \
    -sdk iphonesimulator -derivedDataPath "$DD" build
  APP="$DD/Build/Products/Debug-iphonesimulator/Storyboarder.app"
  UDID=$(xcrun simctl list devices available | awk -F'[()]' '/iPad/ {print $2; exit}')
  if [ -z "$UDID" ]; then echo "no iPad simulator found"; exit 1; fi
  xcrun simctl boot "$UDID" 2>/dev/null || true
  open -a Simulator
  sleep 3
  xcrun simctl install "$UDID" "$APP"
  xcrun simctl launch "$UDID" com.sakuraentropia.storyboarder
  exit 0
fi

"$XCODEBUILD" -project Storyboarder.xcodeproj -scheme Storyboarder -configuration Debug \
  -sdk iphonesimulator -derivedDataPath "$DD" -destination 'generic/platform=iOS Simulator' build
echo "app: $DD/Build/Products/Debug-iphonesimulator/Storyboarder.app"
