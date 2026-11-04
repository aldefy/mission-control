#!/bin/sh
# scripts/media/encode.sh <video.mp4> <poster.jpg> <shots-dir> <out-dir>
# Web versions for ronincrew.dev/mission-control, at the sizes the page expects:
#   mission-control-1080.mp4 (~720 kbps) and mission-control-720.mp4 (~430 kbps), silent, faststart;
#   poster.jpg 1600x900; <name>.webp (q85) for each PNG in <shots-dir>.
# Needs ffmpeg (with libx264) and cwebp.
set -eu
[ $# -eq 4 ] || { echo "usage: $0 <video.mp4> <poster.jpg> <shots-dir> <out-dir>" >&2; exit 2; }
src=$1 poster=$2 shots=$3 out=$4
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
two_pass() { # <scale-filter|-> <bitrate> <maxrate> <out>
  vf=""; [ "$1" = "-" ] || vf="-vf $1"
  (cd "$work" && ffmpeg -loglevel error -y -i "$src" $vf -c:v libx264 -preset slow -b:v "$2" -maxrate "$3" -bufsize "$3" -pass 1 -an -f mp4 /dev/null \
    && ffmpeg -loglevel error -y -i "$src" $vf -c:v libx264 -preset slow -b:v "$2" -maxrate "$3" -bufsize "$3" -pass 2 -pix_fmt yuv420p -an -movflags +faststart "$4")
}
two_pass - 720k 1500k "$out/mission-control-1080.mp4"
two_pass scale=1280:720:flags=lanczos 430k 900k "$out/mission-control-720.mp4"
ffmpeg -loglevel error -y -i "$poster" -vf scale=1600:900:flags=lanczos -q:v 3 "$out/poster.jpg"
for p in "$shots"/*.png; do cwebp -quiet -q 85 -m 6 "$p" -o "$out/$(basename "${p%.png}").webp"; done
ls -l "$out"
