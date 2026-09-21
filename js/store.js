// The app's persistence layer: wraps GitHubStore with an in-memory doc
// cache, debounced writes, and deepMerge optimistic updates — same shape as
// lifeos-app's store.js, adapted for Learning's source/capture data model
// instead of day/week/month.
//
// Write-order discipline (plan Phase G, review finding I2): meta.json and
// sources/index.json are *projections* of the per-capture files, not
// independent sources of truth. Every write updates the capture file first,
// then meta.json, then index.json — so a failure partway through leaves the
// projections merely stale (recoverable by rebuildProjections()), never the
// authoritative data wrong.
import { GitHubStore, GitHubStoreError } from "./github.js?v=7";
import { nextSourceId, nextCaptureId, nextActionId, nextQueueItemId } from "./compact.js?v=7";
import { prepPhotoBatch } from "./photo.js?v=7";
import { nowStamp, todayISO } from "./dateutil.js?v=7";
import { CAPTURE_STATUS, SOURCE_STATUS, QUEUE_ACTION_STATUS } from "./constants.js?v=7";

const CONFIG_KEY = "learning.gh";
const PIN_KEY = "learning.pin";

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
export function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}
export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}
export function loadPinHash() {
  return localStorage.getItem(PIN_KEY);
}
export function savePinHash(hash) {
  localStorage.setItem(PIN_KEY, hash);
}
export function clearPin() {
  localStorage.removeItem(PIN_KEY);
}
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function deepMerge(t, s) {
  for (const k in s) {
    if (s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) {
      t[k] = t[k] && typeof t[k] === "object" ? { ...t[k] } : {};
      deepMerge(t[k], s[k]);
    } else {
      t[k] = s[k];
    }
  }
  return t;
}

const INDEX_PATH = "learning/sources/index.json";
const QUEUE_PATH = "learning/queue.json";
const LIBRARY_PATH = "learning/library.json";
const metaPath = (id) => `learning/sources/${id}/meta.json`;
const capturePath = (id, capId) => `learning/sources/${id}/${capId}.json`;
const inboxPath = (id, filename) => `learning/inbox/${id}/${filename}`;

function defaultMeta(id, fields) {
  const now = new Date().toISOString();
  return {
    id,
    type: fields.type,
    title: fields.title,
    author: fields.author || "",
    url: fields.url || "",
    status: SOURCE_STATUS.ACTIVE,
    ...(fields.totalPages ? { totalPages: fields.totalPages } : {}),
    lastPage: "",
    createdAt: now,
    updatedAt: now,
    finishedAt: "",
    queueItemId: "",
    briefId: "",
    captures: [],
  };
}

function indexRowFrom(meta) {
  const pending = (meta.captures || []).filter((c) =>
    [CAPTURE_STATUS.PENDING_TRANSCRIPTION, CAPTURE_STATUS.PENDING_SUMMARY].includes(c.status)
  ).length;
  const openActions = (meta.captures || []).reduce(
    (n, c) => n + (c.actionIds || []).length,
    0
  );
  return {
    id: meta.id,
    type: meta.type,
    title: meta.title,
    author: meta.author,
    status: meta.status,
    ...(meta.totalPages ? { totalPages: meta.totalPages } : {}),
    lastPage: meta.lastPage,
    captureCount: (meta.captures || []).length,
    pendingCount: pending,
    openActionCount: openActions,
    updatedAt: meta.updatedAt,
    ...(meta.status === SOURCE_STATUS.FINISHED ? { finishedAt: meta.finishedAt } : {}),
  };
}

export class Store {
  constructor(cfg, onFlash) {
    this.gh = new GitHubStore(cfg);
    this.index = null; // { doc, sha }
    this.sources = new Map(); // id -> { doc, sha }
    this.captures = new Map(); // "id/capId" -> { doc, sha }
    this.queue = null; // { doc, sha }
    this.library = null; // { doc, sha }
    this.saveTimers = new Map();
    this.onFlash = onFlash || (() => {});
  }

