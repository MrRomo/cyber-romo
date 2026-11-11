import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, exec, openOverlay } from "herdr";

// Clone of Herdr's workspace-chrome (owner request 2026-11-11): the sidebar's top row shows the
// MrRomo brand logo (logo-sidebar.png: MrRomo_logo_v2_sidebar_360px.png as given,
// 360x93) instead of Herdr's logo and name; search, fold and the footer are unchanged.
const LOGO = "mods/brand-chrome/logo-sidebar.png";
const LOGO_ASPECT = 360 / 93;
const LOGO_HEIGHT = 38; // the brand row is 46px: 4px above and below
const BUTTON = 26, GAP = 4, PAD_RIGHT = 10;

// As tall as the row allows, narrower when the sidebar can't fit it beside the buttons
// (the macOS window buttons take the row's first 76px unless the window is fullscreen).
function logo(sidebarWidth, padLeft) {
  const room = sidebarWidth - padLeft - PAD_RIGHT - 2 * (BUTTON + GAP) - 2;
  const width = Math.max(0, Math.min(LOGO_HEIGHT * LOGO_ASPECT, room));
  return image(LOGO).id("brand-logo").flex_none().w(width).h(width / LOGO_ASPECT);
}

// The MrRomo splash (mods/brand-splash), the way Herdr 98 boots: when Herdr starts with a layout
// that has this row, and whenever such a layout shows again. A layout switch starts the layout's
// mods fresh, while this module stays loaded (shared by copies, even after they close) until its
// source changes, so `starts` counts the top rows started since it loaded: a second start is a
// switch. A first start is Herdr starting, the first switch to such a layout, or a reload of this
// file after an edit; "brand-splash.seen" (the layout and Herdr's start time at the last start)
// picks out the reload, which shows none. Turn it off with shared "brand-splash.enabled": false.
let starts = 0;

// Seconds since Herdr started (the parent of the shell `exec` runs), as Herdr 98 reads it.
async function appAge() {
  try {
    const r = await exec("sh", ["-c", 'ps -o etime= -p "$PPID"']);
    const m = r.stdout.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!m) return null;
    const [, d, h, mi, s] = m.map((x) => Number(x) || 0);
    return ((d * 24 + h) * 60 + mi) * 60 + s;
  } catch {
    return null;
  }
}

function splash(again) {
  return async () => {
    const age = await appAge();
    const name = shared("layout");
    const started = age === null ? null : Date.now() - age * 1000;
    const prev = shared("brand-splash.seen");
    setShared("brand-splash.seen", { layout: name, started });
    const reload = !again && started !== null && Number.isFinite(prev?.started)
      && Math.abs(prev.started - started) < 5000 && prev.layout === name;
    if (reload || shared("brand-splash.enabled") === false) return;
    openOverlay({ mod: "brand-splash", kind: "dialog", frame: "none", modal: true, width: 1, height: 1, props: { layout: name } });
  };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  init(_props, cx) {
    if (props()?.footer) return;
    starts += 1;
    cx.spawn(splash(starts > 1));
  }
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/brand-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      const ready = div().size(6).rounded_full().bg(t.accent);
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    const padLeft = window()?.platform === "macos" && !window()?.fullscreen ? 76 : 14;
    const sidebarWidth = find(layout(), "sidebar")?.size?.px ?? 268;
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : padLeft).pr(PAD_RIGHT).gap(GAP).items_center().text_size(13.5)
      .when(!collapsed, el => el.child(h_flex().flex_1().min_w(0).items_center().child(logo(sidebarWidth, padLeft))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/brand-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/brand-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
