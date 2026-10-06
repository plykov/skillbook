# Skillbook

A phone-first PWA that turns a PDF book into a **claude.ai skill**:

1. **Import** a PDF on your phone. The text is extracted on the device with pdf.js. The PDF itself never leaves the phone.
2. **Ask** the book questions. Answers come from Claude with tappable page citations.
3. **Extract** the frameworks, processes, heuristics, checklists and pitfalls the book teaches, then untick anything you don't want.
4. **Build** a skill (`SKILL.md` plus `references/*.md`), edit it in place, and download or share it as a `.zip`.
5. **Install** it at claude.ai → Settings → Capabilities → Skills → Upload skill.

Live at **https://plykov.github.io/skillbook/** once Pages is enabled (see below). On a phone, open the link and choose *Add to Home Screen* (iOS Safari) or *Install app* (Android Chrome).

## How it works

- **No server.** Static files on GitHub Pages. Books, notes and skill drafts live in the browser's IndexedDB on your device.
- **Your API key.** Paste an Anthropic API key in Settings. It's stored in this browser only and sent only to `api.anthropic.com`, using the SDK's browser mode. Use a key with a low spend limit.
- **Whole book in context.** Claude's 1M-token context fits a typical book (80–250K tokens), so there's no vector index. Each chapter becomes a document block, and the book is prompt-cached so follow-up questions are cheap.
- **Models.** Claude Opus 5.5 (default) or Claude Sonnet 5.5, with adaptive thinking. If a request is refused, the API retries it on Anthropic's default fallback model (`fallbacks: "default"`).
- **Cost.** A 200K-token book costs roughly $1 to load, a few cents per follow-up question, and $2–3 for extraction plus the skill build on Opus 5.5. The app shows the cost of each call.

## Limits (v0.1)

- Text-based PDFs only. Scanned PDFs need OCR first (e.g. `ocrmypdf`).
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
| `src/pdf.ts` | PDF → text per page, outline → chapters (pdf.js, on device) |
| `src/book.ts` | Header/footer stripping, hyphenation repair, sectioning, citation → page mapping |
| `src/claude.ts` | Claude API calls: cited chat, structured extraction, skill generation |
| `src/prompts.ts` | System prompts and JSON schemas |
| `src/skill.ts` | Skill validation, `SKILL.md` frontmatter, zip packaging |
| `src/db.ts` | IndexedDB storage |
| `src/main.ts` | UI |

## Deploy

`.github/workflows/deploy.yml` tests, builds and deploys `dist/` to GitHub Pages on every push to `main`. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The app is built for the `/skillbook/` path. To host it somewhere else, set `BASE_PATH` at build time, e.g. `BASE_PATH=/ npm run build`.

The original product scope is in [`docs/SCOPE.md`](docs/SCOPE.md).
