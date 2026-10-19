#!/usr/bin/env bash
# Compila o Maré para Wear OS sem Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
set -euo pipefail
cd "$(dirname "$0")"
BT=/home/claude/android/android-15
AJ=/home/claude/android/android-35/android.jar
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

python3 - <<'PY'
from PIL import Image, ImageDraw
import os
NIGHT, EMBER, BLUE = (11, 13, 20, 255), (255, 157, 92, 255), (97, 152, 234, 255)
def icon(size):
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, S - 1, S - 1], fill=NIGHT)
    c, r = S / 2, S * 0.24
    cx, cy = c - S * 0.03, c - S * 0.07
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=EMBER)
    off = r * 0.55
    d.ellipse([cx - r + off, cy - r - off * 0.45, cx + r + off, cy + r - off * 0.45], fill=NIGHT)
    y0, xs, lv, h = c + S * 0.22, [c - S * 0.27 + i * (S * 0.54 / 8) for i in range(9)], [0,1,2,1,0,1,2,1,0], S * 0.04
    pts = []
    for i in range(8):
        y = y0 + (lv[i] - 1) * h
        pts += [(xs[i], y), (xs[i + 1], y)]
    d.line(pts, fill=BLUE, width=int(S * 0.03), joint="curve")
    return img.resize((size, size), Image.LANCZOS)
for q, s in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144}.items():
    os.makedirs(f"res/mipmap-{q}", exist_ok=True)
    icon(s).save(f"res/mipmap-{q}/ic_launcher.png")
PY

"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$AJ" --manifest AndroidManifest.xml \
  --java "$OUT/gen" --min-sdk-version 30 --target-sdk-version 34 \
  --version-code 1 --version-name 1.0 "$OUT/res.zip"

javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$AJ:$BT/core-lambda-stubs.jar" \
  -d "$OUT/classes" $(find src "$OUT/gen" -name '*.java')

"$BT/d8" --release --min-api 30 --lib "$AJ" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -j ../unsigned.apk classes.dex)
"$BT/zipalign" -p -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KS=mare-watch.keystore
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias mare -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass mare-watch -keypass mare-watch -dname "CN=Mare Watch" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:mare-watch --key-pass pass:mare-watch \
  --out Mare-relogio.apk "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs Mare-relogio.apk | head -2
ls -la Mare-relogio.apk
