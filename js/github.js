// GitHub Contents API client. Talks only to the private data repo (owner/repo
// held in localStorage, entered on first run) — this app's own repo is public
// and never touches learning data, same split as lifeos-app/Claude.
//
// Ported from lifeos-app's js/github.js (copied, not imported, per the NFR
// that learning-app must not depend on lifeos-app files at runtime) with one
// addition: putBinaryFile(), for uploading photos, which lifeos-app never
// needed since it only ever writes JSON documents through compact().
import { compact } from "./compact.js?v=11";

const API = "https://api.github.com";

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ArrayBuffer -> base64, chunked to avoid call-stack limits on large photos
// (String.fromCharCode(...bigArray) can blow the stack around a few MB).
function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export class GitHubStoreError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code; // "not_found" | "conflict" | "auth" | "rate_limited" | "network" | "unknown"
    this.status = status;
  }
}

export class GitHubStore {
  constructor({ token, repo, branch = "main" }) {
    this.token = token;
    this.repo = repo; // "owner/name"
    this.branch = branch;
  }

  async _request(path, opts = {}) {
    let res;
    try {
      res = await fetch(`${API}/repos/${this.repo}/${path}`, {
        ...opts,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(opts.headers || {}),
        },
      });
    } catch (e) {
      throw new GitHubStoreError("Network error reaching GitHub.", "network");
    }
    if (res.status === 401 || res.status === 403) {
      throw new GitHubStoreError(
        "GitHub rejected the token — it may be expired or scoped wrong.",
        "auth",
        res.status
      );
    }
    if (res.status === 429) {
      throw new GitHubStoreError("Rate limited by GitHub.", "rate_limited", 429);
    }
    return res;
  }

  // Returns { json, sha } for an existing file, or { json: null, sha: null } on 404.
  // A signed-out/unauthenticated GET against a private repo also 404s — that's
  // the acceptance test for "learning data is never publicly reachable."
  async getFile(path) {
    const res = await this._request(
      `contents/${encodeURIComponent(path)}?ref=${this.branch}`
    );
    if (res.status === 404) return { json: null, sha: null };
    if (!res.ok) {
      throw new GitHubStoreError(`Couldn't read ${path} (${res.status}).`, "unknown", res.status);
    }
    const body = await res.json();
    const text = base64ToUtf8(body.content);
    return { json: JSON.parse(text), sha: body.sha };
  }

  // Full recursive file listing for the branch — used to find every source
  // folder/capture without walking sources/<id>/ one directory at a time.
  async listTree() {
    const ref = await this._request(`git/refs/heads/${this.branch}`);
    if (!ref.ok) throw new GitHubStoreError("Couldn't read branch ref.", "unknown", ref.status);
    const { object } = await ref.json();
    const tree = await this._request(`git/trees/${object.sha}?recursive=1`);
    if (!tree.ok) throw new GitHubStoreError("Couldn't list repo tree.", "unknown", tree.status);
    const { tree: entries } = await tree.json();
    return entries; // [{ path, type: "blob"|"tree", sha, ... }]
  }

  // Fetches a blob directly by sha (from listTree(), or a saved photoRef) —
  // one call, no second contents-API round trip to resolve the sha first.
  // This is how a deleted-from-inbox photo (see compact.js's design note on
  // photoRefs) stays viewable on demand: the blob sha is permanent as long
  // as history isn't rewritten, regardless of whether the path still exists
  // in the current tree.
  async getBlob(sha) {
    const res = await this._request(`git/blobs/${sha}`);
    if (!res.ok) throw new GitHubStoreError(`Couldn't read blob ${sha}.`, "unknown", res.status);
    return res.json(); // { content (base64), encoding, sha, size }
  }

  // sha: the sha getFile() returned, or null to create a new file. Rejects
  // (409/422) if the file changed since that sha was read.
  async putFile(path, doc, sha, message) {
    const content = utf8ToBase64(compact(doc) + "\n");
    return this._put(path, content, sha, message);
  }

  // Uploads a raw binary file (a downscaled JPEG) — same endpoint as
  // putFile, just base64 of the actual bytes with no JSON/compact() step.
  // file: a File/Blob from an <input type=file>.
  async putBinaryFile(path, file, sha, message) {
    const buf = await file.arrayBuffer();
    const content = bufferToBase64(buf);
    return this._put(path, content, sha, message);
  }

  async _put(path, base64Content, sha, message) {
    const res = await this._request(`contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: base64Content,
        branch: this.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.status === 409 || res.status === 422) {
      throw new GitHubStoreError(
        "Couldn't save — someone or something else changed this. Your text is still on screen.",
        "conflict",
        res.status
      );
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new GitHubStoreError(
        `Couldn't save — your text is still on screen. (${body.message || res.status})`,
        "unknown",
        res.status
      );
    }
    const body = await res.json();
    return { sha: body.content.sha };
  }

  // Deletes a file outright (used once a photo has been transcribed and its
  // blob reference saved on the capture record — see plan Phase G decision
  // #9). sha is required by the Contents API delete endpoint.
  async deleteFile(path, sha, message) {
    const res = await this._request(`contents/${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sha, branch: this.branch }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new GitHubStoreError(
        `Couldn't delete ${path}. (${body.message || res.status})`,
        "unknown",
        res.status
      );
    }
  }
}
