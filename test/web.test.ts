import { describe, expect, it } from "vitest";
import { cleanMarkdown, parseFrontMatter, splitByHeadings } from "../src/markdown";
import { HttpError, bookLandingUrl, decodeEntities, groupLeaves, isLegalTitle, loadWritebook, parseLeaf, parseSourceUrl, parseWritebookToc } from "../src/web";
import { BASE, LANDING_HTML, LEAVES, leafMarkdown } from "./fixtures/writebook";

describe("markdown helpers", () => {
  it("parses front matter with JSON-quoted values", () => {
    const { meta, body } = parseFrontMatter('---\ntitle: "A \\"quoted\\" title"\nauthor: Ada\n---\n\nHello');
    expect(meta).toEqual({ title: 'A "quoted" title', author: "Ada" });
    expect(body.trim()).toBe("Hello");
    expect(parseFrontMatter("no front matter").body).toBe("no front matter");
  });
  it("cleans images, links and blank-line runs", () => {
    expect(cleanMarkdown("![alt](x.png)\n\n\n\nSee [the guide](https://a.b/c_(d)) now.   \n\n\n\nEnd")).toBe("See the guide now.\n\nEnd");
  });
  it("splits by the shallowest heading level that occurs often enough", () => {
    const md = "Intro text\n\n# One\n\na\n\n# Two\n\nb\n\n# Three\n\nc";
    expect(splitByHeadings(md, "file").map((g) => g.title)).toEqual(["Introduction", "One", "Two", "Three"]);
    expect(splitByHeadings("## A\n\nx\n\n## B\n\ny\n\n## C\n\nz", "f").map((g) => g.title)).toEqual(["A", "B", "C"]);
    expect(splitByHeadings("# Only\n\ntext", "file")).toEqual([{ title: "file", text: "# Only\n\ntext" }]);
  });
  it("ignores headings inside code fences", () => {
    const md = "```\n# not a heading\n# nor this\n# nor this\n```\n\ntext";
    expect(splitByHeadings(md, "f")).toHaveLength(1);
  });
});

describe("URLs", () => {
  it("accepts https (and local http), rejects the rest", () => {
    expect(parseSourceUrl(" https://a.com/x ").hostname).toBe("a.com");
    expect(parseSourceUrl("http://localhost:8080/x").hostname).toBe("localhost");
    expect(() => parseSourceUrl("http://a.com/x")).toThrow(/https/);
    expect(() => parseSourceUrl("not a url")).toThrow(/web address/);
  });
  it("finds the book landing page from a book or leaf URL", () => {
    expect(bookLandingUrl(new URL("https://h.com/9/slug"))).toBe("https://h.com/9/slug");
    expect(bookLandingUrl(new URL("https://h.com/9/slug/198/leaf?x=1"))).toBe("https://h.com/9/slug");
    expect(bookLandingUrl(new URL("https://h.com/blog/post"))).toBeNull();
  });
  it("decodes entities", () => expect(decodeEntities("Tom &amp; Jerry &#39;s &#x2014; &quot;ok&quot;")).toBe("Tom & Jerry 's — \"ok\""));
});

describe("parseWritebookToc", () => {
  const toc = parseWritebookToc(LANDING_HTML, BASE)!;
  it("reads the cover", () => {
    expect(toc.title).toBe("The Field Guide");
    expect(toc.subtitle).toBe("Doing small things well");
    expect(toc.author).toBe("Ada Example");
  });
  it("lists leaves in order with kinds and absolute URLs", () => {
    expect(toc.leaves.map((l) => [l.id, l.kind])).toEqual(LEAVES.map((l) => [String(l.id), l.kind]));
    expect(toc.leaves[1].url).toBe(`${BASE}/11/terms-of-use`);
    expect(toc.leaves.map((l) => l.title)).toEqual(LEAVES.map((l) => l.title));
  });
  it("strips trailing heading-anchor marks from titles", () => {
    const html = `<div class="toc__leaf--page"><a class="toc__title min-width" href="/7/field-guide/5/one"><span class="x">LEGAL DISCLAIMER #</span></a></div>`;
    expect(parseWritebookToc(html, BASE)!.leaves[0].title).toBe("LEGAL DISCLAIMER");
  });
  it("falls back to link scanning when the markup changes, and returns null for non-books", () => {
    const plain = `<a href="/7/field-guide/5/one">Open One</a><a href="/7/field-guide/6/two">Two</a><a href="/other/1/x">nope</a>`;
    expect(parseWritebookToc(plain, BASE)!.leaves.map((l) => [l.id, l.title])).toEqual([["5", "One"], ["6", "Two"]]);
    expect(parseWritebookToc("<p>just a page</p>", BASE)).toBeNull();
  });
});

describe("legal pages", () => {
  it("are recognised by title", () => {
    for (const t of ["LICENSE AGREEMENT", "LEGAL DISCLAIMER & READER RESPONSIBILITY", "Terms of Use", "⚠️ Disclaimer", "Privacy Policy", "Copyright"]) expect(isLegalTitle(t), t).toBe(true);
    for (const t of ["Chapter 1: Trust", "Licensing your work", "How to Read", "Preface I"]) expect(isLegalTitle(t), t).toBe(false);
  });
});

