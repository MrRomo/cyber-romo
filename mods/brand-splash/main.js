// MrRomo splash: Matrix rain in electric yellow and blue behind the MrRomo logo (logo.png:
// MrRomo_logo_cyberpunk_v2.png trimmed, 2000x621) and a typed boot log, over the whole window for
// about four seconds, like Herdr 98's boot screen. A click or any key skips it.
//
// Opened by mods/brand-chrome (the sidebar's top row) when Herdr starts or a layout with that row
// shows. Replay it with `herdr-app do mod.open --name brand-splash`.
//
// Every motion runs natively; the script renders three times (sized, go, fade out). Rain falls by
// a `top` transition (one target change after the first frame; each drop has its own speed and
// delay), log lines type by a `width` transition on a clipping box, the progress bar lights by
// staggered `opacity` transitions, glyphs flicker with `frames`, the cursor and scan beam `loop`.
import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, shared, settings, agents } from "herdr";

const YELLOW = "#ffee00";
const BLUE = "#00a8ff";
const HEAD = { [YELLOW]: "#fffbd6", [BLUE]: "#dcf4ff" };
const BG = "#020308";
const LOGO = "mods/brand-splash/logo.png";
const LOGO_ASPECT = 2000 / 621;
const MONO = "Geist Mono";
const TITLE = "Orbitrox"; // loaded from mods/brand-title/fonts/
const GLYPHS = Array.from("ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789MR0X524D:=*+<>|");
const HEX = Array.from("0123456789ABCDEF");

const LANE = 20; // px between rain columns
const GLYPH_SIZE = 15;
const GLYPH_LINE = 19;
const DROPS = 3; // per column, each following the last part way down
const SHOW = 4400; // ms before it fades by itself
const FADE = 380;

const LOG_SIZE = 13;
const CHAR_W = LOG_SIZE * 0.6; // Geist Mono's advance
const ROW_CHARS = 46; // a log line: label, dot leader, status
const LABEL_CHARS = 32;
const TYPE_MS = 10; // per character
const LOG_START = 700;
const LOG_GAP = 90;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const alpha = (a) => Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
const hexes = (n, len) => Array.from({ length: n }, () => Array.from({ length: len }, () => pick(HEX)).join(""));

export default class BrandSplash extends View {
  init(_props, cx) {
    this.size = null;
    this.drops = null;
    this.go = false;
    this.out = false;
    this.focus = cx.focus_handle();
    this.focus.focus();
    const layout = String(props()?.layout ?? shared("layout") ?? "herdr");
    const n = agents().length;
    this.log = [
      ["LINKING HERDR CORE", "OK"],
      [`SPAWNING AGENTS [${n}]`, "OK"],
      [`LOADING LAYOUT ${layout.toUpperCase()}`, "OK"],
      ["NEURAL INTERFACE", "ONLINE"],
    ];
    this.clock = new Date().toTimeString().slice(0, 8);
    cx.timer.after(SHOW, (cx) => this.skip(cx));
  }

  skip(cx) {
    if (this.out) return;
    this.out = true;
    cx.notify();
    cx.timer.after(FADE, () => closeOverlay(props().overlay));
  }

  sized(size, cx) {
    const zoom = Number(settings()?.zoom) || 1; // reported zoomed, as mods/brand-title found
    const w = Math.round((size?.width ?? 0) / zoom), h = Math.round((size?.height ?? 0) / zoom);
    if (!w || !h || this.drops) return;
    this.size = { w, h };
    this.drops = this.rain(w, h);
    cx.notify();
    // Drawn once where everything starts; the next frame gives the targets the transitions run to.
    cx.timer.after(50, (cx) => { this.go = true; cx.notify(); });
  }

