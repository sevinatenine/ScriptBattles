#!/usr/bin/env bash
# Builds tinted sprites from a grayscale template by multiplying it with a color.
# Usage: bash make_sprites.sh      (run next to template.png; writes to ./sprites)
set -euo pipefail
cd "$(dirname "$0")"

TEMPLATE="template.png"
OUT="sprites"
# The template's lightest gray (0-255). It gets stretched to white before tinting so the
# colors come out true instead of muddy. Set this to your template's brightest gray (104 for yours).
WHITEPOINT=104
# -level treats bare numbers as 16-bit values, so give it a percentage instead
WHITE_PCT=$(awk -v w="$WHITEPOINT" 'BEGIN { printf "%.4f", w / 255 * 100 }')

# name  normal-color  hit-color   (same colors botColors() produced)
SPRITES=(
  "wanderer  #2873bd #66b2ff"
  "crawler   #2849bd #6688ff"
  "skulker   #3028bd #6f66ff"
  "brute     #5a28bd #9966ff"
  "stalker   #8328bd #c366ff"
  "warden    #ad28bd #ee66ff"
  "reaver    #bd28a4 #ff66e5"
  "revenant  #bd287b #ff66bb"
  "colossus  #bd2852 #ff6690"
  "horror    #bd2828 #ff6666"
  "other     #33aa33 #00ff00"   # other players (PLAYER / PLAYER_HIT)
  "player    #ee3333 #ff8888"   # your own character
)

# magick (v7) if present, otherwise convert (v6)
if command -v magick >/dev/null 2>&1; then IM=(magick); else IM=(convert); fi

mkdir -p "$OUT"
read -r W H < <("${IM[@]}" "$TEMPLATE" -format "%w %h\n" info:)

# 1) opaque, brightened copy of the template (shading kept, lightest gray -> white)
"${IM[@]}" "$TEMPLATE" -alpha off -colorspace sRGB -level "0,${WHITE_PCT}%" -type TrueColor "$OUT/.base.png"
# 2) the template's own transparency, as a mask
"${IM[@]}" "$TEMPLATE" -alpha extract "$OUT/.mask.png"

tint() {   # $1 = color, $2 = output file
  "${IM[@]}" -size "${W}x${H}" xc:"$1" -type TrueColor \
    "$OUT/.base.png" -compose Multiply -composite \
    "$OUT/.mask.png" -alpha off -compose CopyOpacity -composite \
    -depth 8 -type TrueColorAlpha -define png:color-type=6 \
    "$2"
}

for row in "${SPRITES[@]}"; do
  read -r name color hit <<<"$row"
  tint "$color" "$OUT/${name}.png"
  tint "$hit"   "$OUT/${name}_hit.png"
  echo "made $name  ($color / $hit)"
done

rm -f "$OUT/.base.png" "$OUT/.mask.png"
echo "done -> $OUT/"