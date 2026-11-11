# Claude Code facts for the agents-claude mod, read-only: it never writes to Claude's files
# or a terminal. It stands alone (stdlib only, Python 3.6+, no files of its own) because the
# mod runs it as `python3 -c <this file> ...` on each machine, here or remote.
#
#   python3 -c <src> [ids...]       one run: print the state as JSON (the plan B poll)
#   python3 -c <src> --watch V [N]  the watcher: keep STATE_FILE current for N s (default 540),
#                                   V = the mod's copy of this source (its hash)
#
# The state: {"v": 2, "at": ms, "state": STATE_FILE, "agents": {
#   "<terminal id>": {"session", "status", "model", "effort", "ctx",
#                     "subagents": [{id, type, desc, model, effort, ctx, at, depth}]}}}
#
# A session is tied to its terminal by (1) `claude attach <job>` in the terminal (a
# background session lives in Claude's daemon, outside the terminal, and its
# HC_TERMINAL_ID is the daemon's launcher's, so only this counts for it), (2) the
# terminal's foreground pid, (3) HC_TERMINAL_ID in the claude process's environment
# (herdr-core sets it), (4) the terminal's shell among the process's ancestors.
#
# The watcher looks at file times every 250 ms and recomputes only what changed, writing
# STATE_FILE at most once a second (and every 15 s as a heartbeat). It never outlives its
# job: it exits at its deadline, when its parent goes (Herdr quit or the mod reloaded),
# when a newer copy asks it to, or after repeated errors. One per machine (a flock).
import fcntl
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
CFG = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
STATE_DIR = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "herdr-agents-claude")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
STALE = 30 * 60  # a sub-agent silent this long is gone (killed, or its parent quit)
TICK = 0.25  # s between looks at file times
MIN_WRITE = 1.0  # s between state writes while things keep changing
HEARTBEAT = 15.0  # s: rewrite the state even when nothing changed, so the mod knows we live
TERMS_EVERY = 3.0  # s between `hc ls` checks for new or gone terminals


def run(argv):
    try:
        return subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5).stdout.decode("utf-8", "replace")
    except Exception:
        return ""


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except Exception:
        return False


