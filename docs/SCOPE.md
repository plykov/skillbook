# Book → Skill: scope

A NotebookLM-style workbench that imports a book (PDF, MOBI/AZW3, EPUB), lets you
interrogate it with cited answers, distils its frameworks into structured notes,
and exports a ready-to-install **Claude skill** (`SKILL.md` + `references/`).

Working name: **Bookskill**. Status: scope only, no code yet.

---

## 1. Problem and goal

Turning a book into a useful Claude skill today is manual: read it, take notes,
work out the frameworks, then write a `SKILL.md` that triggers at the right moments
and doesn't just paraphrase chapters. (`hormozi-coach` is an example of the
target output.)

**Goal:** go from book file to a tested, installable skill in under an hour of human
time, keeping every claim in the skill traceable to a page or location in the source.

**Non-goals (v1):** audio overviews, multi-user collaboration, mobile app, DRM
removal, publishing skills to a marketplace.

---

## 2. Users and core jobs

Single user (the owner) to begin with: a consultant or operator who reads business
and craft books and wants Claude to *apply* them.

| # | Job | Done when |
|---|-----|-----------|
| J1 | Import a book | Text, chapters and page/location anchors are extracted and look right in a preview |
| J2 | Ask the book questions | Answers are grounded and every claim links to a page or location |
| J3 | Extract the "operating system" | Frameworks, definitions, checklists, heuristics, worked examples and anti-patterns sit in an editable catalogue |
| J4 | Build a skill | Draft `SKILL.md` + reference files, editable, with a trigger description |
| J5 | Test the skill | A handful of eval prompts run with and without the skill, side by side |
| J6 | Export | `.zip` for claude.ai, folder for `.claude/skills/`, optional upload via the Skills API |

---

## 3. Pipeline

```
 file ──► ① Ingest ──► ② Normalise ──► ③ Index ──► ④ Notebook (chat + notes)
                                         │
                                         └──► ⑤ Extract ──► ⑥ Skill builder ──► ⑦ Eval ──► ⑧ Export
```

### ① Ingest
| Format | Approach | Notes |
|--------|----------|-------|
| PDF (text) | `pymupdf` (or `pypdf` if AGPL is a problem) per page, keeping page numbers | Remove running headers/footers by spotting repeated lines |
| PDF (scanned) | Detect pages with almost no text → `ocrmypdf`/Tesseract, or send page images to Claude vision | Mark OCR'd pages as low confidence |
| EPUB | `ebooklib` + HTML → Markdown; chapter boundaries from the TOC/spine | Cleanest source; use it when available |
| MOBI / AZW3 | Calibre `ebook-convert book.mobi book.epub`, then the EPUB path. Fallback: `mobi` (KindleUnpack) Python package | **DRM-protected and KFX files are rejected** with a clear message. No circumvention |

Output: `book.json` containing metadata (title, author, ISBN if present) and an
ordered list of `sections` with `{id, chapter, title, text, anchor}`. Anchors are
PDF page numbers or EPUB/MOBI location indices.

### ② Normalise
- Fix hyphenation, ligatures and broken paragraphs; keep headings, lists and tables as Markdown.
- Detect chapter structure (TOC first, heading heuristics as fallback). The user confirms it in a preview.
- Count tokens (`messages.count_tokens`) to choose the retrieval mode below.

### ③ Index: long context first, RAG only if needed
Current Claude models have a **1M-token context**. A typical non-fiction book is
80–250K tokens, so v1 **puts the whole book in context** instead of building a vector index:
- Upload the normalised text once with the **Files API** and attach it as a `document` block with `citations: {enabled: true}`, split into one block per chapter so citations name the chapter and the character range.
- Add **prompt caching** on the book prefix. Every follow-up question then re-reads it at the cache-read price (roughly 5% of the input price).
- Keep a map from citation offsets to page/location anchors so the UI can show "p. 142".
- **RAG fallback** for books or collections over about 600K tokens: BM25 + embeddings over the sections, top-k chapters into context. This is v2, built only when a real book needs it.

Why not send the raw PDF? The native PDF input gives page-level citations, but it is
capped at 32 MB and 600 pages per request, and it re-bills images. Normalised text is
cheaper, and it works the same way for MOBI and EPUB.

### ④ Notebook UI (the NotebookLM part)
- Three panes: **Sources** (chapter tree and reader) · **Chat** (cited answers, click to jump to the source) · **Notes** (pinned answers and extracted items).
- Preset actions: chapter summaries, glossary, "list every framework", "steelman / critique", "turn into a checklist".
- Multiple sources per notebook (e.g. two books by the same author, or a book plus your own notes).

### ⑤ Structured extraction
A map-reduce pass, one call per chapter, that writes to a typed catalogue using
structured outputs (`output_config.format`):

```jsonc
{
  "kind": "framework | definition | process | heuristic | checklist | example | anti_pattern | metric | quote",
  "name": "Value Equation",
  "summary": "...",            // in our own words
  "steps_or_components": [...],
  "when_to_use": "...",
  "pitfalls": [...],
  "source": {"chapter": 4, "anchor": "p. 57-61"},
  "confidence": 0.0-1.0
}
```
Then a reduce pass merges duplicates across chapters and links related items.

Note: citations and structured outputs can't be combined in one request (the API
returns a 400). Extraction therefore uses structured outputs and records the
source anchor itself, while chat uses citations.

The user curates the catalogue: keep, merge, edit or drop items. This human step is
what turns a summary into a skill.

### ⑥ Skill builder
Turns the curated catalogue into the Agent Skills format:

