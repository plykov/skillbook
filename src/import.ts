// Picks the importer by file content, falling back to the extension, so a
// mislabelled download still works. Importers are loaded on demand.
import type { Book } from "./book";

type Progress = (done: number, total: number) => void;

export interface Imported {
  book: Book;
  /** Things the user should know about (skipped pages, missing text). */
  notes: string[];
}

export async function importBook(file: File, onProgress: Progress): Promise<Imported> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const isPdf = String.fromCharCode(...head) === "%PDF-" || /\.pdf$/i.test(file.name);
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
  if (isPdf && !isZip) return { book: await (await import("./pdf")).importPdf(file, onProgress), notes: [] };
  if (isZip || /\.epub$/i.test(file.name)) return { book: await (await import("./epub")).importEpub(file, onProgress), notes: [] };
  if (/\.(md|markdown|txt)$/i.test(file.name) || file.type.startsWith("text/")) return { book: await (await import("./textfile")).importTextFile(file), notes: [] };
  if (/\.(mobi|azw3?|kfx)$/i.test(file.name)) {
    throw new Error("MOBI/AZW files aren't supported yet. Convert the book to EPUB first (for example with Calibre), then import that.");
  }
  throw new Error("Unsupported file. Import a PDF, EPUB, Markdown or text file.");
}

/** Imports a web book (Writebook-style) or a single web page, fetched through the user's relay. */
export async function importUrl(input: string, relayUrl: string, onProgress: Progress): Promise<Imported> {
  const { parseSourceUrl, bookLandingUrl, parseWritebookToc, loadWritebook } = await import("./web");
  const { relayFetch } = await import("./relay");
  if (!relayUrl.trim()) throw new Error("Set up your relay first (Settings → Web import relay). The README explains it in five minutes.");
  const url = parseSourceUrl(input);
  const fetchText = relayFetch(relayUrl);

  const landing = bookLandingUrl(url);
  const html = await fetchText(landing ?? url.href);
  const toc = landing ? parseWritebookToc(html, landing) : null;
  if (toc) return loadWritebook(toc, fetchText, onProgress);

  onProgress(1, 1);
  return { book: (await import("./webpage")).importWebPage(html, url.href), notes: ["Imported as a single page. Multi-page web books are supported for Writebook sites."] };
}
