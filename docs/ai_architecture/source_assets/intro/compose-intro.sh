#!/usr/bin/env bash
# docs/ai_architecture/source_assets/intro/compose-intro.sh
#
# ==================================================================
#  HOW THE THREE INTRO FILMS ARE MADE, AND WHY THE NUMBERS DIFFER
# ==================================================================
#
# ONE BODY, THREE TITLES. `intro-body.mp4` (10.006s) is the shared gold architectural / hex-map cinematic
# ending in the Neta mark. It is the authority: every ruleset's film is this file, entered from its own
# frame zero, with a different title cross-faded on the front. Recovered from git 492277a, where it was
# the whole intro before the base wordmark was prepended; verified frame-for-frame against the shipped
# `game-intro.mp4` (SSIM >= 0.996 sampled from the tail, which is phase-independent).
#
# THE BASE FILM IS NOT REGENERATED. `public/video/game-intro.mp4` is what was already shipping and is left
# byte-identical -- it is itself this body with the base wordmark cross-faded on at 3.011s over 1.000s.
# Re-encoding it to match a script would have risked the one film nobody asked to change.
#
# THE CUT POINTS ARE EDITORIAL, MEASURED FRAME BY FRAME AT 24FPS:
#
#   film   semanticResolve  visualSettle  crossfadeStart  duration  titleGone  total
#   base   0.000            ~0.0          3.011           1.000     4.011      13.042
#   plus   1.958            2.917 (f70)   2.917           1.000     3.917      12.959
#   lpf    3.167 (f76)      3.208 (f77)   3.250 (f78)     0.750     4.000      13.292
#
# Each handoff is at that title's VISUAL SETTLE, so the crossfade consumes decoration and never
# construction. The numbers differ because the footage does: the base wordmark is complete at frame zero
# and shimmers for three seconds, Plus is lit by a travelling burst that clears at 2.917s, and LPF's
# subtitle does not finish kerning until 3.167s of a 4.000s clip.
#
# OFFSETS ARE FRAME-ALIGNED ON PURPOSE. A first pass used 2.90s and xfade snapped it, putting the body's
# t=0 at 2.98 -- so the composed film and the constant in `GameIntroOverlay.tsx` disagreed by a frame and a
# half. Multiples of 1/24 remove the question.
#
# AUDIO IS ATTENUATED TO THE BASE TITLE'S LEVEL. Measured over each title's first three seconds:
# base -33.3 dB mean, Plus -22.1, LPF -21.3. Dropped in raw, the two new films would have opened 11-12 dB
# hotter than the base and then fallen into a quiet body -- the "variant-specific loudness" and "gain dip
# at the handoff" the brief rules out. After the gains below all three films measure -20.7/-20.8 dB mean.
#
# NO PADDING. Extending LPF's last (static) frame would have bought a quarter-second more reading time,
# and was rejected on measurement: both title clips carry continuous audio to 3.9s, so the video freeze
# would have needed a silent audio pad under it, which is the gain dip again.

set -euo pipefail
cd "$(dirname "$0")"
BODY=intro-body.mp4
OUT=../../../../frontend/public/video

compose() { # title offset duration gainDb out
  local end; end=$(python3 -c "print(round($2+$3,6))")
  ffmpeg -v error -y -i "$1" -i "$BODY" -filter_complex "
    [0:v]settb=AVTB,fps=24,format=yuv420p,scale=1280:720[tv];
    [1:v]settb=AVTB,fps=24,format=yuv420p,scale=1280:720[bv];
    [tv][bv]xfade=transition=fade:duration=$3:offset=$2,format=yuv420p[v];
    [0:a]atrim=0:$end,asetpts=N/SR/TB,volume=$4dB[ta];
    [1:a]asetpts=N/SR/TB[ba];
    [ta][ba]acrossfade=d=$3:c1=tri:c2=tri[a]
  " -map "[v]" -map "[a]" \
    -c:v libx264 -crf 20 -preset slow -pix_fmt yuv420p -r 24 \
    -c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart "$5"
}

compose ../../../../frontend/public/video/18XXPlus.mp4 2.916667 1.00 -11.2 "$OUT/game-intro-plus.mp4"
compose ../../../../frontend/public/video/18xxLPF.mp4  3.250000 0.75 -12.0 "$OUT/game-intro-lpf.mp4"
