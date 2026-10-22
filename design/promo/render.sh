#!/usr/bin/env bash
# 把 promo.html 的每張圖輸出成 PNG（用本機的 Chrome 無頭模式，需要網路載入 Google Fonts）。
# 用法：bash design/promo/render.sh
set -euo pipefail

cd "$(dirname "$0")"
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
PAGE="file:///$(pwd -W 2>/dev/null || pwd)/promo.html"
PROFILE="$(mktemp -d)"
mkdir -p png

# 輸出檔名 寬 高 網址參數
BOARDS=(
  "square 1080 1080 board=square"
  "story 1080 1920 board=story"
  "banner 1200 630 board=banner"
  "avatar 640 640 board=avatar"
  "intro 640 360 board=intro"
  "logo-clear 740 430 board=logo-clear"
  "logo-mustard 1000 600 board=logo-mustard"
  "wordmark 540 128 board=wordmark"
  "apple-icon 180 180 board=apple-icon"
  "icon-16 16 16 board=icon&size=16"
  "icon-32 32 32 board=icon&size=32"
  "icon-48 48 48 board=icon&size=48"
)

for entry in "${BOARDS[@]}"; do
  read -r name w h query <<<"$entry"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --user-data-dir="$PROFILE" \
    --virtual-time-budget=12000 --window-size="$w,$h" \
    --screenshot="$(pwd -W 2>/dev/null || pwd)/png/$name.png" "$PAGE?$query" >/dev/null 2>&1
  echo "png/$name.png"
done

rm -rf "$PROFILE"

# 網站的分頁圖示：16、32、48 三種尺寸包成一個 favicon.ico
python -I make-ico.py png/favicon.ico png/icon-16.png png/icon-32.png png/icon-48.png
echo "png/favicon.ico"