```
<skill-name>/
├── SKILL.md              # frontmatter + core method (target < 500 lines)
├── references/
│   ├── frameworks.md     # full framework write-ups, loaded on demand
│   ├── glossary.md
│   ├── examples.md       # worked examples / case studies
│   └── sources.md        # item → chapter/page map
└── scripts/              # optional, e.g. a scoring calculator
```

- **Frontmatter:** `name` (lowercase and hyphens, 64 characters max) and `description` (1,024 characters max) that says *what it does and when to trigger*. The builder drafts 3 candidate descriptions and the evals choose between them.
- **Body structure:** when to use → core workflow (the book's method as steps) → decision rules → output format → pointers to the `references/` files. This keeps SKILL.md short and lets details load only when needed.
- **Voice:** written as instructions to Claude ("score the offer on…"), not as a book summary.
- Editable in place, with a diff between versions.

### ⑦ Eval
- Generate 5–10 realistic trigger prompts, plus 3 that must *not* trigger, from the catalogue.
- Run each prompt with and without the skill (same model) and show the outputs side by side. An optional Claude grader scores them against a rubric built from the catalogue.
- Trigger check: does the description select the skill for the positive prompts and skip it for the negatives?

### ⑧ Export
- `.zip` for claude.ai → Settings → Capabilities → Skills.
- A folder for `~/.claude/skills/` or a repo's `.claude/skills/` (Claude Code).
- Optional: upload through the Skills API (`client.skills.*`, now generally available) for API and Managed Agents use.

---

## 4. Architecture

| Layer | Choice | Why |
|-------|--------|-----|
| Backend | Python 3.12 + FastAPI | Best ingestion libraries (pymupdf, ebooklib, Calibre CLI) and the official `anthropic` SDK |
| Jobs | One worker process (RQ or `arq`) | Ingestion and extraction take minutes, not milliseconds |
| Storage | SQLite + files on disk (`notebooks/<id>/`) | One user; easy to back up |
| Frontend | React + Vite (or HTMX for v0) | Three-pane reader/chat/notes UI with streaming |
| LLM | Anthropic API, `claude-opus-5-5`, adaptive thinking, streaming | Default model; 1M context. Per-chapter extraction can drop to `low` effort, or to `claude-sonnet-5-5` if cost matters (to be measured) |
| Packaging | Docker image that includes Calibre | Calibre is the awkward dependency |

Prompt layout for caching: `system` (fixed) → book documents (cached, never edited)
→ conversation. Nothing that changes from turn to turn goes before the cache breakpoint.

---

## 5. Cost envelope (rough, at Opus 5.5 list prices of $4 / $20 per MTok input/output)

For a 200K-token book:
- Initial cache write of the book: about $1 one-off.
- Each chat turn: cache read at about $0.04, plus a few cents of output.
- Extraction map-reduce: about 200K input + 60K output ≈ $2.
- Evals (10 prompts × 2 arms): under $1.

**Under $10 per book from import to tested skill.** Batch API (50% off) can be used
for extraction when nobody is waiting on it.

---

## 6. Legal and ethical guardrails

- **Bring your own copy.** Personal library use only. No sharing of source text between users.
- **No DRM circumvention.** Encrypted MOBI/AZW/KFX files are refused, with guidance to use DRM-free purchases or the publisher's PDF.
- **Skills hold distilled methods, not the book.** The builder paraphrases, caps verbatim quotes (e.g. 25 words or fewer, a few per skill), and adds attribution (title, author) to `SKILL.md`. Exported skills are personal-use by default. Sharing them publicly is a decision the user makes about the author's rights.
- Source files stay local. Only extracted text goes to the API.

---

## 7. Milestones

| Milestone | Scope | Exit criterion |
|-----------|-------|----------------|
| **M0 · CLI spike** (2–3 days) | `bookskill ingest book.pdf` → `book.json`; `bookskill ask "…"` with citations; `bookskill build` → skill folder | One real book becomes an installable skill end to end |
| **M1 · Notebook** (1–2 wks) | Web UI: sources, chat with citations, notes; MOBI/EPUB through Calibre; chapter-structure preview | Comfortable to read and question a book in the browser |
| **M2 · Skill studio** (1–2 wks) | Extraction catalogue + curation, skill editor, export targets | Curated skill exported in all three formats |
| **M3 · Eval loop** (1 wk) | Trigger tests, with/without comparison, description A/B | Measurable improvement over the baseline on the eval set |
| **v2** | RAG for very large sources, multi-book notebooks, OCR quality tooling, skill version history | — |

---

## 8. Open questions

1. **Where it runs:** local-only desktop/web app, or hosted (Vercel/Fly) behind login?
2. **Frontend depth:** is a CLI + minimal HTMX UI enough for M1, or is the full three-pane React UI a must?
3. **Target surfaces:** claude.ai skills only, or also Claude Code and API/Managed Agents?
4. **Language:** Dutch-language books as well? This affects OCR language packs and prompts.
5. **Repository:** this is unrelated to the Field & Hearth site. It's scoped on this branch for now and should probably move to its own repo before any code is written.

---

## 9. Risks

| Risk | Mitigation |
|------|------------|
| Messy PDF extraction (columns, footnotes, tables) | Preview-and-fix step; per-page OCR fallback; prefer EPUB when the user has it |
| The skill reads like a summary and Claude applies nothing | Builder template forces imperative workflows and decision rules; evals compare against no-skill |
| Description triggers too often or too rarely | Positive and negative trigger tests; description A/B |
| Copyright exposure | Quote caps, attribution, personal-use default, no DRM handling |
| Cost creep on large libraries | Caching, Batch API for extraction, token count shown before running |
