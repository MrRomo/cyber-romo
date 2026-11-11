# Helpers for the third-party pieces (third-party.json). Sourced by install.sh and export.sh,
# after manifest.sh, with REPO set and FETCHED naming an empty scratch folder.

# One line per piece: name, kind (mod or theme), repo, commit, path, patch ("-" for none).
third_party() {
  python3 - "$REPO/third-party.json" <<'PY'
import json, sys
for e in json.load(open(sys.argv[1]))["items"]:
    print("\t".join([e["name"], e["kind"], e["repo"], e["commit"], e["path"], e.get("patch") or "-"]))
PY
}

# The names of the third-party pieces of one kind, space separated.
third_party_names() {
  third_party | awk -F'\t' -v k="$1" '$2 == k { printf "%s ", $1 }'
}

# Downloads GitHub repo $1 at commit $2 (once per run) and prints the folder it is in.
fetch() {
  local repo="$1" commit="$2"
  local dir="$FETCHED/${repo//\//__}-$commit"
  if [ ! -d "$dir" ]; then
    rm -rf "$dir.part"
    mkdir -p "$dir.part"
    if ! curl -fsSL "https://codeload.github.com/$repo/tar.gz/$commit" | tar xzf - -C "$dir.part" --strip-components 1; then
      rm -rf "$dir.part"
      return 1
    fi
    mv "$dir.part" "$dir"
  fi
  echo "$dir"
}

# Builds third-party mod $1 into folder $3 from the downloaded repo folder $2: its <path>,
# then its patch when it has one ($4 relative to the repo, "-" for none).
build_mod() {
  local path="$1" src="$2" out="$3" patch="$4"
  [ -d "$src/$path" ] || return 1
  rm -rf "$out"
  mkdir -p "$out"
  cp -R "$src/$path/." "$out/"
  if [ "$patch" != "-" ]; then
    patch -p1 -s -N -d "$out" < "$REPO/$patch" >/dev/null || return 2
    find "$out" \( -name '*.orig' -o -name '*.rej' \) -delete
  fi
}
