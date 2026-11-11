#!/usr/bin/env bash
# Installs the cyber-romo Herdr layout: its mods, themes, layout and (merged) keys/settings,
# into a Herdr home (~/.config/herdr-app, or $HERDR_HOME). The third-party pieces this repo
# doesn't carry (third-party.json) are downloaded from their authors' GitHub repos at a
# pinned commit and patched. Anything it replaces is copied first to
# <home>/../herdr-app-backups/cyber-romo-<time>/, so an install can be undone by copying that
# folder back.
#
#   ./install.sh               install everything, merge keys.json and settings.json
#   ./install.sh --no-config   leave keys.json and settings.json alone
#   ./install.sh --switch      also show the layout now (Herdr must be running)
#   ./install.sh --dry-run     say what would change, change nothing (it still downloads)
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=manifest.sh
. "$REPO/manifest.sh"
# shellcheck source=lib.sh
. "$REPO/lib.sh"
DEST="${HERDR_HOME:-$HOME/.config/herdr-app}"
CONFIG=1 SWITCH=0 DRY=0
for a in "$@"; do
  case "$a" in
    --no-config) CONFIG=0 ;;
    --switch) SWITCH=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "install: unknown option $a" >&2; exit 2 ;;
  esac
done

die() { echo "install: $*" >&2; exit 1; }
warn() { echo "  ! $*"; }
[ -d "$DEST" ] || die "no Herdr home at $DEST: start the Herdr app once, or set HERDR_HOME"
command -v python3 >/dev/null || die "python3 is needed (and agents-claude needs it on every machine it shows)"
for c in curl tar patch; do command -v "$c" >/dev/null || die "$c is needed to fetch the third-party pieces"; done
third_party >/dev/null || die "third-party.json does not read"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$(dirname "$DEST")/herdr-app-backups/$NAME-$STAMP"
# Built outside the Herdr home (next to it, same disk): a mod folder Herdr sees without its
# mod.json gets docked into the shown layout, so each one is moved in whole.
STAGING="$(dirname "$DEST")/.$NAME-staging-$$"
FETCHED="$STAGING/fetched"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$FETCHED"
backed=0
# Copies an existing path into the backup before it is replaced (once per path).
backup() {
  local rel="$1"
  [ -e "$DEST/$rel" ] || return 0
  [ "$DRY" = 1 ] && return 0
  mkdir -p "$BACKUP/$(dirname "$rel")"
  [ -e "$BACKUP/$rel" ] || cp -R "$DEST/$rel" "$BACKUP/$rel"
  backed=1
}
same() { [ -e "$2" ] && diff -rq -x gpui-kit.d.ts -x jsconfig.json -x .DS_Store "$1" "$2" >/dev/null 2>&1; }

# Puts mod folder $2 in as mods/$1 ($3: where it comes from, for people).
install_mod() {
  local m="$1" src="$2" from="$3"
  if same "$src" "$DEST/mods/$m"; then echo "  mod     $m (already up to date)"; return; fi
  echo "  mod     $m$from$([ -e "$DEST/mods/$m" ] && echo ' (replacing; old one backed up)')"
  [ "$DRY" = 1 ] && return
  backup "mods/$m"
  local stage="$STAGING/mods/$m"
  rm -rf "$stage"
  mkdir -p "$stage"
  cp "$src/mod.json" "$stage/mod.json"
  (cd "$src" && tar cf - --exclude mod.json --exclude gpui-kit.d.ts --exclude jsconfig.json --exclude .DS_Store .) | (cd "$stage" && tar xf -)
  # Herdr's own per-mod files (type definitions for editors) stay; Herdr rewrites them on start.
  for keep in gpui-kit.d.ts jsconfig.json; do
    [ -f "$DEST/mods/$m/$keep" ] && cp "$DEST/mods/$m/$keep" "$stage/$keep"
  done
  rm -rf "$DEST/mods/$m"
  mkdir -p "$DEST/mods"
  mv "$stage" "$DEST/mods/$m"
}

# Puts theme file $2 in as themes/$1.json.
install_theme() {
  local th="$1" src="$2" from="$3"
  if cmp -s "$src" "$DEST/themes/$th.json"; then echo "  theme   $th (already up to date)"; return; fi
  echo "  theme   $th$from"
  [ "$DRY" = 1 ] && return
  mkdir -p "$DEST/themes"
  backup "themes/$th.json"
  cp "$src" "$DEST/themes/$th.json"
}

echo "Installing $NAME into $DEST$([ "$DRY" = 1 ] && echo ' (dry run)')"

