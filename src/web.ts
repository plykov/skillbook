// Web books published with Writebook (37signals' open-source book publisher).
// A book has a table-of-contents page; each leaf (page or chapter divider) has
// its own URL, and appending ".md" to a leaf URL returns clean Markdown.
// Everything here is DOM-free so it runs the same in the browser and in tests.
import { buildSections, layoutGroups, type Book } from "./book";
import { cleanMarkdown, parseFrontMatter, type TextGroup } from "./markdown";

export type FetchText = (url: string) => Promise<string>;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Leaf {
  id: string;
  title: string;
  url: string;
  /** "section" leaves are chapter dividers; the pages that follow belong to them. */
  kind: "page" | "section";
}

export interface WritebookToc {
  title: string;
  subtitle: string;
  author: string;
  /** Landing page URL: origin + /{bookId}/{slug}. */
  url: string;
  leaves: Leaf[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Allows https, and http only for local testing. */
export function parseSourceUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error("That doesn't look like a web address. Paste the full link, starting with https://");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("Only https:// links are supported.");
  return u;
}

/** `https://host/9/book-slug[/leaf…]` → `https://host/9/book-slug`, or null if it isn't a Writebook-style path. */
export function bookLandingUrl(u: URL): string | null {
  const m = /^\/(\d+)\/([^/]+)/.exec(u.pathname);
  return m ? `${u.origin}/${m[1]}/${m[2]}` : null;
}

const LEAF_TITLE_LINK =
  /toc__leaf--(page|section)|<a\b[^>]*?class="[^"]*\btoc__title\b[^"]*"[^>]*?href="([^"]+)"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/g;