def mtime_size(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def terminal_ids(pids):
    """pid -> HC_TERMINAL_ID, from each process's environment."""
    out = {}
    if os.path.isdir("/proc"):
        for pid in pids:
            try:
                with open("/proc/%d/environ" % pid, "rb") as f:
                    env = f.read().split(b"\0")
            except Exception:
                continue
            for kv in env:
                if kv.startswith(b"HC_TERMINAL_ID="):
                    out[pid] = kv.split(b"=", 1)[1].decode()
        return out
    if not pids:
        return out
    # macOS: ps -E appends the environment to the command line.
    text = run(["ps", "-E", "-ww", "-o", "pid=,command=", "-p", ",".join(str(p) for p in pids)])
    for line in text.splitlines():
        parts = line.split()
        if not parts or not parts[0].isdigit():
            continue
        for tok in parts[1:]:
            if tok.startswith("HC_TERMINAL_ID="):
                out[int(parts[0])] = tok.split("=", 1)[1]
    return out


def find_hc():
    for c in (shutil.which("hc"), os.path.join(HOME, ".local/bin/hc"), "/usr/local/bin/hc"):
        if c and os.path.exists(c):
            return c
    return None


def listed_terminals(hc):
    """Addresses of this machine's live terminals (`hc ls`), or None without hc. `hc ls` also
    lists connected machines' terminals (`vps/t7`): those are their own watcher's, and an
    `hc get` of each would cross the network."""
    if not hc:
        return None
    try:
        listed = json.loads(run([hc, "ls", "--json"]) or "{}").get("terminals") or []
    except Exception:
        return None
    return sorted(t["address"] for t in listed if t.get("state") == "live" and t.get("address") and "/" not in t["address"])


def terminal_details(hc, addresses):
    """Shell pid and foreground {argv, pid} of each terminal (`hc get`)."""
    out = []
    for a in addresses:
        try:
            o = json.loads(run([hc, "get", a, "--json"]) or "{}")
        except Exception:
            continue
        out.append({"address": a, "pid": o.get("pid"), "fg": o.get("foreground") or {}})
    return out


def attached_job(argv):
    """`claude attach <job>` -> job, else None."""
    if not argv or os.path.basename(argv[0]) != "claude" or "attach" not in argv:
        return None
    i = argv.index("attach")
    return argv[i + 1] if i + 1 < len(argv) else None


def by_ancestry(pids, shells):
    """pid -> terminal id, the terminal whose shell is an ancestor of the pid."""
    if not shells:
        return {}
    parent = {}
    for line in run(["ps", "-A", "-o", "pid=,ppid="]).splitlines():
        p = line.split()
        if len(p) == 2 and p[0].isdigit() and p[1].isdigit():
            parent[int(p[0])] = int(p[1])
    out = {}
    for pid in pids:
        cur, hops = pid, 0
        while cur and cur > 1 and hops < 64:
            if cur in shells:
                out[pid] = shells[cur]
                break
            cur, hops = parent.get(cur), hops + 1
    return out


def status_word(s):
    """The session file's status as an agent status: working, blocked or idle."""
    s = (s or "").lower()
    if s in ("busy", "running", "working", "thinking"):
        return "working"
    if any(w in s for w in ("wait", "permission", "input", "block", "approv")):
        return "blocked"
    return "idle"


def lines_from_end(path):
    """The file's lines, last first, reading back in growing chunks."""
    size = os.path.getsize(path)
    seen = 0
    with open(path, "rb") as f:
        for chunk in (64 << 10, 512 << 10, 4 << 20, 16 << 20):
            start = max(0, size - chunk)
            f.seek(start)
            data = f.read(size - start)
            lines = data.split(b"\n")
            if start > 0:
                lines = lines[1:]  # cut mid-line
            fresh = lines[: len(lines) - seen] if seen else lines
            for raw in reversed(fresh):
                if raw.strip():
                    yield raw
            seen = len(lines)
            if start == 0:
                return


def usage_of(o):
    """(model, context tokens, effort) from an assistant entry; effort is null on versions that don't record it."""
    m = o.get("message") or {}
    u = m.get("usage")
    model = m.get("model")
    if not isinstance(u, dict) or not model or model.startswith("<"):
        return None
    ctx = sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
    if not ctx:
        return None  # an error or cancelled reply: it says nothing about the context
    return model, ctx, o.get("perTurnEffort") or o.get("effort")


CONTEXT_TOTAL = re.compile(r"\*\*Tokens:\*\*\s*([\d.]+)\s*([kKmM]?)\s*/")


def context_said(o):
    """The total a /context printed (its "**Tokens:** 62.2k / 1m"), or None."""
    m = o.get("message") or {}
    c = m.get("content")
    if o.get("type") != "user" or not isinstance(c, str) or not c.startswith("## Context Usage"):
        return None
    hit = CONTEXT_TOTAL.search(c[:400])
    if not hit:
        return None
    return int(float(hit.group(1)) * {"": 1, "k": 1e3, "m": 1e6}[hit.group(2).lower()])


def last_usage(path, main):
    """(model, context tokens, effort, compacted, said) from the last assistant entry. Newer than
    that reply there may be a compaction (compacted: what it says is left of the conversation,
    its postTokens) or a /context (said: the total it printed); either way the reply's tokens
    no longer hold."""
    compacted = said = None
    for raw in lines_from_end(path):
        late = main and compacted is None and said is None
        boundary = late and b'"compact_boundary"' in raw
        context = late and b"## Context Usage" in raw
        if not boundary and not context and b'"usage"' not in raw:
            continue
        try:
            o = json.loads(raw)
        except Exception:
            continue
        if boundary and o.get("type") == "system" and o.get("subtype") == "compact_boundary":
            compacted = (o.get("compactMetadata") or {}).get("postTokens") or 0
            continue  # the model and effort still come from the reply before it
        if context:
            said = context_said(o)
            if said is not None:
                continue
        if o.get("type") != "assistant" or (main and o.get("isSidechain")):
            continue
        got = usage_of(o)
        if got:
            return got + (compacted, said)
    return None, None, None, compacted, said


def overhead(path):
    """What a session holds besides its conversation (system prompt, tools, memory): its first
    reply's context, less what a compaction carried in when the transcript starts with one."""
    carried = 0
    try:
        with open(path, "rb") as f:
            for n, raw in enumerate(f):
                if n > 5000:
                    break
                if b'"compact_boundary"' not in raw and b'"usage"' not in raw:
                    continue
                try:
                    o = json.loads(raw)
                except Exception:
                    continue
                if o.get("type") == "system" and o.get("subtype") == "compact_boundary":
                    carried = (o.get("compactMetadata") or {}).get("postTokens") or 0
                elif o.get("type") == "assistant" and not o.get("isSidechain"):
                    got = usage_of(o)
                    if got:
                        return max(0, got[1] - carried)
    except Exception:
        pass
    return None


def finished(path):
    """A sub-agent is done once it hands back (SubagentHandback), ends its turn, or was interrupted."""
    later_prompt = False
    for raw in lines_from_end(path):
        try:
            o = json.loads(raw)
        except Exception:
            continue
        kind = o.get("type")
        m = o.get("message") or {}
        content = m.get("content")
        if kind == "user":
            texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"] if isinstance(content, list) else [content or ""]
            if any("Request interrupted" in t for t in texts):
                return True
            if texts and not any(isinstance(c, dict) and c.get("type") == "tool_result" for c in (content if isinstance(content, list) else [])):
                later_prompt = True  # a message after the end: it was resumed
            continue
        if kind != "assistant":
            continue
        if isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "SubagentHandback" for c in content):
            return not later_prompt
        if m.get("stop_reason") == "end_turn":
            return not later_prompt
        if m.get("stop_reason"):
            return False
    return False


