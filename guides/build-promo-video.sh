#!/usr/bin/env bash
# Build RashadTech customer promo videos (English + Arabic, landscape + vertical).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 guides/build_promo_video.py
echo ""
echo "Done. Open guides/output/ for MP4 files."
