// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// agents-claude (a clone of the shipped `agents`): Claude Code rows get a second line with
// the model and the context tokens, and Claude's own sub-agents (in-process, no terminal)
// show under their parent while they work. claude-info.py reads them, read-only, from
// ~/.claude on the agent's machine, here or remote (it runs there as `python3 -c`).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, machines, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, exec, hc, readTextFile, appHome, watchFolder } from "herdr";

// The program-table entry for rows of our own whose pane shows something else.
// The expand/collapse toggle's slot: the 16 px button and 4 px to the icon.
const SLOT = 20;
const CLAUDE = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, tile: null, color: null, shell: false, agent: true };
// "vps/t7" -> ["vps", "t7"]; a bare address is this computer's (null).
const split = (address) => {
  const i = address.lastIndexOf("/");
  return i < 0 ? [null, address] : [address.slice(0, i), address.slice(i + 1)];
};

// A model id as people say it: claude-opus-5-5 -> Opus 5.5, claude-3-5-sonnet-20241022 -> Sonnet 3.5.
function modelName(id) {
  if (!id) return null;
  const parts = id.replace(/^claude-/, "").replace(/\[.*\]$/, "").split("-").filter((p) => !/^\d{8}$/.test(p));
  const family = parts.find((p) => !/^\d+$/.test(p));
  if (!family) return id;
  const version = parts.filter((p) => /^\d+$/.test(p)).join(".");
  return `${family[0].toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ""}`;
}

