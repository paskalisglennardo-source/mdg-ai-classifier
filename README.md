# MDG Material Classifier — OpenRouter AI Upgrade (v5)

Klasifikasi material SAP MDG berbasis **OpenRouter free multimodal models** (text + image),
dengan **knowledge base 254 class** (237 `ZSI1_*` sparepart + 17 `ZPI1_*` promotion),
shortlist client-side, strict-JSON output, rule-engine guardrails, dan **characteristic assistant**.

Arsitektur: **frontend statis** (GitHub Pages) + **Cloudflare Worker proxy** yang memegang API key.
API key **tidak pernah** ada di browser.

```
Browser (index.html + patch v5)
   │  Stage 1: KB shortlist (mdg_ai_class_kb.json, max 10–20 kandidat, specific>generic)
   ▼
Cloudflare Worker (/classify)        ← OPENROUTER_API_KEY (secret) ada di sini
   │  Stage 2: vision model (primary → fallback → OCR)
   ▼
OpenRouter  (gemma-4-31b → gemma-4-26b → nemotron-nano-12b-vl)
   │  strict JSON
   ▼
Browser  Stage 3: rule engine (scoring 40/30/20/10 + manual-review) → UI + Apply/Copy
```

---

## Isi paket

| File | Fungsi |
|------|--------|
| `index.html` | Form MDG existing (tidak dihapus); ditambah `<script>` patch v5 + path data relatif |
| `form_data_final.json` | Config form MDG (485 class, char_attr, char_values) — di-load otomatis oleh form |
| `mdg_ai_class_kb.json` | **KB 254 class** (visual_cues, ocr_cues, required_fields, negative_rule, top_chars, examples) |
| `mdg_ai_openrouter_patch_v5.js` | Patch frontend: shortlist → /classify → rule engine → render + tombol |
| `ai-owner-config.json` | Config owner: `aiProxyUrl`, model names, thresholds (di-edit setelah deploy worker) |
| `cloudflare-worker-mdg-ai-proxy-v5.mjs` | Worker proxy: `/health` `/chat` `/vision` `/classify` |
| `wrangler.toml`, `.env.example` | Konfig deploy worker |
| `tests/run.mjs` | `npm test`: syntax + KB integrity + worker mock |
| `.github/workflows/*` | CI, deploy Pages, deploy Worker |

---

## Install dari awal (GitHub) — langkah demi langkah

### 0. Prasyarat
- Akun GitHub + akun Cloudflare (gratis).
- API key OpenRouter: buat di <https://openrouter.ai/keys>.
- (Opsional, untuk deploy worker dari laptop) Node.js ≥ 18 dan `npm i -g wrangler`.

### 1. Buat repo & upload paket
**Via web (paling gampang):**
1. GitHub → **New repository** → misal `mdg-ai-classifier` → Create.
2. **Add file → Upload files** → drag semua isi folder ini (termasuk folder `docs/`, `tests/`, `.github/`).
   - Pastikan file `.nojekyll` ikut ter-upload (mencegah GitHub Pages memproses ulang aset).
3. **Commit**.

**Via git CLI:**
```bash
git init
git add .
git commit -m "MDG AI classifier v5"
git branch -M main
git remote add origin https://github.com/<USER>/<REPO>.git
git push -u origin main
```

### 2. Aktifkan GitHub Pages (frontend)
1. Repo → **Settings → Pages**.
2. **Build and deployment → Source = GitHub Actions**.
3. Push ke `main` akan menjalankan workflow `Deploy GitHub Pages`. Setelah hijau, situs ada di:
   `https://<USER>.github.io/<REPO>/`
4. Buka URL itu — form MDG muncul, data ter-load otomatis (`form_data_final.json`).
   AI belum aktif sampai langkah 3–4 (worker + config) selesai.

> Catatan: `index.html` sudah dipatch agar memuat `./form_data_final.json` secara **relatif**, jadi aman di project page (`/<REPO>/`).

### 3. Deploy Cloudflare Worker (proxy AI)
Pilih salah satu:

**A. Via laptop (wrangler):**
```bash
npm i -g wrangler
wrangler login
wrangler secret put OPENROUTER_API_KEY     # paste API key OpenRouter (TIDAK masuk git)
wrangler deploy                            # output: https://mdg-ai-proxy-v5.<subdomain>.workers.dev
```

