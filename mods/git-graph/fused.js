// cyber-romo: the graph as the History tab of the Changes panel (git-changes).
//
// Both mods stay whole and sit in the same stack of the layout (cyber-romo's
// panel-body: files, changes, graph). When that stack holds a git-changes block
// and a git-graph block, each draws the same "Changes | History" strip on top,
// and a tab switches the stack to the other block. A mod can't import another
// mod's code, so git-changes/panel.js has its own copy of gitPanel() and the
// strip; keep the two alike.
//
// The graph's "View Diff" posts a commit to git-changes' diff tab in the main
// area, the way git-changes/diff.js showInTab() does (shared "git-changes.view",
// one tab per space holding a git-changes pane with props { role: "diff", space }).
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, shared, setShared, spaces } from "herdr";

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
export const TABS_H = 34;
export function tabStrip(t, { tab, changes, onPick }) {
  const item = (id, label) => div().id(`gc-tab-${id}`).flex_1().h_full().flex().items_center().justify_center().cursor_pointer().text_size(13)
    .text_color(tab === id ? t.foreground : t.muted).when(tab === id, (e) => e.border_b(2).border_color(t.accent)).hover((s) => s.text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { if (tab !== id) onPick(id, cx); }).child(label);
  return h_flex().h(TABS_H).flex_none().border_b(1).border_color(t.border)
    .child(item("changes", changes ? `Changes (${changes})` : "Changes"))
    .child(item("history", "History"));
}

// Opens `item` ({ area: "commit", hash, short, subject, author, when } or { area: "all" })
// of the repository at { root, on } in the active space's git-changes diff tab.
export function openDiff(item, source) {
  const space = spaces().find((s) => s.active);
  if (!space) return;
  const views = shared("git-changes.view") ?? {}, old = views[space.id];
  const tab = old?.tab && space.tabs.some((x) => x.id === old.tab) ? old.tab : null;
  const opening = !tab && old?.opening && Date.now() - old.opening < 1500;
  const live = new Set(spaces().map((s) => s.id));
  const kept = Object.fromEntries(Object.entries(views).filter(([id]) => live.has(id)));
  const name = item.area === "commit" ? item.short : "All changes";
  setShared("git-changes.view", { ...kept, [space.id]: { item, source, at: Date.now(), tab, opening: tab ? null : opening ? old.opening : Date.now() } });
  if (tab) { run("tab.rename", { id: tab, name }); run("tab.select", { id: tab }); }
  else if (!opening) run("tab.new", { space: space.id, name, mod: "git-changes", props: { role: "diff", space: space.id } });
}
