// Rename a space and choose its icon. Opened as a dialog with props { space: <id> } by
// spaces-icons (right-click > Rename, shift-f2) and by space-menu.
//
// The icon is kept in shared "space.icons" ({ <space id>: pick }), its color in shared
// "space.colors" (the one every avatar uses). A pick:
//   none                          Auto: the project's own icon (spaces-icons finds it), else the letter
//   { kind: "letter" }            the name's first letter, even when the project has an icon
//   { kind: "text", value }       one or two characters or an emoji
//   { kind: "glyph", value, tint } an icon from Herdr (icons/, mods/workspace-chrome/); tint: one color
//   { kind: "image", value }      a picture of your own, copied into data/space-rename/
// Enter saves, Esc cancels. An empty name gives the space Herdr's name back (after its folder).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, shared, setShared, appHome, home, window } from "herdr";
import * as fs from "fs/promises";

// The avatar colors, as spaces-icons draws them.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
// One-color glyphs Herdr ships for its own chrome, before its program icons.
const CHROME = ["folder", "terminal", "server", "monitor", "layers", "git-branch", "git-compare", "files", "file-text", "archive", "settings", "clock", "search", "pin", "square-pen", "circle-check", "sidebar", "square"];

const slash = (p) => (p ?? "").split("\\").join("/");

// User-perceived characters, so a flag or a family emoji counts as one.
function graphemes(s) {
  try { return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment); } catch (_) { return [...s]; }
}