def started(path):
    try:
        with open(path, "rb") as f:
            o = json.loads(f.readline())
        return o.get("timestamp") or ""
    except Exception:
        return ""


class Facts:
    """Everything the state needs, with caches so a watcher re-reads only what changed."""

    def __init__(self, wanted):
        self.wanted = wanted
        self.hc = find_hc()
        self.terms = None  # last `hc ls` addresses
        self.map_key = None
        self.mapping = {}  # terminal -> session dict
        self.paths = {}  # session id -> (transcript path or None, when looked)
        self.usage = {}  # path -> (mtime_size, (model, ctx, effort, estimated))
        self.base = {}  # transcript -> tokens a session holds besides its conversation
        self.subs = {}  # path -> (mtime_size, entry or None when finished)

    def sessions(self):
        out = []
        for path in glob.glob(os.path.join(CFG, "sessions", "*.json")):
            try:
                with open(path) as f:
                    s = json.load(f)
            except Exception:
                continue
            pid = s.get("pid")
            if isinstance(pid, int) and s.get("sessionId") and alive(pid):
                out.append(s)
        return out

    def refresh_terminals(self):
        self.terms = listed_terminals(self.hc)

    def map_sessions(self, sessions):
        """terminal -> session; redone only when the sessions or the terminals change."""
        key = (tuple(sorted((s["pid"], s["sessionId"], s.get("kind")) for s in sessions)), tuple(self.terms or ()))
        if key == self.map_key:
            return self.mapping
        terms = None
        if self.terms is not None:
            terms = terminal_details(self.hc, [a for a in self.terms if not self.wanted or a in self.wanted])
        known = None if terms is None else {t["address"] for t in terms}
        jobs, fg, shells = {}, {}, {}
        for t in terms or []:
            job = attached_job(t["fg"].get("argv"))
            if job:
                jobs[job] = t["address"]
            if t["fg"].get("pid"):
                fg[t["fg"]["pid"]] = t["address"]
            if t.get("pid"):
                shells[t["pid"]] = t["address"]
        direct = [s for s in sessions if s.get("kind") != "bg"]
        env = terminal_ids([s["pid"] for s in direct if s["pid"] not in fg])
        rest = [s["pid"] for s in direct if s["pid"] not in fg and (env.get(s["pid"]) not in known if known is not None else s["pid"] not in env)]
        up = by_ancestry(rest, shells) if rest else {}

        def terminal_of(s):
            if s.get("kind") == "bg":
                for job, a in jobs.items():
                    if s.get("jobId") == job or s["sessionId"].startswith(job):
                        return a
                return None
            pid = s["pid"]
            if pid in fg:
                return fg[pid]
            t = env.get(pid)
            if t and (known is None or t in known):
                return t
            return up.get(pid)

        # One session per terminal: an interactive or attached one over a `claude -p` it runs, then the oldest.
        best = {}
        for s in sessions:
            t = terminal_of(s)
            if not t or (self.wanted and t not in self.wanted):
                continue
            rank = (s.get("kind") not in ("interactive", "bg"), s.get("startedAt") or 0)
            if t not in best or rank < best[t][0]:
                best[t] = (rank, s["sessionId"])
        self.map_key = key
        self.mapping = {t: sid for t, (_, sid) in best.items()}
        return self.mapping

    def transcript(self, sid, now):
        path, looked = self.paths.get(sid, (None, 0))
        if path and os.path.exists(path):
            return path
        if now - looked < 5:  # a new session writes its transcript with its first message
            return None
        found = glob.glob(os.path.join(CFG, "projects", "*", sid + ".jsonl"))
        path = max(found, key=os.path.getmtime) if found else None
        self.paths[sid] = (path, now)
        return path

    def last_usage(self, path, main):
        ms = mtime_size(path)
        hit = self.usage.get(path)
        if hit and hit[0] == ms:
            return hit[1]
        model, ctx, effort, compacted, said = last_usage(path, main)
        est = False
        if said is not None:
            ctx = said  # a /context since the last reply: Claude's own count
        elif compacted is not None:
            # Compacted, no reply since: what's left plus the session's fixed part, as an estimate.
            if path not in self.base:
                self.base[path] = overhead(path)
            ctx, est = compacted + (self.base[path] or 0), True
        got = (model, ctx, effort, est)
        self.usage[path] = (ms, got)
        return got

    def subagents(self, transcript, now):
        folder = os.path.join(transcript[: -len(".jsonl")], "subagents")
        out = []
        for path in glob.glob(os.path.join(folder, "agent-*.jsonl")):
            ms = mtime_size(path)
            if not ms or now - ms[0] / 1e9 > STALE:
                continue
            hit = self.subs.get(path)
            if hit and hit[0] == ms:
                if hit[1]:
                    out.append(hit[1])
                continue
            entry = None
            if not finished(path):
                meta = {}
                try:
                    with open(path[: -len(".jsonl")] + ".meta.json") as f:
                        meta = json.load(f)
                except Exception:
                    pass
                model, ctx, effort, _ = self.last_usage(path, False)
                # Before its first reply: the model it was asked for (an alias such as "haiku"), or
                # the session's pick when it was launched with the defaults; the effort it was asked for.
                asked = meta.get("model") or (meta.get("pickedEffortModel") if meta.get("launchedWithDefaults") else None)
                entry = {
                    "id": os.path.basename(path)[len("agent-"): -len(".jsonl")],
                    "type": meta.get("agentType") or "agent",
                    "desc": meta.get("description") or "",
                    "model": model or asked,
                    "effort": effort or meta.get("effort"),
                    "ctx": ctx,
                    "at": int(ms[0] / 1e6),
                    "depth": meta.get("spawnDepth") or 1,
                    "started": started(path),
                }
            self.subs[path] = (ms, entry)
            if entry:
                out.append(entry)
        out.sort(key=lambda s: s["started"])
        return [{k: v for k, v in s.items() if k != "started"} for s in out]

    def state(self):
        now = time.time()
        sessions = self.sessions()
        if self.terms is None:
            self.refresh_terminals()
        by_id = {s["sessionId"]: s for s in sessions}
        agents = {}
        seen = set()
        for t, sid in self.map_sessions(sessions).items():
            s = by_id.get(sid)
            if not s:
                continue
            info = {"session": sid, "status": status_word(s.get("status")), "model": None, "effort": None, "ctx": None, "subagents": []}
            path = self.transcript(sid, now)
            if path:
                seen.add(path)
                info["model"], info["ctx"], info["effort"], est = self.last_usage(path, True)
                if est:
                    info["est"] = True
                info["subagents"] = self.subagents(path, now)
            agents[t] = info
        # Forget what's gone, so a watcher's caches stay as small as what it shows.
        live = {sid for sid in by_id}
        self.paths = {k: v for k, v in self.paths.items() if k in live}
        folders = tuple(p[: -len(".jsonl")] + "/subagents/" for p in seen)
        self.subs = {k: v for k, v in self.subs.items() if k.startswith(folders)}
        self.usage = {k: v for k, v in self.usage.items() if k in seen or k.startswith(folders)}
        self.base = {k: v for k, v in self.base.items() if k in seen}
        return {"v": 2, "at": int(now * 1000), "state": STATE_FILE, "agents": agents}

    def times(self):
        """What the state is read from, as file times: a change means a recompute."""
        out = []
        for f in sorted(glob.glob(os.path.join(CFG, "sessions", "*.json"))):
            out.append((f, mtime_size(f)))
        for path, _ in self.paths.values():
            if not path:
                continue
            out.append((path, mtime_size(path)))
            folder = path[: -len(".jsonl")] + "/subagents"
            out.append((folder, mtime_size(folder)))
            try:
                for e in os.scandir(folder):
                    if e.name.endswith(".jsonl"):
                        out.append((e.name, mtime_size(e.path)))
            except OSError:
                pass
        return hash(tuple(out))


