/*! ============================================================================
 * cloudflare-worker-mdg-ai-proxy-v5.mjs
 * MDG AI proxy for OpenRouter free multimodal models.
 *
 * Endpoints:
 *   GET  /health    -> { ok, version:"v5", models, ts }
 *   POST /chat      -> OpenAI-style passthrough (text)            [legacy compat]
 *   POST /vision    -> OpenAI-style passthrough (text+image)      [legacy compat]
 *   POST /classify  -> strict-JSON MDG classification
 *   POST  (root)    -> treated as /chat (back-compat with existing form)
 *
 * Secrets / vars (set in Cloudflare):
 *   OPENROUTER_API_KEY            (secret, REQUIRED)
 *   OPENROUTER_SITE_URL          (var, optional)
 *   OPENROUTER_APP_NAME          (var, optional)
 *   OPENROUTER_MODEL_PRIMARY     (var, default google/gemma-4-31b-it:free)
 *   OPENROUTER_MODEL_FALLBACK    (var, default google/gemma-4-26b-a4b-it:free)
 *   OPENROUTER_MODEL_OCR         (var, default nvidia/nemotron-nano-12b-v2-vl:free)
 *
 * The API key NEVER leaves the worker.
 * ==========================================================================*/

export const VERSION = 'v5';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULTS = {
  primary: 'google/gemma-4-31b-it:free',
  fallback: 'google/gemma-4-26b-a4b-it:free',
  ocr: 'nvidia/nemotron-nano-12b-v2-vl:free'
};

export function models(env) {
  env = env || {};
  return {
    primary: env.OPENROUTER_MODEL_PRIMARY || DEFAULTS.primary,
    fallback: env.OPENROUTER_MODEL_FALLBACK || DEFAULTS.fallback,
    ocr: env.OPENROUTER_MODEL_OCR || DEFAULTS.ocr
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

// ---- strict system prompt --------------------------------------------------
export const CLASSIFY_SYSTEM = [
  'You are an SAP MDG material classification assistant for Wings Group Indonesia.',
  'You classify ONLY from the provided candidate classes. Never invent a class outside the candidates.',
  'You must NOT invent part number, brand, size, material, voltage, or pressure. If there is no evidence, leave it out and list the field under missing_required_characteristics.',
  'For sparepart (ZSI1_*), prefer OCR/text evidence (brand, model, MFR no, size, rating) over appearance alone.',
  'Do NOT pick a generic class (ZSI1_GENERAL / ZSI1_OEM_PART / ZSI1_FABRICAT_ITEM) unless there is strong evidence (OEM label, drawing number, machine context) or no specific candidate fits.',
  'Use visual evidence, OCR evidence, characteristic evidence, and each candidate negative_rule.',
  'Scoring weight guidance: visual 40, ocr/text 30, characteristic 20, negative-rule pass 10.',
  'Confidence 0-100. >=85 and no conflict may auto-accept; 60-84 manual review; <60 reject.',
  'Return STRICT JSON ONLY. No markdown, no code fences, no commentary.',
  'JSON schema:',
  '{"recommended_class":"","recommended_class_label":"","confidence":0,"manual_review_required":true,',
  '"manual_review_reason":[],"top_candidates":[{"class_code":"","label":"","confidence":0,"evidence":[],"risk":[]}],',
  '"visual_evidence":[],"ocr_evidence":[],"negative_rule_check":{"passed":true,"conflicts":[]},',
  '"missing_required_characteristics":[],',
  '"characteristic_suggestions":[{"characteristic":"","suggested_value":"","confidence":0,"source":"description/ocr/kb_default/image","evidence":"","needs_user_confirmation":false}],',
  '"reasoning_summary":""}'
].join('\n');

export function buildClassifyMessages(body) {
  body = body || {};
  var cands = (body.candidates || []).map(function (c) {
    return {
      class_code: c.class_code, label: c.label, scope: c.scope,
      supercategory: c.supercategory, is_generic: !!c.is_generic,
      visual_cues: c.visual_cues, ocr_cues: c.ocr_cues,
      required_fields: c.required_fields, negative_rule: c.negative_rule,
      top_chars: c.top_chars, examples: c.examples
    };
  });
  var userText =
    'CANDIDATE CLASSES (choose recommended_class only from these class_code values):\n' +
    JSON.stringify(cands) +
    '\n\nMATERIAL DESCRIPTION / ITEM NAME:\n' + (body.description || '(none)') +
    '\n\nReturn strict JSON per the schema. recommended_class MUST be one of the candidate class_code values.';
  var content;
  if (body.image) {
    content = [
      { type: 'text', text: userText },
      { type: 'image_url', image_url: { url: body.image, detail: body.detail || 'high' } }
    ];
  } else {
    content = userText;
  }
  return [
    { role: 'system', content: CLASSIFY_SYSTEM },
    { role: 'user', content: content }
  ];
}

// ---- robust JSON extraction ----
export function extractJson(text) {
  if (!text) return null;
  var s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  var i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) {} }
  return null;
}

