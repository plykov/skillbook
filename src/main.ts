import { registerSW } from "virtual:pwa-register";
import "./style.css";
import { estimateTokens, locatorOf, suggestExcluded, unitNoun, type Book } from "./book";
import {
  MODELS,
  ask,
  buildSkill,
  checkExtractBatch,
  extractCatalogue,
  friendlyError,
  reviseSkill,
  submitExtractBatch,
  isTransient,
  type ExtractResult,
  type ModelId,
  type Settings,
  type Usage,
} from "./claude";
import { deleteBook, getBook, getState, listBooks, putBook, putState, type BookState } from "./db";
import { importBook } from "./import";
import { slugify, skillZip, validateSkill } from "./skill";
import { applyRevision, mergeItems } from "./tools";
import type { ChatTurn, SkillDraft } from "./types";

registerSW({ immediate: true });

// ---------- tiny DOM helper ----------
type Child = Node | string | null | undefined | false | Child[];
const nodes = (children: Child[]): (Node | string)[] =>
  (children.flat(Infinity as 1) as Child[]).filter((c): c is Node | string => c !== null && c !== undefined && c !== false && !Array.isArray(c));
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  el.append(...nodes(children));
  return el;
}

const app = document.getElementById("app")!;
const dialog = document.getElementById("dialog") as HTMLDialogElement;

// ---------- settings ----------
const SETTINGS_KEY = "skillbook.settings";
function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    return { apiKey: s.apiKey ?? "", model: s.model && s.model in MODELS ? s.model : "claude-opus-5-5", economy: !!s.economy };
  } catch {
    return { apiKey: "", model: "claude-opus-5-5", economy: false };
  }
}
function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: keep in memory for this session */
  }
}
let settings = loadSettings();

// ---------- app state ----------
type Tab = "ask" | "extract" | "skill";
interface BookView {
  name: "book";
  book: Book;
  state: BookState;
  tab: Tab;
}
type View = { name: "library" } | { name: "settings" } | BookView;
let view: View = { name: "library" };
let busy: string | null = null;
let lastError = "";
let lastUsage: Usage | null = null;

const fmtUsd = (n: number) => (n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const fmtK = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const usageLine = () =>
  lastUsage
    ? h("p", { class: "muted" }, `Last call: ${fmtK(lastUsage.inputTokens)} in (${fmtK(lastUsage.cacheReadTokens)} cached) · ${fmtK(lastUsage.outputTokens)} out · ≈ ${fmtUsd(lastUsage.costUsd)}`)
    : null;
const errorLine = () => (lastError ? h("p", { class: "error", role: "alert" }, lastError) : null);

function render() {
  app.replaceChildren(
    ...nodes(view.name === "library" ? renderLibrary() : view.name === "settings" ? renderSettings() : renderBook(view)),
  );
  if (view.name === "book") app.append(deleteButton(view));
}

async function go(next: View) {
  view = next;
  lastError = "";
  render();
  window.scrollTo(0, 0);
}

async function openBook(id: string) {
  const book = await getBook(id);
  if (!book) return;
  // Books imported before section exclusion existed: apply the default suggestions once.
  if (book.sections.every((sec) => sec.excluded === undefined)) {
    for (const sec of book.sections) sec.excluded = suggestExcluded(sec.title);
    await putBook(book);
  }
  await go({ name: "book", book, state: await getState(id), tab: "ask" });
}

async function run(label: string, fn: () => Promise<void>) {
  if (busy) return;
  busy = label;
  lastError = "";
  render();
  const started = Date.now();
  const timer = window.setInterval(() => {
    const el = app.querySelector("#elapsed");
    const sec = Math.round((Date.now() - started) / 1000);
    if (el) el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }, 1000);
  try {
    await fn();
  } catch (e) {
    console.error(e);
    lastError = friendlyError(e);
  } finally {
    clearInterval(timer);
    busy = null;
    render();
  }
}

/** "Working… 0:42" line shown while a long call runs. */
const working = (text: string) => h("p", { class: "muted" }, `${text} `, h("span", { id: "elapsed" }, "0:00"));

function needKey(): boolean {
  if (settings.apiKey) return false;
  lastError = "Add your Anthropic API key in Settings first.";
  render();
  return true;
}

// ---------- library ----------
let books: Book[] = [];
let importProgress = 0;

function renderLibrary(): Child[] {
  const fileInput = h("input", {
    type: "file",
    accept: ".pdf,.epub,application/pdf,application/epub+zip",
    hidden: true,
    onchange: (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) void importFile(file);
    },
  });
  return [
    h("header", { class: "bar" }, h("h1", {}, "Skillbook"), h("button", { class: "ghost", onclick: () => go({ name: "settings" }), "aria-label": "Settings" }, "⚙︎ Settings")),
    !settings.apiKey && h("div", { class: "notice" }, "Add your Anthropic API key in Settings. Books are read on this phone; only the extracted text is sent to Claude when you ask a question."),
    h(
      "div",
      { class: "card" },
      h("button", { class: "primary wide", disabled: !!busy, onclick: () => fileInput.click() }, busy === "import" ? "Reading book…" : "Import a book (PDF or EPUB)"),
      busy === "import" && h("div", { class: "progress" }, h("div", { style: `width:${Math.round(importProgress * 100)}%` })),
      fileInput,
      h("p", { class: "muted" }, "PDF or EPUB, DRM-free. Scanned PDFs need OCR first; for MOBI/AZW, convert to EPUB with Calibre. English books work best."),
    ),
    errorLine(),
    ...books
      .sort((a, b) => b.importedAt - a.importedAt)
      .map((b) =>
        h(
          "button",
          { class: "card book", onclick: () => openBook(b.id) },
          h("strong", {}, b.title),
          h("span", { class: "muted" }, [b.author, `${b.pageCount} ${unitNoun(b)}`, `${b.sections.length} sections`, `~${fmtK(estimateTokens(b))} tokens`].filter(Boolean).join(" · ")),
        ),
      ),
  ];
}

