// EPUB → Book, entirely on-device. An EPUB is a zip of XHTML chapters plus an
// OPF manifest/spine and a table of contents (EPUB 3 nav document or EPUB 2 NCX).
// It has no pages, so the text is cut into fixed-size "locations" (up to ~2,000 characters) that citations
// refer to (loc. 12), and chapters come from the table of contents.
import { unzipSync } from "fflate";
import { LOCATION_CHARS, buildSections, chunkPages, type Book, type OutlineEntry } from "./book";
import { byLocal, htmlToText, parse, parseXhtml } from "./html";

// ---------- pure helpers (unit-tested) ----------

/** Resolves an href against the directory of the file that contains it. Returns a zip path. */
export function resolveHref(baseFile: string, href: string): string {
  const [path] = href.split("#");
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* keep as written */
  }
  const parts = (decoded.startsWith("/") ? decoded.slice(1) : baseFile.split("/").slice(0, -1).concat(decoded.split("/")).join("/")).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

export function fragmentOf(href: string): string {
  const i = href.indexOf("#");
  if (i < 0) return "";
  try {
    return decodeURIComponent(href.slice(i + 1));
  } catch {
    return href.slice(i + 1);
  }
}

const FONT_OBFUSCATION = ["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"];

/** True if encryption.xml declares anything beyond font obfuscation (i.e. DRM). */
export function hasDrm(encryptionXml: string | undefined, hasRightsXml: boolean): boolean {
  if (hasRightsXml) return true;
  if (!encryptionXml) return false;
  const algos = [...encryptionXml.matchAll(/Algorithm\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  return algos.some((a) => !FONT_OBFUSCATION.includes(a) && !/xmlenc#sha|xmldsig|c14n/i.test(a));
}

export interface EpubDoc {
  /** Zip path of the document. */
  href: string;
  text: string;
  /** Element id → character offset in `text`. */
  anchors: Record<string, number>;
}

export interface TocEntry {
  title: string;
  /** Zip path of the target document. */
  href: string;
  fragment: string;
}

/**
 * Cuts every spine document into pseudo-pages and maps TOC entries to the first
 * page of the text they point at. A TOC entry with a fragment starts a new
 * segment inside its document, so books that keep many chapters in one HTML
 * file still get one section per chapter.
 */
export function layoutEpub(docs: EpubDoc[], toc: TocEntry[], size = LOCATION_CHARS): { pages: string[]; outline: OutlineEntry[] } {
  const byHref = new Map(docs.map((d, i) => [d.href, i]));
  // Cut offsets per document, from TOC fragments that resolve to an anchor.
  const cuts: Set<number>[] = docs.map(() => new Set([0]));
  const entryOffset = toc.map((e) => {
    const i = byHref.get(e.href);
    if (i === undefined) return null;
    const at = e.fragment ? docs[i].anchors[e.fragment] : 0;
    const off = Math.min(at ?? 0, docs[i].text.length);
    cuts[i].add(off);
    return { doc: i, off };
  });

  const pages: string[] = [];
  const segmentStart = new Map<string, number>(); // `${doc}:${offset}` → page index
  docs.forEach((d, i) => {
    const offs = [...cuts[i]].sort((a, b) => a - b);
    offs.forEach((off, k) => {
      segmentStart.set(`${i}:${off}`, pages.length);
      pages.push(...chunkPages(d.text.slice(off, offs[k + 1] ?? d.text.length), size));
    });
  });

  const outline: OutlineEntry[] = [];
  toc.forEach((e, k) => {
    const at = entryOffset[k];
    if (!at) return;
    const page = segmentStart.get(`${at.doc}:${at.off}`);
    // Entries pointing at text-less documents land on whatever follows; entries past the end are dropped.
    if (page !== undefined && page < pages.length) outline.push({ title: e.title, page: page + 1 });
  });
  return { pages, outline };
}

// ---------- the importer ----------

const dec = new TextDecoder("utf-8");
const MAX_TEXT_FILE = 20 * 1024 * 1024;

export async function importEpub(file: File, onProgress: (done: number, total: number) => void): Promise<Book> {
  // Only unzip the text-like parts; images and fonts are skipped.
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (f) => f.originalSize < MAX_TEXT_FILE && /\.(x?html?|xml|opf|ncx)$|(^|\/)(encryption|rights)\.xml$/i.test(f.name),
  });
  const read = (path: string): string | undefined => {
    const hit = zip[path] ?? Object.entries(zip).find(([k]) => k.toLowerCase() === path.toLowerCase())?.[1];
    return hit ? dec.decode(hit) : undefined;
  };

  if (hasDrm(read("META-INF/encryption.xml"), "META-INF/rights.xml" in zip)) {
    throw new Error("This EPUB is DRM-protected, so it can't be read here. Use a DRM-free copy (many publishers sell these) or the PDF edition.");
  }

  const container = read("META-INF/container.xml");
  if (!container) throw new Error("This doesn't look like a valid EPUB (no META-INF/container.xml).");
  const opfPath = byLocal(parse(container, "application/xml"), "rootfile")[0]?.getAttribute("full-path");
  const opfXml = opfPath ? read(opfPath) : undefined;
  if (!opfPath || !opfXml) throw new Error("This EPUB has no readable package file.");
  const opf = parse(opfXml, "application/xml");

  const meta = (name: string) =>
    byLocal(opf, name)
      .map((e) => e.textContent?.trim() ?? "")
      .filter(Boolean);

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const item of byLocal(opf, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href)
      manifest.set(id, { href: resolveHref(opfPath, href), type: item.getAttribute("media-type") ?? "", props: item.getAttribute("properties") ?? "" });
  }

  const spine = byLocal(opf, "itemref")
    .map((r) => manifest.get(r.getAttribute("idref") ?? ""))
    .filter((m): m is NonNullable<typeof m> => !!m && /x?html/i.test(m.type));
  if (spine.length === 0) throw new Error("This EPUB has no readable chapters.");

  // Chapters → text
  const docs: EpubDoc[] = [];
  for (let i = 0; i < spine.length; i++) {
    const xml = read(spine[i].href);
    if (xml) {
      const d = parseXhtml(xml);
      const { text, anchors } = htmlToText(byLocal(d, "body")[0] ?? d.documentElement);
      docs.push({ href: spine[i].href, text, anchors });
    }
    onProgress(i + 1, spine.length);
    if (i % 8 === 7) await new Promise((r) => setTimeout(r)); // keep the UI responsive
  }

  const { pages, outline } = layoutEpub(docs, readToc(opf, manifest, read));
  if (pages.join("").length < 200) throw new Error("This EPUB has almost no text (it may be image-based, like a comic or scan).");

  const title = meta("title")[0] || file.name.replace(/\.epub$/i, "");
  return {
    id: crypto.randomUUID(),
    format: "epub",
    title,
    author: meta("creator").join(", "),
    fileName: file.name,
    pageCount: pages.length,
    importedAt: Date.now(),
    sections: buildSections(pages, outline, "loc"),
    emptyPages: 0,
  };
}

