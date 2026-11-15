# What the cyber-romo package is made of. Sourced by export.sh and install.sh.

NAME="cyber-romo"

# The live layout this package is exported from (layouts/<it>.json in the Herdr home);
# it is installed as layouts/cyber-romo.json.
LAYOUT_SRC="${LAYOUT_SRC:-catppuccin}"

# Mods that travel in this repo: cyber-romo's own and third-party ones with a license.
MODS=(
  agents-claude   # own: agents list with model · effort · context tokens and Claude sub-agents
  brand-chrome    # own (clone of Herdr's workspace-chrome): the MrRomo title bar
  brand-title     # own: the Orbitrox font brand-chrome and brand-splash draw with (Orbitron, OFL)
  brand-splash    # own: the MrRomo splash brand-chrome opens
  space-rename    # own: rename a space and choose its icon (auto, letter, text/emoji, Herdr's icons, a picture) and color
  space-menu      # own (copy of Herdr's menu): a space's right-click menu whose Rename opens space-rename
  git-graph       # third-party, MIT: github.com/rabeeh-ta/herdr-git-graph + PR #15 (licenses/git-graph-MIT.txt); the Changes panel's History tab (fused.js)
  git-changes     # third-party, MIT (+ Apache-2.0, ISC parts): github.com/aBER0724/herdr-git-changes (licenses/git-changes/); the Changes panel, its History is git-graph
)

# Third-party mods and themes with no license (file-editor, spaces-icons, tabs-graph, the
# catppuccin themes) are NOT in this repo: third-party.json says where each comes from, and
# install.sh downloads it, applies cyber-romo's patch (patches/) and copies in the files this
# repo adds to it (file-editor's Mermaid renderer, vendor/beautiful-mermaid).

# Herdr's own mods the package uses. Every Herdr install ships them; they are never copied.
SHIPPED=(workspace-chrome workspace-status pane changes files menu new-menu toast confirm prompt peek help worktree machine-add)

# Files Herdr writes into every mod folder by itself (and editor junk): never copied.
EXCLUDES=(gpui-kit.d.ts jsconfig.json .DS_Store node_modules "*.error")
