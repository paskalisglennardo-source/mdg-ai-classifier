/*! ============================================================================
 * mdg_ai_openrouter_patch_v5.js
 * MDG Material Classification — OpenRouter free multimodal upgrade (v5)
 *
 * Drop-in patch. Loaded AFTER the main app <script> in index.html.
 * It does NOT remove existing features; it overrides only the AI image
 * classification path and adds a KB-grounded, auditable, characteristic-aware
 * flow.
 *
 * Pipeline:
 *   Stage 1  KB shortlist (client)   -> max 10-20 candidate classes
 *   Stage 2  Vision model (worker)   -> strict JSON, choose only from shortlist
 *   Stage 3  Rule engine (client)    -> scoring + manual-review guardrails
 *
 * Config is read from ai-owner-config.json (same file the app already loads).
 * Knowledge base is read from mdg_ai_class_kb.json (254 classes).
 * ==========================================================================*/
(function () {
  'use strict';

  var V5 = {
    ready: false,
    kb: null,
    cfg: null,
    byCode: {},
    lastResult: null,
    lastInput: null
  };
  window.MDGAIv5 = V5;

  // ---- defaults (overridden by ai-owner-config.json) ----
  var DEFAULT_CFG = {
    aiProxyUrl: '',
    kbUrl: './mdg_ai_class_kb.json',
    models: {
      primary: 'google/gemma-4-31b-it:free',
      fallback: 'google/gemma-4-26b-a4b-it:free',
      ocr: 'nvidia/nemotron-nano-12b-v2-vl:free'
    },
    image: { maxPx: 1400, quality: 0.82, detail: 'high' },
    shortlist: { max: 18 },
    thresholds: { auto_accept: 85, manual_review_min: 60, top1_top2_min_gap: 8 }
  };

  function log() { try { console.log.apply(console, ['[MDG-AI v5]'].concat([].slice.call(arguments))); } catch (e) {} }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function proxyBase() { return (V5.cfg.aiProxyUrl || (window.AI_CONFIG && AI_CONFIG.aiProxyUrl) || '').replace(/\/+$/, ''); }

  // ----------------------------------------------------------------------
  // Init: load owner config + KB
  // ----------------------------------------------------------------------
  async function init() {
    V5.cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
    // owner config
    try {
      var ocUrl = (window.AI_CONFIG && AI_CONFIG.ownerConfigUrl) || './ai-owner-config.json';
      var r = await fetch(ocUrl, { cache: 'no-store' });
      if (r.ok) {
        var oc = await r.json();
        if (oc.aiProxyUrl) V5.cfg.aiProxyUrl = String(oc.aiProxyUrl).trim();
        if (oc.kbUrl) V5.cfg.kbUrl = oc.kbUrl;
        if (oc.models) V5.cfg.models = Object.assign(V5.cfg.models, oc.models);
        if (oc.image) V5.cfg.image = Object.assign(V5.cfg.image, oc.image);
        if (oc.thresholds) V5.cfg.thresholds = Object.assign(V5.cfg.thresholds, oc.thresholds);
      }
    } catch (e) { log('owner config load failed (non-fatal):', e.message); }

    // knowledge base
    try {
      var rk = await fetch(V5.cfg.kbUrl, { cache: 'no-store' });
      if (!rk.ok) throw new Error('HTTP ' + rk.status);
      V5.kb = await rk.json();
      (V5.kb.classes || []).forEach(function (c) { V5.byCode[c.class_code] = c; });
      if (V5.kb.thresholds) V5.cfg.thresholds = Object.assign(V5.cfg.thresholds, V5.kb.thresholds);
      V5.ready = true;
      log('KB loaded:', (V5.kb.scope && V5.kb.scope.total) || (V5.kb.classes || []).length, 'classes; proxy=', proxyBase() || '(unset)');
    } catch (e) {
      log('KB load FAILED:', e.message, '— falling back to legacy classifier');
    }
  }

  // ----------------------------------------------------------------------
  // Image re-compression for OCR (max 1400px, q 0.82)
  // ----------------------------------------------------------------------
  function recompress(dataUrl) {
    return new Promise(function (resolve) {
      try {
        var img = new Image();
        img.onload = function () {
          var mx = V5.cfg.image.maxPx, w = img.width, h = img.height;
          if (Math.max(w, h) > mx) { var s = mx / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', V5.cfg.image.quality));
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
      } catch (e) { resolve(dataUrl); }
    });
  }

  // ----------------------------------------------------------------------
  // Stage 1 — KB shortlist (specific before generic, scope-aware)
  // ----------------------------------------------------------------------
  var PROMO_HINTS = ['promo', 'posm', 'display', 'banner', 'spanduk', 'signage', 'rambu', 'sticker', 'label', 'apparel', 'kaos', 'baju', 'seragam', 'uniform', 'tas', 'dompet', 'pouch', 'kitchenware', 'dapur', 'gelas', 'cup', 'mug', 'handuk', 'towel', 'jam', 'clock', 'mainan', 'boneka', 'toy', 'gift', 'hadiah', 'merchandise', 'gold', 'logam mulia', 'payung', 'jas hujan', 'rain', 'sport', 'olahraga'];
  var SPARE_HINTS = ['bearing', 'valve', 'seal', 'gasket', 'bolt', 'nut', 'screw', 'belt', 'conveyor', 'o-ring', 'oring', 'pump', 'motor', 'sensor', 'cable', 'hose', 'pipe', 'fitting', 'flange', 'bushing', 'pneumatic', 'hydraulic', 'cylinder', 'sprocket', 'gear', 'chain', 'coupling', 'tire', 'ban', 'electrical', 'breaker', 'relay', 'contactor', 'fuse', 'tool', 'spare', 'part', 'oem', 'mfr', 'maintenance', 'mro'];

  function tokenize(s) {
    return (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9\-./]{1,}/g) || []);
  }
  function scopeBias(tokens) {
    var p = 0, s = 0, j = tokens.join(' ');
    PROMO_HINTS.forEach(function (h) { if (j.indexOf(h) >= 0) p++; });
    SPARE_HINTS.forEach(function (h) { if (j.indexOf(h) >= 0) s++; });
    if (p > s + 1) return 'promotion';
    if (s > p + 1) return 'sparepart';
    return null;
  }

  function shortlist(description, ocrText) {
    if (!V5.ready) return [];
    var toks = tokenize(description + ' ' + (ocrText || ''));
    var tset = {}; toks.forEach(function (t) { tset[t] = 1; });
    var bias = scopeBias(toks);
    var scored = (V5.kb.classes || []).map(function (c) {
      var sc = 0;
      (c.keywords || []).forEach(function (k) { if (tset[k]) sc += 3; });
      tokenize(c.label).forEach(function (k) { if (tset[k]) sc += 4; });
      (c.examples || []).forEach(function (ex) {
        tokenize(ex).forEach(function (k) { if (tset[k]) sc += 1; });
      });
      if (bias && c.scope === bias) sc += 2;
      if (c.is_generic) sc -= 4; // specific before generic
      return { c: c, sc: sc };
    });
    scored.sort(function (a, b) { return b.sc - a.sc || (b.c.rows || 0) - (a.c.rows || 0); });
    var max = V5.cfg.shortlist.max;
    var picked = [], used = {};
    for (var i = 0; i < scored.length && picked.length < max; i++) {
      if (scored[i].sc <= 0) break;
      picked.push(scored[i].c); used[scored[i].c.class_code] = 1;
    }
    // ensure scope leaders present if nothing strong matched
    if (picked.length < 6) {
      var pool = (V5.kb.classes || []).filter(function (c) { return !used[c.class_code] && (!bias || c.scope === bias) && !c.is_generic; })
        .sort(function (a, b) { return (b.rows || 0) - (a.rows || 0); });
      for (var k = 0; k < pool.length && picked.length < 10; k++) { picked.push(pool[k]); used[pool[k].class_code] = 1; }
    }
    // always append generic safety candidates (sparepart) at the end
    ['ZSI1_GENERAL', 'ZSI1_OEM_PART', 'ZSI1_FABRICAT_ITEM'].forEach(function (g) {
      if (!used[g] && V5.byCode[g] && picked.length < max + 3) { picked.push(V5.byCode[g]); used[g] = 1; }
    });
    return picked;
  }

  function candidatePayload(c) {
    return {
      class_code: c.class_code, label: c.label, scope: c.scope,
      supercategory: c.supercategory, is_generic: !!c.is_generic,
      visual_cues: c.visual_cues || [], ocr_cues: c.ocr_cues || [],
      required_fields: c.required_fields || [], negative_rule: c.negative_rule || '',
      top_chars: c.top_chars || {}, examples: (c.examples || []).slice(0, 3)
    };
  }

  // ----------------------------------------------------------------------
  // Stage 2 — call worker /classify
  // ----------------------------------------------------------------------
  async function callClassify(description, imageData, candidates, useFallback) {
    var base = proxyBase();
    if (!base) throw new Error('AI proxy URL belum di-set (ai-owner-config.json → aiProxyUrl).');
    var body = {
      mode: 'classify',
      description: description || '',
      image: imageData || null,
      detail: V5.cfg.image.detail,
      candidates: candidates.map(candidatePayload),
      scoring: (V5.kb && V5.kb.scoring) || { visual: 40, ocr_text: 30, characteristic: 20, negative_rule: 10 },
      thresholds: V5.cfg.thresholds,
      prefer: useFallback ? 'fallback' : 'primary'
    };
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 60000);
    try {
      var r = await fetch(base + '/classify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal
      });
      var data = await r.json();
      if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
      return data;
    } finally { clearTimeout(to); }
  }

  // ----------------------------------------------------------------------
  // Stage 3 — rule engine guardrails (client side, deterministic)
  // ----------------------------------------------------------------------
  function applyRuleEngine(res) {
    var th = V5.cfg.thresholds;
    var reasons = Array.isArray(res.manual_review_reason) ? res.manual_review_reason.slice() : [];
    var conf = Number(res.confidence) || 0;
    var top = res.top_candidates || [];
    var rec = V5.byCode[res.recommended_class] || null;

    if (top.length >= 2) {
      var gap = (Number(top[0].confidence) || 0) - (Number(top[1].confidence) || 0);
      if (gap <= th.top1_top2_min_gap) reasons.push('Top-1/Top-2 confidence gap (' + gap + ') <= ' + th.top1_top2_min_gap);
    }
    if (rec && rec.is_generic) {
      var strong = (res.ocr_evidence && res.ocr_evidence.length) && (res.visual_evidence && res.visual_evidence.length);
      if (!strong) reasons.push('Generic class (GENERAL/OEM/FABRICATED) tanpa OCR+visual evidence kuat');
    }
    if (!(res.ocr_evidence && res.ocr_evidence.length) && rec && rec.scope === 'sparepart') {
      reasons.push('Sparepart tanpa OCR/text evidence (part no/brand/size)');
    }
    if (res.negative_rule_check && res.negative_rule_check.passed === false) {
      reasons.push('Negative rule conflict: ' + ((res.negative_rule_check.conflicts || []).join('; ') || 'lihat detail'));
      conf = Math.min(conf, 55);
    }
    if (conf < th.manual_review_min) reasons.push('Confidence < ' + th.manual_review_min);
    else if (conf < th.auto_accept) reasons.push('Confidence ' + th.manual_review_min + '-' + (th.auto_accept - 1) + ' (manual review band)');

    var manual = reasons.length > 0 || conf < th.auto_accept;
    res.confidence = conf;
    res.manual_review_required = !!manual;
    res.manual_review_reason = Array.from(new Set(reasons));
    res.review_status = conf >= th.auto_accept && !manual ? 'AUTO_ACCEPT' : (conf < th.manual_review_min ? 'REJECT' : 'MANUAL_REVIEW');
    return res;
  }

  // ----------------------------------------------------------------------
  // Render result card
  // ----------------------------------------------------------------------
  function badge(status) {
    var color = status === 'AUTO_ACCEPT' ? '#1b7f3b' : (status === 'REJECT' ? '#b00020' : '#b26a00');
    return '<span style="background:' + color + ';color:#fff;border-radius:10px;padding:2px 10px;font-size:11px;font-weight:700">' + escHtml(status) + '</span>';
  }
  function chips(arr) {
    return (arr || []).map(function (x) { return '<span style="display:inline-block;background:#eef;border:1px solid #ccd;border-radius:8px;padding:1px 7px;margin:2px;font-size:11px">' + escHtml(x) + '</span>'; }).join('');
  }
  function renderResult(res) {
    var rec = V5.byCode[res.recommended_class];
    var label = res.recommended_class_label || (rec && rec.label) || res.recommended_class || '(none)';
    var html = '';
    html += '<div style="border:1px solid #d6d6e0;border-radius:10px;padding:10px;margin-top:4px">';
    html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + badge(res.review_status) +
      '<strong style="font-size:14px">' + escHtml(res.recommended_class || '-') + '</strong>' +
      '<span style="color:#555">' + escHtml(label) + '</span>' +
      '<span style="margin-left:auto;font-weight:700">conf ' + escHtml(res.confidence) + '</span></div>';
    if (rec) html += '<div style="color:#666;font-size:11px;margin-top:2px">' + escHtml(rec.supercategory) + (rec.is_generic ? ' · ⚠ generic' : '') + '</div>';
    if (res.reasoning_summary) html += '<div style="margin-top:6px;font-size:12px">' + escHtml(res.reasoning_summary) + '</div>';
    if (res.manual_review_reason && res.manual_review_reason.length) html += '<div style="margin-top:6px;font-size:12px;color:#b26a00">⚠ ' + res.manual_review_reason.map(escHtml).join('<br>⚠ ') + '</div>';

    if (res.visual_evidence && res.visual_evidence.length) html += '<div style="margin-top:6px"><b style="font-size:11px">Visual</b><br>' + chips(res.visual_evidence) + '</div>';
    if (res.ocr_evidence && res.ocr_evidence.length) html += '<div style="margin-top:4px"><b style="font-size:11px">OCR</b><br>' + chips(res.ocr_evidence) + '</div>';

    if (res.top_candidates && res.top_candidates.length) {
      html += '<div style="margin-top:6px"><b style="font-size:11px">Top candidates</b><br>';
      res.top_candidates.slice(0, 4).forEach(function (t) {
        html += '<div style="font-size:12px">• <code>' + escHtml(t.class_code) + '</code> (' + escHtml(t.confidence) + ') ' + escHtml(t.label || '') + '</div>';
      });
      html += '</div>';
    }
    if (res.missing_required_characteristics && res.missing_required_characteristics.length)
      html += '<div style="margin-top:6px;font-size:12px;color:#b00020"><b>Missing required:</b> ' + res.missing_required_characteristics.map(escHtml).join(', ') + '</div>';
    if (res.characteristic_suggestions && res.characteristic_suggestions.length) {
      html += '<div style="margin-top:6px"><b style="font-size:11px">Characteristic suggestions</b>';
      res.characteristic_suggestions.forEach(function (s) {
        html += '<div style="font-size:12px">• <code>' + escHtml(s.characteristic) + '</code> = <b>' + escHtml(s.suggested_value) + '</b> ' +
          '<span style="color:#888">(' + escHtml(s.confidence) + ', ' + escHtml(s.source) + (s.needs_user_confirmation ? ', confirm' : '') + ')</span></div>';
      });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ----------------------------------------------------------------------
  // Action handling (Apply / Apply+Chars / Copy / Retry)
  // ----------------------------------------------------------------------
  function applyClass(code) {
    if (typeof window.handleBotAction === 'function') {
      // reuse legacy apply_class (wrapper passes non-mdg_ actions through)
      window.handleBotAction({ action: 'apply_class', value: code });
    } else {
      var el = document.getElementById('classInput');
      if (el) { el.value = code; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }
  function applyCharSuggestions(suggestions) {
    var applied = 0, skipped = [];
    (suggestions || []).forEach(function (s) {
      if (!s || !s.characteristic || s.suggested_value == null || s.suggested_value === '') return;
      var row = document.querySelector('.char-row[data-char-name="' + (window.CSS && CSS.escape ? CSS.escape(s.characteristic) : s.characteristic) + '"]');
      if (!row) { skipped.push(s.characteristic + ' (not in form)'); return; }
      var sel = row.querySelector('select[data-char-name]');
      var inp = row.querySelector('input[data-char-name]');
      var val = String(s.suggested_value);
      if (sel) {
        var ok = Array.prototype.some.call(sel.options, function (o) { return o.value.toUpperCase() === val.toUpperCase(); });
        if (ok) {
          Array.prototype.forEach.call(sel.options, function (o) { if (o.value.toUpperCase() === val.toUpperCase()) sel.value = o.value; });
          sel.dispatchEvent(new Event('change', { bubbles: true })); applied++;
        } else { skipped.push(s.characteristic + ' (value bukan allowed)'); }
      } else if (inp) {
        inp.value = val; inp.dispatchEvent(new Event('change', { bubbles: true })); applied++;
      }
    });
    if (typeof window.applyDependencies === 'function') { try { window.applyDependencies(); } catch (e) {} }
    return { applied: applied, skipped: skipped };
  }

  function handleAction(action) {
    var res = V5.lastResult || {};
    switch (action.action) {
      case 'mdg_apply_class':
        applyClass(action.value || res.recommended_class);
        break;
      case 'mdg_apply_class_chars':
        applyClass(res.recommended_class);
        setTimeout(function () {
          var r = applyCharSuggestions(res.characteristic_suggestions || []);
          if (typeof window.addSystemMessage === 'function')
            window.addSystemMessage('✅ Applied class + ' + r.applied + ' characteristic(s)' + (r.skipped.length ? '. Skipped: ' + r.skipped.join(', ') : ''));
        }, 350);
        break;
      case 'mdg_copy_json':
        try {
          navigator.clipboard.writeText(JSON.stringify(res, null, 2));
          if (typeof window.addSystemMessage === 'function') window.addSystemMessage('📋 JSON result disalin ke clipboard');
        } catch (e) {
          if (typeof window.addBotMessage === 'function') window.addBotMessage('<pre style="white-space:pre-wrap;font-size:11px">' + escHtml(JSON.stringify(res, null, 2)) + '</pre>');
        }
        break;
      case 'mdg_retry_fallback':
        if (V5.lastInput) runClassification(V5.lastInput.text, V5.lastInput.image, true);
        break;
    }
  }

  // ----------------------------------------------------------------------
  // Orchestration
  // ----------------------------------------------------------------------
  async function runClassification(text, imageData, useFallback) {
    if (typeof window.showTypingIndicator === 'function') window.showTypingIndicator();
    try {
      var img = imageData ? await recompress(imageData) : null;
      V5.lastInput = { text: text, image: imageData };
      var cands = shortlist(text, '');
      if (!cands.length) throw new Error('KB shortlist kosong — KB belum siap.');
      var raw = await callClassify(text, img, cands, useFallback);
      if (typeof window.hideTypingIndicator === 'function') window.hideTypingIndicator();

      var res = raw && raw.result ? raw.result : raw;
      if (!res || !res.recommended_class) throw new Error('Model tidak mengembalikan recommended_class.');
      res = applyRuleEngine(res);
      res._model_used = raw._model_used || (useFallback ? V5.cfg.models.fallback : V5.cfg.models.primary);
      res._candidates_count = cands.length;
      V5.lastResult = res;

      var actions = [
        { label: '📦 Apply Class', action: 'mdg_apply_class', value: res.recommended_class },
        { label: '🧩 Apply Class + Characteristics', action: 'mdg_apply_class_chars' },
        { label: '📋 Copy JSON', action: 'mdg_copy_json' },
        { label: '🔁 Retry (fallback model)', action: 'mdg_retry_fallback' }
      ];
      (res.top_candidates || []).slice(1, 3).forEach(function (t) {
        if (t && t.class_code) actions.push({ label: '↪ ' + t.class_code, action: 'mdg_apply_class', value: t.class_code });
      });
      if (typeof window.addBotMessage === 'function') window.addBotMessage(renderResult(res), actions);
    } catch (err) {
      if (typeof window.hideTypingIndicator === 'function') window.hideTypingIndicator();
      var msg = (err && err.message) || 'error';
      if (typeof window.addBotMessage === 'function') {
        window.addBotMessage('❌ <b>Klasifikasi v5 gagal:</b> ' + escHtml(msg),
          [{ label: '🔁 Retry (fallback model)', action: 'mdg_retry_fallback' }]);
      }
      log('classification error:', msg);
    }
  }

  // ----------------------------------------------------------------------
  // Hook installation
  // ----------------------------------------------------------------------
  function installHooks() {
    // wrap handleBotAction to intercept mdg_* actions
    var orig = window.handleBotAction;
    window.handleBotAction = function (action) {
      if (action && typeof action.action === 'string' && action.action.indexOf('mdg_') === 0) return handleAction(action);
      return typeof orig === 'function' ? orig.apply(this, arguments) : undefined;
    };
    // override image classifier
    window.analyzeImageForClass = function (text, imageData /*, kbContext */) {
      if (!V5.ready) {
        if (typeof window.addBotMessage === 'function')
          window.addBotMessage('⚠️ KB v5 belum termuat — periksa <code>mdg_ai_class_kb.json</code>. Sementara tidak bisa klasifikasi.');
        return Promise.resolve();
      }
      return runClassification(text, imageData, false);
    };
    log('hooks installed (handleBotAction wrapped, analyzeImageForClass overridden)');
  }

  function boot() {
    init().then(installHooks);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // expose for tests / console
  V5.shortlist = shortlist;
  V5.applyRuleEngine = applyRuleEngine;
  V5.candidatePayload = candidatePayload;
})();
