import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { skillMarkdown, skillZip, slugify, validateSkill } from "../src/skill";
import type { SkillDraft } from "../src/types";

const draft: SkillDraft = {
  name: "offer-builder",
  description: 'Builds offers using the "Value Equation": scores and fixes them.',
  body: "# Offer builder\n\nDo the thing.",
  references: [{ filename: "frameworks.md", content: "# Frameworks" }],
};

describe("slugify", () => {
  it("makes valid names and strips reserved words", () => {
    expect(slugify("$100M Offers: How to Make…")).toBe("100m-offers-how-to-make");
    expect(slugify("Claude Skill for Anthropic")).toBe("skill-for");
    expect(slugify("x".repeat(80)).length).toBe(64);
  });
});

describe("validateSkill", () => {
  it("accepts a good draft", () => expect(validateSkill(draft)).toEqual([]));
  it("rejects bad names, long or tagged descriptions and bad filenames", () => {
    const errs = validateSkill({
      ...draft,
      name: "Bad Name",
      description: "<b>x</b>" + "y".repeat(1100),
      references: [{ filename: "Notes.txt", content: "" }],
    });
    expect(errs.length).toBe(4);
  });
});

describe("packaging", () => {
  it("writes frontmatter with a safely quoted description", () => {
    const md = skillMarkdown(draft);
    expect(md).toMatch(/^---\nname: offer-builder\ndescription: "Builds offers using the \\"Value Equation\\": scores and fixes them."\n---\n\n# Offer builder/);
  });
  it("zips into a single top-level folder", () => {
    const files = unzipSync(skillZip(draft));
    expect(Object.keys(files).sort()).toEqual(["offer-builder/SKILL.md", "offer-builder/references/frameworks.md"]);
    expect(strFromU8(files["offer-builder/SKILL.md"])).toContain("name: offer-builder");
  });
});