async function importFile(file: File) {
  importProgress = 0;
  await run("import", async () => {
    const book = await importBook(file, (done, total) => {
      importProgress = done / total;
      const bar = app.querySelector<HTMLDivElement>(".progress > div");
      if (bar) bar.style.width = `${Math.round(importProgress * 100)}%`;
    });
    if (book.emptyPages > book.pageCount * 0.5) {
      throw new Error(`Most pages (${book.emptyPages} of ${book.pageCount}) have no text layer. This looks like a scanned PDF; run it through OCR first.`);
    }
    await putBook(book);
    void navigator.storage?.persist?.();
    books = await listBooks();
    view = { name: "book", book, state: await getState(book.id), tab: "ask" };
  });
}

// ---------- settings ----------
function renderSettings(): Child[] {
  const key = h("input", { type: "password", value: settings.apiKey, placeholder: "sk-ant-…", autocomplete: "off" });
  const economy = h("input", { type: "checkbox", checked: settings.economy });
  const model = h(
    "select",
    {},
    Object.entries(MODELS).map(([id, m]) => h("option", { value: id, selected: id === settings.model }, `${m.label} ($${m.input}/$${m.output} per M tokens)`)),
  );
  return [
    h("header", { class: "bar" }, h("button", { class: "ghost", onclick: () => go({ name: "library" }) }, "‹ Back"), h("h1", {}, "Settings")),
    h(
      "div",
      { class: "card" },
      h("label", { class: "field" }, h("span", {}, "Anthropic API key"), key),
      h("p", { class: "muted" }, "Stored only in this browser on this device and sent only to api.anthropic.com. Create one at console.anthropic.com. Consider a key with a low spend limit."),
      h("label", { class: "field" }, h("span", {}, "Model"), model),
      h(
        "label",
        { class: "row field" },
        economy,
        h("span", {}, "Economy extraction: run Extract through the Batch API at half price. Results usually take minutes but can take hours; you can close the app meanwhile."),
      ),
      h(
        "button",
        {
          class: "primary",
          onclick: () => {
            settings = { apiKey: key.value.trim(), model: model.value as ModelId, economy: economy.checked };
            saveSettings(settings);
            void go({ name: "library" });
          },
        },
        "Save",
      ),
    ),
  ];
}

