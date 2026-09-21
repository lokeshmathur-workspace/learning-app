// Learning app — main view/render logic. Same event-delegation shape as the
// approved prototype (one click listener, data-act dispatch), but backed by
// real GitHub-API calls through store.js instead of the claude.ai artifact
// runtime, so every action here is async.
import { Store, loadConfig, saveConfig, clearConfig, loadPinHash, savePinHash, clearPin, sha256Hex } from "./store.js?v=7";
import { loadRoutineConfig, saveRoutineConfig, clearRoutineConfig, fireRoutine, RoutineError } from "./routine.js?v=7";
import { PILLARS, SOURCE_TYPES, CAPTURE_STATUS, QUEUE_ACTION_STATUS, BRIEF_TOPICS } from "./constants.js?v=7";
import { fmtRelative, todayISO, prettyDate } from "./dateutil.js?v=7";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  store: null,
  cfg: null,
  pinHash: null,
  pinOk: false,
  view: "loading", // loading | auth | pin | home | new | source | capture | settings
  curId: null,
  sources: [],
  index: null,
  queue: { items: [] },
  form: null,
  draft: null,
  pin: "",
  busy: "",
  err: "",
  fatal: "",
  fullCaptures: {}, // captureId -> full capture doc, for ready captures on the open source
  actionUI: {}, // captureId -> { picks: Set<index>, custom: [{action,pillar}] }
  briefForm: null, // working copy of the open source's draftBrief while reviewing/editing it
};

function actionUIFor(capId) {
  if (!S.actionUI[capId]) S.actionUI[capId] = { picks: new Set(), custom: [], saving: false };
  return S.actionUI[capId];
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("on"), 2600);
}

function onFlash(msg, isError) {
  toast(msg);
}

/* ---------- boot ---------- */
async function init() {
  S.cfg = loadConfig();
  S.pinHash = loadPinHash();
  if (!S.cfg) {
    S.view = "auth";
    return render();
  }
  S.store = new Store(S.cfg, onFlash);
  if (S.pinHash) {
    S.view = "pin";
    return render();
  }
  await enterApp();
}

async function enterApp() {
  S.view = "home";
  render();
  await loadHome();
}

async function loadHome() {
  try {
    S.index = await S.store.getIndex();
    S.queue = await S.store.getQueue();
    S.sources = S.index.sources;
  } catch (e) {
    S.fatal = e.message || "Couldn't load your library.";
  }
  render();
}

/* ---------- auth ---------- */
function vAuth() {
  const f = S.form || { token: "", repo: "lokeshmathur-workspace/Claude", err: "" };
  S.form = f;
  return `<h1>Learning</h1>
  <p class="sub" style="margin:10px 0 18px">Connect your private data repo. The token is stored only in this browser.</p>
  <label for="a-token">GitHub token</label>
  <input id="a-token" type="password" data-f="token" value="${esc(f.token)}" placeholder="github_pat_...">
  <label for="a-repo">Repo</label>
  <input id="a-repo" type="text" data-f="repo" value="${esc(f.repo)}" placeholder="owner/repo">
  <p class="sub" style="margin-top:8px">A fine-grained token scoped to Contents read/write on this one repo. <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create one</a>.</p>
  ${f.err ? `<p class="err">${esc(f.err)}</p>` : ""}
  <div class="sticky"><button class="btn primary" style="width:100%" data-act="connect">Connect</button></div>`;
}

async function connect() {
  const f = S.form;
  const token = f.token.trim();
  const repo = f.repo.trim();
  if (!token || !/^[\w-]+\/[\w.-]+$/.test(repo)) {
    f.err = "Enter a token and a repo in the form owner/repo.";
    return render();
  }
  const cfg = { token, repo, branch: "main" };
  const store = new Store(cfg, onFlash);
  try {
    await store.getIndex();
  } catch (e) {
    f.err = e.message || "Couldn't connect — check the token and repo.";
    return render();
  }
  saveConfig(cfg);
  S.cfg = cfg;
  S.store = store;
  S.form = null;
  await enterApp();
}

/* ---------- PIN ---------- */
function vPin() {
  const setting = !S.pinHash;
  return `<h1>Learning</h1>
  <p class="sub" style="margin-top:10px">${setting ? "Set a PIN to lock this device." : "Enter your PIN"}</p>
  <div class="pindots">${[0, 1, 2, 3].map((i) => `<i class="${i < S.pin.length ? "on" : ""}"></i>`).join("")}</div>
  ${S.err ? `<p class="err" style="text-align:center">${esc(S.err)}</p>` : ""}
  <div class="pinpad">
    ${[1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"].map((n) => (n === "" ? `<span></span>` : `<button class="btn" data-act="pinkey" data-k="${n}">${n}</button>`)).join("")}
  </div>
  ${setting ? `` : `<div class="btnrow" style="max-width:280px;margin:16px auto 0"><button class="btn ghost" data-act="forgetall" style="flex:0 1 auto">Forget token &amp; sign out</button></div>`}`;
}

async function pinKey(k) {
  if (k === "⌫") {
    S.pin = S.pin.slice(0, -1);
    return render();
  }
  if (S.pin.length >= 4) return;
  S.pin += String(k);
  render();
  if (S.pin.length !== 4) return;
  if (!S.pinHash) {
    S.pinHash = await sha256Hex(S.pin);
    savePinHash(S.pinHash);
    S.pin = "";
    return enterApp();
  }
  const hash = await sha256Hex(S.pin);
  if (hash === S.pinHash) {
    S.pin = "";
    return enterApp();
  }
  S.err = "Wrong PIN.";
  S.pin = "";
  render();
}

