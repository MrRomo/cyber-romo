#!/usr/bin/env bash
# Copies the live Herdr setup into this repo: run it after changing the layout, a theme or a
# mod, then commit. It reads the Herdr home (~/.config/herdr-app, or $HERDR_HOME) and never
# writes there. Third-party pieces with no license (third-party.json) are not copied: their
# changes are saved as a patch against the author's pinned commit (patches/<name>.patch).
#
#   ./export.sh                 # from layouts/catppuccin.json
#   LAYOUT_SRC=my-layout ./export.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=manifest.sh
. "$REPO/manifest.sh"
# shellcheck source=lib.sh
. "$REPO/lib.sh"
SRC="${HERDR_HOME:-$HOME/.config/herdr-app}"

die() { echo "export: $*" >&2; exit 1; }
[ -d "$SRC/mods" ] || die "no Herdr home at $SRC"
[ -f "$SRC/layouts/$LAYOUT_SRC.json" ] || die "no layout $SRC/layouts/$LAYOUT_SRC.json"
for c in python3 rsync curl tar diff; do command -v "$c" >/dev/null || die "$c is needed"; done
third_party >/dev/null || die "third-party.json does not read"

FETCHED="$(mktemp -d)"
trap 'rm -rf "$FETCHED"' EXIT
excludes=()
for e in "${EXCLUDES[@]}"; do excludes+=(--exclude "$e"); done

echo "Exporting from $SRC (layout $LAYOUT_SRC) into $REPO"

# This repo's mods: an exact copy, files deleted upstream go here too.
mkdir -p "$REPO/mods"
for m in "${MODS[@]}"; do
  [ -f "$SRC/mods/$m/mod.json" ] || die "mod $m is missing in $SRC/mods"
  rsync -a --delete "${excludes[@]}" "$SRC/mods/$m/" "$REPO/mods/$m/"
  echo "  mod     $m"
done

# Third-party mods: only the difference from the author's pinned commit, as a patch.
# Sets (or clears) its "patch" in third-party.json.
set_patch() {
  python3 - "$REPO/third-party.json" "$1" "$2" <<'PY'
import json, sys
path, name, patch = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(path))
for e in data["items"]:
    if e["name"] == name:
        e["patch"] = None if patch == "-" else patch
with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}
while IFS=$'\t' read -r name kind repo commit path patch; do
  up="$(fetch "$repo" "$commit")" || die "could not download github.com/$repo at $commit"
  if [ "$kind" = theme ]; then
    cmp -s "$up/$path" "$SRC/themes/$name.json" && echo "  theme   $name (as its author's)" \
      || echo "  WARNING: theme $name differs from github.com/$repo@${commit:0:7}: install.sh would install the author's"
    continue
  fi
  [ -f "$SRC/mods/$name/mod.json" ] || die "mod $name is missing in $SRC/mods"
  work="$FETCHED/diff-$name"
  rm -rf "$work"
  mkdir -p "$work/a" "$work/b"
  rsync -a "${excludes[@]}" "$up/$path/" "$work/a/"
  rsync -a "${excludes[@]}" "$SRC/mods/$name/" "$work/b/"
  # diff exits 1 when they differ; the timestamps go, so an unchanged patch stays unchanged.
  (cd "$work" && diff -ruN a b || true) | sed -E 's/^((---|\+\+\+) [^	]+)	.*/\1/' > "$work/patch"
  if grep -q '^Binary files' "$work/patch"; then
    echo "  WARNING: $name has binary changes a patch can't carry:"; grep '^Binary files' "$work/patch" | sed 's/^/    /'
  fi
  if [ -s "$work/patch" ]; then
    mkdir -p "$REPO/patches"
    cp "$work/patch" "$REPO/patches/$name.patch"
    set_patch "$name" "patches/$name.patch"
    echo "  mod     $name (patch against github.com/$repo@${commit:0:7}: $(grep -c '^[-+][^-+]' "$work/patch" || true) lines)"
  else
    rm -f "$REPO/patches/$name.patch"
    set_patch "$name" "-"
    echo "  mod     $name (as its author's, github.com/$repo@${commit:0:7})"
  fi
done < <(third_party)

# The layout, renamed to the package's name. Its preview is this repo's own picture.
mkdir -p "$REPO/layouts"
python3 - "$SRC" "$LAYOUT_SRC" "$REPO" "$NAME" "${MODS[*]} $(third_party_names mod)" "${SHIPPED[*]}" "$(third_party_names theme)" <<'PY'
import json, os, re, sys
src, layout_src, repo, name, mods, shipped, themes = sys.argv[1:8]
mods, shipped, themes = set(mods.split()), set(shipped.split()), set(themes.split())
with open(os.path.join(src, "layouts", layout_src + ".json")) as f:
    text = f.read()
layout = json.loads(text)
preview = "layouts/%s.png" % name
if os.path.exists(os.path.join(repo, preview)):
    layout["preview"] = preview
else:
    layout.pop("preview", None)
layout.pop("cloned_from", None)
with open(os.path.join(repo, "layouts", name + ".json"), "w") as f:
    json.dump(layout, f, indent=2, ensure_ascii=False)
    f.write("\n")
# Everything the layout names must travel with the package or ship with Herdr.
used = set(re.findall(r'"mod"\s*:\s*"([^"]+)"', text))
for m in sorted(used - mods - shipped):
    print("  WARNING: the layout uses mod %r, which is not in MODS, third-party.json or SHIPPED" % m)
theme = layout.get("theme")
named = set(theme.values()) if isinstance(theme, dict) else ({theme} if theme else set())
for t in sorted(named - themes - {"graphite", "ink", "moss", "paper"}):
    print("  WARNING: the layout uses theme %r, which is not in third-party.json" % t)
print("  layout  %s -> layouts/%s.json" % (layout_src, name))
PY

# The person's keys and settings (install.sh merges them in; --no-config skips them).
mkdir -p "$REPO/config"
for f in keys.json settings.json programs.json; do
  if [ -f "$SRC/$f" ]; then cp "$SRC/$f" "$REPO/config/$f"; echo "  config  $f"; fi
done

echo "Done. Review with: git -C \"$REPO\" status"