  // DROPS per column, each following the last part way down, so the rain keeps coming.
  rain(w, h) {
    const drops = [];
    for (let i = 0; i <= Math.ceil(w / LANE); i++) {
      let delay = rand(0, 1100);
      for (let k = 0; k < DROPS; k++) {
        const len = Math.floor(rand(7, 24));
        const start = -len * GLYPH_LINE - rand(0, h * 0.25);
        const end = h + 20;
        const duration = Math.round(((end - start) / rand(380, 1050)) * 1000);
        const glyphs = Array.from({ length: len }, (_, j) => ({
          ch: pick(GLYPHS),
          flicker: j === len - 1 || Math.random() < 0.3 ? Array.from({ length: 6 }, () => pick(GLYPHS)) : null,
          ms: Math.round(rand(60, 160)),
        }));
        drops.push({ id: `drop-${i}-${k}`, x: i * LANE, start, end, duration, delay: Math.round(delay), glyphs,
          color: Math.random() < 0.42 ? YELLOW : BLUE });
        delay += duration * rand(0.25, 0.6);
      }
    }
    return drops;
  }

  drop(d) {
    const len = d.glyphs.length;
    return v_flex().id(d.id).absolute().left(d.x).top(this.go ? d.end : d.start).w(LANE).items_center()
      .transition("top", { duration: d.duration, delay: d.delay, easing: "linear" })
      .children(d.glyphs.map((g, j) => {
        const head = j === len - 1;
        const color = head ? HEAD[d.color] : `${d.color}${alpha(0.12 + Math.pow((j + 1) / len, 1.6) * 0.8)}`;
        const el = div().h(GLYPH_LINE).text_color(color).child(g.ch);
        return g.flicker ? el.frames(g.flicker, g.ms) : el;
      }));
  }

  // The MrRomo logo slides up into place, with a ghost copy that jitters now and then.
  logo(width) {
    const height = width / LOGO_ASPECT;
    return div().id("logo").relative().w(width).h(height)
      .top(this.go ? 0 : 18).transition("top", { duration: 700, delay: 250, easing: "ease-out" })
      .opacity(this.go ? 1 : 0).transition("opacity", { duration: 600, delay: 250 })
      .child(image(LOGO).id("logo-ghost").absolute().top(0).left(0).w(width).h(height)
        .loop("left", { from: -5, to: 5, period: 260, easing: "linear" })
        .loop("opacity", { from: 0, to: 0.32, period: 1900 }))
      .child(image(LOGO).absolute().top(0).left(0).w(width).h(height));
  }

  bar(width) {
    const count = 36, gap = 3, seg = (width - gap * (count - 1)) / count;
    return h_flex().w(width).gap(gap).children(Array.from({ length: count }, (_, i) =>
      div().id(`seg-${i}`).w(seg).h(6).rounded(1).bg(i < count * 0.4 ? YELLOW : BLUE)
        .opacity(this.go ? 1 : 0.1).transition("opacity", { duration: 90, delay: Math.round(450 + i * (2300 / count)) })));
  }

  // "> LABEL . . . . OK", typed: a clipping box widens over a fixed-width row at TYPE_MS per
  // character. The leader is ". " repeated and clipped by flex: runs of dots are a ligature in
  // Geist Mono, narrower than their characters, so padding with dots doesn't line statuses up.
  lines() {
    const rowW = ROW_CHARS * CHAR_W;
    const duration = ROW_CHARS * TYPE_MS;
    let at = LOG_START;
    const rows = this.log.map(([label, status], i) => {
      const text = label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
      const delay = at;
      at += duration + LOG_GAP;
      return h_flex().h(20).child(div().id(`line-${i}`).overflow_hidden().whitespace_nowrap().flex_none()
        .w(this.go ? rowW : 0).transition("width", { duration, delay, easing: "linear" })
        .child(h_flex().w(rowW).flex_none()
          .child(div().flex_none().text_color(`${BLUE}d0`).child(`> ${text}`))
          .child(div().flex_1().min_w(0).overflow_hidden().px(6).text_color(`${BLUE}60`).child(". ".repeat(ROW_CHARS)))
          .child(div().flex_none().text_color(YELLOW).font_weight(700).child(status))));
    });
    // The cursor shows with the last line and stays, blinking.
    const ready = "> READY", readyMs = ready.length * TYPE_MS;
    rows.push(h_flex().h(20).items_center()
      .child(div().id("line-ready").overflow_hidden().whitespace_nowrap().flex_none().text_color(YELLOW)
        .w(this.go ? ready.length * CHAR_W + 2 : 0).transition("width", { duration: readyMs, delay: at, easing: "linear" })
        .child(ready))
      .child(div().id("cursor-show").ml(4).opacity(this.go ? 1 : 0).transition("opacity", { duration: 1, delay: at })
        .child(div().id("cursor").w(8).h(14).bg(YELLOW).loop("opacity", { from: 0, to: 1, period: 900, easing: "linear" }))));
    this.grantedAt = at + readyMs + 150;
    return v_flex().font_family(MONO).text_size(LOG_SIZE).children(rows);
  }

