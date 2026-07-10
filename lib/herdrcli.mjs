// Thin wrapper around the herdr CLI for one-shot request/response calls.
// Empirically reliable (no connect race observed for CLI invocations,
// unlike raw long-lived socket connections - see pipe.mjs for that case).
import { spawnSync } from "node:child_process";

const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";

export function herdr(args) {
  const res = spawnSync(HERDR_BIN, args, { encoding: "utf8" });
  if (res.error) throw res.error;
  const out = (res.stdout || "").trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out, stderr: res.stderr };
  }
}

export function paneList() {
  const r = herdr(["pane", "list"]);
  return r?.result?.panes ?? [];
}

export function paneProcessInfo(paneId) {
  const r = herdr(["pane", "process-info", "--pane", paneId]);
  return r?.result?.process_info ?? null;
}

export function reportAgent(paneId, state, message) {
  const args = [
    "pane", "report-agent", paneId,
    "--source", "custom:gitbash-detector",
    "--agent", "opencode",
    "--state", state,
  ];
  if (message) args.push("--message", message);
  return herdr(args);
}

export function releaseAgent(paneId) {
  return herdr([
    "pane", "release-agent", paneId,
    "--source", "custom:gitbash-detector",
    "--agent", "opencode",
  ]);
}

export function paneRead(paneId, lines = 10) {
  const r = herdr(["pane", "read", paneId, "--source", "visible", "--lines", String(lines)]);
  // `pane read` prints raw text, not JSON - herdr() falls back to {raw, stderr} for non-JSON output.
  return r?.raw ?? "";
}
