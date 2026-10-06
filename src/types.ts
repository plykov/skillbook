import type Anthropic from "@anthropic-ai/sdk";

export type ItemKind =
  | "framework"
  | "process"
  | "definition"
  | "heuristic"
  | "checklist"
  | "example"
  | "anti_pattern"
  | "metric";

export interface CatalogueItem {
  kind: ItemKind;
  name: string;
  summary: string;
  components: string[];
  when_to_use: string;
  pitfalls: string[];
  chapter: string;
  pages: string;
  keep: boolean;
}

export interface Citation {
  label: string;
  section: string;
  quote: string;
}

export interface ChatTurn {
  question: string;
  /** Rendered answer: text runs with citation indexes attached. */
  answer: { text: string; cites: number[] }[];
  citations: Citation[];
  /** Assistant content exactly as returned, replayed verbatim on the next turn. */
  raw: Anthropic.Beta.Messages.BetaContentBlockParam[];
}

export interface SkillReference {
  filename: string;
  content: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  references: SkillReference[];
}

/** Partial update to a skill draft; empty strings mean "unchanged". */
export interface SkillRevision {
  name: string;
  description: string;
  body: string;
  upsert_references: SkillReference[];
  remove_references: string[];
}

export interface PendingBatch {
  id: string;
  /** Section title when extracting more from one chapter; empty for the whole book. */
  chapter: string;
  submittedAt: number;
}
