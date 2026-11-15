// Changes, as a working git panel after Zed's: stage with checkboxes, commit,
// stash, push and pull, and the diff of what's picked; its History tab is
// the git-graph mod beside it (fused.js).
// One mod, three roles (props.role): the panel, its menus (popups over the
// window), and the diff, shown in a tab of the main area.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Panel } from "./panel.js";
import { Menu } from "./menu.js";
import { DiffView } from "./diff.js";

export default class GitChanges extends View {
  init(_props, cx) {
    const role = props()?.role;
    this.part = role === "menu" ? new Menu() : role === "diff" ? new DiffView() : new Panel();
    this.part.init(cx);
  }

  render(cx) { return this.part.render(cx); }
}
