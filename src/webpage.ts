// A single web page (article, guide, docs page) → Book. Used when a link isn't a
// Writebook-style multi-page book.
import { buildSections, layoutGroups, type Book } from "./book";
import { byLocal, htmlToText } from "./html";
import { decodeEntities } from "./web";

export function importWebPage(html: string, url: string): Book {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.querySelector("main") ?? doc.querySelector("article") ?? doc.body;
  const { text } = htmlToText(root ?? doc.documentElement);
  if (text.length < 500) {
    throw new Error("Couldn't find readable text on that page. It may need JavaScript or a login, which this app can't do.");
  }
  const meta = (p: string) => doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute("content")?.trim();
  const title = decodeEntities(meta("og:title") ?? byLocal(doc, "title")[0]?.textContent?.trim() ?? new URL(url).hostname);
  const { pages, outline } = layoutGroups([{ title, text }]);
  return {
    id: crypto.randomUUID(),
    format: "web",
    title,
    author: meta("author") ?? "",
    sourceUrl: url,
    fileName: url,
    pageCount: pages.length,
    importedAt: Date.now(),
    sections: buildSections(pages, outline, "loc"),
    emptyPages: 0,
  };
}