  async getIndex() {
    if (this.index) return this.index.doc;
    const { json, sha } = await this.gh.getFile(INDEX_PATH);
    const doc = json || { sources: [] };
    this.index = { doc, sha };
    return doc;
  }

  async _writeIndex(patchRows) {
    const cur = this.index || { doc: { sources: [] }, sha: null };
    const doc = { sources: patchRows };
    this.index = { doc, sha: cur.sha };
    return this._writeFile(INDEX_PATH, doc, () => this.index, (n) => (this.index = n), "learning: update sources index", true);
  }

  async getSource(id) {
    const key = id;
    if (this.sources.has(key)) return this.sources.get(key).doc;
    const { json, sha } = await this.gh.getFile(metaPath(id));
    if (!json) return null;
    this.sources.set(key, { doc: json, sha });
    return json;
  }

  async getCapture(sourceId, capId) {
    const key = `${sourceId}/${capId}`;
    if (this.captures.has(key)) return this.captures.get(key).doc;
    const { json, sha } = await this.gh.getFile(capturePath(sourceId, capId));
    if (!json) return null;
    this.captures.set(key, { doc: json, sha });
    return json;
  }

  // Creates a new source: reserves the next LB id, writes meta.json, then
  // updates index.json. Two writes, immediate (source creation is a
  // deliberate one-shot action, not something to debounce).
  async createSource(fields) {
    const idx = await this.getIndex();
    const lib = await this.getLibrary();
    const id = nextSourceId(idx.sources, lib.briefs.map((b) => b.id));
    const meta = defaultMeta(id, fields);
    this.sources.set(id, { doc: meta, sha: null });
    const ok = await this._writeFile(
      metaPath(id),
      meta,
      () => this.sources.get(id),
      (n) => this.sources.set(id, n),
      `learning: new source ${id}`,
      true
    );
    if (!ok) return null;
    await this._writeIndex([...idx.sources, indexRowFrom(meta)]);
    return id;
  }

  // Marks a source finished/reading again (FR-3's "Finished book" / "Mark
  // reading" buttons). Only touches status/finishedAt — never the captures
  // or brief fields.
  async setSourceStatus(sourceId, status) {
    const meta = await this.getSource(sourceId);
    if (!meta) return null;
    const newMeta = {
      ...meta,
      status,
      finishedAt: status === SOURCE_STATUS.FINISHED ? new Date().toISOString() : "",
      updatedAt: new Date().toISOString(),
    };
    this.sources.set(sourceId, { doc: newMeta, sha: this.sources.get(sourceId)?.sha });
    const ok = await this._writeFile(metaPath(sourceId), newMeta, () => this.sources.get(sourceId), (n) => this.sources.set(sourceId, n), `learning: ${sourceId} ${status}`, true);
    if (!ok) return null;
    const idx = await this.getIndex();
    await this._writeIndex(idx.sources.map((r) => (r.id === sourceId ? indexRowFrom(newMeta) : r)));
    return newMeta;
  }

