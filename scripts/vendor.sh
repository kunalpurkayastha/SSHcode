#!/usr/bin/env bash
# Fetch the browser libraries sshcode serves from web/vendor (no bundler or npm needed).
#   monaco-editor 0.52.2 — last release with a fully supported AMD build
#   @xterm/xterm 6 + fit/web-links/unicode11/webgl addons — UMD builds
#   marked + DOMPurify — Markdown and notebook previews (loaded on demand)
#   Inter + JetBrains Mono variable fonts (OFL) — stand-ins for SF Pro / SF Mono
#   Carlito + Caladea (OFL) — metric twins of Calibri / Cambria, for .pptx slides
#
# The tarballs come straight from the npm registry and must match the sha512 the
# registry publishes for them (`npm view PKG@VER dist.integrity`, base64 → hex).
# Nothing is fetched when web/vendor already holds these versions; --force refetches.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
OUT="$APP_DIR/web/vendor"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

# unpacked as   package@version                            sha512 of the tarball
PKGS="
monaco   monaco-editor@0.52.2                       18441611999f90e18b75ddd72bcaf2adf5b3dc020ff18ca655788f1c475ec2b52aee6874aab2ab7c72cd09771b07ab139cc2e7399df3b5288a71c885524209c1
xterm    @xterm/xterm@6.0.0                         4d0c037501adc300edfb67202832e7d0845a4b162ed6d4948e029aad20e450cd193624915c5a63c44b2f73f66073992ae68989f95d1af3f908336583dec30e62
fit      @xterm/addon-fit@0.11.0                    8d87204fac6d558867860c61dd08180e79cd3184dc7fc1256f1c45cd7d08668faf69b42a48f0230b7735c09aca079135f55c107a2f3d40289964ff3a0c23c5ee
links    @xterm/addon-web-links@0.12.0              e129a89b744fc95a7b64c60e603a02ffd78624926a6219cf2c61aa27ac0e05f07c5713d588935229d81161bf0da5a33a6127a510a6c0d924ad0fb946caa6a86f
uni      @xterm/addon-unicode11@0.9.0               1710e761ccae5e1365f974aa1992ffb7453d7a235bfeadc4593e6b624413ff3ba283c1b3fd56a09d000d287743585336953324f65cb4105431c71b5952845eb7
webgl    @xterm/addon-webgl@0.19.0                  6f77cc3acc8b56e09e3495b1a25002114103d2f9bba82d1ccb8c11bdfde85114b30d361542218f8539e1599c081ddbc2e3c63ea0b86f6179d8e170d73e8268e8
marked   marked@18.0.14                             9811cae85047b8102586045ef3cc3d1743b501bc305c951c4226d46c2fd071d4db546003eda5b36bec6ddcdea84ff8c2671dff38c792fbcae7ba21d9710f6cec
purify   dompurify@3.4.16                           b2aa3ea4da77a918422296e0462d72f13824dbb068d91cbbc34742d4d05e3537590a15a3cfd5dbfca3a865b44ffd1ea9419f34430f18857c35de159605b3119d
inter    @fontsource-variable/inter@5.3.0           3aea4be3cbdae093687dbf7bc3a358785f52ed6fe41cd28cd04afc0de9b99ea8b88de38bad5243a04f2d644a673099ad92f35b0751083cfc0771d905e9bd6850
jbm      @fontsource-variable/jetbrains-mono@5.3.0  177db1a52d8db06628422d800d290a4e0a498fba336a3b0680327cc284e7aa398807e7710c8a889a3978a57655104c6ef14159da7761997d7c1014bf85dcf72f
carlito  @fontsource/carlito@5.3.0                  a0faaf2c62bf76d5730b82a3743715fd8cd0ab7eec65d317c43e7c003be0b8fa37766eb2cdb04ab38d000e67af245d302efcaf258eff7cf979624090d678d653
caladea  @fontsource/caladea@5.3.0                  12b0495a3f46a7fb534b7de1d12507994dcc087cd06b74494b8d3971cce713cc7154ae3527e9ab2a18e371fde822b9d04c280808c6e5f67007dd731737d00d52
"

