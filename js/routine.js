// Client for the "Learning: process" Claude Code Routine's API trigger (see
// plan Phase G — code.claude.com/docs/en/routines). Firing it starts a fresh
// cloud session that reads learning/CLAUDE.md's Routine Processing
// Instructions and does the actual AI work (transcription, insights,
// summaries, brief drafts). Nothing here calls any AI directly — this file
// only ever does one thing: POST to Anthropic's routine-fire endpoint.
const ROUTINE_CONFIG_KEY = "learning.routine";
const FIRE_BETA_HEADER = "experimental-cc-routine-2026-04-01";

export function loadRoutineConfig() {
  try {
    const raw = localStorage.getItem(ROUTINE_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveRoutineConfig(cfg) {
  localStorage.setItem(ROUTINE_CONFIG_KEY, JSON.stringify(cfg));
}

export function clearRoutineConfig() {
  localStorage.removeItem(ROUTINE_CONFIG_KEY);
}

export class RoutineError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// text: optional fire-payload string. Two shapes this app ever sends:
//   omitted            -> routine does its normal pending-capture sweep
//   "draft brief <id>" -> routine drafts a brief for that one source
// Returns { sessionId, sessionUrl } on success.
export async function fireRoutine(text) {
  const cfg = loadRoutineConfig();
  if (!cfg?.url || !cfg?.token) {
    throw new RoutineError("Processing isn't set up yet — add the routine URL and token in Settings.", "not_granted");
  }
  let res;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "anthropic-beta": FIRE_BETA_HEADER,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(text ? { text } : {}),
    });
  } catch {
    throw new RoutineError("Couldn't reach the routine endpoint.", "network");
  }
  if (res.status === 401) {
    throw new RoutineError("The routine token was rejected — it may have been regenerated or revoked.", "auth");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new RoutineError(body.message || `Couldn't start processing (${res.status}).`, "unknown");
  }
  const body = await res.json();
  return { sessionId: body.claude_code_session_id, sessionUrl: body.claude_code_session_url };
}
