import { describe, expect, it } from "vitest";
import { TOOLS, applyRevision, mergeItems, parseCatalogue, parseRevision, parseSkill } from "../src/tools";
import type { CatalogueItem, SkillDraft } from "../src/types";

const item = (name: string): Omit<CatalogueItem, "keep"> => ({
  kind: "framework",
  name,
  summary: "s",
  components: [],
  when_to_use: "",
  pitfalls: [],
  chapter: "c",
  pages: "p. 1",
});

describe("tool definitions", () => {
  it("are strict and in a fixed order (part of the cached prefix)", () => {
    expect(TOOLS.map((t) => ("name" in t ? t.name : ""))).toEqual(["save_catalogue", "save_skill", "revise_skill"]);
    expect(TOOLS.every((t) => "strict" in t && t.strict)).toBe(true);
  });
});

describe("parsers", () => {
  it("accept valid input and reject malformed input", () => {
    expect(parseCatalogue({ thesis: "t", items: [item("A")] }).items).toHaveLength(1);
    expect(() => parseCatalogue({ thesis: "t", items: [{ ...item("A"), kind: "story" }] })).toThrow(/incomplete/);
    expect(() => parseSkill({ name: "x", description: "d", body: "b" })).toThrow();
    expect(parseRevision({ name: "", description: "", body: "", upsert_references: [], remove_references: [] }).name).toBe("");
  });
});

describe("applyRevision", () => {
  const draft: SkillDraft = {
    name: "a",
    description: "desc",
    body: "body",
    references: [
      { filename: "one.md", content: "1" },
      { filename: "two.md", content: "2" },
    ],
  };
  it("keeps unchanged fields, upserts and removes references", () => {
    const d = applyRevision(draft, {
      name: "",
      description: "new desc",
      body: " ",
      upsert_references: [
        { filename: "two.md", content: "2b" },
        { filename: "three.md", content: "3" },
      ],
      remove_references: ["one.md"],
    });
    expect(d).toEqual({
      name: "a",
      description: "new desc",
      body: "body",
      references: [
        { filename: "two.md", content: "2b" },
        { filename: "three.md", content: "3" },
      ],
    });
    expect(draft.references).toHaveLength(2);
  });
});

describe("mergeItems", () => {
  it("adds only new names, case-insensitively, kept by default", () => {
    const existing = [{ ...item("Value Equation"), keep: false }];
    const merged = mergeItems(existing, [item("value equation"), item("Pricing"), item("pricing ")]);
    expect(merged.map((i) => [i.name, i.keep])).toEqual([
      ["Value Equation", false],
      ["Pricing", true],
    ]);
  });
});
