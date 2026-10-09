// Pure book-model helpers: page cleanup, sectioning, citation → page mapping.
// No DOM or pdf.js imports here so everything is unit-testable.

export interface Section {
  title: string;
  /** 1-based page number of the first page in this section. */
  firstPage: number;
  text: string;
  /** Char offset in `text` where each page starts; pageStarts[0] === 0. */
  pageStarts: number[];
  /** Left out of everything sent to Claude (index, bibliography, …). */
  excluded?: boolean;
}

/** How a book is located: PDF pages, or "locations" (fixed ~2,000-character slices of the text) for everything else. */
export type Locator = "page" | "loc";

export interface Book {
  id: string;
  /** Missing on books imported before EPUB support (all PDFs). */
  format?: "pdf" | "epub" | "web" | "text";
  /** Where a web book was imported from. */
  sourceUrl?: string;
  title: string;
  author: string;
  fileName: string;
  /** Pages (PDF) or locations (EPUB). */
  pageCount: number;
  importedAt: number;
  sections: Section[];
  /** Pages with almost no extractable text (likely scanned images). */
  emptyPages: number;
}

export interface OutlineEntry {
  title: string;
  /** 1-based page number. */
  page: number;
}

const DIGITS = /\d+/g;

function normaliseEdgeLine(line: string): string {
  return line.trim().toLowerCase().replace(DIGITS, "#").replace(/\s+/g, " ");
}

/**
 * Removes running headers/footers and bare page numbers.
 * A line in the first or last two positions of a page is dropped when its
 * digit-normalised form appears on at least 40% of pages.
 */
export function stripRunningHeads(pages: string[][]): string[][] {
  const EDGE = 2;
  pages = pages.map((lines) => lines.filter((l) => !isPageNumber(l)));
  if (pages.length < 8) return pages;
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const seen = new Set<string>();
    for (const l of edgeLines(lines, EDGE)) seen.add(normaliseEdgeLine(l));
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(4, pages.length * 0.4);
  return pages.map((lines) =>
    lines.filter((l, i) => {
      const atEdge = i < EDGE || i >= lines.length - EDGE;
      if (!atEdge) return true;
      const k = normaliseEdgeLine(l);
      return k === "" || (counts.get(k) ?? 0) < threshold;
    }),
  );
}

function edgeLines(lines: string[], n: number): string[] {
  return lines.length <= n * 2 ? lines : [...lines.slice(0, n), ...lines.slice(-n)];
}

function isPageNumber(line: string): boolean {
  return /^\s*(page\s+)?[\divxlc]{1,6}\s*$/i.test(line);
}

