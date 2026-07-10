// Recursive Windows process-tree walker using WMI, run in bulk (one query
// covers all watched panes per poll tick) since Herdr's own foreground-
// process detection cannot see past a Git-Bash pane's outer bash.exe wrapper.
import { spawnSync } from "node:child_process";

// Returns Map<pid, {pid, ppid, name}> for the whole system, one shot.
export function snapshotProcesses() {
  const res = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 }
  );
  if (res.error || !res.stdout) return new Map();
  let rows;
  try {
    rows = JSON.parse(res.stdout);
  } catch {
    return new Map();
  }
  if (!Array.isArray(rows)) rows = [rows];
  const byPid = new Map();
  for (const r of rows) {
    byPid.set(r.ProcessId, { pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name });
  }
  return byPid;
}

// BFS descendants of rootPid, return the pid of a descendant process named
// targetName if found (case-insensitive exact match), else null.
//
// IMPORTANT: only call this for DISCOVERY (a pane we haven't matched to an
// opencode.exe pid yet). Once found, track that pid's liveness directly via
// byPid.has(pid) on later polls - do NOT re-walk ancestry each tick. MSYS/
// Git-Bash intermediate processes (e.g. the sh.exe shebang interpreter) can
// have their own ParentProcessId go stale (pointing at an already-exited
// PID) once some time has passed, even while their child opencode.exe stays
// alive - Windows does not reparent orphans, so re-deriving the chain later
// silently "loses" a process that is still running.
export function findDescendantPid(byPid, rootPid, targetName) {
  const childrenOf = new Map();
  for (const proc of byPid.values()) {
    if (proc.ppid == null) continue;
    if (!childrenOf.has(proc.ppid)) childrenOf.set(proc.ppid, []);
    childrenOf.get(proc.ppid).push(proc);
  }

  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const children = childrenOf.get(pid) || [];
    for (const child of children) {
      if (child.name && child.name.toLowerCase() === targetName.toLowerCase()) {
        return child.pid;
      }
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        queue.push(child.pid);
      }
    }
  }
  return null;
}
