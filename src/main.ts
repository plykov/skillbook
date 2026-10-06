import { registerSW } from "virtual:pwa-register";
import "./style.css";
import { estimateTokens, type Book } from "./book";
import { MODELS, ask, buildSkill, extractCatalogue, friendlyError, type ModelId, type Settings, type Usage } from "./claude";
import { deleteBook, getBook, getState, listBooks, putBook, putState, type BookState } from "./db";
import { slugify, skillZip, validateSkill } from "./skill";
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
    return { apiKey: s.apiKey ?? "", model: s.model && s.model in MODELS ? s.model : "claude-opus-5-5" };
  } catch {
    return { apiKey: "", model: "claude-opus-5-5" };
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
  await go({ name: "book", book, state: await getState(id), tab: "ask" });
}

async function run(label: string, fn: () => Promise<void>) {
  if (busy) return;
  busy = label;
  lastError = "";
  render();
  try {
    await fn();
  } catch (e) {
    console.error(e);
    lastError = friendlyError(e);
  } finally {
    busy = null;
    render();
  }
}

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
    accept: "application/pdf,.pdf",
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
      h("button", { class: "primary wide", disabled: !!busy, onclick: () => fileInput.click() }, busy === "import" ? "Reading PDF…" : "Import a PDF book"),
      busy === "import" && h("div", { class: "progress" }, h("div", { style: `width:${Math.round(importProgress * 100)}%` })),
      fileInput,
      h("p", { class: "muted" }, "Text-based PDFs only (scanned books need OCR first). English books work best."),
    ),
    errorLine(),
    ...books
      .sort((a, b) => b.importedAt - a.importedAt)
      .map((b) =>
        h(
          "button",
          { class: "card book", onclick: () => openBook(b.id) },
          h("strong", {}, b.title),
          h("span", { class: "muted" }, [b.author, `${b.pageCount} pages`, `${b.sections.length} sections`, `~${fmtK(estimateTokens(b))} tokens`].filter(Boolean).join(" · ")),
        ),
      ),
  ];
}

async function importFile(file: File) {
  importProgress = 0;
  await run("import", async () => {
    const { importPdf } = await import("./pdf");
    const book = await importPdf(file, (done, total) => {
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
        "button",
        {
          class: "primary",
          onclick: () => {
            settings = { apiKey: key.value.trim(), model: model.value as ModelId };
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
    h("p", { class: "muted" }, `${v.book.pageCount} pages · ${v.book.sections.length} sections · ~${fmtK(tokens)} tokens`),
    tokens > 900_000 && h("div", { class: "notice" }, "This book is close to or over Claude's 1M-token context window. Requests may fail."),
    h("nav", { class: "tabs", role: "tablist" }, tab("ask", "Ask"), tab("extract", "Extract"), tab("skill", "Skill")),
    ...(v.tab === "ask" ? renderAsk(v) : v.tab === "extract" ? renderExtract(v) : renderSkill(v)),
  ];
}

// ----- ask -----
const QUICK = [
  "What is the core argument, in five bullets?",
  "List every framework the author teaches.",
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
      h("p", { class: "muted" }, "Questions are answered from the book, with tappable page citations. The first question sends the whole book (cached for 5 minutes); follow-ups are much cheaper."),
    h("div", { class: "chat" }, v.state.chat.map((t) => [h("p", { class: "q" }, t.question), renderAnswer(t)])),
    busy === "ask" && h("p", { class: "muted" }, "Claude is reading…"),
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

// ----- extract -----
function costEstimate(v: BookView): string {
  const p = MODELS[settings.model];
  const t = estimateTokens(v.book);
  return fmtUsd((t * p.cacheWrite + 30_000 * p.output) / 1e6);
}

function renderExtract(v: BookView): Child[] {
  const s = v.state;
  const kept = s.catalogue.filter((i) => i.keep).length;
  const extract = () => {
    if (needKey()) return;
    void run("extract", async () => {
      const r = await extractCatalogue(settings, v.book, (chars) => {
        const el = app.querySelector("#extract-progress");
        if (el) el.textContent = `Writing the catalogue… ${fmtK(Math.round(chars / 4))} tokens so far`;
      });
      s.thesis = r.thesis;
      s.catalogue = r.items;
      lastUsage = r.usage;
      await putState(s);
    });
  };
  return [
    h(
      "div",
      { class: "card" },
      h("p", {}, "Claude reads the whole book and lists the frameworks, processes, rules of thumb, checklists and pitfalls it teaches. Untick anything you don't want in the skill."),
      h(
        "button",
        { class: "primary", disabled: !!busy, onclick: extract },
        busy === "extract" ? "Extracting…" : s.catalogue.length ? "Extract again" : "Extract frameworks",
      ),
      h("p", { class: "muted" }, `One call, typically 1–4 minutes. Estimated ${costEstimate(v)} with ${MODELS[settings.model].label}. Keep the app open while it runs.`),
      busy === "extract" && h("p", { class: "muted", id: "extract-progress" }, "Reading the book…"),
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
    void run("skill", async () => {
      const r = await buildSkill(settings, v.book, s.thesis, kept, focus.value, (chars) => {
        const el = app.querySelector("#skill-progress");
        if (el) el.textContent = `Writing the skill… ${fmtK(Math.round(chars / 4))} tokens so far`;
      });
      const d = r.draft;
      d.name = slugify(d.name) || slugify(v.book.title) || "book-skill";
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
            h("button", { class: "primary", disabled: !!busy, onclick: build }, busy === "skill" ? "Building…" : s.skill ? "Rebuild skill" : "Build skill"),
            busy === "skill" && h("p", { class: "muted", id: "skill-progress" }, "Reading the book…"),
          ],
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
