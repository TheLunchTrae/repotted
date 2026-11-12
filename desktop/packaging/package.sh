#!/usr/bin/env bash
# Builds the desktop app for this machine into artifacts/desktop: on macOS an
# app bundle and a DMG, on Windows an installer. The bundled CLI is built from
# packages/cli as a Node single executable, since the app runs it for all its
# GitHub work; its keychain module ships beside it.
#
# With MACOS_SIGNING_IDENTITY set to a Developer ID Application identity in
# the keychain, the bundle and the DMG are signed for notarization, under the
# hardened runtime. Without it the bundle is signed ad hoc and without the
# hardened runtime, whose library validation refuses every ad hoc library;
# Gatekeeper still refuses that app until it is allowed by hand.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
packaging="$root/desktop/packaging"
project="$root/desktop/src/Repotted.Desktop"
out="$root/artifacts/desktop"

case "$(uname -s)" in
  Darwin) os=macos ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *)
    echo "package.sh builds on macOS or Windows only." >&2
    exit 1
    ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *)
    echo "package.sh does not build for $(uname -m)." >&2
    exit 1
    ;;
esac
if [[ $os == windows && $arch != x64 ]]; then
  echo "The Windows installer is built for x64 only." >&2
  exit 1
fi
rid="$([[ $os == macos ]] && echo osx || echo win)-$arch"
exe="$([[ $os == windows ]] && echo .exe || true)"

version="$(dotnet msbuild "$project" -getProperty:Version)"
cli_version="$(cd "$root" && node -p "require('./packages/cli/package.json').version")"
publish="$out/publish-$rid"
rm -rf "$publish"
mkdir -p "$out"

echo "Publishing Repotted $version for $rid"
dotnet publish "$project" --configuration Release --runtime "$rid" --self-contained \
  -p:PublishReadyToRun=true -p:RestoreLockedMode=true -p:ContinuousIntegrationBuild=true \
  -p:DebugType=none -p:PublishDocumentationFile=false --output "$publish"

# The app finds the CLI beside itself as repotted-cli; see RepottedCli.Locate.
# sea.ts writes repotted-keyring.node beside it.
cli="$publish/repotted-cli$exe"
node "$root/packages/cli/sea.ts" "$cli"

# The compiled CLI must start, serve MCP with its bundled dependencies, and
# load its keychain module on this platform.
smoke() {
  local reported
  reported="$("$1" --version)"
  if [[ $reported != "$cli_version" ]]; then
    echo "$1 reports version $reported, not $cli_version." >&2
    exit 1
  fi
  node "$root/packages/cli/tests/node-smoke.mjs" "$1"
  # Without a token variable or a GitHub CLI sign-in, status reads the keychain.
  # Signed out, it exits 1 either way, so a keychain that fails to load shows
  # only in problems.
  local status=0 answer no_gh
  no_gh="$(mktemp -d)"
  answer="$(env -u GITHUB_TOKEN -u GH_TOKEN GH_CONFIG_DIR="$no_gh" "$1" status --json)" || status=$?
  rm -rf "$no_gh"
  if ((status > 1)) || [[ $answer == *'"problems":["'* ]]; then
    echo "$1 status --json exited $status with: $answer" >&2
    exit 1
  fi
}
smoke "$cli"

if [[ $os == windows ]]; then
  iscc="$(command -v iscc || echo "/c/Program Files (x86)/Inno Setup 6/ISCC.exe")"
  name="Repotted-$version-windows-$arch-setup"
  "$iscc" -Q \
    "-DAppVersion=$version" \
    "-DSourceDir=$(cygpath -w "$publish")" \
    "-DIconFile=$(cygpath -w "$project/Assets/repotted.ico")" \
    "-DOutputDir=$(cygpath -w "$out")" \
    "-DOutputBaseFilename=$name" \
    "$(cygpath -w "$packaging/windows/Repotted.iss")"
  echo "Built $out/$name.exe"
  exit 0
fi

app="$out/Repotted.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp -R "$publish/." "$app/Contents/MacOS/"
cp "$packaging/macos/Repotted.icns" "$app/Contents/Resources/"
sed "s/@VERSION@/$version/g" "$packaging/macos/Info.plist" >"$app/Contents/Info.plist"

identity="${MACOS_SIGNING_IDENTITY:-}"
timestamp=--timestamp
runtime=runtime
if [[ -z $identity ]]; then
  echo "MACOS_SIGNING_IDENTITY is not set, so the app is signed ad hoc without the hardened runtime and the DMG is not signed."
  identity=-
  timestamp=--timestamp=none
  runtime=
fi
sign() {
  codesign --force "$timestamp" ${runtime:+--options "$runtime"} --sign "$identity" ${MACOS_SIGNING_KEYCHAIN:+--keychain "$MACOS_SIGNING_KEYCHAIN"} "$@"
}
# Each file first, then the bundle, which signs its executable, Repotted;
# --deep would give every file the app's entitlements.
# That includes the keychain module, so the CLI loads it signed by the same team.
find "$app/Contents/MacOS" -type f ! -name Repotted ! -name repotted-cli -print0 |
  while IFS= read -r -d '' file; do sign "$file"; done
sign --entitlements "$packaging/macos/repotted-cli.entitlements" "$app/Contents/MacOS/repotted-cli"
sign --entitlements "$packaging/macos/Repotted.entitlements" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
# Under the hardened runtime, library validation loads only libraries signed
# by the loading executable's team, and an ad hoc signature has no team. GitHub's
# macOS runners launched such apps anyway, so the launch below can't be
# trusted to catch a mismatch.
team() { codesign --display --verbose=2 "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'; }
for exe in Repotted repotted-cli; do
  [[ "$(codesign --display --verbose=2 "$app/Contents/MacOS/$exe" 2>&1)" == *'flags='*runtime* ]] || continue
  exe_team="$(team "$app/Contents/MacOS/$exe")"
  if [[ $exe_team == 'not set' ]]; then
    echo "$exe runs under the hardened runtime without a team, so it can't load any library." >&2
    exit 1
  fi
  find "$app/Contents/MacOS" -type f -print0 |
    while IFS= read -r -d '' file; do
      [[ "$(file -b "$file")" == Mach-O* ]] || continue
      file_team="$(team "$file")"
      if [[ $file_team != "$exe_team" ]]; then
        echo "$exe runs under the hardened runtime with team $exe_team, so it can't load $file, signed with team ${file_team:-none}." >&2
        exit 1
      fi
    done
done
# The CLI must still JIT and load its keychain module, under the hardened
# runtime when signed, and the app must load its native libraries: a launch
# that fails exits early.
smoke "$app/Contents/MacOS/repotted-cli"
"$app/Contents/MacOS/Repotted" &
launched=$!
sleep 15
if ! kill -0 "$launched" 2>/dev/null; then
  launch_status=0
  wait "$launched" || launch_status=$?
  echo "Repotted exited on launch with status $launch_status." >&2
  exit 1
fi
kill "$launched" 2>/dev/null || true

dmg="$out/Repotted-$version-macos-$arch.dmg"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
hdiutil create -volname Repotted -srcfolder "$stage" -format UDZO -ov "$dmg"
if [[ $identity != - ]]; then
  codesign --force --timestamp --sign "$identity" ${MACOS_SIGNING_KEYCHAIN:+--keychain "$MACOS_SIGNING_KEYCHAIN"} "$dmg"
fi
echo "Built $dmg"
