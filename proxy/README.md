# Skillbook relay (optional)

Needed only for **Import from link** in the app. Browsers can't read most websites directly (CORS), so this tiny Cloudflare Worker fetches pages for the app. It runs in **your** Cloudflare account, so what you import passes through your own infrastructure only.

It is deliberately narrow:

- Only your app's origin may call it (`ALLOWED_ORIGIN`).
- It only fetches hosts you list (`ALLOWED_HOSTS`). This list is the real protection.
- GET only, https only, text responses only, 5 MB maximum.
- No cookies or credentials are forwarded or returned, so it can't read members-only pages.

## Deploy (about 5 minutes, free plan is plenty)

1. Create a free account at <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Create Worker**, name it `skillbook-relay`, click **Deploy**, then **Edit code**.
3. Replace the contents with [`worker.js`](worker.js) from this folder and click **Deploy**.
4. **Settings → Variables and Secrets → Add** two plain-text variables:
   - `ALLOWED_ORIGIN` = `https://plykov.github.io`
   - `ALLOWED_HOSTS` = `library.sevenfigurecreators.com` (comma-separate more sites)
5. Copy the Worker's address (`https://skillbook-relay.<your-name>.workers.dev`) into the app's **Settings → Web import relay**.

Prefer the command line? Edit `wrangler.toml`, then run `npx wrangler deploy` in this folder.

## Notes

- To allow another site later, add its host to `ALLOWED_HOSTS` and redeploy; no app change needed.
- Responses are cached for a few minutes, so re-importing a book doesn't hit the source site again.
- The app fetches politely (3 pages at a time, with short pauses).
