// Learning app — main view/render logic. Same event-delegation shape as the
// approved prototype (one click listener, data-act dispatch), but backed by
// real GitHub-API calls through store.js instead of the claude.ai artifact
// runtime, so every action here is async.
import { Store, loadConfig, saveConfig, clearConfig, loadPinHash, savePinHash, clearPin, sha256Hex } from "./store.js";
import { loadRoutineConfig, saveRoutineConfig, clearRoutineConfig, fireRoutine, RoutineError } from "./routine.js";
import { PILLARS, SOURCE_TYPES, CAPTURE_STATUS, QUEUE_ACTION_STATUS } from "./constants.js";
import { fmtRelative, todayISO, prettyDate } from "./dateutil.js";

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
};

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
  const openActions = (S.queue.items || []).reduce((n, it) => n + (it.actionItems || []).filter((a) => a.status !== QUEUE_ACTION_STATUS.DONE).length, 0);
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
  <button class="stat" data-act="actions"><b>${openActions}</b><span>Actions pending</span></button></div>
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
  render();
  S.meta = await S.store.getSource(id);
  render();
}

function capCard(c) {
  const label = c.type === "page" ? (c.pages || []).map((p) => (p.page ? "p. " + p.page : "page")).join(", ") : c.type === "link" ? "Summary" : "Thought" + (c.pageRef ? " · p. " + c.pageRef : "");
  const pending = [CAPTURE_STATUS.PENDING_TRANSCRIPTION, CAPTURE_STATUS.PENDING_SUMMARY].includes(c.status);
  if (pending) {
    return `<div class="card" style="border-style:dashed">
      <div class="row"><div class="kicker">${esc(label)}</div><span class="pill">Pending</span></div>
      <p class="sub" style="margin-top:8px">Saved to your library. Tap <b>Process now</b> below to transcribe/summarize it.</p></div>`;
  }
  if (c.status === CAPTURE_STATUS.NEEDS_RETAKE) {
    return `<div class="card"><div class="row"><div class="kicker">${esc(label)}</div><span class="pill">Couldn't read this</span></div>
      <p class="sub" style="margin-top:8px">No usable text came back from this photo. Retake it with better lighting.</p></div>`;
  }
  if (c.status === CAPTURE_STATUS.NEEDS_TEXT) {
    return `<div class="card"><div class="row"><div class="kicker">${esc(label)}</div><span class="pill">Needs text</span></div>
      <p class="sub" style="margin-top:8px">Couldn't fetch that link. Paste the transcript or key points to summarize it.</p></div>`;
  }
  let body = "";
  if (c.type === "thought") body += `<p class="quote">${esc(c.thought)}</p>`;
  if (c.note) body += `<div class="note"><b>My note</b>${esc(c.note)}</div>`;
  if ((c.actionIds || []).length) body += `<div class="note"><b>Actions</b><p class="sub">${c.actionIds.length} confirmed</p></div>`;
  if (c.needsInsights) body += `<p class="sub" style="margin-top:8px">Insights pending — tap Process now.</p>`;
  return `<div class="card"><div class="kicker">${esc(label)} · ${fmtRelative(c.createdAt)}</div>${body}</div>`;
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
  <h2>Notes <small>${(meta.captures || []).length || ""}</small></h2>
  ${(meta.captures || []).length ? meta.captures.slice().reverse().map(capCard).join("") : `<div class="empty">${isBook ? "Photograph a page or jot a thought to make your first note." : "Add a thought or paste text to capture what you learned."}</div>`}
  <div class="btnrow" style="margin-top:30px"><button class="btn ghost danger" data-act="delsrc" style="flex:0 1 auto">${S.delArm === "src" ? "Tap again to delete this and all its notes" : "Delete"}</button></div>`;
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

/* ---------- Capture editor — thought mode is fully wired (FR-5, milestone M3).
   Page/link capture UI lands in milestone M4. ---------- */
function vCapture() {
  const d = S.draft;
  const s = S.sources.find((x) => x.id === d.srcId) || { title: "" };
  if (d.mode !== "thought") {
    return `<button class="btn ghost back" data-act="cancelcap">‹ ${esc(s.title)}</button><h1>Coming soon</h1><p class="sub" style="margin-top:10px">Page-photo capture lands in the next update — Add thought already works.</p>`;
  }
  return `<button class="btn ghost back" data-act="cancelcap">‹ ${esc(s.title)}</button><h1>Add a thought</h1>
  <label for="c-thought">Your thought</label><textarea id="c-thought" data-f="thought" style="min-height:140px" placeholder="What struck you, and why it matters">${esc(d.thought)}</textarea>
  ${s.type === "book" ? `<label for="c-page">Page (optional)</label><input id="c-page" type="text" inputmode="numeric" data-f="pageRef" value="${esc(d.pageRef)}" placeholder="112">` : ""}
  <label for="c-note">Your note</label><textarea id="c-note" data-f="note" placeholder="Optional — anything to add">${esc(d.note)}</textarea>
  ${d.err ? `<p class="err">${esc(d.err)}</p>` : ""}
  <div class="sticky"><button class="btn primary" style="width:100%" data-act="savethought" ${S.busy ? "disabled" : ""}>Save note</button></div>`;
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
  const open = (S.queue.items || []).flatMap((it) => (it.actionItems || []).filter((a) => a.status !== QUEUE_ACTION_STATUS.DONE).map((a) => ({ ...a, srcTitle: it.title })));
  const done = (S.queue.items || []).flatMap((it) => (it.actionItems || []).filter((a) => a.status === QUEUE_ACTION_STATUS.DONE).map((a) => ({ ...a, srcTitle: it.title })));
  const statusLabel = (a) => (a.status === QUEUE_ACTION_STATUS.ACCEPTED ? "In Life OS" : a.status === QUEUE_ACTION_STATUS.DONE ? "Done" : "Waiting for /today");
  const item = (a) => `<div class="chk" style="cursor:default"><span>${a.status === QUEUE_ACTION_STATUS.DONE ? "✓" : "○"}</span><span>${esc(a.action)}<small>${esc(PILLARS[a.pillar] || a.pillar)} · ${esc(a.srcTitle || "")} · ${statusLabel(a)}</small></span></div>`;
  return `<button class="btn ghost back" data-act="home">‹ Library</button><h1>Actions</h1>
  <h2>Open <small>${open.length || ""}</small></h2>${open.length ? `<div class="card">${open.map(item).join("")}</div>` : `<div class="empty">No open actions. Actions you tick when saving a note land here.</div>`}
  ${done.length ? `<h2>Recently done</h2><div class="card">${done.slice(-15).reverse().map(item).join("")}</div>` : ""}`;
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
  if (!f) return;
  if (S.view === "auth" && S.form) S.form[f] = e.target.value;
  else if (S.view === "new" && S.form) S.form[f] = e.target.value;
  else if (S.view === "capture" && S.draft) S.draft[f] = e.target.value;
  else if (S.view === "settings" && S.settingsForm) S.settingsForm[f] = e.target.value;
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const a = b.dataset.act;
  if (b.tagName === "LABEL" && b.querySelector("input[type=file]")) return;
  if (a !== "delsrc") S.delArm = null;
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
  }
});

init();
