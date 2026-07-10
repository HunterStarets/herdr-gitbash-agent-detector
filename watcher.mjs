// Persistent singleton watcher for Herdr Git-Bash panes.
//
// Herdr's native Windows foreground-process detection cannot see past a
// Git-Bash pane's outer bash.exe wrapper (MSYS child processes never show
// up in whatever console-process enumeration Herdr uses on Windows), so
// opencode.exe running inside a Git-Bash pane is invisible to it. This
// watcher fills that gap by:
//   1. Finding panes Herdr has NOT natively detected an agent for.
//   2. Checking if that pane's shell is bash.exe (a candidate).
//   3. Walking the real Windows process tree (WMI) for an opencode.exe
//      descendant of that shell.
//   4. Reading the pane's visible screen text for a simple regex marker
//      ("esc interrupt") to distinguish working vs idle.
//   5. Reporting via `herdr pane report-agent` / `release-agent`, which
//      becomes the authoritative state source for that pane.
//
// Started via a `pane.created` event hook (see herdr-plugin.toml). Guards
// itself with a pid-lock file so only one instance runs at a time - every
// subsequent pane.created firing spawns a throwaway process that detects
// the lock and exits immediately.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { paneList, paneProcessInfo, paneRead, reportAgent, releaseAgent } from "./lib/herdrcli.mjs";
import { snapshotProcesses, findDescendantPid } from "./lib/proctree.mjs";

const POLL_INTERVAL_MS = 1500;
const TARGET_PROCESS = "opencode.exe";
const WORKING_PATTERN = /esc interrupt/i;

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || ".";
fs.mkdirSync(stateDir, { recursive: true });
const lockPath = path.join(stateDir, "watcher.lock");

// pane_id -> { shellPid, opencodePid, reporting: bool, lastState: "idle"|"working"|null }
const watched = new Map();
// opencode.exe pids observed on the PREVIOUS poll tick - used to restrict
// elimination-matching to pids that just appeared, never to long-lived
// pre-existing processes unrelated to any pane we're tracking (e.g. other
// standalone opencode sessions, or this very watcher's own ancestry).
let previousOpencodePids = new Set();

function isPidAlive(pid) {
  const res = spawnSync("powershell", [
    "-NoProfile", "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { "yes" } else { "no" }`,
  ], { encoding: "utf8" });
  return (res.stdout || "").trim() === "yes";
}

function tryAcquireSingletonLock() {
  if (fs.existsSync(lockPath)) {
    const prevPid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (prevPid && isPidAlive(prevPid)) {
      return false; // another watcher is already running
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return true;
}

if (!tryAcquireSingletonLock()) {
  process.exit(0);
}

// Baseline: snapshot pre-existing opencode.exe pids at startup so the first
// real poll tick doesn't mistake an unrelated, already-running session for
// a "newly appeared" one during elimination-matching.
{
  const baseline = snapshotProcesses();
  for (const proc of baseline.values()) {
    if (proc.name?.toLowerCase() === TARGET_PROCESS) previousOpencodePids.add(proc.pid);
  }
}

function classifyPane(pane) {
  // Herdr already knows about this pane's agent natively (e.g. PowerShell
  // panes) - nothing for us to do.
  if (pane.agent) return false;
  const info = paneProcessInfo(pane.pane_id);
  const shellName = info?.foreground_processes?.[0]?.name?.toLowerCase() ?? "";
  return shellName === "bash.exe" || shellName === "sh.exe";
}

function refreshWatchList() {
  const panes = paneList();
  const currentIds = new Set(panes.map((p) => p.pane_id));

  // Drop panes that no longer exist.
  for (const paneId of [...watched.keys()]) {
    if (!currentIds.has(paneId)) {
      const w = watched.get(paneId);
      if (w.reporting) releaseAgent(paneId);
      watched.delete(paneId);
    }
  }

  // Add newly-discovered Git-Bash candidate panes.
  for (const pane of panes) {
    if (watched.has(pane.pane_id)) continue;
    if (!classifyPane(pane)) continue;
    const info = paneProcessInfo(pane.pane_id);
    watched.set(pane.pane_id, {
      shellPid: info.shell_pid,
      opencodePid: null,
      reporting: false,
      lastState: null,
    });
  }
}

function pollOnce() {
  refreshWatchList();
  if (watched.size === 0) return;

  const byPid = snapshotProcesses();

  // Track every opencode.exe pid already claimed by some pane (ours or
  // Herdr's own native detection) so the elimination fallback below never
  // double-assigns a pid that's already accounted for.
  const claimedPids = new Set();
  for (const w of watched.values()) {
    if (w.opencodePid != null) claimedPids.add(w.opencodePid);
  }

  const pendingPanes = [];
  for (const [paneId, w] of watched) {
    if (w.opencodePid == null) {
      // Primary strategy: ancestry walk. Works when MSYS didn't orphan the
      // intermediate process chain (e.g. bash calling opencode.exe directly
      // via a shell function, no sh.exe shebang hop involved).
      const found = findDescendantPid(byPid, w.shellPid, TARGET_PROCESS);
      if (found != null && !claimedPids.has(found)) {
        w.opencodePid = found;
        claimedPids.add(found);
      } else {
        pendingPanes.push(paneId);
      }
    }
  }

  // Fallback strategy: elimination matching. MSYS's fork/exec emulation can
  // leave an intermediate process (e.g. the sh.exe shebang interpreter) with
  // a stale/dead ParentProcessId, severing the ancestry chain even though
  // opencode.exe itself is alive and well - Windows does not reparent
  // orphans. When exactly one pane is still unmatched and exactly one
  // opencode.exe pid NEWLY appeared since the last tick (never seen before,
  // so it can't be some unrelated long-running session) is unclaimed,
  // assign by exclusion.
  const currentOpencodePids = new Set();
  for (const proc of byPid.values()) {
    if (proc.name?.toLowerCase() === TARGET_PROCESS) currentOpencodePids.add(proc.pid);
  }

  if (pendingPanes.length === 1) {
    const newlyAppeared = [];
    for (const pid of currentOpencodePids) {
      if (!previousOpencodePids.has(pid) && !claimedPids.has(pid)) newlyAppeared.push(pid);
    }
    if (newlyAppeared.length === 1) {
      watched.get(pendingPanes[0]).opencodePid = newlyAppeared[0];
    }
  }

  previousOpencodePids = currentOpencodePids;

  for (const [paneId, w] of watched) {
    if (w.opencodePid == null) continue;

    // Liveness check by pid identity, not by re-walking ancestry.
    if (!byPid.has(w.opencodePid)) {
      if (w.reporting) releaseAgent(paneId);
      w.opencodePid = null;
      w.reporting = false;
      w.lastState = null;
      continue;
    }

    const screen = paneRead(paneId, 10);
    const state = WORKING_PATTERN.test(screen) ? "working" : "idle";

    if (!w.reporting || w.lastState !== state) {
      reportAgent(paneId, state);
      w.reporting = true;
      w.lastState = state;
    }
  }
}

// Run forever.
setInterval(() => {
  try {
    pollOnce();
  } catch {
    // Never let a single bad tick kill the persistent watcher.
  }
}, POLL_INTERVAL_MS);