  // Uploads a batch of photos (all-or-nothing per plan Phase G decision #11)
  // and, only once every photo has confirmed-uploaded, creates the
  // pending_transcription capture referencing them. Returns { ok, error?,
  // captureId? }.
  async uploadPagePhotos(sourceId, files) {
    const prepped = await prepPhotoBatch(files);
    const failed = prepped.filter((p) => !p.ok);
    if (failed.length) {
      return { ok: false, error: `Couldn't process ${failed.length} of ${files.length} photo(s) — nothing was uploaded. Try again.` };
    }
    const stamp = nowStamp();
    const uploaded = [];
    for (let i = 0; i < prepped.length; i++) {
      const filename = `${stamp}-${i + 1}.jpg`;
      const path = inboxPath(sourceId, filename);
      try {
        await this.gh.putBinaryFile(path, prepped[i].blob, null, `learning: upload photo ${filename}`);
        uploaded.push(path);
      } catch (e) {
        // Roll back whatever uploaded so far so a half-batch never lingers.
        for (const p of uploaded) {
          try {
            const { sha } = await this.gh.getFile(p);
            if (sha) await this.gh.deleteFile(p, sha, `learning: revert partial upload`);
          } catch {
            /* best-effort rollback */
          }
        }
        return { ok: false, error: "Upload failed partway through — nothing was saved. Check your connection and try again." };
      }
    }
    const captureId = await this._addCapture(sourceId, {
      type: "page",
      status: CAPTURE_STATUS.PENDING_TRANSCRIPTION,
      createdAt: new Date().toISOString(),
      photos: uploaded,
    });
    return captureId ? { ok: true, captureId } : { ok: false, error: "Photos uploaded, but couldn't save the note. Try reopening the book." };
  }

  // Creates a pending_summary capture for a link (+ optional pasted text).
  async addLinkCapture(sourceId, { url, pastedText }) {
    return this._addCapture(sourceId, {
      type: "link",
      status: CAPTURE_STATUS.PENDING_SUMMARY,
      createdAt: new Date().toISOString(),
      url,
      pastedText: pastedText || "",
    });
  }

  // Creates a ready-immediately thought capture, flagged so the next
  // routine run adds insights to it (needsInsights: true — a lighter form
  // of "pending" than pending_transcription/pending_summary, since the
  // thought itself is already fully visible).
  async addThoughtCapture(sourceId, { thought, pageRef, note }) {
    return this._addCapture(sourceId, {
      type: "thought",
      status: CAPTURE_STATUS.READY,
      needsInsights: true,
      createdAt: new Date().toISOString(),
      thought,
      pageRef: pageRef || "",
      note: note || "",
      actionIds: [],
    });
  }

  // Shared by all three capture-creation paths above. Writes the capture
  // file first (authoritative), then meta.json's light projection, then
  // index.json's counts — see the write-order note at the top of this file.
  async _addCapture(sourceId, captureFields) {
    const meta = await this.getSource(sourceId);
    if (!meta) return null;
    const capId = nextCaptureId((meta.captures || []).map((c) => c.id));
    const captureDoc = { id: capId, ...captureFields };
    const key = `${sourceId}/${capId}`;
    this.captures.set(key, { doc: captureDoc, sha: null });
    const capOk = await this._writeFile(
      capturePath(sourceId, capId),
      captureDoc,
      () => this.captures.get(key),
      (n) => this.captures.set(key, n),
      `learning: ${sourceId} capture ${capId}`,
      true
    );
    if (!capOk) return null;

    const lightRow = {
      id: capId,
      type: captureFields.type,
      status: captureFields.status,
      createdAt: captureFields.createdAt,
      ...(captureFields.pages ? { pages: captureFields.pages } : {}),
      ...(captureFields.thought !== undefined ? { thought: captureFields.thought, pageRef: captureFields.pageRef } : {}),
      ...(captureFields.needsInsights ? { needsInsights: true } : {}),
      actionIds: captureFields.actionIds || [],
    };
    const newMeta = { ...meta, captures: [...(meta.captures || []), lightRow], updatedAt: new Date().toISOString() };
    if (captureFields.type === "page" && (captureFields.pages || []).length) {
      const lastPage = captureFields.pages.filter((p) => p.page).slice(-1)[0]?.page;
      if (lastPage) newMeta.lastPage = lastPage;
    }
    this.sources.set(sourceId, { doc: newMeta, sha: this.sources.get(sourceId)?.sha });
    await this._writeFile(
      metaPath(sourceId),
      newMeta,
      () => this.sources.get(sourceId),
      (n) => this.sources.set(sourceId, n),
      `learning: ${sourceId} meta update`,
      true
    );

    const idx = await this.getIndex();
    await this._writeIndex(idx.sources.map((r) => (r.id === sourceId ? indexRowFrom(newMeta) : r)));
    return capId;
  }

