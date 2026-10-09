// A synthetic Writebook-style book (invented text) that mirrors the real markup:
// a cover with title/subtitle/author, then a table of contents of section and page leaves.
export const BASE = "https://books.example.com/7/field-guide";

export interface FixtureLeaf {
  id: number;
  slug: string;
  title: string;
  kind: "page" | "section";
  body: string;
}

const para = (topic: string, n = 6) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} about ${topic}: a short, original sentence describing the idea and how a practitioner would apply it in daily work.`).join("\n\n");

export const LEAVES: FixtureLeaf[] = [
  { id: 10, slug: "welcome", title: "WELCOME", kind: "section", body: "WELCOME" },
  { id: 11, slug: "terms-of-use", title: "TERMS OF USE", kind: "page", body: "These terms say nothing about the method.\n\n" + para("terms", 3) },
  { id: 12, slug: "how-to-read", title: "How to Read This Guide", kind: "page", body: "## How to Read This Guide\n\n" + para("reading") },
  { id: 20, slug: "chapter-1-start", title: "Chapter 1: Start Small", kind: "section", body: "Chapter 1: Start Small" },
  { id: 21, slug: "1-1-pick-one", title: "1.1 - Pick One Thing", kind: "page", body: "## 1.1 - Pick One Thing\n\n![diagram](/rails/blob/abc.png)\n\n" + para("picking") + "\n\nSee [the checklist](/7/field-guide/22/1-2-check) for more." },
  { id: 22, slug: "1-2-check", title: "1.2 - Run the Checklist", kind: "page", body: "## 1.2 - Run the Checklist\n\n" + para("checklists") },
  { id: 30, slug: "chapter-2-scale", title: "Chapter 2: Scale It", kind: "section", body: "Chapter 2: Scale It" },
  { id: 31, slug: "2-1-repeat", title: "2.1 - Repeat What Works", kind: "page", body: "## 2.1 - Repeat What Works\n\n" + para("repetition") },
  { id: 32, slug: "picture", title: "A Picture Page", kind: "page", body: "" },
  { id: 40, slug: "appendix-licence", title: "LICENSE", kind: "page", body: para("licence", 2) },
];

const leafHtml = (l: FixtureLeaf) => `
<div class="arrangement__item toc__leaf toc__leaf--${l.kind}" data-id="${l.id}">
  <form method="post" action="/books/7/sections/${l.id}"><button><span class="for-screen-reader">Delete ${l.title}</span></button></form>
  <div class="toc__thumbnail "><a class="toc__link" data-turbo-frame="_top" href="/7/field-guide/${l.id}/${l.slug}"><span class="for-screen-reader">Open ${l.title}</span></a></div>
  <a class="toc__title min-width" data-turbo-frame="_top" href="/7/field-guide/${l.id}/${l.slug}"><span class="overflow-ellipsis">${l.title.replace("&", "&amp;")}</span></a>
</div>`;

export const LANDING_HTML = `<!doctype html><html><head><title>The Field Guide</title>
<meta property="og:title" content="The Field Guide"><meta property="og:description" content="A practical guide"></head>
<body><main id="main"><div class="book__cover"><strong class="book__title txt-x-large--responsive">The Field Guide</strong>
<span class="txt-large--responsive txt-normal">Doing small things well</span>
<span class="txt-large--responsive txt-normal">Ada Example</span></div>
<ol class="toc">${LEAVES.map(leafHtml).join("")}</ol></main></body></html>`;

export const leafMarkdown = (l: FixtureLeaf) => `---\ntitle: ${JSON.stringify(l.title)}\nurl: "${BASE}/${l.id}/${l.slug}"\n---\n\n${l.body}\n`;
