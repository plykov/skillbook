import { describe, expect, it } from "vitest";
import { buildSections, estimateTokens, joinLines, pageAt, pageLabel, stripRunningHeads } from "../src/book";

describe("stripRunningHeads", () => {
  it("drops repeated headers, footers and page numbers but keeps body lines", () => {
    const pages = Array.from({ length: 10 }, (_, i) => [
      "THE GREAT BOOK",
      `Chapter ${i % 3}`,
      `Body line unique to page ${i}`,
      `Another body line ${i}`,
      "Body text that repeats in the middle",
      `More body ${i}`,
      `Closing body ${i}`,
      `${i + 1}`,
    ]);
    const out = stripRunningHeads(pages);
    expect(out[0]).not.toContain("THE GREAT BOOK");
    expect(out[0]).not.toContain("1");
    expect(out[4]).toContain("Body line unique to page 4");
    expect(out[4]).toContain("Body text that repeats in the middle");
  });
});

describe("joinLines", () => {
  it("repairs hyphenation across line breaks", () => {
    expect(joinLines(["the value equa-", "tion matters"])).toBe("the value equation matters");
  });
  it("keeps real hyphens before capitals", () => {
    expect(joinLines(["pre-", "Socratic"])).toBe("pre-\nSocratic");
  });
});

describe("buildSections", () => {
  const pages = Array.from({ length: 60 }, (_, i) => `page ${i + 1} text`);

  it("uses the outline and adds front matter", () => {
    const secs = buildSections(pages, [
      { title: "One", page: 5 },
      { title: "Two", page: 20 },
      { title: "Three", page: 40 },
    ]);
    expect(secs.map((s) => [s.title, s.firstPage])).toEqual([
      ["Front matter", 1],
      ["One", 5],
      ["Two", 20],
      ["Three", 40],
    ]);
    expect(secs[1].text.startsWith("page 5 text")).toBe(true);
    expect(secs[1].text.endsWith("page 19 text")).toBe(true);
  });

  it("falls back to page ranges without a usable outline", () => {
    const secs = buildSections(pages, [{ title: "Only", page: 1 }]);
    expect(secs.map((s) => s.title)).toEqual(["Pages 1–25", "Pages 26–50", "Pages 51–60"]);
  });

  it("caps very long outlines", () => {
    const outline = Array.from({ length: 60 }, (_, i) => ({ title: `S${i}`, page: i + 1 }));
    const secs = buildSections([...pages, ...pages], [...outline, ...outline.map((o) => ({ ...o, page: o.page + 60 }))]);
    expect(secs.length).toBeLessThanOrEqual(60);
    expect(secs.map((s) => s.text).join("\n\n")).toContain("page 60 text");
  });

  it("maps char offsets back to pages", () => {
    const [s] = buildSections(pages, []);
    const p3 = s.text.indexOf("page 3 text");
    expect(pageAt(s, 0)).toBe(1);
    expect(pageAt(s, p3)).toBe(3);
    expect(pageAt(s, p3 + 4)).toBe(3);
    expect(pageLabel(s, p3, p3 + 5)).toBe("p. 3");
    expect(pageLabel(s, 0, p3 + 5)).toBe("pp. 1–3");
    expect(estimateTokens({ sections: [s] })).toBeGreaterThan(0);
  });
});
