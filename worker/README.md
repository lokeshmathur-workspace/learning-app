# Routine proxy — deploy steps

This is a small Cloudflare Worker that sits between the app and Anthropic's
Claude Code Routine "fire" endpoint, purely to add the CORS header a browser
requires — the endpoint itself is built for server-to-server calls (curl,
backend code) and doesn't send one. It holds no secret of its own; your
routine's bearer token still lives only in your browser and is passed
through on every request, exactly as if the app called Anthropic directly.

## 1. Install Wrangler (if you haven't already, from the Life OS AI Worker)

```
npm install -g wrangler
wrangler login
```

## 2. Deploy

From this `worker/` folder:

```
wrangler deploy
```

No `wrangler secret put` step — there's nothing secret to store. This prints
a URL like `https://learning-routine-proxy.<your-subdomain>.workers.dev`.

## 3. Update the app's Settings

You already have the routine's real fire URL from setting up the routine
earlier — something like:

```
https://api.anthropic.com/v1/claude_code/routines/trig_XXXXXXXX/fire
```

In the app's **Settings**, replace the **Routine API URL** field with the
same path, but on your new Worker's domain instead of Anthropic's:

```
https://learning-routine-proxy.<your-subdomain>.workers.dev/v1/claude_code/routines/trig_XXXXXXXX/fire
```

Your **Routine token** field doesn't change — same token as before.

## Rotating or turning it off

- **Regenerate the routine token:** same as before — regenerate it at
  claude.ai/code/routines and update the app's Settings. Nothing here needs
  to change.
- **Turn it off:** `wrangler delete` removes the Worker. Process now will go
  back to failing with the CORS error until you either redeploy this or
  Anthropic adds browser CORS support to the endpoint directly.

## Cost

Free — this Worker makes one small request per Process now click, nowhere
near Cloudflare's free-tier limits.