WANT="$(awk 'NF { print $2 }' <<<"$PKGS")"
if [[ ${1:-} != --force && -f $OUT/VERSIONS && "$(cat "$OUT/VERSIONS")" == "$WANT" ]]; then
  echo "vendor files in $OUT are up to date"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "downloading Monaco, xterm.js, marked, DOMPurify and fonts from $REGISTRY…"
while read -r dir spec sum; do
  [[ -n $dir ]] || continue
  name="${spec%@*}" ver="${spec##*@}"
  curl -fsSL --retry 3 -o "$TMP/$dir.tgz" "$REGISTRY/$name/-/${name##*/}-$ver.tgz"
  if ! echo "$sum  $TMP/$dir.tgz" | sha512sum -c --status; then
    echo "vendor.sh: $spec doesn't match its checksum; not installing it" >&2
    exit 1
  fi
  mkdir -p "$TMP/$dir" && tar xzf "$TMP/$dir.tgz" -C "$TMP/$dir" --strip-components=1
done <<<"$PKGS"

# Build next to the live folder and swap it in at the end, so a running
# server never serves a half-copied vendor tree.
FINAL="$OUT"
OUT="$FINAL.new"
rm -rf "$OUT"
mkdir -p "$OUT/monaco" "$OUT/xterm" "$OUT/fonts" "$OUT/markdown"
cp -r "$TMP/monaco/min/vs" "$OUT/monaco/vs"
cp "$TMP/monaco/LICENSE" "$OUT/monaco/LICENSE"
cp "$TMP/xterm/lib/xterm.js" "$TMP/xterm/css/xterm.css" "$OUT/xterm/"
cp "$TMP/fit/lib/addon-fit.js" "$TMP/links/lib/addon-web-links.js" "$TMP/uni/lib/addon-unicode11.js" "$TMP/webgl/lib/addon-webgl.js" "$OUT/xterm/"
cp "$TMP/marked/lib/marked.umd.js" "$OUT/markdown/marked.js"
cp "$TMP/purify/dist/purify.min.js" "$OUT/markdown/purify.js"
cp "$TMP/marked/LICENSE" "$OUT/markdown/LICENSE-marked"
cp "$TMP/purify/LICENSE" "$OUT/markdown/LICENSE-DOMPurify"
cp "$TMP/xterm/LICENSE" "$OUT/xterm/LICENSE"
for sub in latin latin-ext; do
  cp "$TMP/inter/files/inter-$sub-wght-normal.woff2" "$OUT/fonts/"
  cp "$TMP/jbm/files/jetbrains-mono-$sub-wght-normal.woff2" "$OUT/fonts/"
  cp "$TMP/jbm/files/jetbrains-mono-$sub-wght-italic.woff2" "$OUT/fonts/"
done
for style in 400-normal 700-normal 400-italic 700-italic; do
  for sub in latin latin-ext greek; do cp "$TMP/carlito/files/carlito-$sub-$style.woff2" "$OUT/fonts/"; done
  for sub in latin latin-ext; do cp "$TMP/caladea/files/caladea-$sub-$style.woff2" "$OUT/fonts/"; done
done
cp "$TMP/inter/LICENSE" "$OUT/fonts/LICENSE-Inter"
cp "$TMP/carlito/LICENSE" "$OUT/fonts/LICENSE-Carlito"
cp "$TMP/caladea/LICENSE" "$OUT/fonts/LICENSE-Caladea"
cp "$TMP/jbm/LICENSE" "$OUT/fonts/LICENSE-JetBrainsMono"
printf '%s\n' "$WANT" > "$OUT/VERSIONS"
rm -rf "$FINAL.old"
[[ -d $FINAL ]] && mv "$FINAL" "$FINAL.old"
mv "$OUT" "$FINAL"
rm -rf "$FINAL.old"
echo "vendor files in $FINAL ($(du -sh "$FINAL" | cut -f1))"
