# Quick Start

## 🟢 Cara tercepat & anti-error 405 — Cloudflare Pages (all-in-one)
Frontend + proxy AI dalam satu deploy. Proxy same-origin di `/api/*` via `functions/`.

1. Cloudflare → **Workers & Pages → Create → Pages** → **Direct Upload** (atau Connect to Git).
   Upload **seluruh** isi folder ini, **termasuk folder `functions/`**.
   Build preset **None**, build command kosong, output dir `/`.
2. **Settings → Environment variables** → tambah `OPENROUTER_API_KEY` (dari <https://openrouter.ai/keys>) → **Encrypt**. (Production & Preview.)
3. **Re-deploy** (wajib supaya env var aktif).
4. Cek `https://<project>.pages.dev/api/health` → `{"ok":true,"version":"v5","key_configured":true}`.
5. Buka situs → upload foto + description → **Analyze**. `ai-owner-config.json` sudah `"/api"`, tidak perlu diedit.

> Error `HTTP 405 ... Worker mungkin error` = POST mendarat di situs statis. Pastikan folder `functions/` ke-upload dan `aiProxyUrl` = `/api`. Lihat README → Troubleshooting.

## ⚪ Alternatif — GitHub Pages + Worker terpisah
1. Repo GitHub → Settings → Pages → Source = **GitHub Actions**.
2. `npm i -g wrangler && wrangler login && wrangler secret put OPENROUTER_API_KEY && wrangler deploy`.
3. `curl https://<WORKER-URL>/health` → version `v5`.
4. Edit `ai-owner-config.json` → `"aiProxyUrl": "https://<WORKER-URL>"` (URL worker penuh) → commit & push.

Test lokal: `npm test` (harus PASS). API key hanya di server (Pages env / Worker secret), tidak pernah di frontend.