**B. Via GitHub Actions (otomatis tiap push):**
1. Buat Cloudflare API token (Workers Scripts: Edit) di
   <https://dash.cloudflare.com/profile/api-tokens>.
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = token tadi.
3. Set worker secret OpenRouter (sekali, dari laptop): `wrangler secret put OPENROUTER_API_KEY`.
   (Secret OpenRouter tidak bisa di-set dari Actions tanpa langkah tambahan — set manual sekali via wrangler atau dashboard Cloudflare → Worker → Settings → Variables → Encrypt.)
4. Push → workflow `Deploy Cloudflare Worker` jalan.

Tes worker:
```bash
curl https://<WORKER-URL>/health
# {"ok":true,"version":"v5","models":{...},"key_configured":true,...}
```

### 4. Sambungkan frontend ke worker
1. Edit `ai-owner-config.json`:
   ```json
   { "aiProxyUrl": "https://<WORKER-URL>", "aiEnabled": true }
   ```
2. (Opsional) set `OPENROUTER_SITE_URL` di `wrangler.toml` ke URL Pages kamu lalu `wrangler deploy` lagi (untuk atribusi OpenRouter).
3. Commit & push. Pages redeploy otomatis.

### 5. Pakai
Buka situs Pages → panel AI → upload foto material + isi description → **Analyze**.
Hasil tampil sebagai kartu (recommended_class, confidence, evidence, candidates, characteristic suggestions) dengan tombol:
**Apply Class**, **Apply Class + Characteristics**, **Copy JSON**, **Retry (fallback model)**.

---

## Setting `OPENROUTER_API_KEY` di Cloudflare (ringkas)
- **Recommended:** `wrangler secret put OPENROUTER_API_KEY` (encrypted, tidak terlihat lagi).
- **Dashboard:** Cloudflare → Workers & Pages → worker kamu → **Settings → Variables and Secrets → Add → Encrypt**.
- Jangan pernah menaruh key di `index.html`, `ai-owner-config.json`, atau file repo apa pun.

---

## Test lokal
```bash
npm test       # syntax check + KB integrity (254/237/17) + worker mock OpenRouter
npm run check  # node --check semua file JS/worker
npm run serve  # http-server di http://localhost:8080 (uji frontend statis)
```
Detail: [`docs/LOCAL_TESTING.md`](docs/LOCAL_TESTING.md). Deploy detail: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Model & pipeline
- **Primary:** `google/gemma-4-31b-it:free`
- **Fallback:** `google/gemma-4-26b-a4b-it:free` (dipakai saat primary error/timeout/JSON invalid/confidence rendah)
- **OCR mode:** `nvidia/nemotron-nano-12b-v2-vl:free`
- Image dikompres ~max **1400px**, quality **0.82**, dikirim `detail:"high"`.
- Scoring: visual **40** / OCR **30** / characteristic **20** / negative-rule **10**.
- Threshold: `>=85` auto-accept · `60–84` manual review · `<60` reject · gap top1–top2 `<=8` manual review.
- Generic (`ZSI1_GENERAL/OEM_PART/FABRICAT_ITEM`) dipenalti & dipaksa manual review tanpa evidence kuat.

---

## Limitations (penting)
- **Butuh API key & worker ter-deploy** agar klasifikasi live jalan. Tanpa itu, frontend tetap tampil tapi `/classify` gagal (UI menampilkan error + tombol retry).
- **OpenRouter free tier ada rate limit** (per menit/hari) dan model `:free` bisa antre/lambat/kadang menolak; fallback membantu tapi tidak menjamin. Untuk volume tinggi, pakai key berbayar / model non-free.
- Free multimodal model **kualitas OCR bervariasi** — untuk sparepart, hasil tetap perlu verifikasi manual (sesuai threshold).
- `visual_cues`/`ocr_cues` di KB diturunkan dari Appendix PDF; `required_fields` diturunkan otoritatif dari `form_data_final.json` (`entry_required`).
- KB scope = 254 (subset). Form punya 246 `ZSI1` + 17 `ZPI1`; 9 `ZSI1` di luar scope KB tidak ikut shortlist (sesuai desain KB).
- Patch hanya meng-override jalur klasifikasi AI; fitur form lain tidak diubah.