  // Rebuilds meta.json's capture projection and this source's index.json
  // row from its actual per-capture files — the self-heal path for the
  // "regenerable projection" design (matches computed.json's own precedent
  // in the Life OS repo). Call this if a UI ever notices meta.json looks
  // stale relative to what a capture file actually says.
  async rebuildProjections(sourceId) {
    const meta = await this.getSource(sourceId);
    if (!meta) return;
    const rows = [];
    for (const row of meta.captures || []) {
      const full = await this.getCapture(sourceId, row.id);
      if (full) {
        rows.push({
          id: full.id,
          type: full.type,
          status: full.status,
          createdAt: full.createdAt,
          ...(full.pages ? { pages: full.pages } : {}),
          ...(full.thought !== undefined ? { thought: full.thought, pageRef: full.pageRef } : {}),
          actionIds: full.actionIds || full.confirmedActions || [],
        });
      }
    }
    const newMeta = { ...meta, captures: rows };
    this.sources.set(sourceId, { doc: newMeta, sha: this.sources.get(sourceId)?.sha });
    await this._writeFile(metaPath(sourceId), newMeta, () => this.sources.get(sourceId), (n) => this.sources.set(sourceId, n), `learning: rebuild ${sourceId} projection`, true);
    const idx = await this.getIndex();
    await this._writeIndex(idx.sources.map((r) => (r.id === sourceId ? indexRowFrom(newMeta) : r)));
  }

  // Deletes a source: its meta.json, every capture file, any leftover inbox
  // photos, and (plan Phase G decision #5) any of its queue actions still
  // pending — accepted/done ones are left untouched.
  async deleteSource(sourceId) {
    const meta = await this.getSource(sourceId);
    if (!meta) return true;
    for (const row of meta.captures || []) {
      const { sha } = await this.gh.getFile(capturePath(sourceId, row.id));
      if (sha) await this.gh.deleteFile(capturePath(sourceId, row.id), sha, `learning: delete ${sourceId}/${row.id}`);
    }
    const { sha: metaSha } = await this.gh.getFile(metaPath(sourceId));
    if (metaSha) await this.gh.deleteFile(metaPath(sourceId), metaSha, `learning: delete source ${sourceId}`);
    // Leftover unprocessed inbox photos for this source, if any remain.
    try {
      const entries = await this.gh.listTree();
      for (const e of entries) {
        if (e.type === "blob" && e.path.startsWith(`learning/inbox/${sourceId}/`)) {
          await this.gh.deleteFile(e.path, e.sha, `learning: delete orphaned photo`);
        }
      }
    } catch {
      /* best-effort */
    }
    this.sources.delete(sourceId);
    const idx = await this.getIndex();
    await this._writeIndex(idx.sources.filter((r) => r.id !== sourceId));

    const q = await this.getQueue();
    const kept = q.items.filter((item) => {
      if (item.sourceId !== sourceId) return true;
      item.actionItems = (item.actionItems || []).filter((a) => a.status !== QUEUE_ACTION_STATUS.PENDING);
      return item.actionItems.length > 0;
    });
    if (kept.length !== q.items.length || kept.some((item, i) => item !== q.items[i])) {
      await this.saveQueue(kept, true);
    }
    return true;
  }