// ---------- book ----------
function renderBook(v: BookView): Child[] {
  const tokens = estimateTokens(v.book);
  const tab = (t: Tab, label: string) =>
    h("button", { role: "tab", "aria-selected": String(v.tab === t), onclick: () => ((v.tab = t), (lastError = ""), render()) }, label);
  return [
    h("header", { class: "bar" }, h("button", { class: "ghost", onclick: () => go({ name: "library" }) }, "‹"), h("h1", {}, v.book.title)),
    h("p", { class: "muted" }, `${v.book.pageCount} ${unitNoun(v.book)} · ${v.book.sections.length} sections · ~${fmtK(tokens)} tokens sent to Claude`),
    renderSections(v),
    tokens > 900_000 && h("div", { class: "notice" }, "This book is close to or over Claude's 1M-token context window. Requests may fail."),
    h("nav", { class: "tabs", role: "tablist" }, tab("ask", "Ask"), tab("extract", "Extract"), tab("skill", "Skill")),
    ...(v.tab === "ask" ? renderAsk(v) : v.tab === "extract" ? renderExtract(v) : renderSkill(v)),
  ];
}

// ----- ask -----
const QUICK = [
  "What is the core argument, in five bullets?",
  "Explain the key terms in plain English.",
  "What should a reader do first, according to the book?",
  "Where is the author's reasoning weakest?",
];

function renderAnswer(turn: ChatTurn): Node {
  return h(
    "div",
    { class: "a" },
    turn.answer.map((run) => [
      run.text,
      ...run.cites.map((i) =>
        h("sup", { class: "cite" }, h("button", { onclick: () => showCitation(turn, i), "aria-label": `Source ${i + 1}` }, String(i + 1))),
      ),
    ]),
  );
}

function showCitation(turn: ChatTurn, i: number) {
  const c = turn.citations[i];
  dialog.replaceChildren(
    h("p", {}, h("strong", {}, c.label), h("span", { class: "muted" }, ` · ${c.section}`)),
    h("blockquote", {}, c.quote.trim()),
    h("form", { method: "dialog" }, h("button", { class: "primary" }, "Close")),
  );
  dialog.showModal();
}

function renderAsk(v: BookView): Child[] {
  const input = h("textarea", { rows: 2, placeholder: "Ask the book…", disabled: !!busy });
  const send = (q: string) => {
    q = q.trim();
    if (!q || needKey()) return;
    void run("ask", async () => {
      const pending = h("div", { class: "a", id: "streaming" });
      const log = app.querySelector(".chat");
      log?.append(h("p", { class: "q" }, q), pending);
      pending.scrollIntoView({ block: "end" });
      const { turn, usage } = await ask(settings, v.book, v.state.chat, q, (t) => pending.append(t));
      v.state.chat.push(turn);
      lastUsage = usage;
      await putState(v.state);
    });
  };
  return [
    v.state.chat.length === 0 &&
      h("p", { class: "muted" }, "Questions are answered from the book, with tappable page citations. The first call of a session sends the whole book; everything for the next hour (questions, Extract, Skill) re-reads it from the cache at a fraction of the price."),
    h("div", { class: "chat" }, v.state.chat.map((t) => [h("p", { class: "q" }, t.question), renderAnswer(t)])),
    busy === "ask" && working("Claude is reading…"),
    errorLine(),
    usageLine(),
    h(
      "div",
      { class: "composer" },
      h("div", { class: "chips" }, QUICK.map((q) => h("button", { disabled: !!busy, onclick: () => send(q) }, q))),
      h(
        "div",
        { class: "row" },
        h("div", { class: "spacer" }, input),
        h("button", { class: "primary", disabled: !!busy, onclick: () => send(input.value) }, "Ask"),
      ),
      v.state.chat.length > 0 &&
        h(
          "button",
          { class: "ghost muted", disabled: !!busy, onclick: async () => ((v.state.chat = []), await putState(v.state), render()) },
          "Clear conversation",
        ),
    ),
  ];
}

// ----- sections -----
function renderSections(v: BookView): Child {
  const included = v.book.sections.filter((sec) => !sec.excluded).length;
  return h(
    "details",
    { class: "card" },
    h("summary", {}, `Sections sent to Claude: ${included} of ${v.book.sections.length}`),
    h("p", { class: "muted" }, "Leave out pages that teach nothing (index, bibliography, copyright, acknowledgements) to cut every call's cost. Changing this restarts the conversation and the cache."),
    v.book.sections.map((sec) =>
      h(
        "label",
        { class: "row" },
        h("input", {
          type: "checkbox",
          checked: !sec.excluded,
          disabled: !!busy,
          onchange: async (e: Event) => {
            const box = e.target as HTMLInputElement;
            if (v.state.chat.length && !confirm("Changing sections clears the current conversation. Continue?")) {
              box.checked = !sec.excluded;
              return;
            }
            sec.excluded = !box.checked;
            v.state.chat = [];
            await putBook(v.book);
            await putState(v.state);
            render();
            app.querySelector("details")?.setAttribute("open", "");
          },
        }),
        h("span", {}, sec.title, h("span", { class: "muted" }, ` · ${locatorOf(v.book) === "loc" ? "loc." : "p."} ${sec.firstPage} · ~${fmtK(Math.ceil(sec.text.length / 4))} tokens`)),
      ),
    ),
  );
}

