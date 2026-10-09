// Fetches web pages through the user's own relay (see proxy/). Browsers can't
// read most websites directly (CORS), so a tiny Cloudflare Worker that the user
// deploys fetches the page and adds the headers the browser needs.
import { HttpError, type FetchText } from "./web";

const RELAY_ERROR = "skillbook-relay:";

export function relayFetch(relayUrl: string): FetchText {
  const base = relayUrl.trim().replace(/\/+$/, "");
  return async (url) => {
    let res: Response;
    try {
      res = await fetch(`${base}/?url=${encodeURIComponent(url)}`);
    } catch {
      throw new Error("Couldn't reach your relay. Check its address in Settings, and your connection.");
    }
    const body = await res.text();
    if (res.ok) return body;
    // The relay's own refusals carry a marker so they aren't mistaken for the website's errors.
    if (body.startsWith(RELAY_ERROR)) throw new Error(`Your relay said: ${body.slice(RELAY_ERROR.length).trim()}`);
    throw new HttpError(res.status, `the site answered ${res.status}`);
  };
}