# What the package borrows from Herdr itself.
for m in "${SHIPPED[@]}"; do
  [ -f "$DEST/mods/$m/mod.json" ] || warn "Herdr's mod '$m' is missing here: update the Herdr app (made with herdr-app 0.1.15)"
done

# This repo's mods.
for m in "${MODS[@]}"; do install_mod "$m" "$REPO/mods/$m" ""; done

# Third-party mods and themes: downloaded at their pinned commit, then cyber-romo's patch.
while IFS=$'\t' read -r name kind repo commit path patch; do
  src="$(fetch "$repo" "$commit")" || die "could not download github.com/$repo at $commit (offline? see third-party.json)"
  from=" (from github.com/$repo@${commit:0:7})"
  [ "$patch" = - ] || from=" (from github.com/$repo@${commit:0:7} + patch)"
  if [ "$kind" = mod ]; then
    out="$STAGING/built/$name"
    build_mod "$path" "$src" "$out" "$patch" || die "could not build $name: $patch does not apply to github.com/$repo@${commit:0:7}"
    install_mod "$name" "$out" "$from"
  else
    [ -f "$src/$path" ] || die "github.com/$repo@${commit:0:7} has no $path"
    install_theme "$name" "$src/$path" "$from"
  fi
done < <(third_party)

# The layout last, once everything it names is in place.
mkdir -p "$DEST/layouts"
for f in "$REPO/layouts/$NAME".*; do
  rel="layouts/$(basename "$f")"
  if cmp -s "$f" "$DEST/$rel"; then echo "  layout  $(basename "$f") (already up to date)"; continue; fi
  echo "  layout  $(basename "$f")"
  [ "$DRY" = 1 ] && continue
  backup "$rel"
  cp "$f" "$DEST/$rel"
done

# Merges config/<file> into <home>/<file>: sections (keys.json's "global", settings' "sounds")
# merge key by key, values replace. Arg 2 = 1: only say what would change. Exit 3 = it would
# change something (and, unless only saying, it did).
merge_config() {
  python3 - "$REPO/config/$1" "$DEST/$1" "$2" <<'PY'
import json, os, sys
ours_path, theirs_path, dry = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
ours = json.load(open(ours_path))
theirs = json.load(open(theirs_path)) if os.path.exists(theirs_path) else {}
changed = []
def merge(a, b, path):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            merge(a[k], v, path + [k])
        elif a.get(k) != v:
            changed.append(".".join(path + [k]))
            a[k] = v
merge(theirs, ours, [])
print("  config  %s: %s" % (os.path.basename(theirs_path), ("%d value(s) set" % len(changed)) if changed else "already up to date"))
if changed and not dry:
    tmp = theirs_path + ".cyber-romo.tmp"
    with open(tmp, "w") as f:
        json.dump(theirs, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, theirs_path)
sys.exit(3 if changed else 0)
PY
}

# Keys and settings: merged, so whatever else that home has stays. Ours win on a clash.
if [ "$CONFIG" = 1 ]; then
  for f in keys.json settings.json programs.json; do
    [ -f "$REPO/config/$f" ] || continue
    # A first pass only says whether anything would change (exit 3), so only then is it backed up.
    if [ "$DRY" = 0 ] && ! merge_config "$f" 1 >/dev/null; then backup "$f"; fi
    merge_config "$f" "$DRY" || true
  done
else
  echo "  config  skipped (--no-config)"
fi

[ "$DRY" = 1 ] && { echo "Dry run: nothing changed."; exit 0; }

# Each mod must load; herdr-app reports the exact error otherwise.
if command -v herdr-app >/dev/null; then
  for m in "${MODS[@]}" $(third_party_names mod); do
    herdr-app check "$DEST/mods/$m" >/dev/null 2>&1 && echo "  check   $m ok" || warn "herdr-app check failed for $m: run 'herdr-app check $DEST/mods/$m'"
  done
  for f in layout keys settings programs; do
    [ -f "$DEST/$f.error" ] && warn "$DEST/$f.error: $(head -c 300 "$DEST/$f.error")"
  done
  if [ "$SWITCH" = 1 ]; then
    HERDR_APP_HOME="$DEST" herdr-app do layout.switch --name "$NAME" >/dev/null && echo "  shown   layout $NAME" || warn "could not switch (is the Herdr app running?)"
  fi
else
  warn "herdr-app is not on PATH: open the Herdr app once to check the mods"
fi

[ "$backed" = 1 ] && echo "Replaced files were backed up to $BACKUP"
echo "Done. Show it with cmd-shift-l (layout.switch), or: herdr-app do layout.switch --name $NAME"
