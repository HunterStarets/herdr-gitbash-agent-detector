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
// Persistent opencode TUI footer chrome, shown regardless of idle/working
// state (unlike WORKING_PATTERN, which only appears while actively
// generating). Used as a "this pane's screen genuinely shows opencode
// running" ground-truth signal - see matchablePanes in pollOnce().
const OPENCODE_UI_PATTERN = /ctrl\+p commands/i;
// How old an opencode.exe process is allowed to be to still qualify as a
// startup-reconciliation candidate (see firstTickDone below). A genuine
// "Herdr restarted with sessions already running" recovery case involves
// processes that have been running for at most a few hours of normal use;
// anything older is far more likely a long-abandoned, never-reaped MSYS
// orphan (observed directly: a 4-day-old zombie opencode.exe from an
// entirely different, already-closed pane got matched to a brand-new,
// actually-blank pane during reconciliation before this cutoff existed).
const RECONCILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || ".";
fs.mkdirSync(stateDir, { recursive: true });
const lockPath = path.join(stateDir, "watcher.lock");

// pane_id -> { shellPid, opencodePid, reporting: bool, lastState: "idle"|"working"|null, addedAt, terminalId }
const watched = new Map();

// pid -> { firstSeenAt } - opencode.exe pids observed at least once that are
// NOT yet claimed by any pane and were NOT already running at watcher
// startup. Unlike a single-tick "previous vs current" diff, entries persist
// here across ticks until they are either claimed by a pane or the process
// dies. That's what lets elimination-matching resolve a pid that appears in
// the SAME tick as another pane's pid instead of permanently losing track
// of it after exactly one tick (see poll loop below for why that mattered).
const unclaimedPool = new Map();
// opencode.exe pids confirmed to have no associated pending pane - frozen
// out of unclaimedPool consideration so a long-running unrelated opencode
// session is never mistaken for a freshly-launched one later on. Populated
// lazily after the FIRST poll tick (see firstTickDone below) rather than
// up-front at import time: this watcher is a long-lived singleton that
// often survives across Herdr restarts, and `pane.created` never fires for
// panes restored from a prior session (only `workspace.focused` does, per
// herdr-plugin.toml) - so on that bootstrap path, the panes' opencode.exe
// processes are ALREADY running the moment this watcher (re)starts. An
// up-front baseline would permanently blacklist exactly those pids before
// ever getting a chance to reconcile them with their pending panes, which
// is the scenario this hook exists to handle in the first place.
const baselinePids = new Set();
// Sole reconciliation window: the very first poll tick treats every
// currently-running opencode.exe pid as a fair match candidate (no
// baseline yet). Whatever's left unclaimed after that first attempt is
// then frozen into baselinePids for good - see pollOnce().
let firstTickDone = false;

// opencode.exe pids that once legitimately belonged to a pane whose
// tracking we later tore down (the pane closed, or its underlying Herdr
// terminal got recreated - see terminalId handling in refreshWatchList).
// Permanently excluded from unclaimedPool: without a working ancestry walk,
// elimination-matching has NO way to verify a pid actually belongs to a
// given pane, it just infers it from "currently unclaimed and alive". A pid
// freed up by one pane closing is NOT fair game for some other pane that
// happens to be pending at the same moment - that caused exactly this bug:
// closing the ORIGINAL "digex-17498" pane freed its still-alive (MSYS
// orphaned, never actually reaped) opencode.exe pid back into the pool,
// which then got wrongly assigned to a completely different, actually-
// blank pane the next time reconciliation ran.
const retiredPids = new Set();

function isPidAlive(pid) {
  const res = spawnSync("powershell", [
    "-NoProfile", "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { "yes" } else { "no" }`,
  ], { encoding: "utf8" });
  return (res.stdout || "").trim() === "yes";
}

