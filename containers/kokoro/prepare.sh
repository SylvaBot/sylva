#!/bin/sh
# Copy what the server needs out of node_modules ($1) into the app ($2):
# the model in six parts (checked against its sha256), the English voices
# and the three runtime packages.
set -eu
mods="$1"
app="$2"
mkdir -p "$app/data/model" "$app/data/voices" "$app/node_modules/@breezystack"
for i in 0 1 2 3 4 5; do
  cp "$mods/kokoro-q8-shards/kokoro-q8.part$i.bin" "$app/data/model/part$i.bin"
done
sum=$(cat "$app/data/model/part0.bin" "$app/data/model/part1.bin" "$app/data/model/part2.bin" \
  "$app/data/model/part3.bin" "$app/data/model/part4.bin" "$app/data/model/part5.bin" | sha256sum | cut -d' ' -f1)
[ "$sum" = "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478" ] || { echo "Kokoro model hash does not match"; exit 1; }
cp "$mods"/kokoro-js/voices/[ab][fm]_*.bin "$app/data/voices/"
[ "$(ls "$app/data/voices" | wc -l)" = 28 ] || { echo "Expected 28 English voices"; exit 1; }
cp -r "$mods/onnxruntime-node" "$mods/onnxruntime-common" "$mods/phonemizer" "$app/node_modules/"
cp -r "$mods/@breezystack/lamejs" "$app/node_modules/@breezystack/"
# Cloudflare runs containers on linux/amd64.
rm -rf "$app"/node_modules/onnxruntime-node/bin/napi-v*/darwin "$app"/node_modules/onnxruntime-node/bin/napi-v*/win32 \
  "$app"/node_modules/onnxruntime-node/bin/napi-v*/linux/arm64
