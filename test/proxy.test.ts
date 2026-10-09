import { describe, expect, it } from "vitest";
import { handle, hostAllowed } from "../proxy/worker.js";

const ENV = { ALLOWED_ORIGIN: "https://plykov.github.io", ALLOWED_HOSTS: "library.example.com, *.books.test" };
const ORIGIN = "https://plykov.github.io";

const req = (target: string, init: { origin?: string | null; method?: string } = {}) =>
  new Request(`https://relay.example.workers.dev/?url=${encodeURIComponent(target)}`, {
    method: init.method ?? "GET",
    headers: init.origin === null ? {} : { Origin: init.origin ?? ORIGIN },
  });

const page = (body: string, init: ResponseInit = {}) => new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8" }, ...init });

describe("hostAllowed", () => {
  it("matches exact hosts and wildcard subdomains only", () => {
    const allowed = ["library.example.com", "*.books.test"];
    expect(hostAllowed("library.example.com", allowed)).toBe(true);
    expect(hostAllowed("LIBRARY.example.com", allowed)).toBe(true);
    expect(hostAllowed("a.books.test", allowed)).toBe(true);
    expect(hostAllowed("books.test", allowed)).toBe(false);
    expect(hostAllowed("evilbooks.test", allowed)).toBe(false);
    expect(hostAllowed("library.example.com.evil.net", allowed)).toBe(false);
  });
});

describe("relay", () => {
  it("relays allowed pages with CORS for the app origin", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const res = await handle(req("https://library.example.com/9/x/1/y.md"), ENV, async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return page("# Hello", { headers: { "content-type": "text/markdown", "set-cookie": "session=secret" } });
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Hello");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen[0].url).toBe("https://library.example.com/9/x/1/y.md");
    expect(seen[0].headers["User-Agent"]).toMatch(/Skillbook-relay/);
    expect(Object.keys(seen[0].headers).map((k) => k.toLowerCase())).not.toContain("cookie");
  });

  it("refuses unknown origins, missing origin, and non-GET methods", async () => {
    const f = async () => page("x");
    const evil = await handle(req("https://library.example.com/a", { origin: "https://evil.example" }), ENV, f);
    expect(evil.status).toBe(403);
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await handle(req("https://library.example.com/a", { origin: null }), ENV, f)).status).toBe(403);
    expect((await handle(req("https://library.example.com/a", { method: "POST" }), ENV, f)).status).toBe(405);
    const pre = await handle(req("https://library.example.com/a", { method: "OPTIONS" }), ENV, f);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("only fetches allow-listed https hosts, and marks its own refusals", async () => {
    const f = async () => page("x");
    const notListed = await handle(req("https://other.example.org/a"), ENV, f);
    expect(notListed.status).toBe(403);
    expect(await notListed.text()).toMatch(/^skillbook-relay: other\.example\.org isn't on/);
    expect((await handle(req("http://library.example.com/a"), ENV, f)).status).toBe(400);
    expect((await handle(req("file:///etc/passwd"), ENV, f)).status).toBe(400);
    expect((await handle(new Request("https://r.dev/?url=nonsense", { headers: { Origin: ORIGIN } }), ENV, f)).status).toBe(400);
    expect((await handle(req("https://library.example.com/a"), { ...ENV, ALLOWED_HOSTS: "" }, f)).status).toBe(500);
  });

  it("re-checks the allow-list on every redirect hop", async () => {
    let calls = 0;
    const toEvil = async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    };
    const res = await handle(req("https://library.example.com/a"), ENV, toEvil);
    expect(res.status).toBe(403);
    expect(calls).toBe(1);

    const hops = async (url: string) => (url.endsWith("/b") ? page("landed") : new Response(null, { status: 301, headers: { location: "/b" } }));
    const ok = await handle(req("https://library.example.com/a"), ENV, hops);
    expect(await ok.text()).toBe("landed");

    const loop = async () => new Response(null, { status: 302, headers: { location: "https://library.example.com/again" } });
    expect((await handle(req("https://library.example.com/a"), ENV, loop)).status).toBe(502);
  });

  it("passes upstream statuses through, and refuses non-text or oversized bodies", async () => {
    const missing = await handle(req("https://library.example.com/nope.md"), ENV, async () => new Response("Not Found", { status: 404, headers: { "content-type": "text/html" } }));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not Found"); // no relay marker: it's the site's own 404

    const image = await handle(req("https://library.example.com/a.png"), ENV, async () => new Response("bytes", { headers: { "content-type": "image/png" } }));
    expect(image.status).toBe(415);

    const big = await handle(req("https://library.example.com/big"), ENV, async () => page("x", { headers: { "content-type": "text/html", "content-length": String(6 * 1024 * 1024) } }));
    expect(big.status).toBe(413);

    const down = await handle(req("https://library.example.com/a"), ENV, async () => Promise.reject(new Error("dns")));
    expect(down.status).toBe(502);
  });

  it("allows http only for localhost when ALLOW_HTTP is set (tests)", async () => {
    const env = { ...ENV, ALLOWED_HOSTS: "localhost", ALLOW_HTTP: "1" };
    expect((await handle(req("http://localhost:9000/x"), env, async () => page("ok"))).status).toBe(200);
    expect((await handle(req("http://localhost:9000/x"), { ...env, ALLOW_HTTP: "" }, async () => page("ok"))).status).toBe(400);
  });
});
