// Picks the importer by file content, falling back to the extension, so a
// mislabelled download still works. Importers are loaded on demand.
import type { Book } from "./book";

type Progress = (done: number, total: number) => void;

export async function importBook(file: File, onProgress: Progress): Promise<Book> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const isPdf = String.fromCharCode(...head) === "%PDF-" || /\.pdf$/i.test(file.name);
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
  if (isPdf && !isZip) return (await import("./pdf")).importPdf(file, onProgress);
  if (isZip || /\.epub$/i.test(file.name)) return (await import("./epub")).importEpub(file, onProgress);
  if (/\.(mobi|azw3?|kfx)$/i.test(file.name)) {
    throw new Error("MOBI/AZW files aren't supported yet. Convert the book to EPUB first (for example with Calibre), then import that.");
  }
  throw new Error("Unsupported file. Import a PDF or EPUB.");
}
