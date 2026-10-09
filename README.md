# Skillbook

A phone-first PWA that turns a book (PDF, EPUB, web book or text file) into a **claude.ai skill**:

1. **Import** a PDF, EPUB, Markdown/text file, or a web book from a link. Files are read on the device (pdf.js for PDFs, a built-in parser for EPUBs) and never uploaded.
2. **Ask** the book questions. Answers come from Claude with tappable page citations.
3. **Extract** the frameworks, processes, heuristics, checklists and pitfalls the book teaches, then untick anything you don't want.
4. **Build** a skill (`SKILL.md` plus `references/*.md`), edit it in place, and download or share it as a `.zip`.
5. **Install** it at claude.ai → Settings → Capabilities → Skills → Upload skill.

Live at **https://plykov.github.io/skillbook/** once Pages is enabled (see below). On a phone, open the link and choose *Add to Home Screen* (iOS Safari) or *Install app* (Android Chrome).

## How it works

- **No server.** Static files on GitHub Pages. Books, notes and skill drafts live in the browser's IndexedDB on your device.
- **Your API key.** Paste an Anthropic API key in Settings. It's stored in this browser only and sent only to `api.anthropic.com`, using the SDK's browser mode. Use a key with a low spend limit.
- **Whole book in context.** Claude's 1M-token context fits a typical book (80–250K tokens), so there's no vector index. Each chapter becomes a citation-enabled document block.
- **Models.** Claude Opus 5.5 (default) or Claude Sonnet 5.5, with adaptive thinking at high effort. If a request is refused, the API retries it on Anthropic's default fallback model (`fallbacks: "default"`).

## Keeping token spend down

The book is by far the largest input, so the app is built to send it at full price once per session:

1. **One shared cached prefix.** Ask, Extract, Skill and Revise all start with the same tools, the same system prompt and the same book documents. The model, thinking and effort settings are identical too. Structured output uses strict tools rather than JSON output formats, because those would change the prefix and can't be combined with citations. Task instructions come after the book.
2. **1-hour cache.** The book is cached for an hour, and every use restarts the clock. Reading answers or curating the catalogue between steps doesn't cost a re-send.
3. **Only content is sent.** Index, bibliography, copyright, acknowledgements and similar sections are excluded by default. Change this under *Sections sent to Claude* on the book page.
4. **No unnecessary full re-runs.**
   - *Revise* sends the current skill plus your instruction and gets back only the changed parts.
   - *Extract more* adds new items from one section instead of re-extracting the whole book.
5. **Economy extraction (optional, Settings).** Runs Extract through the Message Batches API at 50% off, including cache reads and writes. Results usually arrive in minutes but can take up to 24 hours; you can close the app meanwhile. Refusal fallback isn't available in batch mode.

Rough cost for a 200K-token book on Opus 5.5: the first call writes the book to the cache (about $1.60). Each later call within the hour re-reads it for about $0.04, plus its own output: around $0.03 per answer and $0.50 each for extraction and the skill build. Each call shows its token use and cost, including how much was read from the cache.

## Importing web books

Paste a link under **Import a web book from a link**. This works for **Writebook** libraries (multi-page online books published with 37signals' Writebook, which serve a clean Markdown version of every page) and, more roughly, for any single web page.

- Chapters come from the book's table of contents; pages under a chapter are combined into one section, and citations point to locations (`loc. 12`) like EPUBs.
- Licence, terms and disclaimer pages are skipped automatically (they stay on the source site) and image-only pages are noted.
- Pages are fetched 3 at a time with short pauses.
- **A relay is required.** Browsers can't read most websites directly (CORS), so the app fetches through a small Cloudflare Worker that you deploy to your own account. It only fetches the sites you allow and never forwards cookies. Setup takes about five minutes: see [`proxy/README.md`](proxy/README.md), then paste the Worker's address into **Settings → Web import relay**.
- Members-only pages aren't supported (no logins or cookies are passed on).
- **Respect the source's licence.** Many books allow personal, non-commercial use only. Import what you have the right to read, keep skills built from it private unless the licence allows sharing, and ask the author for permission before using it commercially.

Any other text you can save (a note export, a newsletter, a saved article) can be imported as a `.md` or `.txt` file; Markdown headings become chapters.

## Limits (v0.1)

- PDF, EPUB, Markdown/text and web books; files must be DRM-free. Scanned PDFs need OCR first (e.g. `ocrmypdf`). DRM-protected EPUBs are refused.
- MOBI/AZW isn't read directly: convert to EPUB first, e.g. `ebook-convert book.mobi book.epub` (Calibre).
- EPUBs have no pages, so citations point to *locations* (`loc. 12`): consecutive slices of up to about 2,000 characters, counted from the start of the book. Chapters come from the EPUB's table of contents (EPUB 3 nav or EPUB 2 NCX), including books that keep many chapters in one HTML file. Footnote call-outs are dropped and the footnote text is kept.
- English books.
- Keep the app in the foreground during extraction and skill building (1–4 minutes). Phones may kill background network requests.
- Skills generated from a book are for personal use. They paraphrase methods and cap verbatim quotes, but sharing them is your call about the author's rights.

## Development

```bash
npm install
npm run dev        # http://localhost:5173/skillbook/
npm test           # unit tests (vitest)
npm run build      # typecheck + production build into dist/
```

Source layout:

| File | Role |
|------|------|
| `src/import.ts` | Picks the importer by file content (PDF, EPUB, text) or imports a web link |
| `src/web.ts` | Writebook web books: table of contents, page Markdown, chapter grouping, legal-page skipping |
| `src/relay.ts` | Fetches web pages through the user's relay |
| `src/webpage.ts` | Single web page → book |
| `src/textfile.ts`, `src/markdown.ts` | Markdown/text files, front matter, heading splitting |
| `src/html.ts` | (X)HTML → text, shared by EPUB and web page import |
| `proxy/worker.js` | The Cloudflare Worker relay (deployed separately; see `proxy/README.md`) |
| `src/pdf.ts` | PDF → text per page, outline → chapters (pdf.js, on device) |
| `src/epub.ts` | EPUB → text, table of contents → chapters, locations; DRM check |
| `src/book.ts` | Header/footer stripping, hyphenation repair, sectioning, citation → page/location mapping |
| `src/claude.ts` | Claude API calls: cited chat, structured extraction, skill generation |
| `src/prompts.ts` | System prompts and JSON schemas |
| `src/skill.ts` | Skill validation, `SKILL.md` frontmatter, zip packaging |
| `src/db.ts` | IndexedDB storage |
| `src/main.ts` | UI |

## Deploy

`.github/workflows/deploy.yml` tests, builds and deploys `dist/` to GitHub Pages on every push to `main`. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The app is built for the `/skillbook/` path. To host it somewhere else, set `BASE_PATH` at build time, e.g. `BASE_PATH=/ npm run build`.

The original product scope is in [`docs/SCOPE.md`](docs/SCOPE.md).