describe("groupLeaves", () => {
  const leaves = parseWritebookToc(LANDING_HTML, BASE)!.leaves;
  const texts = new Map(leaves.map((l) => [l.id, parseLeaf(leafMarkdown(LEAVES.find((x) => String(x.id) === l.id)!), l.title).text]));
  const { groups, skipped } = groupLeaves(leaves, texts);

  it("makes one group per chapter, with its pages in order", () => {
    expect(groups.map((g) => g.title)).toEqual(["WELCOME", "Chapter 1: Start Small", "Chapter 2: Scale It"]);
    expect(groups[1].text.indexOf("1.1 - Pick One Thing")).toBeLessThan(groups[1].text.indexOf("1.2 - Run the Checklist"));
  });
  it("skips legal pages, empty pages and divider-only text", () => {
    expect(skipped).toEqual(["TERMS OF USE", "LICENSE"]);
    expect(groups[0].text).not.toContain("terms");
    expect(groups[0].text.startsWith("WELCOME")).toBe(false); // the divider's own title line isn't repeated as body
    expect(groups.some((g) => g.text.includes("Picture Page"))).toBe(false);
  });
  it("puts pages outside any section in their own group", () => {
    const { groups: g } = groupLeaves(
      [
        { id: "1", title: "Loose page", url: "u1", kind: "page" },
        { id: "2", title: "Chapter", url: "u2", kind: "section" },
        { id: "3", title: "In chapter", url: "u3", kind: "page" },
      ],
      new Map([["1", "loose text"], ["2", "Chapter"], ["3", "chapter text"]]),
    );
    expect(g.map((x) => x.title)).toEqual(["Loose page", "Chapter"]);
  });
  it("drops every page under a legal section", () => {
    const { groups: g, skipped: s } = groupLeaves(
      [
        { id: "1", title: "LEGAL NOTICES", url: "u1", kind: "section" },
        { id: "2", title: "Fine print", url: "u2", kind: "page" },
        { id: "3", title: "Chapter 1", url: "u3", kind: "section" },
        { id: "4", title: "Body", url: "u4", kind: "page" },
      ],
      new Map([["2", "fine"], ["4", "body text"]]),
    );
    expect(s).toEqual(["LEGAL NOTICES", "Fine print"]);
    expect(g.map((x) => x.title)).toEqual(["Chapter 1"]);
  });
});

describe("loadWritebook", () => {
  const toc = parseWritebookToc(LANDING_HTML, BASE)!;
  const serve = (calls: string[] = []) => async (url: string) => {
    calls.push(url);
    const leaf = LEAVES.find((l) => url === `${BASE}/${l.id}/${l.slug}.md`);
    if (!leaf) throw new HttpError(404, "missing");
    if (leaf.slug === "picture") throw new HttpError(404, "no markdown for picture pages");
    return leafMarkdown(leaf);
  };

  it("builds a web book with chapter sections and location citations", async () => {
    const calls: string[] = [];
    const progress: number[] = [];
    const { book, notes } = await loadWritebook(toc, serve(calls), (d) => progress.push(d), { paceMs: 0 });
    expect(book.format).toBe("web");
    expect(book.title).toBe("The Field Guide");
    expect(book.author).toBe("Ada Example");
    expect(book.sourceUrl).toBe(BASE);
    expect(book.sections.map((s) => s.title)).toEqual(["WELCOME", "Chapter 1: Start Small", "Chapter 2: Scale It"]);
    expect(book.sections[1].text).not.toContain("![");
    expect(book.sections[1].text).toContain("See the checklist for more.");
    expect(book.pageCount).toBeGreaterThanOrEqual(book.sections.length);
    const starts = book.sections.map((x) => x.firstPage);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
    expect(progress.at(-1)).toBe(LEAVES.length);
    // Legal pages are never even requested.
    expect(calls.some((u) => /terms-of-use|appendix-licence/.test(u))).toBe(false);
    expect(notes.join(" ")).toMatch(/Skipped 2 licence\/legal pages/);
    expect(notes.join(" ")).toMatch(/1 page was not available as text \(A Picture Page\)/);
  });

  it("retries transient failures and reports the page that finally fails", async () => {
    let flaky = 0;
    const fetchText = async (url: string) => {
      if (url.includes("/21/") && flaky++ < 2) throw new HttpError(503, "busy");
      return serve()(url);
    };
    const ok = await loadWritebook(toc, fetchText, () => undefined, { paceMs: 0 });
    expect(ok.book.sections).toHaveLength(3);
    await expect(loadWritebook(toc, async (u) => (u.includes("/31/") ? Promise.reject(new HttpError(500, "boom")) : serve()(u)), () => undefined, { paceMs: 0 })).rejects.toThrow(/Couldn't read “2\.1 - Repeat What Works”/);
  });

  it("refuses a book with no text", async () => {
    await expect(loadWritebook(toc, async () => "---\ntitle: x\n---\n\nhi", () => undefined, { paceMs: 0 })).rejects.toThrow(/almost no text/);
  });
});