/** Joins lines into paragraphs-ish text and repairs end-of-line hyphenation. */
export function joinLines(lines: string[]): string {
  return lines
    .map((l) => l.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const FALLBACK_PAGES_PER_SECTION = 25;
const MAX_SECTIONS = 60;

/**
 * Splits page texts into sections using the PDF outline when it is usable,
 * otherwise into fixed-size page ranges.
 */
export function buildSections(pageTexts: string[], outline: OutlineEntry[], locator: Locator = "page"): Section[] {
  const n = pageTexts.length;
  let starts = cleanOutline(outline, n);
  if (starts.length < 3) {
    starts = [];
    for (let p = 1; p <= n; p += FALLBACK_PAGES_PER_SECTION) {
      const end = Math.min(n, p + FALLBACK_PAGES_PER_SECTION - 1);
      starts.push({ title: `${locator === "loc" ? "Locations" : "Pages"} ${p}–${end}`, page: p });
    }
  } else if (starts[0].page > 1) {
    starts.unshift({ title: "Front matter", page: 1 });
  }
  starts = capSections(starts, MAX_SECTIONS);

  return starts.map((s, i) => {
    const endPage = i + 1 < starts.length ? starts[i + 1].page - 1 : n;
    const pageStarts: number[] = [];
    let text = "";
    for (let p = s.page; p <= endPage; p++) {
      if (text) text += "\n\n";
      pageStarts.push(text.length);
      text += pageTexts[p - 1];
    }
    return { title: s.title, firstPage: s.page, text, pageStarts, excluded: suggestExcluded(s.title) };
  });
}

// Whole-title matches, plus a few prefixes ("Praise for …", "Also by …").
const NON_CONTENT =
  /^((index|bibliography|works cited|references|copyright( page)?|acknowledge?ments?|(table of )?contents|permissions|colophon)\s*$|(about the authors?|also by|other books by|praise for)\b)/i;

/** Sections that carry no teachable content and are left out by default. */
export function suggestExcluded(title: string): boolean {
  return NON_CONTENT.test(title.replace(/^[\s\d.:–-]+/, "").trim());
}

/** Sections that are sent to Claude, in book order. */
export function includedSections(book: Pick<Book, "sections">): Section[] {
  return book.sections.filter((s) => !s.excluded && s.text.trim().length > 0);
}

function cleanOutline(outline: OutlineEntry[], pageCount: number): OutlineEntry[] {
  const sorted = outline
    .filter((o) => o.page >= 1 && o.page <= pageCount && o.title.trim())
    .map((o) => ({ title: o.title.trim().replace(/\s+/g, " "), page: o.page }))
    .sort((a, b) => a.page - b.page);
  // Several outline entries on the same page: keep the first.
  return sorted.filter((o, i) => i === 0 || o.page !== sorted[i - 1].page);
}

function capSections(starts: OutlineEntry[], max: number): OutlineEntry[] {
  if (starts.length <= max) return starts;
  const group = Math.ceil(starts.length / max);
  const out: OutlineEntry[] = [];
  for (let i = 0; i < starts.length; i += group) {
    const last = starts[Math.min(i + group, starts.length) - 1];
    out.push({ title: group > 1 ? `${starts[i].title} … ${last.title}` : starts[i].title, page: starts[i].page });
  }
  return out;
}

/** Maps a char offset inside a section to its 1-based book page. */
export function pageAt(section: Section, charIndex: number): number {
  let lo = 0;
  let hi = section.pageStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (section.pageStarts[mid] <= charIndex) lo = mid;
    else hi = mid - 1;
  }
  return section.firstPage + lo;
}

export const locatorOf = (book: Pick<Book, "format">): Locator => (book.format && book.format !== "pdf" ? "loc" : "page");

/** "p. 3" / "pp. 3–5" for PDFs, "loc. 3" / "locs. 3–5" for EPUBs. */
export function pageLabel(section: Section, start: number, end: number, locator: Locator = "page"): string {
  const a = pageAt(section, start);
  const b = pageAt(section, Math.max(start, end - 1));
  const [one, many] = locator === "loc" ? ["loc.", "locs."] : ["p.", "pp."];
  return a === b ? `${one} ${a}` : `${many} ${a}–${b}`;
}

/** Plural noun for UI copy: "pages" or "locations". */
export const unitNoun = (book: Pick<Book, "format">) => (locatorOf(book) === "loc" ? "locations" : "pages");

/** "1 section", "3 sections". */
export const count = (n: number, plural: string) => `${n} ${n === 1 ? plural.replace(/s$/, "") : plural}`;

/** Rough token estimate of the included sections (~4 chars per token of English prose). */
export function estimateTokens(book: Pick<Book, "sections">): number {
  const chars = includedSections(book).reduce((sum, s) => sum + s.text.length + s.title.length, 0);
  return Math.ceil(chars / 4);
}

export const LOCATION_CHARS = 2000;

/** Splits text into pages of up to ~`size` characters on paragraph boundaries (long paragraphs split at spaces). */
export function chunkPages(text: string, size = LOCATION_CHARS): string[] {
  const pages: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) pages.push(cur.trim());
    cur = "";
  };
  for (let para of text.split(/\n{2,}/)) {
    para = para.trim();
    if (!para) continue;
    while (para.length > size * 1.5) {
      let cut = para.lastIndexOf(" ", size);
      if (cut < size / 2) cut = size;
      if (cur) flush();
      pages.push(para.slice(0, cut).trim());
      para = para.slice(cut).trim();
    }
    if (cur && cur.length + para.length > size) flush();
    cur += (cur ? "\n\n" : "") + para;
    if (cur.length >= size) flush();
  }
  flush();
  return pages;
}

/** Cuts titled groups of text into locations; the outline points at each group's first location. Empty groups are dropped. */
export function layoutGroups(groups: { title: string; text: string }[], size = LOCATION_CHARS): { pages: string[]; outline: OutlineEntry[] } {
  const pages: string[] = [];
  const outline: OutlineEntry[] = [];
  for (const g of groups) {
    const ps = chunkPages(g.text, size);
    if (ps.length === 0) continue;
    outline.push({ title: g.title, page: pages.length + 1 });
    pages.push(...ps);
  }
  return { pages, outline };
}