function tryAcquireSingletonLock() {
  // Atomic exclusive-create ("wx") instead of existsSync-then-writeFileSync:
  // the latter is a classic TOCTOU race - two watcher.mjs processes spawned
  // within the same instant (e.g. two workspace.focused events firing back
  // to back for two different panes) can both pass the existsSync check
  // before either writes, so both "win" and run as duplicate singletons.
  // Duplicates are worse than a missed poll: each keeps its own independent
  // watched/claimedPids state, so two live watchers can each believe a pid
  // is unclaimed and assign it to two different panes. Loop on EEXIST so a
  // stale lock (owner dead) gets reclaimed by exactly one contender.
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return true; // we created it fresh - we own the lock
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    let prevPid = null;
    try {
      prevPid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    } catch {
      continue; // lock vanished between our failed create and this read - retry
    }
    if (prevPid && isPidAlive(prevPid)) {
      return false; // another watcher is genuinely running
    }
    // Stale lock (owner dead) - try to reclaim it. If another contender
    // beats us to the recreate, our next "wx" attempt above will fail with
    // EEXIST again and we'll re-check its (now-live) owner and back off.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already removed/replaced by another contender - loop and re-check
    }
  }
}

if (!tryAcquireSingletonLock()) {
  process.exit(0);
}

function classifyPane(pane) {
  const info = paneProcessInfo(pane.pane_id);
  const shellName = info?.foreground_processes?.[0]?.name?.toLowerCase() ?? "";
  return shellName === "bash.exe" || shellName === "sh.exe";
}

