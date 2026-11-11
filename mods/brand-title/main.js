// The MrRomo title, before the tabs in the Mission Control top bar. A neon logo:
// "Mr" in electric yellow, "Romo" in electric blue, over an offset copy in the
// opposite colors (the engine has no text shadow). Font: fonts/Orbitrox-Black.otf is
// Orbitron Black with its family renamed: a running Herdr keeps the first face it loads
// for a family, and the OFL reserves the name "Orbitron" for the unmodified font.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, settings, theme, window as appWindow } from "herdr";

const YELLOW = "#ffee00";
const BLUE = "#00a8ff";
const EDGE = 12;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Room for the macOS window buttons, which float over the layout unless the window
// is fullscreen. The rule is the one mission-control-tabs uses for its own padding.
function leftPadding(root) {
  const win = appWindow();
  const x = Number(root?.traffic_lights?.[0]);
  if (win?.platform !== "macos" || win.titlebar !== "none" || win.fullscreen || !Number.isFinite(x)) return EDGE;
  return Math.ceil((x + 64) / (Number(settings()?.zoom) || 1));
}

const word = (first, second) => h_flex()
  .child(div().text_color(first).child("Mr"))
  .child(div().text_color(second).child("Romo"));

export default class BrandTitle extends View {
  render() {
    const t = theme(), root = layout(), left = leftPadding(root);
    // The block fits the title, measured once drawn: it needs more room when the window buttons show.
    const block = find(root, "mc-brand");
    if (block && this.textWidth) {
      const width = left + this.textWidth + EDGE;
      if (block.size?.px !== width) run("layout.resize", { id: "mc-brand", px: width });
    }
    return h_flex().size_full().min_w(0).pl(left).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().id("brand-text").relative().flex_none().font_family("Orbitrox").font_weight(900).text_size(16)
        .on_size_change((size, cx) => {
          const width = Math.ceil((size?.width ?? 0) / (Number(settings()?.zoom) || 1)); // reported zoomed
          if (width && width !== this.textWidth) { this.textWidth = width; cx.notify(); }
        })
        .child(div().absolute().left(1).top(1).opacity(0.55).child(word(BLUE, YELLOW)))
        .child(div().relative().child(word(YELLOW, BLUE))));
  }
}
