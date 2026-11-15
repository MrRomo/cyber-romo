// The gear's popup, opened with props { role: "settings", scope }: on the Manygit
// list, its scan depth, whether rows show their newest tag, and whether the shown
// repositories fetch in the background (off until ticked); on a repository's graph
// ("graph"), only the last. Each applies at once.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared } from "herdr";
import { DEPTH, depthOf } from "./repos.js";
import { icon } from "./menu.js";

export class Settings {
  init(cx) {
    this.state = InputState.new({ value: String(depthOf(shared("git-graph.depth"))) });
    this.valid = true;
    // A number from 1 to 5 applies as it's typed; anything else only turns the box red.
    this.state.on("change", (_e, cx) => {
      const text = this.state.value().trim(), n = Number(text);
      this.valid = /^\d+$/.test(text) && n >= DEPTH.min && n <= DEPTH.max;
      if (this.valid) setShared("git-graph.depth", n);
      cx.notify();
    });
    this.state.on("submit", () => { if (this.valid) closeOverlay(props().overlay); });
    // The graph's gear has no depth box to focus.
    if (props()?.scope === "graph") return;
    this.state.set_selected_range({ start: 0, end: this.state.value().length });
    this.state.focus();
    cx.timer.after(300, () => this.state.focus());
  }

  render() {
    const t = theme();
    const toggle = (id, key, label) => {
      const on = shared(key) === true;
      return h_flex().id(id).h(30).gap(10).items_center().cursor_pointer()
        .on_click((_e, cx) => { setShared(key, !on); cx.notify(); })
        .child(div().flex_1().font_medium().child(label))
        .child(div().size(15).mr(4).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.input).when(on, (e) => e.bg(t.accent))
          .flex().items_center().justify_center()
          .when(on, (e) => e.child(svg(icon("check")).size(11).text_color(t.accent_foreground))));
    };
    const graph = props()?.scope === "graph";
    return v_flex().id("git-graph-settings").size_full().p(12).gap(8).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .when(!graph, (e) => e.child(h_flex().h(30).gap(10).items_center()
        .child(div().flex_1().font_medium().child("Scan depth"))
        .child(Input.new(this.state).w(56).h(30).px(8).rounded(7).border_1().border_color(this.valid ? t.input : t.ansi1)
          .bg(t.background).text_size(12.8).text_color(t.foreground))))
      .when(!graph, (e) => e.child(toggle("gs-tags", "git-graph.tags", "Show tags")))
      .child(toggle("gs-autofetch", "git-graph.autofetch", "Fetch in the background"));
  }
}
