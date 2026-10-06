import type { Book } from "./book";
import type { CatalogueItem } from "./types";

export const CHAT_SYSTEM = `You help the user study the book supplied as documents in the first message. Each document is one chapter or page range, and its title gives the page numbers.

Answer from the book. Cite the passages that support each claim. If the book doesn't cover something, say so plainly before adding any general knowledge, and label that knowledge as yours, not the author's.

Keep answers tight and practical: lead with the answer, then the supporting detail. Use short lists when the book itself lists steps or components.`;

export const EXTRACT_SYSTEM = `You are distilling a non-fiction book into the reusable "operating system" behind it: the methods a practitioner would apply, not a summary of the chapters.

Work like an analyst who has read the whole book carefully:
- Capture each distinct framework, process, definition, heuristic, checklist, worked example, anti-pattern and metric the author actually teaches.
- Merge repeats: if the author revisits a framework in several chapters, make one item and combine the detail.
- Write in your own words. Name things the way the author names them.
- Skip anecdotes, motivation and filler unless an example illustrates how to apply a method.
- For "pages", give the page range where the item is mainly taught (from the document titles and content), e.g. "pp. 57–61".`;

export function extractPrompt(): string {
  return `Extract the catalogue for this book.

Return:
- "thesis": two or three sentences on what the book teaches and for whom.
- "items": every substantive item, ordered as they'd be applied in practice (foundational concepts first). Typically 15–60 items for a methods book. Each "summary" should be 1–3 sentences. "components" holds the steps, parts or criteria (empty if none). "pitfalls" holds the mistakes the author warns about (empty if none).`;
}

export const SKILL_SYSTEM = `You write Agent Skills for claude.ai. A skill is a folder with a SKILL.md (YAML frontmatter + Markdown body) and optional reference files that Claude reads only when needed.

What makes a good skill:
- The body is instructions to Claude, in the imperative ("Score the offer on…", "Ask the user for…"). It is not a book report.
- Structure the body as: a one-line purpose; "When to use"; the core workflow as numbered steps; decision rules and thresholds; the output format Claude should produce; and a "References" section that names each reference file and says when to read it.
- Keep SKILL.md under ~300 lines. Put full framework write-ups, glossaries and worked examples in references/*.md.
- The description is the trigger: say what the skill does and when to use it, in the third person, with the concrete words a user would type (framework names, task verbs). Max ~900 characters. No angle brackets.
- The name is lowercase-hyphenated, at most 64 characters, and must not contain "claude" or "anthropic".
- Paraphrase. Quote the book verbatim only where the exact wording matters, at most 25 words per quote and a handful in total.
- End the body with an attribution line: "Based on <title> by <author>."`;

export function skillPrompt(book: Book, thesis: string, items: CatalogueItem[], focus: string): string {
  const curated = items.map(({ keep: _keep, ...rest }) => rest);
  return `Build a skill from this book${book.author ? ` (${book.title} by ${book.author})` : ` (${book.title})`}.

Book thesis: ${thesis}

${focus.trim() ? `The user wants the skill to focus on: ${focus.trim()}\n\n` : ""}The user curated these catalogue items. Build the skill around them; use the book for detail and accuracy:
${JSON.stringify(curated, null, 1)}

Return "name", "description", "body" (the SKILL.md Markdown body without frontmatter) and "references" (each with a lowercase-hyphen "filename" ending in .md, and "content"). Reference files should be self-contained; at least one should give the full frameworks in detail.`;
}

const str = { type: "string" };
const strArr = { type: "array", items: str };

export const EXTRACT_SCHEMA = {
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
          kind: {
            type: "string",
            enum: ["framework", "process", "definition", "heuristic", "checklist", "example", "anti_pattern", "metric"],
          },
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
};

export const SKILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "body", "references"],
  properties: {
    name: str,
    description: str,
    body: str,
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["filename", "content"],
        properties: { filename: str, content: str },
      },
    },
  },
};