// A short hash of the helper's source: a watcher of another version is asked to stop.
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function tokens(n) {
  if (n < 1000) return String(n);
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

// The second line: "Opus 5.5 · xhigh · 128k tokens" (the effort only where Claude records
// it), or null when there's nothing to say. "~" marks an estimate: a session compacted since
// its last reply.
function facts(info) {
  const ctx = info?.ctx != null ? `${info.est ? "~" : ""}${tokens(info.ctx)} tokens` : null;
  const bits = [modelName(info?.model), info?.effort || null, ctx].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
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

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
// A Claude sub-agent is listed only while it works.
const subStatus = (s, listed) => (s.c ? "working" : kidStatus(s.t, listed));
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    // Folded agents and groups, kept across reloads.
    try { this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]")); } catch (_) { this.folded = new Set(); }
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    // Claude facts by agent address, and per machine ("" here) how they reach us (machineState).
    this.claude = {};
    this.claudeJson = "{}";
    this.machines = {};
    // Rows of our own (withClaude): each one's last session status, and the finished-unseen ones.
    this.sessionWas = {};
    this.unseen = new Set();
    cx.spawn(async (cx) => {
      this.py = await readTextFile(`${appHome()}/mods/agents-claude/claude-info.py`);
      this.version = this.py ? hash(this.py) : null;
      this.tickClaude(cx);
    });
    cx.timer.every(1000, (cx) => this.tickClaude(cx));
  }

  // Ask the watchers to stop (Herdr quits, or this copy goes). They'd stop by themselves anyway:
  // a local one when its parent goes, any one at its deadline.
  async close(_cx) {
    for (const m of Object.values(this.machines ?? {})) {
      if (!m.dir) continue;
      try { await exec("sh", ["-c", `touch "${m.dir}/stop"`], { on: m.machine, timeout: 2000 }); } catch (_) {}
    }
  }

  // Each machine with spaces (this computer always) runs one claude-info.py watcher that keeps
  // its state file current; we read that file: here at once when it changes (watchFolder),
  // on another machine every 1 s while a Claude there works, else every 3 s (Herdr reads it
  // over its connection, no program runs there). A background session (`claude attach`)
  // reports no status, so Herdr doesn't list it among agents(): the state does.
  // When the watcher fails, it's relaunched after 2, 4, 8 ... 60 s; after 3 failures in a row
  // that machine falls back to one run every 5 s (10 s when idle), and tries the watcher
  // again 5 min later. A machine that isn't up (see up()) is left alone, its facts dropped,
  // and starts over (first contact, then its watcher) once it's back.
  tickClaude(cx) {
    const now = Date.now();
    const remote = [...new Set(spaces().map((s) => s.machine).filter(Boolean))];
    const down = remote.filter((name) => !this.up(name));
    // How each machine's connection is: every 15 s, every 3 s while one is down to see it return.
    if (remote.length && !this.reaching && now - (this.reachAt ?? 0) >= (down.length ? 3000 : 15000)) this.refreshReach(cx);
    const downKey = down.join("\n");
    if (downKey !== (this.downKey ?? "")) {
      this.downKey = downKey;
      cx.notify();
    }
    for (const name of down) {
      if (this.machines[name]) delete this.machines[name];
      if (Object.keys(this.claude).some((k) => split(k)[0] === name)) this.applyClaude(cx, name, {});
    }
    if (!this.py) return;
    const groups = new Map([["", { machine: null, working: false }]]);
    for (const name of remote) if (!down.includes(name)) groups.set(name, { machine: name, working: false });
    const groupOf = (address) => groups.get(split(address)[0] ?? "");
    for (const a of agents()) if (a.status === "working" && groupOf(a.address)) groupOf(a.address).working = true;
    for (const [address, info] of Object.entries(this.claude)) {
      if ((info.status === "working" || info.subagents?.length) && groupOf(address)) groupOf(address).working = true;
    }
    for (const [key, g] of groups) {
      if (!this.machines[key]) {
        this.machines[key] = { machine: g.machine, mode: "watch", path: null, dir: null, launching: false, retryAt: 0, failures: 0, quick: 0, back: 0, pollAt: 0, polling: false, readAt: 0, reading: false, watching: false, seenAt: 0 };
      }
      const m = this.machines[key];
      const stale = m.seenAt && now - m.seenAt > 45000; // the watcher writes at least every 15 s
      // The plan B poll: also the first contact (it says where the state file is) and the stopgap
      // while the watcher's file is stale.
      if (m.mode === "poll" || !m.path || stale) {
        if (!m.polling && now >= m.pollAt && now >= m.retryAt) this.pollClaude(cx, m, g.working);
        if (m.mode === "poll" && now >= m.back) Object.assign(m, { mode: "watch", failures: 0, quick: 0 });
        if (!m.path) continue;
      }
      if (m.mode !== "watch") continue;
      if (!m.launching && now >= m.retryAt) this.launchWatcher(cx, m);
      if (!m.machine) {
        if (!m.watching && m.seenAt) this.watchLocal(cx, m);
        if (now - m.readAt >= 5000) this.readState(cx, m); // in case a change slipped by
      } else if (now - m.readAt >= (g.working ? 1000 : 3000) - 100) {
        this.readState(cx, m);
      }
    }
  }

  // Whether a machine's agents mean anything now. This computer's always do. Herdr keeps an
  // unreachable machine's last spaces and agents on screen (as they were when it went), so
  // another machine counts only while its core answers (`hc machine ls`: "connected") and its
  // layout is loaded (machines(): "ready").
  up(machine) {
    if (!machine) return true;
    const state = this.reach?.[machine];
    if (state && state !== "connected") return false;
    const doc = machines().find((m) => m.name === machine)?.layout;
    return !doc || doc === "ready";
  }

  refreshReach(cx) {
    this.reaching = true;
    this.reachAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) {
          const next = {};
          for (const m of JSON.parse(r.stdout).machines ?? []) next[m.name] = m.state;
          const json = JSON.stringify(next);
          if (json !== this.reachJson) {
            this.reach = next;
            this.reachJson = json;
            cx.notify();
          }
        }
      } catch (_) {}
      this.reaching = false;
    });
  }

  // A failed launch or poll: back off 2, 4, 8 ... 60 s; the third in a row turns on plan B.
  failed(m) {
    m.failures += 1;
    m.retryAt = Date.now() + Math.min(60000, 1000 * 2 ** m.failures);
    if (m.mode === "watch" && m.failures >= 3) Object.assign(m, { mode: "poll", back: Date.now() + 300000, pollAt: 0 });
  }

  launchWatcher(cx, m) {
    m.launching = true;
    const started = Date.now();
    cx.spawn(async (cx) => {
      let code = null;
      try {
        code = (await exec("python3", ["-c", this.py, "--watch", this.version, "540"], { on: m.machine, timeout: 560000 })).code;
      } catch (_) {}
      m.launching = false;
      const now = Date.now();
      if (code === 0) {
        // Its normal end (deadline, asked to stop). Ending again and again within seconds is a bug.
        m.quick = now - started < 5000 ? m.quick + 1 : 0;
        if (m.quick >= 3) this.failed(m);
        else m.retryAt = now;
      } else if (code === 3) {
        m.retryAt = now + 30000; // one of this version runs already (another copy, another screen): read its file
      } else if (code === 4) {
        m.retryAt = now + 1000; // an older one was asked to stop: take over in a moment
      } else {
        this.failed(m);
      }
    });
  }

  // Here: read the state as soon as its folder changes. A missing folder ends the loop; the tick restarts it.
  watchLocal(cx, m) {
    m.watching = true;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(m.dir);
          await this.readState(cx, m);
        }
      } catch (_) {}
      m.watching = false;
    });
  }

  async readState(cx, m) {
    if (m.reading) return;
    m.reading = true;
    m.readAt = Date.now();
    try {
      const text = await readTextFile(m.path, { on: m.machine });
      const state = text ? JSON.parse(text) : null;
      if (state?.agents) {
        // When its heartbeat last moved, by our clock: the machine's own clock may differ.
        if (state.at !== m.lastAt) Object.assign(m, { lastAt: state.at, seenAt: Date.now() });
        m.failures = 0;
        this.applyClaude(cx, m.machine, state.agents);
      }
    } catch (_) {}
    m.reading = false;
  }

  pollClaude(cx, m, working) {
    m.polling = true;
    m.pollAt = Date.now() + (working ? 5000 : 10000);
    cx.spawn(async (cx) => {
      let state = null;
      try {
        const out = await exec("python3", ["-c", this.py], { on: m.machine, timeout: 15000 });
        if (out.code === 0) state = JSON.parse(out.stdout || "{}");
      } catch (_) {}
      m.polling = false;
      if (!state?.agents) return this.failed(m);
      if (state.state && !m.path) Object.assign(m, { path: state.state, dir: state.state.replace(/\/[^/]+$/, "") });
      if (m.mode === "poll") m.failures = 0;
      this.applyClaude(cx, m.machine, state.agents);
    });
  }

  applyClaude(cx, machine, agentsHere) {
    const next = {};
    for (const [k, v] of Object.entries(this.claude)) if (split(k)[0] !== machine) next[k] = v;
    for (const [id, info] of Object.entries(agentsHere)) next[machine ? `${machine}/${id}` : id] = info;
    const json = JSON.stringify(next);
    if (json === this.claudeJson) return;
    this.claude = next;
    this.claudeJson = json;
    cx.notify();
  }

  // Claude sessions Herdr doesn't list (an attached background session reports no status)
  // get rows of their own, in space and tab order, with the session's status.
  withClaude(list, all) {
    const listed = new Set(list.map((a) => a.address));
    const extra = Object.entries(this.claude).filter(([address, info]) => !listed.has(address) && info.status);
    if (!extra.length) return list;
    const byTerminal = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p]));
    const where = new Map();
    for (const s of spaces()) for (const tab of s.tabs) where.set(tab.id, { s, tab, order: s.index * 1000 + tab.index });
    const labels = new Map(all.map((k) => [k.address, k.labels ?? {}]));
    const out = [...list];
    for (const [address, info] of extra) {
      const p = byTerminal.get(address);
      const w = p && where.get(p.tab);
      if (!w) continue; // no pane here (a parked or sub-agent terminal)
      out.push({
        address,
        pane: p.pane,
        space: w.s.id,
        space_name: w.s.name,
        tab: w.tab.id,
        tab_index: w.tab.index,
        tab_name: w.tab.name,
        status: this.sessionStatus(address, info.status, p.focused),
        app: "claude-code",
        program: p.program?.key === "claude" ? p.program : CLAUDE,
        title: p.title,
        seq: 0,
        pinned: Boolean(labels.get(address)?.["herdr.pinned"]),
        focused: p.focused,
      });
    }
    // agents() is in space, tab, pane order; a stable sort keeps that within a tab.
    return out.sort((x, y) => (where.get(x.tab)?.order ?? 0) - (where.get(y.tab)?.order ?? 0));
  }

  // As Herdr's: "done" = it finished while you weren't looking; it's idle once you look.
  sessionStatus(address, s, focused) {
    const was = this.sessionWas[address];
    this.sessionWas[address] = s;
    if (s !== "idle" || focused) this.unseen.delete(address);
    else if (was && was !== "idle") this.unseen.add(address);
    return this.unseen.has(address) ? "done" : s;
  }

  toggleFold(id) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    try { localStorage.setItem("folded", JSON.stringify([...this.folded].slice(-200))); } catch (_) {}
  }

  // Claude's in-process sub-agents first, then sub-agent terminals, as one tree.
  kids(all, addr) {
    const ts = this.tree(all, addr);
    const cs = this.claude?.[addr]?.subagents ?? [];
    return [...cs.map((c, i) => ({ c, lines: [i === cs.length - 1 && !ts.length ? "└" : "├"] })), ...ts];
  }

  // A Claude sub-agent: its type and task, time since it last wrote; model and tokens below.
  claudeSubRow(t, s, parent, compact) {
    const c = s.c;
    const pic = icon(parent.program, 14, t.foreground);
    const more = facts(c);
    return v_flex()
      .id(`csub-${parent.address}-${c.id}`)
      .pl(39 + (this.indent ?? 0))
      .pr(8)
      .pb(more ? 4 : 0)
      .rounded(8)
      .flex_none()
      .text_size(12.5)
      .hover((el) => el.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: parent.pane }))
      .child(h_flex()
        .h(26)
        .items_center()
        .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
          .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
          .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
        .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().flex_none().max_w(130).truncate().text_color(t.muted).child(c.type))
          .when(Boolean(c.desc), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`· ${c.desc}`))))
        .when(Boolean(c.at), el => el.child(div().flex_none().ml(6).text_size(11).text_color(t.dim).child(duration(Date.now() - c.at))))
        .child(div().ml(6).child(this.status(t, { status: "working" }, compact))))
      .when(Boolean(more), el => el.child(div().mt(-5).pl(s.lines.length * 13 + (pic ? 22 : 0)).text_size(11).text_color(t.dim).truncate().child(more)));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    const more = facts(this.claude?.[k.address]);
    const frame = (el) => el
      .id(`sub-${k.address}`)
      .pl(39 + (this.indent ?? 0))
      .pr(8)
      .rounded(8)
      .flex_none()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)));
    const line = (el) => el
      .h(26)
      .gap(0)
      .items_center()
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
    if (!more) return line(frame(h_flex()));
    return frame(v_flex())
      .pb(4)
      .child(line(h_flex()))
      .child(div().mt(-5).pl(s.lines.length * 13 + (pic ? 22 : 0)).text_size(11).text_color(t.dim).truncate().child(more));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    const all = terminals();
    // Not an unreachable machine's: Herdr still lists them, frozen as they were.
    let list = this.withClaude(agents(), all).filter((a) => this.up(split(a.address)[0]));
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.kids(all, a.address).map((s) => RANK[subStatus(s, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    // Each row's children, once. While any row has some, every row keeps the toggle's slot,
    // so the icons line up; the sub-agent rows move over by as much (this.indent).
    const kidsOf = new Map(list.map((a) => [a.address, collapsed ? [] : this.kids(all, a.address)]));
    const slot = [...kidsOf.values()].some((k) => k.length > 0);
    this.indent = slot ? SLOT : 0;
    const withKids = (a, i) => {
      const subs = kidsOf.get(a.address) ?? [];
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => (s.c ? this.claudeSubRow(t, s, a, byPriority) : this.subRow(t, s, shown, byPriority)))];
    };

    // Expand / collapse an agent's children; only on rows that have some.
    const toggle = (a) => {
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .size(16)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(4)
        .text_color(t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(open ? "Collapse sub-agents" : "Expand sub-agents")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.toggleFold(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12));
    };
    // Collapsed: how many are hidden, colored by the most urgent of them.
    const hidden = (subs) => {
      const top = subs.map((s) => subStatus(s, this.listed)).reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      return div()
        .flex_none()
        .h(16)
        .px(5)
        .rounded(8)
        .flex()
        .items_center()
        .bg(t.raised)
        .text_size(10.5)
        .text_color(top && top !== "idle" ? (t[top] ?? t.dim) : t.dim)
        .child(String(subs.length));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      // Claude Code: model and context tokens on a second line, under the name.
      const second = facts(this.claude?.[a.address]);
      const frame = (el) => el
        .id(`ag-${a.address}`)
        .px(8)
        .flex_none()
        .rounded(8)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }));
      const line = (el) => el
        .items_center()
        .gap(9)
        .when(slot || Boolean(pic), el => el.child(h_flex().flex_none().gap(SLOT - 16).items_center()
          .when(slot, el => el.child(subs.length > 0 ? toggle(a) : div().w(16).flex_none()))
          .when(Boolean(pic), el => el.child(pic))))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0 && this.folded.has(a.address), el => el.child(hidden(subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
      if (!second) return line(frame(h_flex()).h(30));
      return frame(v_flex())
        .pt(4)
        .pb(5)
        .child(line(h_flex()).h(22))
        .child(div().pl((slot ? SLOT : 0) + (pic ? 25 : 0)).text_size(11).text_color(t.dim).truncate().child(second));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.toggleFold(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "agents-claude", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
