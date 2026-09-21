// CORS relay for Anthropic's Claude Code Routine "fire" endpoint.
//
// Why this exists: api.anthropic.com/v1/claude_code/routines/*/fire is built
// for server-to-server calls (curl, backend code) -- it sends no
// Access-Control-Allow-Origin header, so a browser refuses to let JS call it
// directly cross-origin (confirmed by testing the endpoint's OPTIONS
// response directly). This Worker sits in between purely to add that header;
// it does NOT hold the routine's bearer token as a secret -- the app still
// sends it with every request (Authorization header), same as if it were
// calling Anthropic directly, and this Worker never stores or logs it. It's
// a CORS bridge, not a credential holder -- that's why, unlike the Life OS
// AI Worker, there's no `wrangler secret put` step for this one at all.
//
// Only ever forwards to Anthropic's routine-fire paths, never an arbitrary
// URL -- so even though this Worker's own URL isn't secret, it can't be
// used as an open relay to somewhere else.

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, anthropic-beta, anthropic-version",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    const headers = cors(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      return new Response("POST only.", { status: 405, headers });
    }

    const url = new URL(request.url);
    if (!/^\/v1\/claude_code\/routines\/[^/]+\/fire$/.test(url.pathname)) {
      return new Response("Not found.", { status: 404, headers });
    }

    const auth = request.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ ok: false, message: "Missing Authorization header." }), {
        status: 401,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    let upstream;
    try {
      upstream = await fetch(`https://api.anthropic.com${url.pathname}`, {
        method: "POST",
        headers: {
          Authorization: auth,
          "anthropic-beta": request.headers.get("anthropic-beta") || "experimental-cc-routine-2026-04-01",
          "anthropic-version": request.headers.get("anthropic-version") || "2023-06-01",
          "Content-Type": "application/json",
        },
        body: await request.text(),
      });
    } catch {
      return new Response(JSON.stringify({ ok: false, message: "Couldn't reach Anthropic." }), {
        status: 502,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...headers, "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  },
};