  // Deletes one note/page/link within a source (FR-3's per-card delete,
  // added after Lokesh's testing flagged only whole-source delete existed).
  // Same rules as deleteSource, scoped to this one capture: its own file,
  // any inbox photos it still references (an unprocessed pending page),
  // removal from meta.json/index.json's projections, and removal of any of
  // its actionIds that are still pending in queue.json.
  async deleteCapture(sourceId, captureId) {
    const meta = await this.getSource(sourceId);
    if (!meta) return true;
    const row = (meta.captures || []).find((c) => c.id === captureId);
    const full = await this.getCapture(sourceId, captureId);

    const { sha } = await this.gh.getFile(capturePath(sourceId, captureId));
    if (sha) await this.gh.deleteFile(capturePath(sourceId, captureId), sha, `learning: delete ${sourceId}/${captureId}`);

    for (const p of (full && full.photos) || []) {
      try {
        const { sha: psha } = await this.gh.getFile(p);
        if (psha) await this.gh.deleteFile(p, psha, `learning: delete orphaned photo`);
      } catch {
        /* best-effort */
      }
    }

    const newMeta = { ...meta, captures: (meta.captures || []).filter((c) => c.id !== captureId), updatedAt: new Date().toISOString() };
    this.sources.set(sourceId, { doc: newMeta, sha: this.sources.get(sourceId)?.sha });
    await this._writeFile(metaPath(sourceId), newMeta, () => this.sources.get(sourceId), (n) => this.sources.set(sourceId, n), `learning: ${sourceId} remove ${captureId}`, true);
    const idx = await this.getIndex();
    await this._writeIndex(idx.sources.map((r) => (r.id === sourceId ? indexRowFrom(newMeta) : r)));
    this.captures.delete(`${sourceId}/${captureId}`);

    const actionIds = (row && row.actionIds) || (full && full.confirmedActions) || [];
    if (actionIds.length) {
      const q = await this.getQueue();
      let changed = false;
      const kept = q.items
        .map((item) => {
          const before = (item.actionItems || []).length;
          item.actionItems = (item.actionItems || []).filter((a) => !(actionIds.includes(a.actionId) && a.status === QUEUE_ACTION_STATUS.PENDING));
          if (item.actionItems.length !== before) changed = true;
          return item;
        })
        .filter((item) => item.actionItems.length > 0);
      if (changed) await this.saveQueue(kept, true);
    }
    return true;
  }

  // --- queue.json — the app is the ONLY writer of this file (plan Phase G
  // decision #3: the routine never touches it). Reused, not reshaped: same
  // schema already live in the Claude repo.
  async getQueue() {
    if (this.queue) return this.queue.doc;
    const { json, sha } = await this.gh.getFile(QUEUE_PATH);
    const doc = json || { items: [] };
    this.queue = { doc, sha };
    return doc;
  }

  saveQueue(items, immediate) {
    const cur = this.queue || { doc: { items: [] }, sha: null };
    const doc = { items };
    this.queue = { doc, sha: cur.sha };
    return this._writeFile(QUEUE_PATH, doc, () => this.queue, (n) => (this.queue = n), "learning: update queue", immediate);
  }

  // Removes a task from view without deleting it (learning/CLAUDE.md rule:
  // "A dismissed action stays in the queue with status: 'dismissed'; don't
  // delete it") — same convention already used for Life OS's own queue
  // lifecycle, just triggered here instead of from /today.
  async dismissAction(actionId) {
    const q = await this.getQueue();
    let found = false;
    for (const item of q.items) {
      const a = (item.actionItems || []).find((x) => x.actionId === actionId);
      if (a) {
        a.status = QUEUE_ACTION_STATUS.DISMISSED;
        found = true;
        break;
      }
    }
    if (!found) return false;
    return this.saveQueue(q.items, true);
  }