function refreshWatchList() {
  const panes = paneList();
  const currentIds = new Set(panes.map((p) => p.pane_id));

  // Drop panes that no longer exist at all (closed).
  for (const paneId of [...watched.keys()]) {
    if (!currentIds.has(paneId)) {
      const w = watched.get(paneId);
      if (w.reporting) releaseAgent(paneId);
      if (w.opencodePid != null) retiredPids.add(w.opencodePid);
      watched.delete(paneId);
    }
  }

  for (const pane of panes) {
    const existing = watched.get(pane.pane_id);

    // Herdr can recreate a pane's underlying terminal/pty while keeping the
    // SAME pane_id - most notably across a Herdr server restart, which is
    // exactly the "pane.created never fires for restored panes" bootstrap
    // case this plugin's workspace.focused hook exists for. Whatever
    // shellPid/opencodePid we recorded for the OLD terminal (and whatever
    // `agent` status this same paneList() snapshot still shows - likely OUR
    // OWN prior report, persisted through the restart) is meaningless for
    // the new one. Detect it via terminal_id (a stable Herdr-side pty
    // identity, unlike pane_id which survives recreation) and force a clean
    // re-classification instead of silently carrying stale state forward -
    // that staleness is what let an old pane's opencode.exe get reported
    // against a brand-new, actually-blank terminal after a restart.
    const terminalChanged = existing != null && existing.terminalId !== pane.terminal_id;
    if (terminalChanged) {
      if (existing.reporting) releaseAgent(pane.pane_id);
      if (existing.opencodePid != null) retiredPids.add(existing.opencodePid);
      watched.delete(pane.pane_id);
    } else if (existing) {
      continue;
    }

    // Respect Herdr's native detection (e.g. PowerShell panes) or a pane we
    // already legitimately track - but only when we're not in the middle of
    // recovering from a just-detected terminal recreation, since in that
    // case `pane.agent` is exactly the stale value we're trying to escape.
    if (!terminalChanged && pane.agent) continue;
    if (!classifyPane(pane)) continue;

    const info = paneProcessInfo(pane.pane_id);
    watched.set(pane.pane_id, {
      shellPid: info.shell_pid,
      opencodePid: null,
      reporting: false,
      lastState: null,
      addedAt: Date.now(),
      terminalId: pane.terminal_id,
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

  // Elimination-matching has no ground truth linking a pid to a specific
  // pane - ancestry-walk (the only real signal) never succeeds on this
  // machine, so it degrades to inferring the link purely from "unclaimed
  // and alive" pid bookkeeping. That is fundamentally ambiguous whenever
  // MORE THAN ONE pane is simultaneously pending: FIFO ordering has to
  // guess which pending pane a candidate belongs to, and can guess wrong
  // (observed directly - a real session's pid got matched to an unrelated,
  // genuinely-blank pane instead, while the pane actually running it stayed
  // undetected). Narrow the field with real ground truth instead: a
  // genuinely blank/idle bash prompt never renders opencode's TUI chrome,
  // so only offer a pane as a match target once its OWN visible screen
  // confirms opencode is actually there.
  const matchablePanes = pendingPanes.filter((paneId) => OPENCODE_UI_PATTERN.test(paneRead(paneId, 10)));

  // Refresh the unclaimed-pid pool: add any never-seen-before opencode.exe
  // pid (excluding baseline pids, retired pids, and pids already claimed by
  // some pane), and drop any pool entry whose process has since died. On
  // the one-time startup reconciliation tick only, also gate entry by
  // RECONCILE_MAX_AGE_MS - anything already too old to be a plausible
  // "restart recovery" candidate goes straight to baselinePids instead,
  // never even getting a chance at FIFO-matching a pending pane.
  const now = Date.now();
  for (const proc of byPid.values()) {
    if (proc.name?.toLowerCase() !== TARGET_PROCESS) continue;
    if (baselinePids.has(proc.pid) || claimedPids.has(proc.pid) || retiredPids.has(proc.pid)) continue;
    if (!firstTickDone && proc.createdAt != null && now - proc.createdAt > RECONCILE_MAX_AGE_MS) {
      baselinePids.add(proc.pid);
      continue;
    }
    if (!unclaimedPool.has(proc.pid)) {
      unclaimedPool.set(proc.pid, { firstSeenAt: proc.createdAt ?? now });
    }
  }
  for (const pid of [...unclaimedPool.keys()]) {
    if (!byPid.has(pid)) unclaimedPool.delete(pid);
  }

  // Fallback strategy: elimination matching. MSYS's fork/exec emulation can
  // leave an intermediate process (e.g. the sh.exe shebang interpreter) with
  // a stale/dead ParentProcessId, severing the ancestry chain even though
  // opencode.exe itself is alive and well - Windows does not reparent
  // orphans. When that happens (observed to be the ONLY working path on
  // some machines - ancestry-walk never succeeds at all), the remaining
  // signal (after the screen-content filter above) is "a genuinely-active
  // opencode pane has no pid yet" plus "an opencode.exe pid appeared that
  // nothing has claimed". Maintain a pool of such pids across ticks (added
  // above) and pair them off against matchable panes in FIFO order:
  // earliest-added pane <-> earliest-seen pid.
  //
  // This must NOT be restricted to "exactly one matchable pane" - opening
  // several Git-Bash panes/spaces back-to-back (each launching opencode
  // within the same ~1.5s poll window) previously left ALL of them
  // permanently unmatched: the old code only ever resolved a single
  // pending pane per tick, and unconditionally discarded any newly-seen pid
  // it didn't use that same tick, so a second or third simultaneous launch
  // could never be picked up on a later tick either. FIFO N:M pairing here
  // makes progress on every matchable pane a pool candidate exists for, and
  // whatever doesn't pair off this tick simply stays in the pool/pending
  // list for the next one instead of being lost.
  if (matchablePanes.length > 0 && unclaimedPool.size > 0) {
    const sortedPanes = matchablePanes
      .map((paneId) => ({ paneId, addedAt: watched.get(paneId).addedAt }))
      .sort((a, b) => a.addedAt - b.addedAt);
    const sortedPool = [...unclaimedPool.entries()].sort(
      (a, b) => a[1].firstSeenAt - b[1].firstSeenAt
    );

    const n = Math.min(sortedPanes.length, sortedPool.length);
    for (let i = 0; i < n; i++) {
      const paneId = sortedPanes[i].paneId;
      const pid = sortedPool[i][0];
      watched.get(paneId).opencodePid = pid;
      unclaimedPool.delete(pid);
    }
  }

  // End of the one-time startup reconciliation window (see baselinePids
  // comment above): whatever's still sitting unclaimed in the pool after
  // this first attempt had no pending pane to match against, so treat it as
  // a standalone opencode.exe session unrelated to any Herdr pane and
  // freeze it out of consideration for good. From here on, only pids that
  // appear AFTER this point are eligible to enter the pool.
  if (!firstTickDone) {
    for (const pid of unclaimedPool.keys()) baselinePids.add(pid);
    unclaimedPool.clear();
    firstTickDone = true;
  }

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