// ----- extract -----
function costEstimate(v: BookView): string {
  const p = MODELS[settings.model];
  const t = estimateTokens(v.book);
  const factor = settings.economy ? 0.5 : 1;
  return `${fmtUsd(factor * (t * p.input * 2 + 30_000 * p.output) / 1e6)} if the book isn't cached yet, about ${fmtUsd(factor * (t * p.cacheRead + 30_000 * p.output) / 1e6)} if it is`;
}

function applyExtract(s: BookState, chapter: string, r: ExtractResult) {
  if (chapter) {
    s.catalogue = mergeItems(s.catalogue, r.items);
  } else {
    s.thesis = r.thesis;
    s.catalogue = mergeItems([], r.items);
  }
  lastUsage = r.usage;
}

let batchPoll: number | undefined;
let lastBatchCheck = 0;
let batchStatus = "";

/** While the Extract tab shows a pending batch, check it about once a minute. */
function scheduleBatchCheck(v: BookView) {
  clearTimeout(batchPoll);
  if (!v.state.pendingBatch) return;
  const wait = Math.max(0, lastBatchCheck + 60_000 - Date.now());
  batchPoll = window.setTimeout(() => {
    if (view === v && v.tab === "extract") void checkBatch(v);
  }, wait);
}

async function checkBatch(v: BookView) {
  const pending = v.state.pendingBatch;
  if (!pending || busy) return;
  lastBatchCheck = Date.now();
  try {
    const r = await checkExtractBatch(settings, pending.id);
    if (r.done) {
      applyExtract(v.state, pending.chapter, r);
      v.state.pendingBatch = null;
      batchStatus = "";
      await putState(v.state);
    } else {
      batchStatus = `Status: ${r.status.replace("_", " ")} (checked ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}).`;
    }
  } catch (e) {
    lastError = friendlyError(e);
    // Connection problems are retried; anything else means this batch is unusable.
    if (!isTransient(e)) {
      v.state.pendingBatch = null;
      await putState(v.state);
    }
  }
  if (view === v) render();
}

