// All Claude API calls. The key lives on the device and requests go straight
// from the browser to api.anthropic.com.
//
// Token economy: every request starts with the same prefix — TOOLS, SYSTEM,
// then the book as citation-enabled documents with a 1-hour cache breakpoint —
// and the same model, thinking and effort settings. Ask, Extract, Skill and
// Revise therefore all re-read one cached copy of the book instead of each
// paying to send it again. Anything task-specific goes after the book.
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { includedSections, locatorOf, pageLabel, type Book } from "./book";
import { SYSTEM, extractTask, reviseTask, skillTask } from "./prompts";
import { TOOLS, parseCatalogue, parseRevision, parseSkill, type ToolName } from "./tools";
import type { CatalogueItem, ChatTurn, Citation, SkillDraft, SkillRevision } from "./types";

/** $ per million tokens. Cache writes: 1.25× input (5 min), 2× input (1 hour). */
export const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", input: 2, output: 10, cacheRead: 0.2 },
} as const;
export type ModelId = keyof typeof MODELS;

export interface Settings {
  apiKey: string;
  model: ModelId;
  /** Run Extract through the Message Batches API (50% off, slower). */
  economy: boolean;
}

export interface Usage {
  costUsd: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** Same effort on every request: changing it between requests restarts the cache. */
const EFFORT = "high" as const;
const MAX_TOKENS = 64000;

function client(s: Settings) {
  return new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
}

/** The cached prefix: one document per included section, breakpoint on the last. */
function bookDocuments(book: Book): BetaContentBlockParam[] {
  const secs = includedSections(book);
  return secs.map((s, i) => ({
    type: "document" as const,
    source: { type: "text" as const, media_type: "text/plain" as const, data: s.text },
    title: `${s.title} (${pageLabel(s, 0, s.text.length, locatorOf(book))})`,
    ...(i === 0 ? { context: `Book: ${book.title}${book.author ? ` by ${book.author}` : ""}` } : {}),
    citations: { enabled: true },
    ...(i === secs.length - 1 ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : {}),
  }));
}

function baseParams(s: Settings, messages: BetaMessageParam[]): MessageCreateParamsNonStreaming {
  return {
    model: s.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    tools: TOOLS,
    system: SYSTEM,
    messages,
  };
}

/** Streams a request with refusal fallback (Anthropic picks the fallback model per refusal category). */
async function streamed(s: Settings, params: MessageCreateParamsNonStreaming, onText?: (t: string) => void): Promise<BetaMessage> {
  const stream = client(s).beta.messages.stream({
    ...params,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (onText) stream.on("text", onText);
  return stream.finalMessage();
}

export function usageOf(s: Settings, m: BetaMessage, discount = 1): Usage {
  const p = MODELS[s.model];
  const u = m.usage;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  const read = u.cache_read_input_tokens ?? 0;
  const costUsd =
    (discount * (u.input_tokens * p.input + w5m * p.input * 1.25 + w1h * p.input * 2 + read * p.cacheRead + u.output_tokens * p.output)) / 1e6;
  return { costUsd, inputTokens: u.input_tokens + w5m + w1h + read, cacheReadTokens: read, outputTokens: u.output_tokens };
}

function checkStop(m: BetaMessage) {
  if (m.stop_reason === "refusal") {
    throw new Error(`Claude declined this request${m.stop_details?.category ? ` (${m.stop_details.category})` : ""}. Try rephrasing.`);
  }
  if (m.stop_reason === "max_tokens") throw new Error("The response hit the output limit before finishing. Try a narrower request.");
}

function toolInput(m: BetaMessage, name: ToolName): unknown {
  checkStop(m);
  const call = m.content.find((b) => b.type === "tool_use" && b.name === name);
  if (!call || call.type !== "tool_use") throw new Error("Claude answered without saving a result. Try again.");
  return call.input;
}

/** A single-turn task over the cached book. */
function taskMessages(book: Book, task: string): BetaMessageParam[] {
  return [{ role: "user", content: [...bookDocuments(book), { type: "text", text: task }] }];
}

// ---------- Ask ----------

export async function ask(
  s: Settings,
  book: Book,
  history: ChatTurn[],
  question: string,
  onText: (t: string) => void,
): Promise<{ turn: ChatTurn; usage: Usage }> {
  const messages: BetaMessageParam[] = [];
  let prevRaw: BetaContentBlockParam[] = [];
  const userTurn = (i: number, text: string): BetaMessageParam => ({
    role: "user",
    content: [
      ...(i === 0 ? bookDocuments(book) : []),
      // A stray tool call in an answer must be closed before the next turn.
      ...prevRaw.flatMap((b): BetaContentBlockParam[] =>
        b.type === "tool_use" ? [{ type: "tool_result", tool_use_id: b.id, content: "Tools aren't used when answering questions.", is_error: true }] : [],
      ),
      { type: "text", text },
    ],
  });
  history.forEach((t, i) => {
    messages.push(userTurn(i, t.question));
    messages.push({ role: "assistant", content: t.raw });
    prevRaw = t.raw;
  });
  messages.push(userTurn(history.length, question));

  // Top-level automatic caching covers the growing conversation after the book.
  const msg = await streamed(s, { ...baseParams(s, messages), cache_control: { type: "ephemeral" } }, onText);
  checkStop(msg);

  const secs = includedSections(book);
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
        citations.push({ label: pageLabel(sec, c.start_char_index, c.end_char_index, locatorOf(book)), section: sec.title, quote: c.cited_text });
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

// ---------- Extract ----------

export interface ExtractResult {
  thesis: string;
  items: Omit<CatalogueItem, "keep">[];
  usage: Usage;
}

/** chapter = "" extracts from the whole book; otherwise only new items from that section. */
export async function extractCatalogue(s: Settings, book: Book, chapter: string, existing: CatalogueItem[]): Promise<ExtractResult> {
  const msg = await streamed(s, baseParams(s, taskMessages(book, extractTask(chapter, existing))));
  return { ...parseCatalogue(toolInput(msg, "save_catalogue")), usage: usageOf(s, msg) };
}

/** Economy mode: same request through the Batch API at half price. Returns the batch id. */
export async function submitExtractBatch(s: Settings, book: Book, chapter: string, existing: CatalogueItem[]): Promise<string> {
  const batch = await client(s).beta.messages.batches.create({
    requests: [{ custom_id: "extract", params: baseParams(s, taskMessages(book, extractTask(chapter, existing))) }],
  });
  return batch.id;
}

export type BatchCheck = { done: false; status: string } | ({ done: true } & ExtractResult);

export async function checkExtractBatch(s: Settings, id: string): Promise<BatchCheck> {
  const c = client(s);
  const batch = await c.beta.messages.batches.retrieve(id);
  if (batch.processing_status !== "ended") return { done: false, status: batch.processing_status };
  for await (const r of await c.beta.messages.batches.results(id)) {
    if (r.result.type === "succeeded") {
      const msg = r.result.message;
      return { done: true, ...parseCatalogue(toolInput(msg, "save_catalogue")), usage: usageOf(s, msg, 0.5) };
    }
    throw new Error(`The batch request ${r.result.type === "errored" ? `failed: ${r.result.error.error.message}` : `was ${r.result.type}`}. Try again.`);
  }
  throw new Error("The batch finished without a result. Try again.");
}

// ---------- Skill ----------

export async function buildSkill(s: Settings, book: Book, thesis: string, items: CatalogueItem[], focus: string) {
  const msg = await streamed(s, baseParams(s, taskMessages(book, skillTask(book, thesis, items, focus))));
  return { draft: parseSkill(toolInput(msg, "save_skill")), usage: usageOf(s, msg) };
}

export async function reviseSkill(s: Settings, book: Book, draft: SkillDraft, instruction: string): Promise<{ revision: SkillRevision; usage: Usage }> {
  const msg = await streamed(s, baseParams(s, taskMessages(book, reviseTask(draft, instruction))));
  return { revision: parseRevision(toolInput(msg, "revise_skill")), usage: usageOf(s, msg) };
}

export function isTransient(e: unknown): boolean {
  return e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500);
}

export function friendlyError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The API key was rejected. Check it in Settings.";
  if (e instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use that model.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a minute and retry.";
  if (e instanceof Anthropic.BadRequestError) return `The API rejected the request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach the API. Check your connection; on a phone, keep the app in the foreground while it works.";
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ""}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