async function callOpenRouter(env, model, messages, maxTokens, timeoutMs) {
  if (!env || !env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured on worker');
  var ctrl = new AbortController();
  var to = setTimeout(function () { ctrl.abort(); }, timeoutMs || 55000);
  try {
    var headers = {
      'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY,
      'Content-Type': 'application/json'
    };
    if (env.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = env.OPENROUTER_SITE_URL;
    if (env.OPENROUTER_APP_NAME) headers['X-Title'] = env.OPENROUTER_APP_NAME;
    var resp = await fetch(OPENROUTER_URL, {
      method: 'POST', headers: headers, signal: ctrl.signal,
      body: JSON.stringify({ model: model, messages: messages, max_tokens: maxTokens || 1200, temperature: 0.1 })
    });
    var data = await resp.json();
    if (!resp.ok) throw new Error((data && data.error && (data.error.message || data.error)) || ('OpenRouter HTTP ' + resp.status));
    return data;
  } finally { clearTimeout(to); }
}

function contentOf(data) {
  try { return data.choices[0].message.content; } catch (e) { return ''; }
}

// ---- /classify with primary -> fallback ----
async function doClassify(env, body) {
  var m = models(env);
  var messages = buildClassifyMessages(body);
  var order;
  if (body && body.ocr_mode) order = [m.ocr, m.fallback];
  else if (body && body.prefer === 'fallback') order = [m.fallback, m.primary];
  else order = [m.primary, m.fallback];

  var attempts = [], used = null, parsed = null, lastErr = '';
  for (var k = 0; k < order.length; k++) {
    var model = order[k];
    try {
      var data = await callOpenRouter(env, model, messages, 1300, 55000);
      var content = contentOf(data);
      var obj = extractJson(content);
      attempts.push({ model: model, parsed: !!obj });
      if (obj && obj.recommended_class) {
        // basic confidence gate -> retry fallback if low
        var conf = Number(obj.confidence) || 0;
        if (conf >= 50 || k === order.length - 1) { parsed = obj; used = model; break; }
      } else if (k === order.length - 1) {
        used = model;
      }
    } catch (e) {
      lastErr = e.message || String(e);
      attempts.push({ model: model, error: lastErr });
    }
  }
  if (!parsed) {
    return {
      _model_used: used || order[order.length - 1],
      _attempts: attempts,
      result: {
        recommended_class: '',
        recommended_class_label: '',
        confidence: 0,
        manual_review_required: true,
        manual_review_reason: ['Model gagal mengembalikan JSON valid' + (lastErr ? (': ' + lastErr) : '')],
        top_candidates: [],
        visual_evidence: [], ocr_evidence: [],
        negative_rule_check: { passed: true, conflicts: [] },
        missing_required_characteristics: [],
        characteristic_suggestions: [],
        reasoning_summary: 'Classification could not be completed automatically; manual review required.'
      }
    };
  }
  return { _model_used: used, _attempts: attempts, result: parsed };
}

// ---- main handler ----
export async function handle(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  var url = new URL(request.url);
  var path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'GET' && path === '/health') {
    return json({ ok: true, version: VERSION, models: models(env), key_configured: !!(env && env.OPENROUTER_API_KEY), ts: Date.now() });
  }

  if (request.method !== 'POST') {
    return json({ ok: true, version: VERSION, hint: 'POST /chat | /vision | /classify' });
  }

  var body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  var m = models(env);

  try {
    if (path === '/classify' || body.mode === 'classify') {
      var out = await doClassify(env, body);
      return json(out);
    }
    // /chat, /vision, or root -> OpenAI-style passthrough
    var model = path === '/vision' ? m.primary : (body.model || m.primary);
    var data = await callOpenRouter(env, model, body.messages || [], body.max_tokens || 1000, 45000);
    return json(data);
  } catch (e) {
    return json({ error: (e && e.message) || 'worker error' }, 502);
  }
}

export default {
  fetch: function (request, env, ctx) { return handle(request, env); }
};
