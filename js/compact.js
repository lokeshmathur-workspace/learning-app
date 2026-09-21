// Byte-for-byte port of lifeos-app's js/compact.js — same convention, so
// learning/ diffs stay just as readable as life-os/ diffs. indent 2, source
// key order preserved (never sorted), arrays of plain scalars collapse to
// one line if they fit in 100 chars. Do not "clean up" this format.
//
// Copied rather than imported per the NFR that learning-app must not depend
// on lifeos-app files at runtime — the two repos deploy independently.

function jsonScalar(v) {
  return JSON.stringify(v);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof PyFloat);
}

// Marks a number as "Python float" so it serializes with a decimal point
// even when whole (50 -> "50.0"). Not currently produced by anything in
// learning-app, but kept for parity with lifeos-app's compact.js in case a
// future derived-stats need arises.
export class PyFloat {
  constructor(value) {
    this.value = value;
  }
}

function pyFloatStr(n) {
  const s = String(n);
  return /[.e]/.test(s) ? s : s + ".0";
}

function encNode(o, depth, indent) {
  const pad = " ".repeat(indent * depth);
  const padIn = " ".repeat(indent * (depth + 1));

  if (o instanceof PyFloat) return pyFloatStr(o.value);

  if (isPlainObject(o)) {
    const keys = Object.keys(o);
    if (keys.length === 0) return "{}";
    const items = keys.map(
      (k) => `${padIn}${jsonScalar(k)}: ${encNode(o[k], depth + 1, indent)}`
    );
    return "{\n" + items.join(",\n") + "\n" + pad + "}";
  }

  if (Array.isArray(o)) {
    if (o.length === 0) return "[]";
    const allScalar = o.every((x) => !isPlainObject(x) && !Array.isArray(x) && !(x instanceof PyFloat));
    if (allScalar) {
      const one = JSON.stringify(o);
      if (one.length + pad.length <= 100) return one;
    }
    const items = o.map((x) => padIn + encNode(x, depth + 1, indent));
    return "[\n" + items.join(",\n") + "\n" + pad + "]";
  }

  return jsonScalar(o);
}

// compact(doc) -> string (no trailing newline; caller adds one).
export function compact(doc, indent = 2) {
  return encNode(doc, 0, indent);
}

// --- ID generation, per learning/CLAUDE.md's Routine Processing Instructions ---
// Source id = "LB" + zero-padded sequential number, reserved at source
// creation (see plan Phase G decision #4). Scans sources/index.json's rows
// for the highest LB number in use so a new one never collides, even with a
// gap left by a deleted-before-brief source.
const LB_RE = /^LB(\d{3})$/;

export function nextSourceId(sourceRows) {
  let maxN = 0;
  for (const row of sourceRows || []) {
    const m = row && typeof row.id === "string" && row.id.match(LB_RE);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `LB${String(maxN + 1).padStart(3, "0")}`;
}

// Action id within a source, e.g. "LB015-A1" — N sequential within that
// source, scanning its already-confirmed/queued action ids.
export function nextActionId(sourceId, existingActionIds) {
  const re = new RegExp(`^${sourceId}-A(\\d+)$`);
  let maxN = 0;
  for (const id of existingActionIds || []) {
    const m = typeof id === "string" && id.match(re);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `${sourceId}-A${maxN + 1}`;
}

// Queue item id, matching the existing convention already live in
// learning/queue.json ("LQ20260623-01") — date + sequence within that date.
export function nextQueueItemId(dateISO, existingQueueIds) {
  const ymd = dateISO.replace(/-/g, "");
  const re = new RegExp(`^LQ${ymd}-(\\d+)$`);
  let maxN = 0;
  for (const id of existingQueueIds || []) {
    const m = typeof id === "string" && id.match(re);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `LQ${ymd}-${String(maxN + 1).padStart(2, "0")}`;
}

// Capture id within a source, "C001", "C002", ... — N sequential within
// that source's own capture list (not date-based, since a source can get
// several captures in one sitting).
export function nextCaptureId(existingCaptureIds) {
  let maxN = 0;
  for (const id of existingCaptureIds || []) {
    const m = typeof id === "string" && id.match(/^C(\d{3})$/);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `C${String(maxN + 1).padStart(3, "0")}`;
}
