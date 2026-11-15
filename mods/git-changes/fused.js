// cyber-romo: the Changes panel's History tab is the git-graph mod.
//
// Both mods stay whole and sit in the same stack of the layout (cyber-romo's
// panel-body: files, changes, graph). When that stack holds a git-changes block
// and a git-graph block, each draws the same "Changes | History" strip on top,
// and a tab switches the stack to the other block. A mod can't import another
// mod's code: this is a copy of git-graph/fused.js's gitPanel(), showTab() and
// tabStrip(); keep the two alike.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, shared } from "herdr";

const modOf = (node) => (node?.type === "block" ? node.content?.mod : null);

// The stack holding both panels, as { stack, changes, graph, active } (ids), or null.
export function gitPanel(node = layout()) {
  if (!node) return null;
  if (node.type === "stack") {
    const kids = node.children ?? [];
    const changes = kids.find((c) => modOf(c) === "git-changes"), graph = kids.find((c) => modOf(c) === "git-graph");
    if (changes && graph) return { stack: node.id, changes: changes.id, graph: graph.id, active: node.active };
  }
  for (const child of node.children ?? []) { const found = gitPanel(child); if (found) return found; }
  return null;
}

// Shows one of the two tabs ("changes" or "history").
export function showTab(pair, tab) {
  if (pair) run("layout.select", { stack: pair.stack, child: tab === "history" ? pair.graph : pair.changes });
}

// The strip, drawn the same in both mods: 34 high, two halves, the shown one underlined.
// Without a git-graph beside it, only Changes.
export const TABS_H = 34;
export function tabStrip(t, { tab, changes, onPick, history = true }) {
  const item = (id, label) => div().id(`gc-tab-${id}`).flex_1().h_full().flex().items_center().justify_center().cursor_pointer().text_size(13)
    .text_color(tab === id ? t.foreground : t.muted).when(tab === id, (e) => e.border_b(2).border_color(t.accent)).hover((s) => s.text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { if (tab !== id) onPick(id, cx); }).child(label);
  return h_flex().h(TABS_H).flex_none().border_b(1).border_color(t.border)
    .child(item("changes", changes ? `Changes (${changes})` : "Changes"))
    .when(history, (e) => e.child(item("history", "History")));
}

// What History's Manygit list says of this folder (git-graph/fused.js publishManygit):
// { opened: the repository opened from the list, or null while the list shows; repos }, or
// null when the folder was never listed.
export const manygitOf = (cwd, on) => (cwd ? (shared("git-graph.manygit") ?? {})[`${on ?? ""}:${cwd}`] ?? null : null);
