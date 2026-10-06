import { describe, expect, it } from "vitest";
import { buildSections, locatorOf, pageLabel, unitNoun } from "../src/book";
import { chunkPages, fragmentOf, hasDrm, layoutEpub, resolveHref } from "../src/epub";

describe("resolveHref", () => {
  it("resolves relative paths against the containing file", () => {
    expect(resolveHref("OEBPS/content.opf", "text/ch1.xhtml")).toBe("OEBPS/text/ch1.xhtml");
    expect(resolveHref("OEBPS/nav.xhtml", "../text/ch1.xhtml#s2")).toBe("text/ch1.xhtml");
    expect(resolveHref("content.opf", "ch%201.xhtml")).toBe("ch 1.xhtml");
    expect(resolveHref("OEBPS/content.opf", "/abs/ch1.xhtml")).toBe("abs/ch1.xhtml");
    expect(resolveHref("a/b.opf", "./c.xhtml")).toBe("a/c.xhtml");
  });
  it("extracts fragments", () => {
    expect(fragmentOf("ch1.xhtml#sec%202")).toBe("sec 2");
    expect(fragmentOf("ch1.xhtml")).toBe("");
  });
});

describe("chunkPages", () => {
  it("packs paragraphs into pages near the target size without splitting them", () => {
    const para = "word ".repeat(100).trim(); // 499 chars
    const pages = chunkPages(Array(10).fill(para).join("\n\n"), 1200);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.every((p) => p.length <= 1200 + 500)).toBe(true);
    expect(pages.join("\n\n").split("\n\n")).toHaveLength(10);
  });
  it("splits one huge paragraph at word boundaries and loses nothing", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
    const pages = chunkPages(text, 500);
    expect(pages.length).toBeGreaterThan(10);
    expect(pages.join(" ").replace(/\s+/g, " ")).toBe(text);
  });
  it("returns nothing for empty text", () => expect(chunkPages(" \n\n ")).toEqual([]));
});

describe("hasDrm", () => {
  const enc = (a: string) => `<encryption><EncryptedData><EncryptionMethod Algorithm="${a}"/></EncryptedData></encryption>`;
  it("allows font obfuscation only", () => {
    expect(hasDrm(undefined, false)).toBe(false);
    expect(hasDrm(enc("http://www.idpf.org/2008/embedding"), false)).toBe(false);
    expect(hasDrm(enc("http://ns.adobe.com/pdf/enc#RC"), false)).toBe(false);
  });
  it("flags content encryption and Adobe rights files", () => {
    expect(hasDrm(enc("http://www.w3.org/2001/04/xmlenc#aes128-cbc"), false)).toBe(true);
    expect(hasDrm(undefined, true)).toBe(true);
  });
});

describe("layoutEpub", () => {
  const para = (n: string) => `${n} `.repeat(150).trim();
  const docs = [
    { href: "cover.xhtml", text: "", anchors: {} },
    { href: "ch1.xhtml", text: para("one"), anchors: {} },
    { href: "ch2.xhtml", text: para("two"), anchors: {} },
    { href: "ch3.xhtml", text: para("three"), anchors: {} },
  ];

  it("maps TOC entries to their first location and skips text-less documents", () => {
    const { pages, outline } = layoutEpub(
      docs,
      [
        { title: "Cover", href: "cover.xhtml", fragment: "" },
        { title: "One", href: "ch1.xhtml", fragment: "" },
        { title: "Two", href: "ch2.xhtml", fragment: "" },
        { title: "Three", href: "ch3.xhtml", fragment: "" },
        { title: "Missing", href: "nope.xhtml", fragment: "" },
      ],
      800,
    );
    expect(pages).toHaveLength(3); // one page per chapter; the empty cover adds none
    // The cover has no text, so "Cover" and "One" share location 1 (the later duplicate is dropped by buildSections).
    expect(outline.map((o) => o.title)).toEqual(["Cover", "One", "Two", "Three"]);
    expect(outline[0].page).toBe(1);
    expect(outline[1].page).toBe(1);
    expect(outline[3].page).toBeGreaterThan(outline[2].page);
    const secs = buildSections(pages, outline, "loc");
    expect(secs.map((s) => s.title)).toEqual(["Cover", "Two", "Three"]);
    expect(secs[0].text).toContain("one");
    expect(secs[1].text.startsWith("two")).toBe(true);
  });

  it("splits a single-file book at TOC fragments", () => {
    const text = `Intro text here.\n\nChapter A body ${"a ".repeat(500)}\n\nChapter B body ${"b ".repeat(500)}`;
    const a = text.indexOf("Chapter A");
    const b = text.indexOf("Chapter B");
    const { pages, outline } = layoutEpub(
      [{ href: "book.xhtml", text, anchors: { a, b } }],
      [
        { title: "Intro", href: "book.xhtml", fragment: "" },
        { title: "A", href: "book.xhtml", fragment: "a" },
        { title: "B", href: "book.xhtml", fragment: "b" },
      ],
      800,
    );
    expect(outline.map((o) => o.title)).toEqual(["Intro", "A", "B"]);
    expect(new Set(outline.map((o) => o.page)).size).toBe(3);
    const secs = buildSections(pages, outline, "loc");
    expect(secs.map((s) => s.title)).toEqual(["Intro", "A", "B"]);
    expect(secs[1].text.startsWith("Chapter A")).toBe(true);
    expect(secs[2].text.startsWith("Chapter B")).toBe(true);
  });

  it("ignores unknown fragments (treated as the start of the document)", () => {
    const { outline } = layoutEpub([{ href: "x.xhtml", text: para("x"), anchors: {} }], [{ title: "X", href: "x.xhtml", fragment: "gone" }], 800);
    expect(outline).toEqual([{ title: "X", page: 1 }]);
  });
});

describe("locations", () => {
  it("label citations as locations for EPUBs", () => {
    const [s] = buildSections(["a", "b", "c"], [], "loc");
    expect(s.title).toBe("Locations 1–3");
    expect(pageLabel(s, 0, 1, "loc")).toBe("loc. 1");
    expect(pageLabel(s, 0, s.text.length, "loc")).toBe("locs. 1–3");
    expect(pageLabel(s, 0, s.text.length)).toBe("pp. 1–3");
    expect(locatorOf({ format: "epub" })).toBe("loc");
    expect(locatorOf({})).toBe("page");
    expect(unitNoun({ format: "epub" })).toBe("locations");
    expect(unitNoun({ format: "pdf" })).toBe("pages");
  });
});