/* ---------- Home / dashboard (FR-1) ---------- */
function vHome() {
  if (S.fatal) return `<h1>Learning</h1><p class="empty" style="margin-top:16px">${esc(S.fatal)}</p>`;
  const active = S.sources.filter((s) => s.status !== "finished").sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const books = active.filter((s) => s.type === "book");
  const vids = active.filter((s) => s.type === "video");
  const arts = active.filter((s) => s.type === "article" || s.type === "other");
  const done = S.sources.filter((s) => s.status === "finished").sort((a, b) => (b.finishedAt || "").localeCompare(a.finishedAt || ""));
  // Grouped by the queue item's own sourceType, not by matching S.sources —
  // that also covers queue items from before this app existed (e.g. a brief
  // written via a manual chat session), which have no sources/index.json
  // row to match against but do carry sourceType. "youtube" (the existing
  // real-data value) and "video" (this app's Type picker value) both roll
  // up under "Videos".
  const TYPE_LABEL = { book: "Books", video: "Videos", youtube: "Videos", article: "Articles", other: "Other" };
  const actionsByType = {};
  let openActions = 0;
  for (const it of S.queue.items || []) {
    const n = (it.actionItems || []).filter((a) => a.status !== QUEUE_ACTION_STATUS.DONE && a.status !== QUEUE_ACTION_STATUS.DISMISSED).length;
    openActions += n;
    if (n) {
      const label = TYPE_LABEL[it.sourceType] || "Other";
      actionsByType[label] = (actionsByType[label] || 0) + n;
    }
  }
  const actionsBreakdown = Object.entries(actionsByType).map(([label, n]) => `${label} ${n}`).join(" · ");
  const captures = S.sources.reduce((n, s) => n + (s.captureCount || 0), 0);
  const pendingSources = S.sources.filter((s) => (s.pendingCount || 0) > 0);
  const pendingTotal = pendingSources.reduce((n, s) => n + s.pendingCount, 0);

  const bookCard = (s) => {
    const pct = s.totalPages && s.lastPage ? Math.min(100, Math.round((parseInt(s.lastPage, 10) / s.totalPages) * 100)) : null;
    const n = s.openActionCount || 0;
    return `<div class="card book" data-act="open" data-id="${s.id}">
      <div class="row"><div><div class="book-title">${esc(s.title)}</div>
      <div class="meta">${esc(s.author || "")}${s.author ? " · " : ""}${s.captureCount || 0} notes${s.lastPage ? " · last p. " + esc(s.lastPage) : ""}${s.updatedAt ? " · " + fmtRelative(s.updatedAt) : ""}</div></div>
      ${n ? `<span class="pill">${n} action${n > 1 ? "s" : ""}</span>` : ""}</div>
      ${pct !== null && !isNaN(pct) ? `<div class="bar" aria-label="${pct}% read"><i style="width:${pct}%"></i></div>` : ""}
      <div class="btnrow">
        <button class="btn" data-act="cap" data-mode="page" data-id="${s.id}">Add page</button>
        <button class="btn" data-act="cap" data-mode="thought" data-id="${s.id}">Add thought</button>
      </div></div>`;
  };
  const rows = (arr) =>
    arr.length
      ? `<div class="list">${arr
          .map((s) => {
            const n = s.openActionCount || 0;
            return `<div class="li" data-act="open" data-id="${s.id}"><div><div class="li-title">${esc(s.title)}</div><div class="meta">${esc(s.author || SOURCE_TYPES[s.type])} · ${s.captureCount || 0} notes${s.updatedAt ? " · " + fmtRelative(s.updatedAt) : ""}</div></div>${n ? `<span class="pill">${n}</span>` : ""}</div>`;
          })
          .join("")}</div>`
      : "";

  return `<div class="top"><div><h1>Learning</h1><div class="sub">${prettyDate(todayISO())}</div></div>
  <button class="btn ghost" data-act="settings" style="flex:0 1 auto">Settings</button></div>
  <div class="stats"><div class="stat"><b>${captures}</b><span>Captures</span></div>
  <button class="stat" data-act="actions"><b>${openActions}</b><span>Actions pending</span>${actionsBreakdown ? `<span style="display:block;margin-top:3px;font-size:11px;color:var(--faint);font-weight:600">${esc(actionsBreakdown)}</span>` : ""}</button></div>
  ${pendingTotal ? `<p class="hint" style="margin-top:14px">${pendingTotal} item${pendingTotal > 1 ? "s" : ""} waiting for processing — tap <b>Process now</b> from any of them, or from a source's page.</p>` : ""}
  <h2>Books you're reading <small>${books.length || ""}</small></h2>
  ${books.length ? books.map(bookCard).join("") : `<div class="empty">Start a book to capture pages, highlights and notes as you read.</div>`}
  <h2>Videos <small>${vids.length || ""}</small></h2>${rows(vids) || `<div class="empty">Add a YouTube link and paste the transcript or your notes to capture learnings.</div>`}
  <h2>Articles and web <small>${arts.length || ""}</small></h2>${rows(arts) || `<div class="empty">Add an article link and paste the text to get a summary.</div>`}
  ${done.length ? `<details style="margin-top:22px"><summary>Finished (${done.length})</summary><div style="margin-top:10px">${rows(done)}</div></details>` : ""}
  <div class="btnrow" style="margin-top:24px"><button class="btn primary" data-act="new" data-type="book">New book</button><button class="btn" data-act="new" data-type="video">Add link</button></div>`;
}

/* ---------- New source (FR-2) ---------- */
function vNew() {
  const f = S.form;
  const isBook = f.type === "book";
  return `<button class="btn ghost back" data-act="home">‹ Library</button><h1>${isBook ? "New book" : "Add a video or article"}</h1>
  <label>Type</label><div class="seg">${Object.entries(SOURCE_TYPES).map(([k, v]) => `<button class="btn" aria-pressed="${f.type === k}" data-act="ftype" data-type="${k}">${v}</button>`).join("")}</div>
  <label for="f-title">Title</label><input id="f-title" type="text" data-f="title" value="${esc(f.title)}" placeholder="${isBook ? "The Culture Code" : "Why AI pilots stall"}">
  <label for="f-author">${isBook ? "Author" : "Creator or publication"}</label><input id="f-author" type="text" data-f="author" value="${esc(f.author)}" placeholder="${isBook ? "Daniel Coyle" : "Harvard Business Review"}">
  ${isBook
    ? `<label for="f-pages">Total pages (optional, for progress)</label><input id="f-pages" type="number" inputmode="numeric" data-f="totalPages" value="${esc(f.totalPages)}" placeholder="304">`
    : `<label for="f-url">Link</label><input id="f-url" type="url" inputmode="url" data-f="url" value="${esc(f.url)}" placeholder="https://youtube.com/watch?v=…">
  <label for="f-text">Transcript, article text or your notes (optional)</label><textarea id="f-text" data-f="text" style="min-height:140px" placeholder="Paste the transcript or article text — Process now will summarize the learnings.">${esc(f.text)}</textarea>`}
  ${f.err ? `<p class="err">${esc(f.err)}</p>` : ""}
  <div class="sticky"><button class="btn primary" style="width:100%" data-act="create" ${S.busy ? "disabled" : ""}>${isBook ? "Start book" : "Add"}</button></div>`;
}

async function createSource() {
  const f = S.form;
  if (!f.title.trim()) {
    f.err = "Enter a title first.";
    return render();
  }
  S.busy = "create";
  render();
  const id = await S.store.createSource({
    type: f.type,
    title: f.title.trim(),
    author: (f.author || "").trim(),
    url: (f.url || "").trim(),
    totalPages: parseInt(f.totalPages, 10) || undefined,
  });
  S.busy = "";
  if (!id) {
    render();
    return;
  }
  S.sources = [...S.sources, { id, type: f.type, title: f.title.trim(), author: (f.author || "").trim(), status: "active", captureCount: 0, pendingCount: 0, openActionCount: 0, updatedAt: new Date().toISOString() }];
  const text = (f.text || "").trim();
  const url = (f.url || "").trim();
  S.form = null;
  if (url) {
    await S.store.addLinkCapture(id, { url, pastedText: text });
    toast("Added — waiting for processing.");
  }
  await openSource(id);
}

/* ---------- Source detail (FR-3) ---------- */
async function openSource(id) {
  S.curId = id;
  S.view = "source";
  S.meta = null;
  S.fullCaptures = {};
  S.actionUI = {};
  S.briefForm = null;
  render();
  S.meta = await S.store.getSource(id);
  render();
  // meta.json's captures[] is a light projection (no transcript/insights/
  // suggestedActions) — fetch each ready capture's full file so capCard()
  // can actually show its content, per plan Phase G's M6 addendum.
  const ready = (S.meta?.captures || []).filter((c) => c.status === CAPTURE_STATUS.READY);
  await Promise.all(
    ready.map(async (c) => {
      const full = await S.store.getCapture(id, c.id);
      if (full) S.fullCaptures[c.id] = full;
    })
  );
  if (S.view === "source" && S.curId === id) render();
}

// Resolves a queue actionId to its human-readable text/pillar, for showing
// already-confirmed actions by content rather than just their id — cross-
// referencing S.queue (already loaded at app level), not a new fetch.
function queueAction(actionId) {
  for (const item of S.queue.items || []) {
    const a = (item.actionItems || []).find((x) => x.actionId === actionId);
    if (a) return a;
  }
  return null;
}

function pagesHTML(full, capId) {
  const set = new Set((full.highlights || []).map((h) => `${h.page}.${h.para}.${h.sentence}`));
  return (full.pages || [])
    .map((pg, pi) => {
      const pageLabel = pg.page ? `<div class="pgno">Page ${esc(pg.page)}</div>` : "";
      const paras = (pg.paragraphs || [])
        .map(
          (pa, ai) =>
            "<p>" +
            (pa.sentences || [])
              .map((s, si) => {
                const on = set.has(`${pi}.${ai}.${si}`);
                return `<span class="s${on ? " hl" : ""}" role="button" tabindex="0" aria-pressed="${on}" data-act="hl" data-cid="${capId}" data-pi="${pi}" data-ai="${ai}" data-si="${si}">${esc(s)}</span> `;
              })
              .join("") +
            "</p>"
        )
        .join("");
      return pageLabel + paras;
    })
    .join("");
}

function insightsHTML(full) {
  const ins = full.insights;
  if (!ins || (!(ins.points || []).length && !(ins.connections || []).length)) return "";
  return `<div class="block block-insights"><div class="block-label">Insights</div><ul class="ins">${(ins.points || [])
    .map((p) => `<li>${esc(p)}</li>`)
    .join("")}${(ins.connections || []).map((c) => `<li>Connects to: ${esc(c)}</li>`).join("")}</ul></div>`;
}

function actionsHTML(full, capId) {
  const confirmed = (full.confirmedActions || [])
    .map((id) => ({ id, a: queueAction(id) }))
    .filter(({ a }) => !a || a.status !== QUEUE_ACTION_STATUS.DISMISSED);
  const suggested = full.suggestedActions || [];
  const ui = actionUIFor(capId);
  if (!confirmed.length && !suggested.length && !ui.custom.length) return "";
  const pickedCount = ui.picks.size + ui.custom.length;

  let h = `<div class="block block-actions"><div class="block-label">Actions</div>`;
  if (confirmed.length) {
    h += confirmed
      .map(
        ({ id, a }) =>
          `<div class="confirmedrow"><span style="flex:1 1 auto">${esc(a ? a.action : id)}${a ? ` <span class="meta" style="margin:0">· ${esc(PILLARS[a.pillar] || a.pillar)}</span>` : ""}</span><button class="rm" data-act="dismissaction" data-id="${id}" aria-label="Delete task">×</button></div>`
      )
      .join("");
  }
  if (suggested.length || ui.custom.length) {
    h += `<p class="sub" style="margin:${confirmed.length ? "10px" : "0"} 0 6px">Tick or add actions, then tap Save to send them to Life OS.</p>
    <div class="acts-list">${suggested
      .map(
        (a, i) =>
          `<div class="actrow"><input type="checkbox" id="pk-${capId}-${i}" data-act="pick" data-cid="${capId}" data-i="${i}" ${ui.picks.has(i) ? "checked" : ""}><label for="pk-${capId}-${i}">${esc(a.action)}<small>${esc(PILLARS[a.pillar] || a.pillar)}</small></label></div>`
      )
      .join("")}${ui.custom
      .map(
        (c, i) =>
          `<div class="actrow"><input type="checkbox" checked disabled><label>${esc(c.action)}<small>${esc(PILLARS[c.pillar] || c.pillar)}</small></label><button class="rm" data-act="rmcustom" data-cid="${capId}" data-i="${i}" aria-label="Remove">×</button></div>`
      )
      .join("")}</div>`;
  }
  h += `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:10px">
    <input type="text" id="ca-${capId}" placeholder="Add your own action">
    <select id="cp-${capId}" aria-label="Pillar" style="width:auto">${Object.entries(PILLARS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div class="btnrow" style="margin-top:8px">
      <button class="btn ghost" data-act="addcustom" data-cid="${capId}" style="flex:0 1 auto">+ Add</button>
      ${pickedCount ? `<button class="btn primary" data-act="saveactions" data-cid="${capId}" style="flex:1 1 auto" ${ui.saving ? "disabled" : ""}>${ui.saving ? "Saving…" : `Save ${pickedCount} action${pickedCount > 1 ? "s" : ""}`}</button>` : ""}
    </div></div>`;
  return h;
}

function capCard(c) {
  const label = c.type === "page" ? (c.pages || []).map((p) => (p.page ? "p. " + p.page : "page")).join(", ") : c.type === "link" ? "Summary" : "Thought" + (c.pageRef ? " · p. " + c.pageRef : "");
  const armed = S.delArm === `cap:${c.id}`;
  const delBtn = `<button class="btn ghost danger" data-act="delcap" data-cid="${c.id}" style="min-height:30px">${armed ? "Confirm" : "Delete"}</button>`;
  const pending = [CAPTURE_STATUS.PENDING_TRANSCRIPTION, CAPTURE_STATUS.PENDING_SUMMARY].includes(c.status);
  if (pending) {
    return `<div class="card" style="border-style:dashed">
      <div class="row"><div class="kicker">${esc(label)}</div><div style="display:flex;gap:6px;align-items:center"><span class="pill">Pending</span>${delBtn}</div></div>
      <p class="sub" style="margin-top:8px">Saved to your library. Tap <b>Process now</b> below to transcribe/summarize it.</p></div>`;
  }
  if (c.status === CAPTURE_STATUS.NEEDS_RETAKE) {
    return `<div class="card"><div class="row"><div class="kicker">${esc(label)}</div><div style="display:flex;gap:6px;align-items:center"><span class="pill">Couldn't read this</span>${delBtn}</div></div>
      <p class="sub" style="margin-top:8px">No usable text came back from this photo. Retake it with better lighting.</p></div>`;
  }
  if (c.status === CAPTURE_STATUS.NEEDS_TEXT) {
    return `<div class="card"><div class="row"><div class="kicker">${esc(label)}</div><div style="display:flex;gap:6px;align-items:center"><span class="pill">Needs text</span>${delBtn}</div></div>
      <p class="sub" style="margin-top:8px">Couldn't fetch that link. Paste the transcript or key points to summarize it.</p></div>`;
  }

  const full = S.fullCaptures[c.id];
  let body = "";
  if (!full) {
    // ready, but its full file hasn't loaded yet (openSource's fetch is
    // still in flight) — light row still has enough for a minimal card.
    if (c.type === "thought") body += `<p class="quote">${esc(c.thought)}</p>`;
    body += `<p class="sub" style="margin-top:8px">Loading…</p>`;
  } else {
    if (full.type === "page") body += `<div class="reader">${pagesHTML(full, c.id)}</div>`;
    if (full.type === "thought") body += `<p class="quote">${esc(full.thought)}</p>`;
    if (full.type === "link" && full.summary) {
      body += `<p style="margin-top:6px">${esc(full.summary.summary)}</p>`;
      if ((full.summary.learnings || []).length) {
        body += `<div class="kicker" style="margin-top:10px">Key learnings</div><ul class="ins">${full.summary.learnings.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
      }
    }
    if (full.note) body += `<div class="note"><b>My note</b>${esc(full.note)}</div>`;
    body += insightsHTML(full);
    body += actionsHTML(full, c.id);
  }
  return `<div class="card"><div class="row"><div class="kicker">${esc(label)} · ${fmtRelative(c.createdAt)}</div>${delBtn}</div>${body}</div>`;
}

// Builds an editable working copy of a routine-drafted brief the first
// time a source's brief block renders it — plain fields for Lokesh to
// tweak, never raw JSON, per plan Phase G's M7 design.
function initBriefForm(draft, meta) {
  return {
    title: draft.title || meta.title || "",
    author: draft.author || meta.author || "",
    type: draft.type || meta.type,
    dateProcessed: draft.dateProcessed || todayISO(),
    topics: [...(draft.topics || [])],
    principles: (draft.principles || []).map((p) => ({ title: p.title || "", explanation: p.explanation || "" })),
    keyInsight: draft.keyInsight || "",
    framework: draft.framework ? { name: draft.framework.name || "", steps: (draft.framework.steps || []).map((s) => ({ step: s.step || "", desc: s.desc || "" })) } : null,
    connections: [...(draft.connections || [])],
    actionItems: draft.actionItems || [],
    retrievalQuestion: draft.retrievalQuestion || "",
    speakingReady: draft.speakingReady !== false,
  };
}

function briefBlock(meta) {
  if (meta.briefId) {
    return `<div class="block block-brief"><div class="block-label">Learning Brief</div><p class="sub" style="margin:0">✓ Saved to your library.</p></div>`;
  }
  if (!meta.draftBrief) {
    return `<div class="btnrow"><button class="btn" data-act="createbrief" data-id="${meta.id}" ${S.busy === "brief" ? "disabled" : ""}>${S.busy === "brief" ? "Drafting…" : "Create learning brief"}</button></div>`;
  }
  if (!S.briefForm) S.briefForm = initBriefForm(meta.draftBrief, meta);
  const f = S.briefForm;
  const saving = S.busy === "savebrief";
  return `<div class="block block-brief">
  <div class="block-label">Learning Brief — Draft</div>
  <p class="sub" style="margin:0 0 10px">Review and tweak before saving to your library.</p>
  <label for="bf-title">Title</label><input id="bf-title" type="text" data-bf="title" value="${esc(f.title)}">
  <label for="bf-author">Author</label><input id="bf-author" type="text" data-bf="author" value="${esc(f.author)}">
  <label>Topics <small style="font-weight:400">(up to 3)</small></label>
  <div class="seg">${BRIEF_TOPICS.map((t) => `<button class="btn" type="button" aria-pressed="${f.topics.includes(t)}" data-act="brieftopic" data-t="${esc(t)}">${esc(t)}</button>`).join("")}</div>
  <label>Principles</label>
  ${f.principles
    .map(
      (p, i) =>
        `<div class="reprow"><div><input type="text" data-bf="principle-title-${i}" value="${esc(p.title)}" placeholder="Principle"><textarea data-bf="principle-body-${i}" placeholder="Explanation" style="min-height:64px">${esc(p.explanation)}</textarea></div><button class="rm" data-act="rmprinciple" data-i="${i}" aria-label="Remove">×</button></div>`
    )
    .join("")}
  <div class="btnrow"><button class="btn ghost" data-act="addprinciple" style="flex:0 1 auto">+ Add principle</button></div>
  <label for="bf-ki">Key insight</label><textarea id="bf-ki" data-bf="keyInsight" style="min-height:80px">${esc(f.keyInsight)}</textarea>
  <label class="chk" style="border-top:0;padding-top:0"><input type="checkbox" data-act="togglefw" ${f.framework ? "checked" : ""}><span>This source has its own named framework or model</span></label>
  ${f.framework
    ? `<div style="margin-top:8px">
    <input type="text" data-bf="frameworkName" value="${esc(f.framework.name)}" placeholder="Framework name">
    ${f.framework.steps
      .map(
        (st, i) =>
          `<div class="reprow"><div><input type="text" data-bf="step-title-${i}" value="${esc(st.step)}" placeholder="Step"><textarea data-bf="step-desc-${i}" placeholder="What it means" style="min-height:56px">${esc(st.desc)}</textarea></div><button class="rm" data-act="rmstep" data-i="${i}" aria-label="Remove">×</button></div>`
      )
      .join("")}
    <div class="btnrow"><button class="btn ghost" data-act="addstep" style="flex:0 1 auto">+ Add step</button></div>
  </div>`
    : ""}
  <label>Connections</label>
  ${f.connections
    .map((c, i) => `<div class="reprow"><input type="text" data-bf="connection-${i}" value="${esc(c)}" placeholder="Links to another book, pillar, or idea"><button class="rm" data-act="rmconnection" data-i="${i}" aria-label="Remove">×</button></div>`)
    .join("")}
  <div class="btnrow"><button class="btn ghost" data-act="addconnection" style="flex:0 1 auto">+ Add connection</button></div>
  ${f.actionItems.length ? `<label>Confirmed actions</label><ul class="ins">${f.actionItems.map((a) => `<li>${esc(a.action)} <span class="meta" style="margin:0">· ${esc(PILLARS[a.pillar] || a.pillar)}</span></li>`).join("")}</ul>` : ""}
  <label for="bf-rq">Retrieval question</label><input id="bf-rq" type="text" data-bf="retrievalQuestion" value="${esc(f.retrievalQuestion)}">
  <label class="chk" style="border-top:0;padding-top:0"><input type="checkbox" data-bf="speakingReady" ${f.speakingReady ? "checked" : ""}><span>Ready to speak or write about this</span></label>
  <div class="btnrow" style="margin-top:14px">
    <button class="btn ghost" data-act="discardbrief" data-id="${meta.id}" style="flex:0 1 auto">Discard draft</button>
    <button class="btn primary" data-act="savebrief" data-id="${meta.id}" style="flex:1 1 auto" ${saving ? "disabled" : ""}>${saving ? "Saving…" : "Confirm & save to library"}</button>
  </div></div>`;
}

function vSource() {
  const s = S.sources.find((x) => x.id === S.curId);
  const meta = S.meta;
  if (!s) return `<button class="btn ghost back" data-act="home">‹ Library</button><p class="empty">This item was removed.</p>`;
  if (!meta) return `<button class="btn ghost back" data-act="home">‹ Library</button><div class="busy"><span class="dot"></span>Loading…</div>`;
  const isBook = s.type === "book";
  const hasPending = (meta.captures || []).some((c) => [CAPTURE_STATUS.PENDING_TRANSCRIPTION, CAPTURE_STATUS.PENDING_SUMMARY].includes(c.status)) || (meta.captures || []).some((c) => c.needsInsights);
  return `<button class="btn ghost back" data-act="home">‹ Library</button>
  <div class="kicker">${SOURCE_TYPES[s.type]}${meta.status === "finished" ? " · finished" : ""}</div><h1>${esc(meta.title)}</h1>
  <div class="sub">${esc(meta.author || "")}${meta.url ? ` · <a href="${esc(meta.url)}" target="_blank" rel="noopener">Open link</a>` : ""}</div>
  <div class="btnrow">
    ${isBook ? `<button class="btn primary" data-act="cap" data-mode="page" data-id="${s.id}">Add page</button>` : ""}
    <button class="btn${isBook ? "" : " primary"}" data-act="cap" data-mode="thought" data-id="${s.id}">Add thought</button>
  </div>
  ${hasPending ? `<div class="btnrow"><button class="btn" data-act="processnow" data-id="${s.id}" ${S.busy === "process" ? "disabled" : ""}>${S.busy === "process" ? "Processing…" : "Process now"}</button></div>` : ""}
  <div class="btnrow">${meta.status === "finished" ? `<button class="btn" data-act="reopen" data-id="${s.id}">Mark reading</button>` : `<button class="btn" data-act="finish" data-id="${s.id}">${isBook ? "Finished book" : "Mark done"}</button>`}</div>
  ${(meta.captures || []).length ? briefBlock(meta) : ""}
  <h2>Notes <small>${(meta.captures || []).length || ""}</small></h2>
  ${(meta.captures || []).length ? meta.captures.slice().reverse().map(capCard).join("") : `<div class="empty">${isBook ? "Photograph a page or jot a thought to make your first note." : "Add a thought or paste text to capture what you learned."}</div>`}
  <div class="btnrow" style="margin-top:30px"><button class="btn ghost danger" data-act="delsrc" style="flex:0 1 auto">${S.delArm === "src" ? "Tap again to delete this and all its notes" : "Delete"}</button></div>`;
}

async function toggleHighlight(capId, pi, ai, si) {
  const full = S.fullCaptures[capId];
  if (!full) return;
  const sentence = full.pages?.[pi]?.paragraphs?.[ai]?.sentences?.[si];
  if (sentence === undefined) return;
  const cur = full.highlights || [];
  const idx = cur.findIndex((h) => h.page === pi && h.para === ai && h.sentence === si);
  const next = idx >= 0 ? cur.filter((_, i) => i !== idx) : [...cur, { page: pi, para: ai, sentence: si, text: sentence }];
  S.fullCaptures[capId] = { ...full, highlights: next };
  render();
  await S.store.saveHighlights(S.curId, capId, next);
}

function addCustomAction(capId) {
  const input = $(`#ca-${capId}`);
  const select = $(`#cp-${capId}`);
  const action = (input?.value || "").trim();
  if (!action) return;
  actionUIFor(capId).custom.push({ action, pillar: select?.value || Object.keys(PILLARS)[0] });
  render();
  const newInput = $(`#ca-${capId}`);
  if (newInput) newInput.value = "";
}

function removeCustomAction(capId, i) {
  actionUIFor(capId).custom.splice(i, 1);
  render();
}

async function saveActionsFor(capId) {
  const full = S.fullCaptures[capId];
  if (!full) return;
  const ui = actionUIFor(capId);
  const picked = (full.suggestedActions || []).filter((_, i) => ui.picks.has(i));
  const actions = [...picked, ...ui.custom];
  if (!actions.length) return;
  ui.saving = true;
  render();
  const newIds = await S.store.confirmCaptureActions(S.curId, capId, S.meta, actions);
  ui.saving = false;
  if (newIds.length) {
    toast(`${newIds.length} action${newIds.length > 1 ? "s" : ""} added.`);
    delete S.actionUI[capId];
    S.queue = await S.store.getQueue();
    S.meta = await S.store.getSource(S.curId);
    const full2 = await S.store.getCapture(S.curId, capId);
    if (full2) S.fullCaptures[capId] = full2;
    const idx = await S.store.getIndex();
    S.sources = idx.sources;
  }
  render();
}

// Removes a task from the Open list without deleting it — sets status
// "dismissed" (per learning/CLAUDE.md's rule: a dismissed action stays in
// the queue, it's never actually deleted), so it drops out of every open
// count/list but the record (and its id) is still there in queue.json.
async function dismissAction(actionId) {
  const ok = await S.store.dismissAction(actionId);
  if (!ok) {
    toast("Couldn't remove — try again.");
    return;
  }
  toast("Task removed.");
  S.queue = await S.store.getQueue();
  render();
}

async function processNow(sourceId) {
  S.busy = "process";
  render();
  try {
    const { sessionUrl } = await fireRoutine();
    toast("Processing started — usually a minute or two.");
    S.lastRoutineUrl = sessionUrl;
  } catch (e) {
    toast(e instanceof RoutineError ? e.message : "Couldn't start processing.");
  }
  S.busy = "";
  render();
}

async function startBriefDraft(sourceId) {
  S.busy = "brief";
  render();
  try {
    await fireRoutine(`draft brief ${sourceId}`);
    toast("Drafting your brief — usually a minute or two. Reopen this book to see it.");
  } catch (e) {
    toast(e instanceof RoutineError ? e.message : "Couldn't start drafting.");
  }
  S.busy = "";
  render();
}

async function discardBrief(sourceId) {
  const ok = await S.store.discardDraftBrief(sourceId);
  if (!ok) {
    toast("Couldn't discard — try again.");
    return;
  }
  S.briefForm = null;
  S.meta = await S.store.getSource(sourceId);
  toast("Draft discarded.");
  render();
}

async function saveBrief(sourceId) {
  const f = S.briefForm;
  if (!f.title.trim()) {
    toast("Add a title first.");
    return;
  }
  if (!f.principles.some((p) => p.title.trim())) {
    toast("Add at least one principle first.");
    return;
  }
  S.busy = "savebrief";
  render();
  const briefFields = {
    title: f.title.trim(),
    author: f.author.trim(),
    type: f.type,
    dateProcessed: f.dateProcessed,
    topics: f.topics,
    principles: f.principles.filter((p) => p.title.trim()).map((p) => ({ title: p.title.trim(), explanation: p.explanation.trim() })),
    keyInsight: f.keyInsight.trim(),
    ...(f.framework && f.framework.name.trim()
      ? { framework: { name: f.framework.name.trim(), steps: f.framework.steps.filter((st) => st.step.trim()).map((st) => ({ step: st.step.trim(), desc: st.desc.trim() })) } }
      : {}),
    connections: f.connections.map((c) => c.trim()).filter(Boolean),
    actionItems: f.actionItems,
    retrievalQuestion: f.retrievalQuestion.trim(),
    speakingReady: !!f.speakingReady,
    reviewHistory: [],
  };
  const ok = await S.store.confirmBrief(sourceId, briefFields);
  S.busy = "";
  if (!ok) {
    toast("Couldn't save — try again.");
    render();
    return;
  }
  toast("Brief saved to your library.");
  S.briefForm = null;
  S.meta = await S.store.getSource(sourceId);
  const idx = await S.store.getIndex();
  S.sources = idx.sources;
  render();
}

/* ---------- Capture editor — thought mode is fully wired (FR-5, milestone M3).
   Page/link capture UI lands in milestone M4. ---------- */
function vCapture() {
  const d = S.draft;
  const s = S.sources.find((x) => x.id === d.srcId) || { title: "" };
  if (d.mode === "page") {
    return `<button class="btn ghost back" data-act="cancelcap">‹ ${esc(s.title)}</button><h1>Add page</h1>
    <p class="sub" style="margin:10px 0 16px">Take a photo of the page, or pick up to 4 pages from your photos. Up to 4 pages upload together and process as one note.</p>
    ${S.busy === "upload"
      ? `<div class="busy"><span class="dot"></span>Uploading…</div>`
      : `<label class="btn primary filebtn" style="width:100%;margin:0">Take or choose photos<input type="file" accept="image/*" multiple data-act="photos" aria-label="Take or choose photos"></label>`}
    ${d.err ? `<p class="err">${esc(d.err)}</p>` : ""}`;
  }
  if (d.mode !== "thought") {
    return `<button class="btn ghost back" data-act="cancelcap">‹ ${esc(s.title)}</button><h1>Coming soon</h1><p class="sub" style="margin-top:10px">This capture type lands in a later update — Add page and Add thought already work.</p>`;
  }
  return `<button class="btn ghost back" data-act="cancelcap">‹ ${esc(s.title)}</button><h1>Add a thought</h1>
  <label for="c-thought">Your thought</label><textarea id="c-thought" data-f="thought" style="min-height:140px" placeholder="What struck you, and why it matters">${esc(d.thought)}</textarea>
  ${s.type === "book" ? `<label for="c-page">Page (optional)</label><input id="c-page" type="text" inputmode="numeric" data-f="pageRef" value="${esc(d.pageRef)}" placeholder="112">` : ""}
  <label for="c-note">Your note</label><textarea id="c-note" data-f="note" placeholder="Optional — anything to add">${esc(d.note)}</textarea>
  ${d.err ? `<p class="err">${esc(d.err)}</p>` : ""}
  <div class="sticky"><button class="btn primary" style="width:100%" data-act="savethought" ${S.busy ? "disabled" : ""}>Save note</button></div>`;
}

async function uploadPagePhotos(files) {
  const d = S.draft;
  if (files.length > 4) {
    toast("Using the first 4 photos.");
    files = files.slice(0, 4);
  }
  S.busy = "upload";
  d.err = "";
  render();
  const result = await S.store.uploadPagePhotos(d.srcId, files);
  S.busy = "";
  if (!result.ok) {
    d.err = result.error;
    return render();
  }
  toast(`${files.length} photo${files.length > 1 ? "s" : ""} saved — waiting for processing.`);
  S.draft = null;
  await openSource(d.srcId);
}

async function saveThought() {
  const d = S.draft;
  if (!d.thought.trim()) {
    d.err = "Write your thought first.";
    return render();
  }
  S.busy = "save";
  render();
  const capId = await S.store.addThoughtCapture(d.srcId, { thought: d.thought.trim(), pageRef: (d.pageRef || "").trim(), note: (d.note || "").trim() });
  S.busy = "";
  if (!capId) return render();
  toast("Note saved.");
  S.draft = null;
  await openSource(d.srcId);
}

/* ---------- Settings ---------- */
function vSettings() {
  const rc = loadRoutineConfig() || { url: "", token: "" };
  const f = S.settingsForm || { routineUrl: rc.url, routineToken: rc.token };
  S.settingsForm = f;
  return `<button class="btn ghost back" data-act="home">‹ Library</button><h1>Settings</h1>
  <h2>Processing</h2>
  <p class="sub">The routine that transcribes photos, summarizes links, and drafts briefs. <a href="https://claude.ai/code/routines" target="_blank" rel="noopener">Manage your routine</a>.</p>
  <label for="s-rurl">Routine API URL</label><input id="s-rurl" type="text" data-f="routineUrl" value="${esc(f.routineUrl)}" placeholder="https://api.anthropic.com/v1/claude_code/routines/.../fire">
  <label for="s-rtoken">Routine token</label><input id="s-rtoken" type="password" data-f="routineToken" value="${esc(f.routineToken)}" placeholder="sk-ant-oat01-...">
  <div class="btnrow"><button class="btn primary" data-act="saveroutine" style="flex:0 1 auto">Save</button></div>
  <h2>Account</h2>
  <p class="sub">Connected to <b>${esc(S.cfg.repo)}</b>. Token stored only in this browser.</p>
  <div class="btnrow"><button class="btn ghost danger" data-act="forgetall" style="flex:0 1 auto">Forget token &amp; sign out</button></div>`;
}

function saveRoutineSettings() {
  const f = S.settingsForm;
  saveRoutineConfig({ url: f.routineUrl.trim(), token: f.routineToken.trim() });
  toast("Saved.");
}

function forgetAll() {
  clearConfig();
  clearPin();
  clearRoutineConfig();
  location.reload();
}

/* ---------- Actions (FR-7, thin version — full ticking UI lands with M6) ---------- */
function vActions() {
  const isOpen = (a) => a.status !== QUEUE_ACTION_STATUS.DONE && a.status !== QUEUE_ACTION_STATUS.DISMISSED;
  const open = (S.queue.items || []).flatMap((it) => (it.actionItems || []).filter(isOpen).map((a) => ({ ...a, srcTitle: it.title })));
  const done = (S.queue.items || []).flatMap((it) => (it.actionItems || []).filter((a) => a.status === QUEUE_ACTION_STATUS.DONE).map((a) => ({ ...a, srcTitle: it.title })));
  const statusLabel = (a) => (a.status === QUEUE_ACTION_STATUS.ACCEPTED ? "In Life OS" : a.status === QUEUE_ACTION_STATUS.DONE ? "Done" : "Waiting for /today");
  const openItem = (a) => `<div class="chk" style="cursor:default"><span>○</span><span style="flex:1 1 auto">${esc(a.action)}<small>${esc(PILLARS[a.pillar] || a.pillar)} · ${esc(a.srcTitle || "")} · ${statusLabel(a)}</small></span><button class="rm" data-act="dismissaction" data-id="${a.actionId}" aria-label="Delete task">×</button></div>`;
  const doneItem = (a) => `<div class="chk" style="cursor:default"><span>✓</span><span>${esc(a.action)}<small>${esc(PILLARS[a.pillar] || a.pillar)} · ${esc(a.srcTitle || "")} · ${statusLabel(a)}</small></span></div>`;
  return `<button class="btn ghost back" data-act="home">‹ Library</button><h1>Actions</h1>
  <h2>Open <small>${open.length || ""}</small></h2>${open.length ? `<div class="card">${open.map(openItem).join("")}</div>` : `<div class="empty">No open actions. Actions you tick when saving a note land here.</div>`}
  ${done.length ? `<h2>Recently done</h2><div class="card">${done.slice(-15).reverse().map(doneItem).join("")}</div>` : ""}`;
}

/* ---------- render dispatch ---------- */
function render() {
  const app = $("#app");
  if (S.view === "loading") return;
  const views = { auth: vAuth, pin: vPin, home: vHome, new: vNew, source: vSource, capture: vCapture, settings: vSettings, actions: vActions };
  app.innerHTML = (views[S.view] || vHome)();
}

/* ---------- events ---------- */
document.addEventListener("input", (e) => {
  const f = e.target.dataset.f;
  if (f) {
    if (S.view === "auth" && S.form) S.form[f] = e.target.value;
    else if (S.view === "new" && S.form) S.form[f] = e.target.value;
    else if (S.view === "capture" && S.draft) S.draft[f] = e.target.value;
    else if (S.view === "settings" && S.settingsForm) S.settingsForm[f] = e.target.value;
    return;
  }
  const bf = e.target.dataset.bf;
  if (!bf || S.view !== "source" || !S.briefForm) return;
  const fw = S.briefForm.framework;
  if (bf === "title") S.briefForm.title = e.target.value;
  else if (bf === "author") S.briefForm.author = e.target.value;
  else if (bf === "keyInsight") S.briefForm.keyInsight = e.target.value;
  else if (bf === "retrievalQuestion") S.briefForm.retrievalQuestion = e.target.value;
  else if (bf === "frameworkName" && fw) fw.name = e.target.value;
  else if (bf.startsWith("principle-title-")) S.briefForm.principles[+bf.split("-")[2]].title = e.target.value;
  else if (bf.startsWith("principle-body-")) S.briefForm.principles[+bf.split("-")[2]].explanation = e.target.value;
  else if (bf.startsWith("connection-")) S.briefForm.connections[+bf.split("-")[1]] = e.target.value;
  else if (bf.startsWith("step-title-") && fw) fw.steps[+bf.split("-")[2]].step = e.target.value;
  else if (bf.startsWith("step-desc-") && fw) fw.steps[+bf.split("-")[2]].desc = e.target.value;
});

document.addEventListener("change", async (e) => {
  if (e.target.dataset.act === "photos" && e.target.files && e.target.files.length) {
    const files = Array.from(e.target.files);
    e.target.value = "";
    await uploadPagePhotos(files);
    return;
  }
  if (e.target.dataset.act === "pick") {
    const capId = e.target.dataset.cid;
    const i = parseInt(e.target.dataset.i, 10);
    const ui = actionUIFor(capId);
    if (e.target.checked) ui.picks.add(i);
    else ui.picks.delete(i);
    render();
    return;
  }
  if (S.view === "source" && S.briefForm) {
    if (e.target.dataset.act === "togglefw") {
      S.briefForm.framework = e.target.checked ? { name: "", steps: [{ step: "", desc: "" }] } : null;
      render();
    } else if (e.target.dataset.bf === "speakingReady") {
      S.briefForm.speakingReady = e.target.checked;
    }
  }
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const a = b.dataset.act;
  if (b.tagName === "LABEL" && b.querySelector("input[type=file]")) return;
  if (a !== "delsrc" && a !== "delcap") S.delArm = null;
  switch (a) {
    case "connect":
      await connect();
      break;
    case "pinkey":
      await pinKey(b.dataset.k);
      break;
    case "forgetall":
      forgetAll();
      break;
    case "home":
      S.view = "home";
      S.form = null;
      render();
      await loadHome();
      break;
    case "settings":
      S.view = "settings";
      render();
      break;
    case "saveroutine":
      saveRoutineSettings();
      break;
    case "actions":
      S.view = "actions";
      render();
      break;
    case "new":
      S.form = { type: b.dataset.type, title: "", author: "", url: "", totalPages: "", text: "", err: "" };
      S.view = "new";
      render();
      break;
    case "ftype":
      S.form.type = b.dataset.type;
      render();
      break;
    case "create":
      await createSource();
      break;
    case "open":
      if (e.target.closest("button") && e.target.closest("button") !== b) return;
      await openSource(b.dataset.id);
      break;
    case "cap":
      S.draft = { srcId: b.dataset.id, mode: b.dataset.mode, thought: "", pageRef: "", note: "" };
      S.view = "capture";
      render();
      break;
    case "cancelcap":
      S.draft = null;
      S.view = "source";
      render();
      break;
    case "savethought":
      await saveThought();
      break;
    case "processnow":
      await processNow(b.dataset.id);
      break;
    case "createbrief":
      await startBriefDraft(b.dataset.id);
      break;
    case "brieftopic": {
      const t = b.dataset.t;
      const topics = S.briefForm.topics;
      const i = topics.indexOf(t);
      if (i >= 0) topics.splice(i, 1);
      else if (topics.length < 3) topics.push(t);
      else {
        toast("Up to 3 topics.");
        break;
      }
      render();
      break;
    }
    case "addprinciple":
      S.briefForm.principles.push({ title: "", explanation: "" });
      render();
      break;
    case "rmprinciple":
      S.briefForm.principles.splice(parseInt(b.dataset.i, 10), 1);
      render();
      break;
    case "addconnection":
      S.briefForm.connections.push("");
      render();
      break;
    case "rmconnection":
      S.briefForm.connections.splice(parseInt(b.dataset.i, 10), 1);
      render();
      break;
    case "addstep":
      S.briefForm.framework.steps.push({ step: "", desc: "" });
      render();
      break;
    case "rmstep":
      S.briefForm.framework.steps.splice(parseInt(b.dataset.i, 10), 1);
      render();
      break;
    case "discardbrief":
      await discardBrief(b.dataset.id);
      break;
    case "savebrief":
      await saveBrief(b.dataset.id);
      break;
    case "finish":
    case "reopen": {
      const newMeta = await S.store.setSourceStatus(b.dataset.id, a === "finish" ? "finished" : "active");
      if (newMeta) {
        S.meta = newMeta;
        S.sources = S.sources.map((r) => (r.id === b.dataset.id ? { ...r, status: newMeta.status } : r));
      }
      render();
      break;
    }
    case "delsrc": {
      if (S.delArm !== "src") {
        S.delArm = "src";
        return render();
      }
      S.delArm = null;
      await S.store.deleteSource(S.curId);
      toast("Deleted.");
      S.view = "home";
      render();
      await loadHome();
      break;
    }
    case "hl":
      await toggleHighlight(b.dataset.cid, parseInt(b.dataset.pi, 10), parseInt(b.dataset.ai, 10), parseInt(b.dataset.si, 10));
      break;
    case "addcustom":
      addCustomAction(b.dataset.cid);
      break;
    case "rmcustom":
      removeCustomAction(b.dataset.cid, parseInt(b.dataset.i, 10));
      break;
    case "saveactions":
      await saveActionsFor(b.dataset.cid);
      break;
    case "dismissaction":
      await dismissAction(b.dataset.id);
      break;
    case "delcap": {
      const cid = b.dataset.cid;
      const key = `cap:${cid}`;
      if (S.delArm !== key) {
        S.delArm = key;
        return render();
      }
      S.delArm = null;
      await S.store.deleteCapture(S.curId, cid);
      toast("Note deleted.");
      S.meta = await S.store.getSource(S.curId);
      const idx = await S.store.getIndex();
      S.sources = idx.sources;
      render();
      break;
    }
  }
});

init();
