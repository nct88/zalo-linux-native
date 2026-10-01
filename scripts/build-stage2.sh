#!/usr/bin/env bash

set -euo pipefail

# Get the envs from arguments
VER="${1:-unknown}"
OUTNAME="${2:?Error: No OUTNAME given}"
DIST_DIR="${3:?Error: No DIST_DIR given}"

export ARCH="$(uname -m)"
export ARCH_SUFFIX=$( [[ "${ARCH}" == "arm64" || "${ARCH}" == "aarch64" ]] && echo "-aarch64" || echo "-x86_64" )
export APP_NAME="Zalo"
export DESKTOP="zalo.desktop"
export ICON="zalo.png"
export STARTUPWMCLASS="zalo"
export OUTPATH="${DIST_DIR}"
# Updates (Gear Lever, AppImageUpdate) come from the releases of the repository
# that builds it: GITHUB_REPOSITORY on CI, this project otherwise.
REPO="${GITHUB_REPOSITORY:-nct88/zalo-linux-native}"
export UPINFO="gh-releases-zsync|${REPO%%/*}|${REPO##*/}|latest|Zalo-Linux-Native-*${ARCH_SUFFIX}.AppImage.zsync"
export VERSION="$VER"

APPDIR="${DIST_DIR}/squashfs-root"
APPIMAGETOOL="${DIST_DIR}/appimagetool"

export APPDIR OUTNAME 

echo "=== Building Zalo AppImage for ${ARCH} ==="

# Check if the original AppImage exists
if [[ ! -f "${DIST_DIR}/${OUTNAME}" ]]; then
  echo "Error: Cannot find ${OUTNAME}, please run the builder first." >&2
  exit 1
fi

# Prepare appimagetool (which is quick-sharun.sh in this case)
if [[ ! -f "$APPIMAGETOOL" ]]; then
  echo "Downloading appimagetool..."
  wget -q https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/refs/heads/main/useful-tools/quick-sharun.sh -O "$APPIMAGETOOL"
  chmod +x "$APPIMAGETOOL"
fi

# Extract the original AppImage
echo "Extracting AppImage..."
chmod +x "${DIST_DIR}/${OUTNAME}"
cd "$DIST_DIR"
./"$OUTNAME" --appimage-extract >/dev/null 2>&1

if [[ ! -d "$APPDIR" ]]; then
  echo "Error: Cannot find ${APPDIR}, extraction failed." >&2
  exit 1
fi

# Remove the original AppImage before repacking
rm -f "$OUTNAME"

# Repack it with quick-sharun
echo "Packaging $OUTNAME..."
"$APPIMAGETOOL" --make-appimage

# Cleanup and chmod the output file
rm -rf "$APPDIR" "${DIST_DIR}/appinfo"
chmod +x "$OUTNAME" || true

echo "=== Build completed: ${DIST_DIR}/${OUTNAME} ==="
exit 