  // Appends ticked actions (suggested + any custom ones) to queue.json,
  // creating that source's queue item on first use. addedBy is always
  // "LearningApp" here (plan Phase G decision #10) — a manual chat session
  // writing queue.json directly would use "LearningProject" instead, but
  // that path never runs through this app.
  async confirmActions(sourceId, sourceMeta, actions) {
    const q = await this.getQueue();
    let item = q.items.find((it) => it.id === sourceMeta.queueItemId);
    if (!item) {
      const id = nextQueueItemId(todayISO(), q.items.map((it) => it.id));
      item = {
        id,
        dateAdded: todayISO(),
        addedBy: "LearningApp",
        source: sourceMeta.url || "",
        sourceType: sourceMeta.type,
        title: sourceMeta.title,
        summary: "",
        keyInsights: [],
        actionItems: [],
        sourceId,
      };
      q.items = [...q.items, item];
      if (!sourceMeta.queueItemId) {
        const newMeta = { ...sourceMeta, queueItemId: id };
        this.sources.set(sourceId, { doc: newMeta, sha: this.sources.get(sourceId)?.sha });
        await this._writeFile(metaPath(sourceId), newMeta, () => this.sources.get(sourceId), (n) => this.sources.set(sourceId, n), `learning: ${sourceId} queueItemId`, true);
      }
    }
    const existingIds = item.actionItems.map((a) => a.actionId);
    const newIds = [];
    for (const a of actions) {
      const actionId = nextActionId(sourceId, [...existingIds, ...newIds]);
      newIds.push(actionId);
      item.actionItems.push({
        actionId,
        action: a.action,
        pillar: a.pillar,
        priority: "medium",
        status: QUEUE_ACTION_STATUS.PENDING,
        targetWeek: "",
        dateAccepted: "",
        dateCompleted: "",
        linkedTaskId: "",
      });
    }
    await this.saveQueue(q.items, true);
    return newIds;
  }

  // Patches a capture's highlights[] only — tap-to-highlight in the reader.
  async saveHighlights(sourceId, captureId, highlights) {
    const key = `${sourceId}/${captureId}`;
    const cur = this.captures.get(key);
    if (!cur) return false;
    const doc = { ...cur.doc, highlights };
    this.captures.set(key, { doc, sha: cur.sha });
    return this._writeFile(capturePath(sourceId, captureId), doc, () => this.captures.get(key), (n) => this.captures.set(key, n), `learning: ${sourceId}/${captureId} highlights`, true);
  }

  // Patches a capture's note only.
  async saveCaptureNote(sourceId, captureId, note) {
    const key = `${sourceId}/${captureId}`;
    const cur = this.captures.get(key);
    if (!cur) return false;
    const doc = { ...cur.doc, note };
    this.captures.set(key, { doc, sha: cur.sha });
    return this._writeFile(capturePath(sourceId, captureId), doc, () => this.captures.get(key), (n) => this.captures.set(key, n), `learning: ${sourceId}/${captureId} note`, true);
  }

  // Ticking actions on a specific capture: writes queue.json via
  // confirmActions() (unchanged), then — the part confirmActions() alone
  // doesn't do — records the new ids on the capture file's confirmedActions[]
  // and on meta.json's light row actionIds[], so a confirmed action shows as
  // confirmed everywhere (and so delete-cascade logic, which reads exactly
  // these two fields, can find it later). Returns the new action ids.
  async confirmCaptureActions(sourceId, captureId, sourceMeta, actions) {
    const newIds = await this.confirmActions(sourceId, sourceMeta, actions);
    if (!newIds.length) return newIds;

    const key = `${sourceId}/${captureId}`;
    const cap = this.captures.get(key);
    if (cap) {
      const doc = { ...cap.doc, confirmedActions: [...(cap.doc.confirmedActions || []), ...newIds] };
      this.captures.set(key, { doc, sha: cap.sha });
      await this._writeFile(capturePath(sourceId, captureId), doc, () => this.captures.get(key), (n) => this.captures.set(key, n), `learning: ${sourceId}/${captureId} confirm actions`, true);
    }

    const meta = await this.getSource(sourceId);
    if (meta) {
      const newMeta = {
        ...meta,
        captures: (meta.captures || []).map((c) =>
          c.id === captureId ? { ...c, actionIds: [...(c.actionIds || []), ...newIds] } : c
        ),
        updatedAt: new Date().toISOString(),
      };
      this.sources.set(sourceId, { doc: newMeta, sha: this.sources.get(sourceId)?.sha });
      await this._writeFile(metaPath(sourceId), newMeta, () => this.sources.get(sourceId), (n) => this.sources.set(sourceId, n), `learning: ${sourceId} confirm actions`, true);
      const idx = await this.getIndex();
      await this._writeIndex(idx.sources.map((r) => (r.id === sourceId ? indexRowFrom(newMeta) : r)));
    }
    return newIds;
  }

