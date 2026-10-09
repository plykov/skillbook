// Skillbook relay: a tiny Cloudflare Worker that fetches web pages for the app.
//
// Browsers refuse to read most websites from another origin (CORS), so the app
// asks this Worker to fetch a page and return it with the right headers. It is
// deliberately narrow:
//   - only the app's own origin(s) may call it            (ALLOWED_ORIGIN)
//   - it only fetches hosts you list                      (ALLOWED_HOSTS)
//   - GET only, https only, text responses only, 5 MB max
//   - no cookies or credentials are forwarded or returned
// The ALLOWED_HOSTS list is the real protection: even if someone forges the
// Origin header, the Worker can only fetch the sites you named.

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TEXT_TYPES = /^(text\/|application\/(xhtml\+xml|xml|json))/i;

const list = (v) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** Exact host, or "*.example.com" for any subdomain. */
export function hostAllowed(host, allowed) {
  host = host.toLowerCase();
  return allowed.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p));
}

function relayError(status, message, cors) {
  // The marker lets the app tell relay refusals apart from the website's own errors.
  return new Response(`skillbook-relay: ${message}`, { status, headers: { ...cors, "content-type": "text/plain; charset=utf-8" } });
}

export async function handle(request, env, fetchImpl = fetch) {
  const origins = list(env.ALLOWED_ORIGIN);
  const origin = request.headers.get("Origin") ?? "";
  const cors = origins.includes(origin.toLowerCase()) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
  if (!cors["Access-Control-Allow-Origin"]) return relayError(403, "this origin isn't allowed. Set ALLOWED_ORIGIN to your app's address.", cors);
  if (request.method !== "GET") return relayError(405, "GET only.", cors);

  const allowedHosts = list(env.ALLOWED_HOSTS);
  if (allowedHosts.length === 0) return relayError(500, "ALLOWED_HOSTS isn't set on the relay.", cors);

  let target;
  try {
    target = new URL(new URL(request.url).searchParams.get("url") ?? "");
  } catch {
    return relayError(400, "missing or invalid ?url= parameter.", cors);
  }

  let res;
  for (let hop = 0; ; hop++) {
    const local = env.ALLOW_HTTP === "1" && (target.hostname === "localhost" || target.hostname === "127.0.0.1");
    if (target.protocol !== "https:" && !local) return relayError(400, "https links only.", cors);
    if (!hostAllowed(target.hostname, allowedHosts)) return relayError(403, `${target.hostname} isn't on the relay's ALLOWED_HOSTS list.`, cors);
    if (hop > MAX_REDIRECTS) return relayError(502, "too many redirects.", cors);

    try {
      res = await fetchImpl(target.href, {
        redirect: "manual",
        headers: { "User-Agent": "Skillbook-relay/1 (personal reading; +https://github.com/plykov/skillbook)", Accept: "text/markdown, text/html;q=0.9, */*;q=0.5" },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch {
      return relayError(502, `couldn't reach ${target.hostname}.`, cors);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      target = new URL(res.headers.get("location"), target);
      continue;
    }
    break;
  }

  const type = res.headers.get("content-type") ?? "";
  if (res.ok && !TEXT_TYPES.test(type)) return relayError(415, `won't relay "${type || "unknown"}" content; text only.`, cors);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return relayError(413, "response too large.", cors);
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return relayError(413, "response too large.", cors);

  // Upstream status passes through (a 404 stays a 404); upstream headers (cookies etc.) do not.
  return new Response(body, { status: res.status, headers: { ...cors, "content-type": type || "text/plain; charset=utf-8", "Cache-Control": "private, max-age=300" } });
}

export default { fetch: (request, env) => handle(request, env) };
