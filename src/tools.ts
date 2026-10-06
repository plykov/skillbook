// Output tools. Every request carries this exact list, in this order, so the
// cached prefix (tools → system → book) is byte-identical across Ask, Extract
// and Skill. Strict tools replace JSON-schema output formats, which can't be
// combined with citations and would change the prefix.
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CatalogueItem, ItemKind, SkillDraft, SkillReference, SkillRevision } from "./types";

const str = { type: "string" };
const strArr = { type: "array", items: str };
const KINDS: ItemKind[] = ["framework", "process", "definition", "heuristic", "checklist", "example", "anti_pattern", "metric"];
const reference = {
  type: "object",
  additionalProperties: false,
  required: ["filename", "content"],
  properties: { filename: str, content: str },
};

export const TOOLS: BetaToolUnion[] = [
  {
    name: "save_catalogue",
    description: "Save catalogue items distilled from the book. Call only when the user asks for extraction.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["thesis", "items"],
      properties: {
        thesis: str,
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "name", "summary", "components", "when_to_use", "pitfalls", "chapter", "pages"],
            properties: {
              kind: { type: "string", enum: KINDS },
              name: str,
              summary: str,
              components: strArr,
              when_to_use: str,
              pitfalls: strArr,
              chapter: str,
              pages: str,
            },
          },
        },
      },
    },
  },
  {
    name: "save_skill",
    description: "Save a complete skill. Call only when the user asks to build a skill.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description", "body", "references"],
      properties: { name: str, description: str, body: str, references: { type: "array", items: reference } },
    },
  },
  {
    name: "revise_skill",
    description:
      "Save changes to an existing skill. Send only what changes: empty strings leave name, description or body unchanged; upsert_references holds only new or rewritten files. Call only when the user asks for a revision.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description", "body", "upsert_references", "remove_references"],
      properties: {
        name: str,
        description: str,
        body: str,
        upsert_references: { type: "array", items: reference },
        remove_references: strArr,
      },
    },
  },
];

export type ToolName = "save_catalogue" | "save_skill" | "revise_skill";

// Defensive shape checks before the input touches app state.
const isStr = (x: unknown): x is string => typeof x === "string";
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isRef = (x: unknown): x is SkillReference => isObj(x) && isStr(x.filename) && isStr(x.content);

class ToolInputError extends Error {}
function fail(what: string): never {
  throw new ToolInputError(`Claude's ${what} came back incomplete. Try again.`);
}

export function parseCatalogue(x: unknown): { thesis: string; items: Omit<CatalogueItem, "keep">[] } {
  if (!isObj(x) || !isStr(x.thesis) || !Array.isArray(x.items)) fail("catalogue");
  const items = x.items.map((i) => {
    if (
      !isObj(i) ||
      !KINDS.includes(i.kind as ItemKind) ||
      ![i.name, i.summary, i.when_to_use, i.chapter, i.pages].every(isStr) ||
      !isStrArr(i.components) ||
      !isStrArr(i.pitfalls)
    )
      fail("catalogue");
    return i as unknown as Omit<CatalogueItem, "keep">;
  });
  return { thesis: x.thesis, items };
}

export function parseSkill(x: unknown): SkillDraft {
  if (!isObj(x) || ![x.name, x.description, x.body].every(isStr) || !Array.isArray(x.references) || !x.references.every(isRef)) fail("skill");
  return x as unknown as SkillDraft;
}

export function parseRevision(x: unknown): SkillRevision {
  if (
    !isObj(x) ||
    ![x.name, x.description, x.body].every(isStr) ||
    !Array.isArray(x.upsert_references) ||
    !x.upsert_references.every(isRef) ||
    !isStrArr(x.remove_references)
  )
    fail("revision");
  return x as unknown as SkillRevision;
}

export function applyRevision(d: SkillDraft, r: SkillRevision): SkillDraft {
  const refs = d.references.filter((ref) => !r.remove_references.includes(ref.filename));
  for (const u of r.upsert_references) {
    const i = refs.findIndex((ref) => ref.filename === u.filename);
    if (i >= 0) refs[i] = u;
    else refs.push(u);
  }
  return {
    name: r.name.trim() || d.name,
    description: r.description.trim() || d.description,
    body: r.body.trim() || d.body,
    references: refs,
  };
}

/** Adds newly extracted items, skipping names already in the catalogue. */
export function mergeItems(existing: CatalogueItem[], added: Omit<CatalogueItem, "keep">[]): CatalogueItem[] {
  const key = (n: string) => n.trim().toLowerCase();
  const seen = new Set(existing.map((i) => key(i.name)));
  const fresh = added.filter((i) => !seen.has(key(i.name)) && seen.add(key(i.name)));
  return [...existing, ...fresh.map((i) => ({ ...i, keep: true }))];
}