  // --- library.json — same rule as queue.json: the app is the only writer
  // (the routine only ever produces a *draft*, stored on the source's own
  // meta.json until Lokesh confirms it — see saveDraftBrief/confirmBrief).
  async getLibrary() {
    if (this.library) return this.library.doc;
    const { json, sha } = await this.gh.getFile(LIBRARY_PATH);
    const doc = json || { _readme: "Lokesh's personal knowledge library. Written by the LifeOS Learning project. Never edited manually. Each entry is a Learning Brief from a book, article, video, podcast, or course.", _lastUpdated: "", _totalBriefs: 0, briefs: [] };
    this.library = { doc, sha };
    return doc;
  }

  // Clears a routine-drafted brief without saving it, so Lokesh can fire
  // "Create learning brief" again for a fresh draft.
  async discardDraftBrief(sourceId) {
    const meta = await this.getSource(sourceId);
    if (!meta) return false;
    const newMeta = { ...meta };
    delete newMeta.draftBrief;
    this.sources.set(sourceId, { doc: newMeta, sha: this.sources.get(sourceId)?.sha });
    return this._writeFile(metaPath(sourceId), newMeta, () => this.sources.get(sourceId), (n) => this.sources.set(sourceId, n), `learning: ${sourceId} discard draft brief`, true);
  }

  async confirmBrief(sourceId, briefFields) {
    const meta = await this.getSource(sourceId);
    const lib = await this.getLibrary();
    const doc = {
      ...lib,
      _lastUpdated: todayISO(),
      _totalBriefs: lib.briefs.length + 1,
      briefs: [...lib.briefs, { id: sourceId, ...briefFields }],
    };
    const ok = await this._writeFile(LIBRARY_PATH, doc, () => this.library, (n) => (this.library = n), `learning: brief ${sourceId} — ${briefFields.title}`, true);
    if (!ok) return false;
    const newMeta = { ...meta, briefId: sourceId, status: SOURCE_STATUS.FINISHED, finishedAt: meta.finishedAt || new Date().toISOString(), draftBrief: undefined };
    delete newMeta.draftBrief;
    this.sources.set(sourceId, { doc: newMeta, sha: this.sources.get(sourceId)?.sha });
    await this._writeFile(metaPath(sourceId), newMeta, () => this.sources.get(sourceId), (n) => this.sources.set(sourceId, n), `learning: ${sourceId} finished`, true);
    const idx = await this.getIndex();
    await this._writeIndex(idx.sources.map((r) => (r.id === sourceId ? indexRowFrom(newMeta) : r)));
    return true;
  }

  // Resolves true/false (never rejects); errors always reported via onFlash.
  _writeFile(path, doc, getCache, setCache, message, immediate, debounceMs = 500) {
    clearTimeout(this.saveTimers.get(path));
    const doWrite = async () => {
      const cache = getCache();
      try {
        const { sha } = await this.gh.putFile(path, cache.doc, cache.sha, message);
        setCache({ ...cache, sha });
        return true;
      } catch (e) {
        this.onFlash(e instanceof GitHubStoreError ? e.message : "Couldn't save.", true);
        return false;
      }
    };
    if (immediate) return doWrite();
    this.saveTimers.set(path, setTimeout(doWrite, debounceMs));
    return Promise.resolve(true);
  }

  // Signed-out privacy self-test, same as lifeos-app's verifyPrivate().
  async verifyPrivate(repo) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(QUEUE_PATH)}`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    return res.status === 404;
  }
}