function renderExtract(v: BookView): Child[] {
  const s = v.state;
  const kept = s.catalogue.filter((i) => i.keep).length;
  const pending = s.pendingBatch;
  const chapterSelect = h(
    "select",
    { "aria-label": "Section" },
    v.book.sections.filter((sec) => !sec.excluded).map((sec) => h("option", { value: sec.title }, sec.title)),
  );

  const extract = (chapter: string) => {
    if (needKey()) return;
    if (!chapter && s.catalogue.length && !confirm("Extract the whole book again? This replaces the current list.")) return;
    void run("extract", async () => {
      if (settings.economy) {
        const id = await submitExtractBatch(settings, v.book, chapter, s.catalogue);
        s.pendingBatch = { id, chapter, submittedAt: Date.now() };
        batchStatus = "Submitted. Checking about once a minute while this tab is open.";
        lastBatchCheck = Date.now();
        await putState(s);
        return;
      }
      applyExtract(s, chapter, await extractCatalogue(settings, v.book, chapter, s.catalogue));
      await putState(s);
    });
  };
  scheduleBatchCheck(v);

  return [
    h(
      "div",
      { class: "card" },
      h("p", {}, "Claude reads the whole book and lists the frameworks, processes, rules of thumb, checklists and pitfalls it teaches. Untick anything you don't want in the skill."),
      pending
        ? [
            h("p", {}, h("strong", {}, "Economy batch running"), pending.chapter ? ` for “${pending.chapter}”` : "", `, submitted ${new Date(pending.submittedAt).toLocaleString()}.`),
            h("p", { class: "muted" }, batchStatus || "You can close the app; results are kept by Anthropic for 29 days."),
            h("button", { disabled: !!busy, onclick: () => checkBatch(v) }, "Check now"),
          ]
        : [
            h(
              "button",
              { class: "primary", disabled: !!busy, onclick: () => extract("") },
              busy === "extract" ? "Extracting…" : s.catalogue.length ? "Extract whole book again" : "Extract frameworks",
            ),
            h(
              "p",
              { class: "muted" },
              settings.economy
                ? `Economy mode (Settings): half price, results in minutes to hours. Estimated ${costEstimate(v)}.`
                : `Typically 1–4 minutes; keep the app open. Estimated ${costEstimate(v)}.`,
            ),
            busy === "extract" && working(settings.economy ? "Submitting…" : "Claude is reading the book…"),
            s.catalogue.length > 0 &&
              h(
                "div",
                {},
                h("p", { class: "muted" }, "Missed something? Extract more from one section; only new items are added."),
                h("div", { class: "row" }, h("div", { class: "spacer" }, chapterSelect), h("button", { disabled: !!busy, onclick: () => extract(chapterSelect.value) }, "Extract more")),
              ),
          ],
    ),
    errorLine(),
    usageLine(),
    s.thesis && h("div", { class: "card" }, h("div", { class: "kind" }, "Thesis"), h("p", {}, s.thesis)),
    s.catalogue.length > 0 &&
      h(
        "div",
        { class: "row" },
        h("span", { class: "muted" }, `${kept} of ${s.catalogue.length} items kept`),
        h("span", { class: "spacer" }),
        h("button", { class: "primary", onclick: () => ((v.tab = "skill"), render()) }, "Next: build skill ›"),
      ),
    ...s.catalogue.map((item) =>
      h(
        "div",
        { class: `card item${item.keep ? "" : " dropped"}` },
        h("input", {
          type: "checkbox",
          checked: item.keep,
          "aria-label": `Keep ${item.name}`,
          onchange: async (e: Event) => {
            item.keep = (e.target as HTMLInputElement).checked;
            (e.target as HTMLElement).parentElement?.classList.toggle("dropped", !item.keep);
            await putState(s);
          },
        }),
        h(
          "div",
          {},
          h("div", { class: "kind" }, `${item.kind.replace("_", " ")} · ${item.pages}`),
          h(
            "details",
            {},
            h("summary", {}, h("strong", {}, item.name)),
            h("p", {}, item.summary),
            item.components.length > 0 && h("ol", {}, item.components.map((c) => h("li", {}, c))),
            item.when_to_use && h("p", { class: "muted" }, `Use when: ${item.when_to_use}`),
            item.pitfalls.length > 0 && h("p", { class: "muted" }, `Pitfalls: ${item.pitfalls.join("; ")}`),
            h("p", { class: "muted" }, item.chapter),
          ),
        ),
      ),
    ),
  ];
}

// ----- skill -----
let saveTimer: number | undefined;
function saveSoon(s: BookState) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void putState(s), 400);
}

function downloadName(d: SkillDraft) {
  return `${d.name || "skill"}.zip`;
}