def write_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = "%s.%d.tmp" % (STATE_FILE, os.getpid())
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def log_error(text):
    try:
        path = os.path.join(STATE_DIR, "error.log")
        old = ""
        if os.path.exists(path):
            with open(path) as f:
                old = f.read()[-8000:]
        with open(path, "w") as f:
            f.write(old + time.strftime("%Y-%m-%d %H:%M:%S ") + text.strip() + "\n")
    except Exception:
        pass


def watch(version, seconds):
    """Exit codes: 0 done (deadline, parent gone, asked to stop), 2 repeated errors,
    3 another watcher of this version runs, 4 asked an older watcher to stop."""
    os.makedirs(STATE_DIR, exist_ok=True)
    lock = open(os.path.join(STATE_DIR, "watch.lock"), "a+")
    stop_file = os.path.join(STATE_DIR, "stop")
    owner_file = os.path.join(STATE_DIR, "owner.json")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        try:
            with open(owner_file) as f:
                owner = json.load(f)
        except Exception:
            owner = {}
        if owner.get("version") == version:
            return 3
        with open(stop_file, "w") as f:
            f.write(version)
        return 4
    try:
        os.remove(stop_file)
    except OSError:
        pass
    with open(owner_file, "w") as f:
        json.dump({"pid": os.getpid(), "version": version, "since": int(time.time() * 1000)}, f)
    parent = os.getppid()
    deadline = time.monotonic() + seconds
    facts = Facts(set())
    errors = 0
    last_json = None
    last_write = 0.0
    last_terms = 0.0
    last_times = None
    dirty = True
    while True:
        now = time.monotonic()
        if now >= deadline or os.getppid() != parent or os.path.exists(stop_file):
            return 0
        try:
            if now - last_terms >= TERMS_EVERY:
                before = facts.terms
                facts.refresh_terminals()
                last_terms = now
                dirty = dirty or facts.terms != before
            t = facts.times()
            if t != last_times:
                last_times = t
                dirty = True
            beat = now - last_write >= HEARTBEAT
            if (dirty and now - last_write >= MIN_WRITE) or beat:
                state = facts.state()
                text = json.dumps(state["agents"], sort_keys=True)
                if text != last_json or beat:
                    write_state(state)
                    last_json = text
                    last_write = now
                dirty = False
                last_times = facts.times()  # state() may have found new transcripts
            errors = 0
        except Exception as e:
            errors += 1
            log_error("watch: %r" % (e,))
            if errors >= 5:
                return 2
        time.sleep(TICK)


def main():
    args = sys.argv[1:]
    if args and args[0] == "--watch":
        version = args[1] if len(args) > 1 else ""
        seconds = float(args[2]) if len(args) > 2 else 540.0
        sys.exit(watch(version, seconds))
    state = Facts(set(args)).state()
    json.dump(state, sys.stdout)


main()