// One-color art, to tint: it names no color of its own (no fill draws black). Brand marks
// (Simple Icons) are like that; Claude's mark, say, has its own.
function mono(svgText) {
  const values = [...svgText.matchAll(/(?:fill|stroke|stop-color)\s*[=:]\s*["']?\s*([^"';\s>)]+\)?)/gi)].map((m) => m[1].toLowerCase());
  return values.every((v) => ["none", "currentcolor", "transparent", "black", "#000", "#000000", "inherit"].includes(v));
}

// The UI font has no emoji and plain text doesn't fall back: draw them with the system's.
const EMOJI = { macos: "Apple Color Emoji", windows: "Segoe UI Emoji", linux: "Noto Color Emoji" };
function emojiFont(text) {
  try { return /\p{Extended_Pictographic}/u.test(text) ? EMOJI[window().platform] ?? null : null; } catch (_) { return null; }
}

function fillOf(color, t) {
  return color?.startsWith("#") ? color : (MARK[color] ?? t[color] ?? MARK.ansi6);
}

// A PNG's width from its header, 0 when it isn't one.
function pngWidth(b) {
  if (b.length < 24 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return 0;
  return ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// The avatar for a pick, as spaces-icons draws it (`found`: the project's own icon, if any).
export function avatar(t, { pick, found, name, color, size }) {
  const fill = fillOf(color, t);
  const r = Math.max(4, Math.round(size * 0.28));
  const box = () => h_flex().size(size).flex_none().rounded(r).items_center().justify_center();
  const kind = pick?.kind;
  if (kind === "image") return div().size(size).flex_none().rounded(r).overflow_hidden().child(image(pick.value).size(size));
  if (kind === "glyph") {
    return pick.tint
      ? box().bg(fill).child(svg(pick.value).size(Math.round(size * 0.64)).text_color("#ffffff"))
      : box().child(image(pick.value).size(Math.round(size * 0.9)));
  }
  if (kind === "text") {
    const two = graphemes(pick.value).length > 1;
    const font = emojiFont(pick.value);
    return box().bg(fill).text_color("#ffffff")
      .when(Boolean(font), (el) => el.font_family(font).text_size(size * (two ? 0.5 : 0.68)))
      .when(!font, (el) => el.font_bold().text_size(size * (two ? 0.46 : 0.58)))
      .child(pick.value);
  }
  if (kind !== "letter" && found) return div().size(size).flex_none().rounded(r).overflow_hidden().child(image(found).size(size));
  return box().bg(fill).text_size(size * 0.58).font_bold().text_color("#ffffff").child(graphemes(name || "?")[0]?.toUpperCase() ?? "?");
}

export default class SpaceRename extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.space = spaces().find((s) => s.id === p.space) ?? null;
    const name = this.space?.name ?? "";
    this.pick = (shared("space.icons") ?? {})[p.space] ?? null;
    this.color = (shared("space.colors") ?? {})[p.space] ?? "ansi6";
    this.error = null;
    this.query = "";
    this.icons = [];

    this.nameInput = InputState.new({ value: name });
    if (name) this.nameInput.set_selected_range({ start: 0, end: name.length });
    this.nameInput.on("change", (_e, cx) => cx.notify());
    this.nameInput.on("submit", (_e, cx) => this.later(cx, "save"));
    this.nameInput.focus();
    cx.timer.after(600, () => this.nameInput.focus());

    this.textInput = InputState.new({ placeholder: "A or 🚀", value: this.pick?.kind === "text" ? this.pick.value : "" });
    this.textInput.on("change", (_e, cx) => this.typed(cx));
    this.textInput.on("submit", (_e, cx) => this.later(cx, "save"));

    this.searchInput = InputState.new({ placeholder: "Search icons (docker, python, server…)" });
    this.searchInput.on("change", (_e, cx) => { this.query = this.searchInput.value().trim().toLowerCase(); cx.notify(); });

    this.imageInput = InputState.new({ placeholder: "~/Pictures/logo.png, or a path in the project" });
    this.imageInput.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.imageInput.on("submit", (_e, cx) => this.later(cx, "useImage"));

    this.handle = cx.focus_handle();
    this.busy = false;
    cx.spawn(async (cx) => this.loadIcons(cx));
  }

  // The text field: one or two characters (or emoji) become the icon; emptied, the letter.
  typed(cx) {
    const v = graphemes(this.textInput.value().trim()).slice(0, 2).join("");
    if (v) this.pick = { kind: "text", value: v };
    else if (this.pick?.kind === "text") this.pick = { kind: "letter" };
    cx.notify();
  }

  // Runs save / useImage off the event: they wait on files.
  later(cx, what) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try { await this[what](cx); } finally { this.busy = false; }
    });
  }

  // Herdr's chrome glyphs, then every program icon it ships (icons/*.svg).
  async loadIcons(cx) {
    const out = CHROME.map((n) => ({ name: n, value: `mods/workspace-chrome/${n}.svg`, tint: true }));
    const dir = `${slash(appHome())}/icons`;
    try {
      for (const f of (await fs.readdir(dir)).filter((f) => f.endsWith(".svg")).sort()) {
        let tint = false;
        try { tint = mono(await fs.readFile(`${dir}/${f}`, "utf8")); } catch (_) {}
        out.push({ name: f.replace(/\.svg$/, ""), value: `icons/${f}`, tint });
      }
    } catch (_) {}
    this.icons = out;
    cx.notify();
  }

  // Where a relative picture path starts: the space's folder now.
  folder() {
    const s = this.space;
    if (!s) return home();
    const tabs = new Set((s.tabs ?? []).map((c) => c.id));
    return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || home();
  }

  // The project icon spaces-icons found for this space (its "Auto"): the most specific of the
  // folders it searched that holds this space's folder.
  found() {
    const s = this.space;
    if (!s || s.machine) return null;
    if (props()?.found !== undefined) return props().found;
    const here = [slash(this.folder()), slash(s.folder)].map((p) => p.replace(/\/+$/, ""));
    let best = null;
    for (const [root, v] of Object.entries(shared("spaces-icons.found") ?? {})) {
      const icon = v && typeof v === "object" ? v.icon : v;
      if (!icon) continue;
      if (here.some((p) => p === root || p.startsWith(`${root}/`)) && (!best || root.length > best.root.length)) best = { root, icon };
    }
    return best?.icon ?? null;
  }

  // Copies the picture named in the image field into data/space-rename/ and picks it.
  // Resolves false (and says why) when it can't.
  async useImage(cx) {
    let path = this.imageInput.value().trim().replace(/^["']|["']$/g, "");
    if (!path) return true;
    if (path === "~" || path.startsWith("~/")) path = slash(home()) + path.slice(1);
    else if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path)) path = `${slash(this.folder())}/${path}`;
    const ext = path.toLowerCase().endsWith(".svg") ? "svg" : path.toLowerCase().endsWith(".png") ? "png" : null;
    const fail = (why) => { this.error = why; cx.notify(); return false; };
    if (!ext) return fail("Use an .svg or .png file.");
    let bytes;
    try { bytes = await fs.readFile(path); } catch (_) { return fail(`Can't read ${path}`); }
    if (ext === "png" && pngWidth(bytes) < 16) return fail("That PNG is smaller than 16 px.");
    const dir = `${slash(appHome())}/data/space-rename`;
    // Named by where it came from and when: a new picture at the same path shows at once.
    const name = `${hash(`${path}\n${Date.now()}`)}.${ext}`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(`${dir}/${name}`, bytes);
    } catch (_) { return fail("Can't copy it into the Herdr home."); }
    this.pick = { kind: "image", value: `data/space-rename/${name}`, from: path };
    this.imageInput.set_value("");
    this.error = null;
    cx.notify();
    return true;
  }

  async save(cx) {
    const s = this.space;
    if (!s) return closeOverlay(props()?.overlay);
    if (this.imageInput.value().trim() && !(await this.useImage(cx))) return;
    const old = shared("space.icons") ?? {};
    const icons = { ...old };
    if (!this.pick) delete icons[s.id];
    else icons[s.id] = this.pick;
    // Closed spaces of this computer lose theirs (now the spaces are surely loaded; another
    // machine's may just be away).
    const ids = new Set(spaces().map((x) => x.id));
    for (const id of Object.keys(icons)) if (!id.includes("/") && !ids.has(id)) delete icons[id];
    setShared("space.icons", icons);
    // Pictures no space shows any more go.
    const used = new Set(Object.values(icons).filter((v) => v?.kind === "image").map((v) => v.value));
    for (const v of Object.values(old)) {
      if (v?.kind === "image" && !used.has(v.value)) { try { await fs.unlink(`${slash(appHome())}/${v.value}`); } catch (_) {} }
    }
    const colors = { ...(shared("space.colors") ?? {}), [s.id]: this.color };
    for (const id of Object.keys(colors)) if (!id.includes("/") && !ids.has(id)) delete colors[id];
    setShared("space.colors", colors);
    const name = this.nameInput.value().trim();
    closeOverlay(props()?.overlay);
    // Unchanged, an unnamed space stays named after its folder.
    if (name !== s.name) run("space.rename", { id: s.id, name });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); }
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const s = this.space;
    const name = this.nameInput.value().trim() || s?.name || "";
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const field = (state) => Input.new(state).h(34).px(10).rounded(9).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((x) => x.opacity(0.88)).on_click(action).child(text);
    const same = (a, b) => (a?.kind ?? "auto") === (b?.kind ?? "auto") && (a?.value ?? null) === (b?.value ?? null);
    // A choice: a tile that shows what the avatar would be, ringed when chosen.
    const tile = (id, pick, body, tip) => div().id(id).p(3).rounded(8).border_2().cursor_pointer()
      .border_color(same(this.pick, pick) ? t.accent : "#00000000")
      .hover((x) => x.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => {
        this.pick = pick;
        if (pick?.kind !== "text") this.textInput.set_value("");
        cx.notify();
      })
      .child(body);
    const found = this.found();
    const q = this.query;
    const shown = q ? this.icons.filter((i) => i.name.includes(q)) : this.icons;

    if (!s) {
      return v_flex().p(18).bg(t.popover).text_color(t.foreground).child("That space is gone.")
        .child(h_flex().pt(16).justify_end().child(button("sr-close", "Close", true, () => closeOverlay(p.overlay))));
    }
    return v_flex().id("space-rename").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(avatar(t, { pick: this.pick, found, name, color: this.color, size: 26 }))
        .child(div().pl(10).flex_1().text_size(15).font_semibold().truncate().child("Rename space"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(label("Name"))
      .child(field(this.nameInput))
      .child(div().pt(5).text_size(11).text_color(t.dim).child("Empty: named after its folder again."))
      .child(label("Icon"))
      .child(h_flex().gap(4).items_center()
        .child(tile("sr-auto", null, h_flex().h(26).px(8).gap(6).items_center().text_size(12)
          .child(avatar(t, { pick: null, found, name, color: this.color, size: 20 })).child("Auto"), "The project's own icon, else the letter"))
        .child(tile("sr-letter", { kind: "letter" }, h_flex().h(26).px(8).gap(6).items_center().text_size(12)
          .child(avatar(t, { pick: { kind: "letter" }, name, color: this.color, size: 20 })).child("Letter"), "The name's first letter"))
        .child(div().w(10))
        .child(div().text_size(11.5).text_color(t.dim).child("Text"))
        .child(div().w(84).pl(6).child(Input.new(this.textInput).h(30).px(8).rounded(8).border_1()
          .border_color(this.pick?.kind === "text" ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))))
      .child(h_flex().pt(10).gap(6).items_center()
        .child(div().pr(4).text_size(11.5).text_color(t.dim).child("Color"))
        .children(PALETTE.map((c) => div().id(`sr-color-${c}`).size(20).rounded(10).bg(MARK[c]).cursor_pointer()
          .border_2().border_color(this.color === c ? t.foreground : "#00000000")
          .on_click((_e, cx) => { this.color = c; cx.notify(); }))))
      .child(div().pt(12).child(field(this.searchInput)))
      .child(div().id("sr-icons").mt(8).h(150).min_h(0).overflow_y_scroll().rounded(9).border_1().border_color(t.border).p(4)
        .child(h_flex().flex_wrap().gap(2)
          .children(shown.map((i) => tile(`sr-i-${i.value}`, { kind: "glyph", value: i.value, tint: i.tint },
            avatar(t, { pick: { kind: "glyph", value: i.value, tint: i.tint }, name, color: this.color, size: 24 }), i.name)))
          .when(this.icons.length > 0 && !shown.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("No icon by that name.")))))
      .child(label("Your own picture (.svg or .png)"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().child(field(this.imageInput)))
        .child(button("sr-use", "Use", false, (_e, cx) => this.later(cx, "useImage"))))
      .when(Boolean(this.error), (el) => el.child(div().pt(6).text_size(11.5).text_color(t.blocked ?? t.ansi1).child(this.error)))
      .when(this.pick?.kind === "image" && Boolean(this.pick.from), (el) => el.child(div().pt(6).text_size(11.5).text_color(t.dim).truncate().child(`Picture: ${this.pick.from}`)))
      .child(div().flex_1())
      .child(h_flex().pt(14).gap(8).justify_end()
        .child(button("sr-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("sr-save", "Save", true, (_e, cx) => this.later(cx, "save"))));
  }
}