/** Table of contents from the EPUB 3 nav document, else the EPUB 2 NCX. Top-level entries unless there are too few. */
function readToc(
  opf: Document,
  manifest: Map<string, { href: string; type: string; props: string }>,
  read: (path: string) => string | undefined,
): TocEntry[] {
  type Raw = { title: string; href: string; depth: number };
  const finish = (raw: Raw[], base: string): TocEntry[] => {
    const top = raw.filter((r) => r.depth <= 1);
    return (top.length >= 3 ? top : raw)
      .filter((r) => r.href && r.title)
      .map((r) => ({ title: r.title.replace(/\s+/g, " ").trim(), href: resolveHref(base, r.href), fragment: fragmentOf(r.href) }));
  };

  const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes("nav"));
  const navXml = nav && read(nav.href);
  if (nav && navXml) {
    const doc = parseXhtml(navXml);
    const navs = byLocal(doc, "nav");
    const toc = navs.find((n) => (n.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? n.getAttribute("epub:type") ?? "").includes("toc")) ?? navs[0];
    if (toc) {
      const raw = byLocal(toc, "a").map((a) => {
        let depth = 0;
        for (let p = a.parentElement; p && p !== toc; p = p.parentElement) if (p.localName.toLowerCase() === "ol") depth++;
        return { title: a.textContent ?? "", href: a.getAttribute("href") ?? "", depth };
      });
      const entries = finish(raw, nav.href);
      if (entries.length) return entries;
    }
  }

  const spineToc = byLocal(opf, "spine")[0]?.getAttribute("toc");
  const ncx = (spineToc && manifest.get(spineToc)) || [...manifest.values()].find((m) => /dtbncx/i.test(m.type));
  const ncxXml = ncx && read(ncx.href);
  if (ncx && ncxXml) {
    const raw = byLocal(parse(ncxXml, "application/xml"), "navPoint".toLowerCase()).map((np) => {
      let depth = 0;
      for (let p: Element | null = np; p; p = p.parentElement) if (p.localName.toLowerCase() === "navpoint") depth++;
      const label = byLocal(np, "text")[0]?.textContent ?? "";
      const content = byLocal(np, "content")[0]?.getAttribute("src") ?? "";
      return { title: label, href: content, depth };
    });
    return finish(raw, ncx.href);
  }
  return [];
}