/** Reads the book's table of contents from its landing-page HTML. Returns null if no leaves are found. */
export function parseWritebookToc(html: string, landingUrl: string): WritebookToc | null {
  const base = new URL(landingUrl);
  const root = `${base.pathname.replace(/\/$/, "")}/`;
  const leaves: Leaf[] = [];
  const seen = new Set<string>();
  const add = (kind: Leaf["kind"], href: string, title: string) => {
    let u: URL;
    try {
      u = new URL(decodeEntities(href), base);
    } catch {
      return;
    }
    if (u.origin !== base.origin || !u.pathname.startsWith(root)) return;
    const rest = u.pathname.slice(root.length); // "198/before-you-start"
    if (!/^\d+\/[^/]+$/.test(rest)) return;
    const id = rest.split("/")[0];
    if (seen.has(id)) return;
    seen.add(id);
    // Titles sometimes end in a heading-anchor "#".
    leaves.push({ id, title: title.replace(/\s+#+$/, "") || rest.split("/")[1], url: `${u.origin}${u.pathname}`, kind });
  };

  let kind: Leaf["kind"] = "page";
  for (const m of html.matchAll(LEAF_TITLE_LINK)) {
    if (m[1]) kind = m[1] as Leaf["kind"];
    else add(kind, m[2], stripTags(m[3]));
  }
  if (leaves.length === 0) {
    // Markup changed: fall back to any link that looks like a leaf, treating all as pages.
    for (const m of html.matchAll(/<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) add("page", m[1], stripTags(m[2]).replace(/^Open\s+/, ""));
  }
  if (leaves.length === 0) return null;

  const cover = /<strong class="book__title[^"]*">([\s\S]*?)<\/strong>\s*(?:<span[^>]*>([\s\S]*?)<\/span>\s*)?(?:<span[^>]*>([\s\S]*?)<\/span>)?/.exec(html);
  const meta = (p: string) => new RegExp(`<meta[^>]+property="${p}"[^>]+content="([^"]*)"`).exec(html)?.[1];
  const title = (cover && stripTags(cover[1])) || decodeEntities(meta("og:title") ?? "") || stripTags(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "") || "Web book";
  return {
    title,
    subtitle: cover?.[2] ? stripTags(cover[2]) : decodeEntities(meta("og:description") ?? ""),
    author: cover?.[3] ? stripTags(cover[3]) : "",
    url: landingUrl,
    leaves,
  };
}

/** Pages that carry no teachable content (licence, terms, disclaimers). They are skipped at import. */
export const isLegalTitle = (title: string) => /^[^a-z0-9]*(legal\b|licen[sc]e\b|terms\b|privacy\b|disclaimer\b|copyright\b)/i.test(title);

export function parseLeaf(md: string, fallbackTitle: string): { title: string; text: string } {
  const { meta, body } = parseFrontMatter(md);
  return { title: meta.title || fallbackTitle, text: cleanMarkdown(body) };
}

/** Text of a chapter-divider leaf beyond its own title line (dividers are usually just a title). */
function ownText(text: string, title: string): string {
  const lines = text.split("\n");
  if (lines[0] && lines[0].replace(/^#+\s*/, "").trim().toLowerCase() === title.trim().toLowerCase()) lines.shift();
  const rest = lines.join("\n").trim();
  return rest.length >= 40 ? rest : "";
}

/**
 * Groups leaves into chapters: a section leaf starts a group that takes the
 * pages after it; pages outside any section are groups of their own.
 */
export function groupLeaves(leaves: Leaf[], texts: Map<string, string>): { groups: TextGroup[]; skipped: string[] } {
  const groups: { title: string; parts: string[] }[] = [];
  const skipped: string[] = [];
  let cur: { title: string; parts: string[] } | null = null;
  let skipSection = false;

  for (const leaf of leaves) {
    const text = texts.get(leaf.id) ?? "";
    if (leaf.kind === "section") {
      skipSection = isLegalTitle(leaf.title);
      if (skipSection) {
        skipped.push(leaf.title);
        cur = null;
        continue;
      }
      cur = { title: leaf.title, parts: [] };
      groups.push(cur);
      const own = ownText(text, leaf.title);
      if (own) cur.parts.push(own);
    } else if (skipSection) {
      skipped.push(leaf.title);
    } else if (isLegalTitle(leaf.title)) {
      skipped.push(leaf.title);
    } else if (text) {
      if (cur) cur.parts.push(text);
      else groups.push({ title: leaf.title, parts: [text] });
    }
  }
  return {
    groups: groups.filter((g) => g.parts.length).map((g) => ({ title: g.title, text: g.parts.join("\n\n") })),
    skipped,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, tries = 3, backoffMs = 400): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if ((e instanceof HttpError && e.status === 404) || i >= tries - 1) throw e;
      await sleep(backoffMs * (i + 1));
    }
  }
}

export interface LoadOptions {
  concurrency?: number;
  /** Pause after each request, per worker, to stay polite to the source site. */
  paceMs?: number;
}

export interface LoadedBook {
  book: Book;
  /** Notes to show the user after import. */
  notes: string[];
}

/** Fetches every leaf's Markdown and builds the Book. */
export async function loadWritebook(
  toc: WritebookToc,
  fetchText: FetchText,
  onProgress: (done: number, total: number) => void,
  { concurrency = 3, paceMs = 120 }: LoadOptions = {},
): Promise<LoadedBook> {
  const texts = new Map<string, string>();
  const missing: string[] = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < toc.leaves.length) {
      const leaf = toc.leaves[next++];
      if (isLegalTitle(leaf.title)) {
        onProgress(++done, toc.leaves.length);
        continue; // never fetched: skipped pages stay on the source site
      }
      try {
        const md = await withRetry(() => fetchText(`${leaf.url}.md`));
        texts.set(leaf.id, parseLeaf(md, leaf.title).text);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) missing.push(leaf.title);
        else throw new Error(`Couldn't read “${leaf.title}”: ${e instanceof Error ? e.message : String(e)}`);
      }
      onProgress(++done, toc.leaves.length);
      if (paceMs) await sleep(paceMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, toc.leaves.length) }, worker));

  const { groups, skipped } = groupLeaves(toc.leaves, texts);
  const { pages, outline } = layoutGroups(groups.map((g) => ({ title: g.title, text: g.text.startsWith("#") ? g.text : `# ${g.title}\n\n${g.text}` })));
  if (pages.join("").length < 200) throw new Error("Found the book's pages but almost no text in them. It may need a login, or be image-based.");

  const notes: string[] = [];
  if (skipped.length) notes.push(`Skipped ${skipped.length} licence/legal page${skipped.length > 1 ? "s" : ""} (${skipped.join("; ")}). They stay on the source site.`);
  if (missing.length) notes.push(`${missing.length} page${missing.length > 1 ? "s were" : " was"} not available as text (${missing.slice(0, 5).join("; ")}${missing.length > 5 ? "…" : ""}).`);

  return {
    book: {
      id: crypto.randomUUID(),
      format: "web",
      title: toc.title,
      author: toc.author,
      sourceUrl: toc.url,
      fileName: toc.url,
      pageCount: pages.length,
      importedAt: Date.now(),
      sections: buildSections(pages, outline, "loc"),
      emptyPages: 0,
    },
    notes,
  };
}
