// All Claude API calls. The key lives on the device and requests go straight
// from the browser to api.anthropic.com.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, MessageCreateParamsBase } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { pageLabel, type Book, type Section } from "./book";
import { CHAT_SYSTEM, EXTRACT_SCHEMA, EXTRACT_SYSTEM, SKILL_SCHEMA, SKILL_SYSTEM, extractPrompt, skillPrompt } from "./prompts";
import type { CatalogueItem, ChatTurn, Citation, SkillDraft } from "./types";

export const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5", input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
} as const;
export type ModelId = keyof typeof MODELS;

export interface Settings {
  apiKey: string;
  model: ModelId;
}

export interface Usage {
  costUsd: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

function client(s: Settings) {
  return new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
}

/** Common request fields: refusal fallback opt-in (Anthropic picks the fallback model per refusal category). */
function base(s: Settings, maxTokens: number): Pick<MessageCreateParamsBase, "model" | "max_tokens" | "betas" | "fallbacks" | "thinking"> {
  return {
    model: s.model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
}

function usageOf(s: Settings, m: BetaMessage): Usage {
  const p = MODELS[s.model];
  const u = m.usage;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const costUsd = (u.input_tokens * p.input + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead + u.output_tokens * p.output) / 1e6;
  return { costUsd, inputTokens: u.input_tokens + cacheWrite + cacheRead, cacheReadTokens: cacheRead, outputTokens: u.output_tokens };
}

function checkStop(m: BetaMessage) {
  if (m.stop_reason === "refusal") {
    throw new Error(`Claude declined this request${m.stop_details?.category ? ` (${m.stop_details.category})` : ""}. Try rephrasing.`);
  }
  if (m.stop_reason === "max_tokens") throw new Error("The response hit the output limit before finishing. Try again with fewer items.");
}

/** Usable sections only — the API rejects empty documents. */
function docSections(book: Book): Section[] {
  return book.sections.filter((s) => s.text.trim().length > 0);
}

/**
 * The whole book as one document block per section. The last block carries a
 * cache breakpoint so follow-up requests re-read the book at cache price.
 * Built deterministically so the cached prefix stays byte-identical.
 */
function bookDocuments(book: Book, citations: boolean): BetaContentBlockParam[] {
  const secs = docSections(book);
  return secs.map((s, i) => ({
    type: "document" as const,
    source: { type: "text" as const, media_type: "text/plain" as const, data: s.text },
    title: `${s.title} (${pageLabel(s, 0, s.text.length)})`,
    context: i === 0 ? `Book: ${book.title}${book.author ? ` by ${book.author}` : ""}` : undefined,
    citations: { enabled: citations },
    ...(i === secs.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

export async function ask(
  s: Settings,
  book: Book,
  history: ChatTurn[],
  question: string,
  onText: (t: string) => void,
): Promise<{ turn: ChatTurn; usage: Usage }> {
  const messages: BetaMessageParam[] = [];
  history.forEach((t, i) => {
    const q: BetaContentBlockParam = { type: "text", text: t.question };
    messages.push({ role: "user", content: i === 0 ? [...bookDocuments(book, true), q] : [q] });
    messages.push({ role: "assistant", content: t.raw });
  });
  const q: BetaContentBlockParam = { type: "text", text: question };
  messages.push({ role: "user", content: history.length === 0 ? [...bookDocuments(book, true), q] : [q] });

  const stream = client(s).beta.messages.stream({
    ...base(s, 32000),
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },
    system: CHAT_SYSTEM,
    messages,
  });
  stream.on("text", onText);
  const msg = await stream.finalMessage();
  checkStop(msg);

  const secs = docSections(book);
  const citations: Citation[] = [];
  const keyToIndex = new Map<string, number>();
  const answer: ChatTurn["answer"] = [];
  for (const block of msg.content) {
    if (block.type !== "text") continue;
    const cites: number[] = [];
    for (const c of block.citations ?? []) {
      if (c.type !== "char_location") continue;
      const sec = secs[c.document_index];
      if (!sec) continue;
      const key = `${c.document_index}:${c.start_char_index}:${c.end_char_index}`;
      let idx = keyToIndex.get(key);
      if (idx === undefined) {
        idx = citations.length;
        keyToIndex.set(key, idx);
        citations.push({ label: pageLabel(sec, c.start_char_index, c.end_char_index), section: sec.title, quote: c.cited_text });
      }
      if (!cites.includes(idx)) cites.push(idx);
    }
    answer.push({ text: block.text, cites });
  }
  return {
    turn: { question, answer, citations, raw: msg.content as BetaContentBlockParam[] },
    usage: usageOf(s, msg),
  };
}

async function structured<T>(
  s: Settings,
  book: Book,
  system: string,
  prompt: string,
  schema: Record<string, unknown>,
  onProgress: (outputChars: number) => void,
): Promise<{ data: T; usage: Usage }> {
  // Citations and structured outputs can't be combined, so the book goes in
  // without citations here (a separate cache entry from the chat one).
  const stream = client(s).beta.messages.stream({
    ...base(s, 64000),
    output_config: { effort: "high", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: [...bookDocuments(book, false), { type: "text", text: prompt }] }],
  });
  let chars = 0;
  stream.on("text", (t) => onProgress((chars += t.length)));
  const msg = await stream.finalMessage();
  checkStop(msg);
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return { data: JSON.parse(text) as T, usage: usageOf(s, msg) };
}

export async function extractCatalogue(s: Settings, book: Book, onProgress: (chars: number) => void) {
  const { data, usage } = await structured<{ thesis: string; items: Omit<CatalogueItem, "keep">[] }>(
    s,
    book,
    EXTRACT_SYSTEM,
    extractPrompt(),
    EXTRACT_SCHEMA,
    onProgress,
  );
  return { thesis: data.thesis, items: data.items.map((i) => ({ ...i, keep: true })), usage };
}

export async function buildSkill(
  s: Settings,
  book: Book,
  thesis: string,
  items: CatalogueItem[],
  focus: string,
  onProgress: (chars: number) => void,
) {
  const { data, usage } = await structured<SkillDraft>(s, book, SKILL_SYSTEM, skillPrompt(book, thesis, items, focus), SKILL_SCHEMA, onProgress);
  return { draft: data, usage };
}

export function friendlyError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The API key was rejected. Check it in Settings.";
  if (e instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use that model.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a minute and retry.";
  if (e instanceof Anthropic.BadRequestError) return `The API rejected the request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach the API. Check your connection; on a phone, keep the app in the foreground while it works.";
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ""}: ${e.message}`;
  if (e instanceof SyntaxError) return "Claude's reply wasn't valid JSON. Try again.";
  return e instanceof Error ? e.message : String(e);
}