  // Yellow over an offset blue copy, as the sidebar wordmark used to be.
  granted() {
    const word = (color) => div().text_color(color).child("ACCESS GRANTED");
    return div().id("granted").relative().font_family(TITLE).font_weight(900).text_size(22)
      .opacity(this.go ? 1 : 0).transition("opacity", { duration: 220, delay: this.grantedAt ?? 3000 })
      .child(div().absolute().left(2).top(2).child(word(`${BLUE}c0`)))
      .child(div().relative().child(word(YELLOW)));
  }

  plate(w) {
    const width = Math.round(Math.min(w * 0.6, 900));
    const lines = this.lines(); // sets this.grantedAt
    return v_flex().items_center().gap(16).px(36).py(26).rounded(6).bg(`${BG}e6`).border(1).border_color(`${BLUE}38`)
      .child(h_flex().w(width).justify_between().font_family(MONO).text_size(11)
        .child(div().text_color(`${BLUE}b0`).child("HERDR // NEURAL LINK"))
        .child(div().text_color(`${YELLOW}c0`).frames(hexes(8, 8).map(s => `0x${s}`), 120).child("0x00000000")))
      .child(this.logo(width))
      .child(this.bar(width))
      .child(div().w(width).child(lines))
      .child(this.granted());
  }

  render() {
    const root = div().id("splash").size_full().relative().overflow_hidden().bg(BG).text_size(GLYPH_SIZE)
      .font_family(MONO).cursor_pointer()
      .track_focus(this.focus).on_key_down((_e, cx) => { this.skip(cx); cx.stop_propagation(); })
      .on_click((_e, cx) => this.skip(cx))
      .on_size_change((size, cx) => this.sized(size, cx))
      .opacity(this.out ? 0 : 1).transition("opacity", FADE);
    if (!this.size) return root;
    const { w, h } = this.size;
    return root
      .child(div().absolute().inset_0().children(this.drops.map((d) => this.drop(d))))
      // Scanlines and a slow scan beam over the rain.
      .child(div().absolute().inset_0().children(Array.from({ length: Math.ceil(h / 3) }, (_, i) =>
        div().absolute().left(0).top(i * 3).w(w).h(1).bg("#00000060"))))
      .child(div().id("beam").absolute().left(0).w(w).h(90).bg(`${BLUE}0c`)
        .loop("top", { from: -90, to: h, period: 5200, easing: "linear" }))
      .child(div().absolute().inset_0().flex().items_center().justify_center().child(this.plate(w)))
      .child(v_flex().absolute().top(18).right(24).items_end().font_family(MONO).text_size(11)
        .child(div().text_color(`${YELLOW}c0`).child(`MRROMO.SYS  ${this.clock}`))
        .child(div().text_color(`${BLUE}90`).child("SYS // ONLINE")))
      .child(v_flex().absolute().bottom(18).left(24).font_family(MONO).text_size(11).text_color(`${BLUE}80`)
        .children([0, 1, 2].map((i) => div().frames(hexes(10, 24), 90 + i * 30).child(""))))
      .child(div().absolute().bottom(20).left(0).w(w).flex().justify_center().font_family(MONO).text_size(11)
        .child(div().id("hint").px(10).py(3).rounded(3).bg(`${BG}d8`).text_color(`${BLUE}d0`)
          .loop("opacity", { from: 0.35, to: 1, period: 1400 })
          .child("CLICK OR PRESS ANY KEY TO SKIP")));
  }
}
