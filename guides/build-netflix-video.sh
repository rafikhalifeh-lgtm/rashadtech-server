#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/output"
HTML="file://$ROOT/netflix-signin-slides.html"
CHROME="${CHROME:-/usr/local/bin/google-chrome}"
SLIDES=8
DURATION=6
mkdir -p "$OUT/frames"

build_lang() {
  local lang=$1
  local name="netflix-signin-guide-${lang}"
  echo "Capturing ${lang} slides..."
  rm -f "$OUT/frames/${lang}"-*.png
  for i in $(seq 0 $((SLIDES - 1))); do
    "$CHROME" --headless=new --disable-gpu --no-sandbox \
      --window-size=1080,1920 --hide-scrollbars \
      --screenshot="$OUT/frames/${lang}-${i}.png" \
      "${HTML}#${i}-${lang}" 2>/dev/null
    echo "  slide $i"
  done

  echo "Building ${name}.mp4..."
  local list="$OUT/${name}-list.txt"
  : > "$list"
  for i in $(seq 0 $((SLIDES - 1))); do
    local frame="$OUT/frames/${lang}-${i}.png"
    local seg="$OUT/frames/${lang}-${i}.mp4"
    ffmpeg -y -loop 1 -i "$frame" -c:v libx264 -t "$DURATION" -pix_fmt yuv420p \
      -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p" \
      "$seg" -loglevel error
    echo "file '$seg'" >> "$list"
  done

  ffmpeg -y -f concat -safe 0 -i "$list" -c copy "$OUT/${name}-raw.mp4" -loglevel error

  # Re-encode with short crossfade between segments for smoother playback
  ffmpeg -y -i "$OUT/${name}-raw.mp4" \
    -vf "fps=30" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -movflags +faststart \
    "$OUT/${name}.mp4" -loglevel error

  # Horizontal version for desktop / YouTube
  ffmpeg -y -i "$OUT/${name}.mp4" \
    -vf "scale=1080:1920,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart \
    "$OUT/${name}-landscape.mp4" -loglevel error

  rm -f "$list" "$OUT/${name}-raw.mp4" "$OUT/frames/${lang}"-*.mp4
  echo "Done: $OUT/${name}.mp4 ($(du -h "$OUT/${name}.mp4" | cut -f1))"
}

build_lang en
build_lang ar

echo ""
echo "Videos ready in $OUT:"
ls -lh "$OUT"/*.mp4
