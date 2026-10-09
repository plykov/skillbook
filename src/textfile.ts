// Markdown / plain-text file → Book. A universal fallback for anything you can
// save as text: exports from note apps, newsletters, reader apps, saved pages.
import { buildSections, layoutGroups, type Book } from "./book";
import { cleanMarkdown, parseFrontMatter, splitByHeadings } from "./markdown";

export async function importTextFile(file: File): Promise<Book> {
  const raw = await file.text();
  const { meta, body } = parseFrontMatter(raw);
  const text = cleanMarkdown(body);
  if (text.length < 200) throw new Error("That file has almost no text in it.");

  const fallback = file.name.replace(/\.(md|markdown|txt)$/i, "");
  const groups = splitByHeadings(text, fallback);
  const { pages, outline } = layoutGroups(groups);
  const firstH1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  return {
    id: crypto.randomUUID(),
    format: "text",
    title: meta.title || (groups.length === 1 ? firstH1 : "") || fallback,
    author: meta.author ?? "",
    fileName: file.name,
    pageCount: pages.length,
    importedAt: Date.now(),
    sections: buildSections(pages, outline, "loc"),
    emptyPages: 0,
  };
}
