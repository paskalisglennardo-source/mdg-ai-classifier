# Quick Start (GitHub) — 5 langkah

1. **Upload** semua isi folder ini ke repo baru (sertakan `.nojekyll`, `docs/`, `tests/`, `.github/`).
2. **Pages:** Settings → Pages → Source = **GitHub Actions**. Tunggu workflow hijau → buka `https://<USER>.github.io/<REPO>/`.
3. **Worker:** dari laptop:
   ```bash
   npm i -g wrangler
   wrangler login
   wrangler secret put OPENROUTER_API_KEY   # paste key dari https://openrouter.ai/keys
   wrangler deploy                          # catat URL workers.dev
   curl https://<WORKER-URL>/health         # harus version "v5"
   ```
4. **Wire:** edit `ai-owner-config.json` → `"aiProxyUrl": "https://<WORKER-URL>"` → commit & push.
5. **Pakai:** buka situs Pages → upload foto + description → Analyze → Apply Class / Apply Class + Characteristics.

Test lokal: `npm test` (harus PASS).

> API key hanya di Cloudflare Worker (secret). Tidak pernah di frontend.
