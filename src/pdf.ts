// PDF → Book, entirely on-device with pdf.js. Nothing is uploaded here.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { buildSections, joinLines, stripRunningHeads, type Book, type OutlineEntry } from "./book";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type PDFDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

export async function importPdf(file: File, onProgress: (done: number, total: number) => void): Promise<Book> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  try {
    const pages: string[][] = [];
    let emptyPages = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const lines = await pageLines(doc, i);
      if (lines.join("").replace(/\s/g, "").length < 20) emptyPages++;
      pages.push(lines);
      onProgress(i, doc.numPages);
    }
    const pageTexts = stripRunningHeads(pages).map(joinLines);
    const outline = await readOutline(doc);
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as { Title?: string; Author?: string };

    return {
      id: crypto.randomUUID(),
      title: info.Title?.trim() || file.name.replace(/\.pdf$/i, ""),
      author: info.Author?.trim() || "",
      fileName: file.name,
      pageCount: doc.numPages,
      importedAt: Date.now(),
      sections: buildSections(pageTexts, outline),
      emptyPages,
    };
  } finally {
    await task.destroy();
  }
}

async function pageLines(doc: PDFDoc, pageNo: number): Promise<string[]> {
  const page = await doc.getPage(pageNo);
  const content = await page.getTextContent();
  const lines: string[] = [];
  let line = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    line += item.str;
    if (item.hasEOL) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  page.cleanup();
  return lines;
}

async function readOutline(doc: PDFDoc): Promise<OutlineEntry[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline) return [];
  // Top level is usually chapters; if it has too few entries (e.g. one
  // "Contents" root), use the level below.
  let items = outline;
  if (items.length < 3 && items.some((o) => o.items?.length)) items = items.flatMap((o) => [o, ...(o.items ?? [])]);

  const out: OutlineEntry[] = [];
  for (const item of items) {
    try {
      const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
      if (!dest?.length) continue;
      const ref = dest[0];
      const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref);
      out.push({ title: item.title, page: index + 1 });
    } catch {
      // Broken outline entry; skip it.
    }
  }
  return out;
}
