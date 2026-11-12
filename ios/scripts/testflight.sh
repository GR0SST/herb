#!/bin/bash
# Archives Herb and uploads it to App Store Connect.
# Usage: ios/scripts/testflight.sh <build-number>
# Each upload needs a higher build number than the last one.
set -euo pipefail

BUILD_NUMBER="${1:?Usage: testflight.sh <build-number>}"
IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="${HERB_RELEASE_DIR:-$(mktemp -d)}"
ARCHIVE="$WORK_DIR/Herb.xcarchive"
OPTIONS="$WORK_DIR/ExportOptions.plist"

xcodebuild archive \
  -project "$IOS_DIR/Herb.xcodeproj" -scheme Herb -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -derivedDataPath "$WORK_DIR/DerivedData" -allowProvisioningUpdates \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER"

# The ONNX Runtime framework ships without MinimumOSVersion, and App Store Connect rejects that.
# Exporting signs the framework again, so changing it here is safe.
TARGET=$(xcodebuild -project "$IOS_DIR/Herb.xcodeproj" -scheme Herb -configuration Release -showBuildSettings \
  | awk -F' = ' '/ IPHONEOS_DEPLOYMENT_TARGET = /{print $2; exit}')
PLIST="$ARCHIVE/Products/Applications/Herb.app/Frameworks/onnxruntime.framework/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :MinimumOSVersion" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :MinimumOSVersion string $TARGET" "$PLIST"

/usr/libexec/PlistBuddy -c "Add :method string app-store-connect" "$OPTIONS"
/usr/libexec/PlistBuddy -c "Add :destination string upload" "$OPTIONS"
/usr/libexec/PlistBuddy -c "Add :signingStyle string automatic" "$OPTIONS"

xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$WORK_DIR/export" \
  -exportOptionsPlist "$OPTIONS" -allowProvisioningUpdates