function renderSkill(v: BookView): Child[] {
  const s = v.state;
  const kept = s.catalogue.filter((i) => i.keep);
  const focus = h("input", { type: "text", placeholder: "Optional focus, e.g. “scoring and fixing sales offers”" });

  const build = () => {
    if (needKey()) return;
    if (s.skill && !confirm("Rebuild the whole skill? For small changes, use Revise below; it's much cheaper.")) return;
    void run("skill", async () => {
      const r = await buildSkill(settings, v.book, s.thesis, kept, focus.value);
      const d = r.draft;
      d.name = slugify(d.name) || slugify(v.book.title) || "book-skill";
      s.skill = d;
      lastUsage = r.usage;
      await putState(s);
    });
  };

  const instruction = h("textarea", { rows: 2, placeholder: "e.g. “Add a scoring rubric to the workflow” or “Shorten the description”" });
  const revise = () => {
    const text = instruction.value.trim();
    if (!text || !s.skill || needKey()) return;
    const current = s.skill;
    void run("revise", async () => {
      const r = await reviseSkill(settings, v.book, current, text);
      const d = applyRevision(current, r.revision);
      d.name = slugify(d.name) || current.name;
      s.skill = d;
      lastUsage = r.usage;
      await putState(s);
    });
  };

  const head: Child[] = [
    h(
      "div",
      { class: "card" },
      kept.length === 0
        ? h("p", {}, "Extract and curate the book's frameworks first (Extract tab).")
        : [
            h("p", {}, `Builds a claude.ai skill from the ${kept.length} kept items, using the book for detail.`),
            h("label", { class: "field" }, h("span", {}, "Focus"), focus),
            h("button", { class: s.skill ? "" : "primary", disabled: !!busy, onclick: build }, busy === "skill" ? "Building…" : s.skill ? "Rebuild from scratch" : "Build skill"),
            busy === "skill" && working("Claude is writing the skill…"),
          ],
    ),
    s.skill &&
      h(
        "div",
        { class: "card" },
        h("label", { class: "field" }, h("span", {}, "Revise: describe the change and Claude edits only that part"), instruction),
        h("button", { class: "primary", disabled: !!busy, onclick: revise }, busy === "revise" ? "Revising…" : "Revise"),
        busy === "revise" && working("Claude is revising…"),
      ),
    errorLine(),
    usageLine(),
  ];
  if (!s.skill) return head;
  const d = s.skill;

  const errors = h("div", {});
  const counter = h("span", { class: "muted" });
  const refresh = () => {
    counter.textContent = ` ${d.description.length}/1024`;
    const errs = validateSkill(d);
    errors.replaceChildren(...errs.map((e) => h("p", { class: "error" }, e)));
    return errs.length === 0;
  };
  const bind = <T extends HTMLInputElement | HTMLTextAreaElement>(el: T, set: (val: string) => void) => {
    el.addEventListener("input", () => {
      set(el.value);
      refresh();
      saveSoon(s);
    });
    return el;
  };

  const exportZip = async (share: boolean) => {
    if (!refresh()) return;
    const blob = new Blob([skillZip(d) as BlobPart], { type: "application/zip" });
    const file = new File([blob], downloadName(d), { type: "application/zip" });
    if (share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: d.name }).catch(() => undefined);
      return;
    }
    const url = URL.createObjectURL(blob);
    h("a", { href: url, download: downloadName(d) }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const canShare = typeof navigator.canShare === "function";
  const body: Child[] = [
    h(
      "div",
      { class: "card" },
      h("label", { class: "field" }, h("span", {}, "Name"), bind(h("input", { type: "text", value: d.name }), (x) => (d.name = x))),
      h(
        "label",
        { class: "field" },
        h("span", {}, "Description (what it does + when Claude should use it)", counter),
        bind(h("textarea", { rows: 5, value: d.description }), (x) => (d.description = x)),
      ),
      h("label", { class: "field" }, h("span", {}, "SKILL.md body"), bind(h("textarea", { class: "code", value: d.body }), (x) => (d.body = x))),
    ),
    ...d.references.map((r, i) =>
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "row" },
          h("div", { class: "spacer" }, bind(h("input", { type: "text", value: r.filename, "aria-label": "Reference filename" }), (x) => (r.filename = x))),
          h(
            "button",
            { class: "ghost danger", onclick: async () => (d.references.splice(i, 1), await putState(s), render()) },
            "Remove",
          ),
        ),
        h("label", { class: "field" }, bind(h("textarea", { class: "code", value: r.content, "aria-label": r.filename }), (x) => (r.content = x))),
      ),
    ),
    errors,
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "row" },
        h("button", { class: "primary", onclick: () => exportZip(false) }, "Download .zip"),
        canShare && h("button", { onclick: () => exportZip(true) }, "Share…"),
      ),
      h(
        "p",
        { class: "muted" },
        "Install: claude.ai → Settings → Capabilities → Skills → Upload skill, and choose the zip. Skills built from a book are for your personal use; keep them private unless you have the rights to share.",
      ),
    ),
  ];
  refresh();
  return [...head, ...body];
}

// ---------- delete ----------
function deleteButton(v: BookView): Node {
  return h(
    "p",
    {},
    h(
      "button",
      {
        class: "ghost danger",
        disabled: !!busy,
        onclick: async () => {
          if (!confirm(`Delete “${v.book.title}” and its notes from this device?`)) return;
          await deleteBook(v.book.id);
          books = await listBooks();
          void go({ name: "library" });
        },
      },
      "Delete book from this device",
    ),
  );
}

void (async () => {
  books = await listBooks();
  render();
})();
