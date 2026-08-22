import $ from 'jquery';
import Notification from 'vj/components/notification';
import { aiMarkdown, downloadAiReportPdf } from 'vj/components/ai-report/pdf';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, request } from 'vj/utils';

/**
 * Teacher-only "📊 AI Class Report" on contest and homework detail pages:
 * one cached, regenerable class-level teaching report (Layer 2). The button
 * shows for domain roots / super-admins (UiContext.isDomainRoot) and for the
 * activity owner when the page exposes the tdoc; the server enforces the
 * same gate regardless.
 */

const STYLE = [
  '.acr-mask { position: fixed; inset: 0; z-index: 3300; background: rgba(10,14,22,.5); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 20px; animation: ptaFadeIn .2s ease-out; }',
  '.acr { background: var(--pta-card); color: var(--pta-ink); border-radius: var(--pta-radius-lg); width: 940px; max-width: 96vw; max-height: 92vh; display: flex; flex-direction: column; box-shadow: var(--pta-shadow-pop); overflow: hidden; animation: ptaPopIn .3s var(--pta-ease); }',
  '.acr-mask--closing { transition: opacity .18s ease; opacity: 0; pointer-events: none; }',
  '.acr-mask--closing .acr { transition: transform .18s ease, opacity .18s ease; transform: translateY(12px) scale(.97); opacity: 0; }',
  '.acr__head { display: flex; align-items: center; gap: 10px; padding: 11px 18px; background: var(--pta-grad-violet); background-size: 220% 100%; animation: ptaSheen 9s ease infinite; color: #fff; flex: 0 0 auto; }',
  '.acr__title { flex: 1 1 auto; font-weight: bold; font-size: 15px; letter-spacing: .02em; }',
  '.acr__ts { font-size: 11px; color: rgba(255,255,255,.85); flex: 0 0 auto; }',
  '.acr__pill { background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.75); color: #fff; padding: 3px 14px; font-size: 12px; border-radius: 999px; cursor: pointer; flex: 0 0 auto; transition: background .15s ease, transform .15s var(--pta-ease); }',
  '.acr__pill:hover { background: rgba(255,255,255,.32); transform: translateY(-1px); }',
  '.acr__pill:disabled { opacity: .6; cursor: default; transform: none; }',
  '.acr__close { border: none; background: transparent; font-size: 20px; color: rgba(255,255,255,.9); cursor: pointer; padding: 0 6px; line-height: 1; transition: transform .2s var(--pta-ease); }',
  '.acr__close:hover { transform: rotate(90deg); }',
  '.acr__body { padding: 14px 20px; overflow-y: auto; font-size: 13.5px; scrollbar-width: thin; }',
  '.acr__stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }',
  '.acr__stat { background: var(--pta-card-3); border: 1px solid var(--pta-line); border-radius: 999px; padding: 6px 12px; font-size: 12.5px; color: var(--pta-ink-soft); animation: ptaScaleIn .24s var(--pta-ease) backwards; }',
  '.acr__stat:nth-child(2) { animation-delay: .04s; } .acr__stat:nth-child(3) { animation-delay: .08s; } .acr__stat:nth-child(4) { animation-delay: .12s; } .acr__stat:nth-child(5) { animation-delay: .16s; }',
  '.acr__stat b { color: var(--pta-violet-text); }',
  '.acr__empty { text-align: center; padding: 26px 16px; color: var(--pta-ink-faint); }',
  '.acr__gen { display: block; margin: 6px auto 14px; border: none; border-radius: 999px; padding: 10px 26px; font-size: 14px; color: #fff; cursor: pointer; background: linear-gradient(120deg, #4c6ef5, #845ef7); box-shadow: 0 6px 16px -6px rgba(76,110,245,.6); transition: filter .12s ease, transform .12s var(--pta-ease), box-shadow .12s ease; }',
  '.acr__gen:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 9px 20px -6px rgba(76,110,245,.65); }',
  '.acr__wait { display: flex; align-items: center; gap: 14px; padding: 22px 14px; }',
  '.acr__spinner { width: 28px; height: 28px; border: 3px solid #dbe7f8; border-top-color: #4c6ef5; border-right-color: #845ef7; border-radius: 50%; animation: ptaSpin .8s linear infinite; flex: 0 0 auto; }',
  '.pta-dark .acr__spinner { border-color: #3a4a63; border-top-color: #91a7ff; border-right-color: #845ef7; }',
  '.acr__report { line-height: 1.65; animation: ptaFadeIn .3s ease both; }',
  '.acr__report h1 { font-size: 18px; margin: 0 0 10px; color: #5f3dc4; }',
  '.acr__report h2 { font-size: 15px; margin: 18px 0 8px; color: #5f3dc4; border-bottom: 1px solid #eee3ff; padding-bottom: 4px; }',
  '.acr__report h3 { font-size: 13.5px; margin: 12px 0 4px; color: #4b3b8f; }',
  '.acr__report pre { background: #f8f7fc; border: 1px solid #e9e4f5; border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; }',
  '.acr__report code { background: #f1edfa; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; color: #5f3dc4; }',
  '.acr__report pre code { background: none; padding: 0; color: inherit; }',
  '.acr__report blockquote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid #b197fc; border-radius: 0 8px 8px 0; background: #f7f4ff; color: #555; }',
  '.acr__report table { border-collapse: collapse; margin: 8px 0; }',
  '.acr__report td, .acr__report th { border: 1px solid #e5ddf5; padding: 4px 10px; }',
  '.acr__charts { display: flex; flex-direction: column; gap: 10px; margin: 2px 0 14px; }',
  '.acr__chartcard { background: var(--pta-card-2); border: 1px solid var(--pta-line); border-radius: 10px; padding: 8px 12px 6px; transition: box-shadow .15s ease, transform .15s var(--pta-ease); animation: ptaFadeUp .28s var(--pta-ease) backwards; }',
  '.acr__chartcard:nth-child(2) { animation-delay: .05s; } .acr__chartcard:nth-child(3) { animation-delay: .1s; } .acr__chartcard:nth-child(4) { animation-delay: .15s; }',
  '.acr__chartcard:hover { box-shadow: var(--pta-shadow-hover); transform: translateY(-1px); }',
  '.acr__chartcard h4 { margin: 0 0 4px; font-size: 12.5px; color: var(--pta-violet-text); }',
  '.acr__chartcard canvas { display: block; }',
  // dark: only the fixed violet report palette needs explicit values.
  '.pta-dark .acr__report h1, .pta-dark .acr__report h2, .pta-dark .acr__report h3 { color: #b197fc; }',
  '.pta-dark .acr__report h2 { border-bottom-color: #3a3350; }',
  '.pta-dark .acr__report pre { background: #1b1f24; border-color: #30363d; color: #d4d4d4; }',
  '.pta-dark .acr__report code { background: #322a44; color: #d0bdfb; }',
  '.pta-dark .acr__report pre code { color: inherit; }',
  '.pta-dark .acr__report blockquote { background: #2a2440; border-left-color: #845ef7; color: #b9b0d6; }',
  '.pta-dark .acr__report td, .pta-dark .acr__report th { border-color: #3a3350; }',
].join('\n');


/* ------------------------------ figure engine ------------------------------ */

const VERDICT_COLORS = {
  'Wrong Answer': '#e03131',
  'Time Limit Exceeded': '#e8590c',
  'Output Limit Exceeded': '#e8590c',
  'Memory Limit Exceeded': '#9c36b5',
  'Runtime Error': '#c2255c',
  'Compile Error': '#5f3dc4',
  'System Error': '#868e96',
  Hacked: '#e03131',
};
const verdictColor = (name) => VERDICT_COLORS[name] || '#d9480f';

/**
 * Minimal grouped/stacked bar renderer on a plain canvas — one code path for
 * the modal (theme-aware) and for the PDF (light copy via toDataURL).
 */
function drawBars(canvas, cfg) {
  const dark = !!cfg.dark;
  const cssW = cfg.width || 860;
  const scale = 2; // crisp on screen and in the PDF
  const fg = dark ? '#cfd6dd' : '#444';
  const grid = dark ? '#333a41' : '#e8ecf3';
  const axis = dark ? '#4a525b' : '#c5cddb';
  const FONT = '11px -apple-system, "Segoe UI", Arial, sans-serif';
  // Wrapped bottom legend (for long knowledge-point names): pre-measure rows.
  let legendRows = [];
  let extra = 0;
  const plotWGuess = cssW - 52;
  if (cfg.legendBottom) {
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = FONT;
    let row = [];
    let x = 0;
    for (const se of cfg.series) {
      const w = 16 + meas.measureText(se.name).width + 14;
      if (x + w > plotWGuess && row.length) {
        legendRows.push(row);
        row = [];
        x = 0;
      }
      row.push({ name: se.name, color: se.color, x });
      x += w;
    }
    if (row.length) legendRows.push(row);
    extra = legendRows.length * 16 + 6;
  }
  const cssH = (cfg.height || 230) + extra;
  canvas.width = cssW * scale;
  canvas.height = cssH * scale;
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  if (cfg.background) {
    ctx.fillStyle = cfg.background;
    ctx.fillRect(0, 0, cssW, cssH);
  }
  const M = {
    l: 40, r: 12, t: cfg.legendBottom ? 12 : 26, b: 30 + extra,
  };
  const plotW = cssW - M.l - M.r;
  const plotH = cssH - M.t - M.b;
  const totals = cfg.labels.map((_, i) => (cfg.stacked
    ? cfg.series.reduce((a, se) => a + (se.values[i] || 0), 0)
    : Math.max(...cfg.series.map((se) => se.values[i] || 0))));
  const maxV = Math.max(1, ...totals);
  ctx.font = FONT;
  // gridlines + y labels
  const steps = 4;
  for (let g = 0; g <= steps; g++) {
    const v = (maxV / steps) * g;
    const y = M.t + plotH - (plotH * g) / steps;
    ctx.strokeStyle = g === 0 ? axis : grid;
    ctx.beginPath();
    ctx.moveTo(M.l, y);
    ctx.lineTo(cssW - M.r, y);
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(v)), M.l - 6, y + 4);
  }
  // top-right legend (compact charts only)
  if (!cfg.legendBottom) {
    let lx = cssW - M.r;
    ctx.textAlign = 'right';
    for (let k = cfg.series.length - 1; k >= 0; k--) {
      const se = cfg.series[k];
      ctx.fillStyle = fg;
      ctx.fillText(se.name, lx, 14);
      lx -= ctx.measureText(se.name).width + 6;
      ctx.fillStyle = se.color;
      ctx.fillRect(lx - 10, 6, 10, 10);
      lx -= 18;
    }
  }
  // bars
  const n = cfg.labels.length || 1;
  const slot = plotW / n;
  const groupW = Math.min(slot * 0.66, 88);
  for (let i = 0; i < n; i++) {
    const cx = M.l + slot * i + slot / 2;
    if (cfg.stacked) {
      let acc = 0;
      for (const se of cfg.series) {
        const v = se.values[i] || 0;
        if (!v) continue;
        const h = (plotH * v) / maxV;
        const y = M.t + plotH - (plotH * acc) / maxV - h;
        ctx.fillStyle = se.color;
        ctx.fillRect(cx - groupW / 2, y, groupW, h);
        if (h > 13) {
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.fillText(String(v), cx, y + h / 2 + 4);
        }
        acc += v;
      }
      if (acc > 0) {
        ctx.fillStyle = fg;
        ctx.textAlign = 'center';
        ctx.fillText(String(acc), cx, M.t + plotH - (plotH * acc) / maxV - 4);
      }
    } else {
      const bw = groupW / cfg.series.length;
      cfg.series.forEach((se, k) => {
        const v = se.values[i] || 0;
        const h = (plotH * v) / maxV;
        const x = cx - groupW / 2 + bw * k;
        const y = M.t + plotH - h;
        ctx.fillStyle = se.color;
        ctx.fillRect(x + 1, y, bw - 2, h);
        ctx.fillStyle = fg;
        ctx.textAlign = 'center';
        ctx.fillText(String(v), x + bw / 2, Math.max(y - 3, 12));
      });
    }
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.fillText(cfg.labels[i], cx, cssH - extra - 10);
  }
  // wrapped bottom legend
  if (legendRows.length) {
    let ly = cssH - extra + 8;
    ctx.textAlign = 'left';
    for (const row of legendRows) {
      for (const item of row) {
        ctx.fillStyle = item.color;
        ctx.fillRect(M.l + item.x, ly - 8, 10, 10);
        ctx.fillStyle = fg;
        ctx.fillText(item.name, M.l + item.x + 14, ly + 1);
      }
      ly += 16;
    }
  }
}

const CONCEPT_PALETTE = ['#e03131', '#e8590c', '#9c36b5', '#1c7ed6', '#0ca678', '#5f3dc4', '#c2255c', '#d9480f'];

/** Figure specs from the light stats + AI concepts (shared by modal and PDF). */
function figureSpecs(stats, concepts) {
  const probs = (stats && stats.problems) || [];
  if (!probs.length) return [];
  const labels = probs.map((p) => p.label);
  const specs = [{
    title: i18n('Completion by problem'),
    height: 210,
    cfg: {
      labels,
      series: [
        { name: i18n('Attempted'), color: '#748ffc', values: probs.map((p) => p.attempted || 0) },
        { name: i18n('Solved'), color: '#2f9e44', values: probs.map((p) => p.solved || 0) },
      ],
    },
  }];
  const cs = (concepts || []).filter((c) => c && c.name);
  if (cs.length) {
    // The AI's knowledge-point classification: the chart teachers asked for.
    const top = [...cs]
      .map((c) => ({ ...c, total: labels.reduce((a, l) => a + ((c.problems || {})[l] || 0), 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 7);
    specs.push({
      title: i18n('Error knowledge points by problem'),
      height: 250,
      cfg: {
        labels,
        stacked: true,
        legendBottom: true,
        series: top.map((c, k) => ({
          name: c.name,
          color: CONCEPT_PALETTE[k % CONCEPT_PALETTE.length],
          values: labels.map((l) => (c.problems || {})[l] || 0),
        })),
      },
    });
  } else {
    // Pre-generation fallback: verdicts are the best available signal until
    // the AI has classified the actual knowledge points.
    const verdictNames = [...new Set(probs.flatMap((p) => Object.keys(p.firstFail || {})))]
      .sort((a, b) => probs.reduce((s, p) => s + ((p.firstFail || {})[b] || 0), 0)
        - probs.reduce((s, p) => s + ((p.firstFail || {})[a] || 0), 0))
      .slice(0, 7);
    if (verdictNames.length) {
      specs.push({
        title: i18n('First-failure verdicts by problem'),
        height: 250,
        cfg: {
          labels,
          stacked: true,
          series: verdictNames.map((v) => ({
            name: v, color: verdictColor(v), values: probs.map((p) => (p.firstFail || {})[v] || 0),
          })),
        },
      });
    }
  }
  if (probs.some((p) => p.tutorQuestions != null)) {
    // Self-learning bonus figure: how students engaged with the Socratic
    // tutor — replies vs silent skips is the disengagement signal.
    specs.push({
      title: i18n('Tutor engagement by problem'),
      height: 220,
      cfg: {
        labels,
        series: [
          { name: i18n('Questions asked'), color: '#5f3dc4', values: probs.map((p) => p.tutorQuestions || 0) },
          { name: i18n('Student replies'), color: '#0ca678', values: probs.map((p) => p.tutorReplies || 0) },
          { name: i18n('Skipped questions'), color: '#e8590c', values: probs.map((p) => p.tutorSkipped || 0) },
        ],
      },
    });
  }
  specs.push({
    title: i18n('Median attempts and grader-thrash students'),
    height: 210,
    cfg: {
      labels,
      series: [
        { name: i18n('Median attempts'), color: '#4c6ef5', values: probs.map((p) => p.medianAttempts || 0) },
        { name: i18n('Thrash students'), color: '#e8590c', values: probs.map((p) => p.thrashers || 0) },
      ],
    },
  });
  return specs;
}

/** Modal figures: theme-aware, drawn into the given container. */
function renderCharts($container, stats, concepts) {
  const specs = figureSpecs(stats, concepts);
  $container.empty();
  if (!specs.length) return;
  const dark = document.documentElement.classList.contains('pta-dark');
  for (const spec of specs) {
    const $card = $(`<div class="acr__chartcard"><h4>${esc(spec.title)}</h4></div>`);
    const canvas = document.createElement('canvas');
    $card.append(canvas);
    $container.append($card);
    drawBars(canvas, { ...spec.cfg, height: spec.height, width: 860, dark });
  }
}

/** PDF figures: always light, rendered offscreen to base64 PNGs. */
function chartFigures(stats, concepts) {
  return figureSpecs(stats, concepts).map((spec) => {
    const canvas = document.createElement('canvas');
    drawBars(canvas, {
      ...spec.cfg, height: spec.height, width: 1000, dark: false, background: '#ffffff',
    });
    return { title: spec.title, dataUrl: canvas.toDataURL('image/png'), pdfWidth: 500 };
  });
}

function esc(text) {
  return $('<i>').text(String(text ?? '')).html();
}

const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');

function reportUrl() {
  return `${window.location.pathname.replace(/\/(contest|homework|self-learning)\//, '/activity/')}/ai-class-report`;
}

function classFileName(title) {
  return `AI-Class-Report-${String(title || 'activity')}.pdf`.replace(/[^\w.-]+/g, '-');
}

function statsStrip(stats) {
  if (!stats) return '';
  let html = '<div class="acr__stats">';
  html += `<span class="acr__stat">${esc(i18n('Participants'))}: <b>${esc(String(stats.participants ?? '-'))}</b></span>`;
  for (const p of stats.problems || []) {
    html += `<span class="acr__stat" title="${esc(p.title || '')}">${esc(p.label)}: <b>${esc(String(p.solved))}</b>/${esc(String(p.attempted))} ${esc(i18n('solved'))}</span>`;
  }
  if (stats.sampled) html += `<span class="acr__stat">⚠ ${esc(i18n('sampled'))}</span>`;
  html += '</div>';
  return html;
}

function openModal() {
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
  if (!document.getElementById('acr-style')) {
    $('<style>').attr('id', 'acr-style').text(STYLE).appendTo(document.head);
  }
  const $mask = $('<div class="acr-mask"></div>').appendTo(document.body);
  const $modal = $(`<div class="acr" role="dialog" aria-label="${esc(i18n('AI Class Report'))}">`
    + '<div class="acr__head">'
    + `<span class="acr__title">📊 ${esc(i18n('AI Class Report'))}</span>`
    + '<span class="acr__ts"></span>'
    + `<button type="button" class="acr__pill acr__regen" style="display:none">↻ ${esc(i18n('Regenerate'))}</button>`
    + `<button type="button" class="acr__pill acr__dl" style="display:none">⬇ ${esc(i18n('Download PDF'))}</button>`
    + `<button type="button" class="acr__close" title="${esc(i18n('Close'))}">×</button></div>`
    + `<div class="acr__body"><div class="acr__empty">${esc(i18n('Loading...'))}</div></div>`
    + '</div>').appendTo($mask);
  const $body = $modal.find('.acr__body');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    $(document).off('keydown.acr');
    $mask.addClass('acr-mask--closing');
    setTimeout(() => $mask.remove(), 190);
  };
  $modal.find('.acr__close').on('click', close);
  $(document).on('keydown.acr', (ev) => {
    if (ev.key === 'Escape') close();
  });

  let stats = null;
  let concepts = [];
  let currentMd = '';

  function showReport(reportMd, generatedAt) {
    currentMd = String(reportMd || '');
    const html = aiMarkdown.render(currentMd);
    $body.html(statsStrip(stats) + '<div class="acr__charts"></div>' + `<div class="acr__report typo">${html}</div>`);
    renderCharts($body.find('.acr__charts'), stats, concepts);
    import('vj/components/highlighter/prismjs')
      .then(({ default: prism }) => prism.highlightBlocks($body))
      .catch(() => { /* highlighting is optional */ });
    $modal.find('.acr__ts').text(generatedAt ? `${i18n('Saved')}: ${fmtTs(generatedAt)}` : '');
    $modal.find('.acr__regen, .acr__dl').show();
  }

  function showGeneratePrompt() {
    const n = (stats && stats.participants) || 0;
    const m = (stats && (stats.problems || []).length) || 0;
    $body.html(statsStrip(stats)
      + '<div class="acr__charts"></div>'
      + `<div class="acr__empty">${esc(i18n('No report generated yet.'))}</div>`
      + `<button type="button" class="acr__gen">🤖 ${esc(i18n('Generate Class Report'))} (${n} × ${m})</button>`);
    renderCharts($body.find('.acr__charts'), stats, concepts);
    $body.find('.acr__gen').on('click', () => generate());
  }

  async function generate() {
    const n = (stats && stats.participants) || 0;
    const m = (stats && (stats.problems || []).length) || 0;
    $modal.find('.acr__regen, .acr__dl').prop('disabled', true);
    $body.html(statsStrip(stats)
      + '<div class="acr__wait"><div class="acr__spinner"></div>'
      + `<div><b>${esc(i18n('Analyzing the class...'))}</b> (${n} ${esc(i18n('students'))} × ${m} ${esc(i18n('problems'))})<br>`
      + `${esc(i18n('This can take one to three minutes. Please keep this window open.'))}`
      + (n > 60 ? `<br>${esc(i18n('Large class detected — batched analysis may take up to five minutes.'))}` : '')
      + '</div></div>');
    try {
      const res = await request.post(reportUrl(), {});
      if (closed) return;
      stats = (res && res.stats) || stats;
      concepts = (res && res.concepts) || [];
      showReport(res.report, res.updateAt);
      Notification.success(i18n('Class report generated.'));
    } catch (e) {
      if (closed) return;
      Notification.error(e.message);
      showGeneratePrompt();
    } finally {
      $modal.find('.acr__regen, .acr__dl').prop('disabled', false);
    }
  }

  $modal.find('.acr__regen').on('click', () => generate());
  $modal.find('.acr__dl').on('click', function onDl() {
    const $p = $(this);
    $p.prop('disabled', true);
    const html = aiMarkdown.render(currentMd);
    downloadAiReportPdf(currentMd, html, classFileName(stats && stats.activity), {
      figures: chartFigures(stats, concepts),
      figuresTitle: i18n('Statistics Overview'),
    }).finally(() => $p.prop('disabled', false));
  });

  request.get(reportUrl()).then((res) => {
    if (closed) return;
    stats = (res && res.stats) || null;
    concepts = (res && res.concepts) || [];
    if (res && res.report) showReport(res.report, res.generatedAt);
    else showGeneratePrompt();
  }).catch((e) => {
    if (closed) return;
    $body.html(`<div class="acr__empty">⚠ ${esc(e.message)}</div>`);
  });
}

function injectButton() {
  if (!document.getElementById('acr-style')) {
    $('<style>').attr('id', 'acr-style').text(STYLE).appendTo(document.head);
  }
  const $btn = $(`<button type="button" class="acr-btn" id="acr-open">📊 ${esc(i18n('AI Class Report'))}</button>`)
    .on('click', openModal);
  const $tools = $('.section__tools').first();
  if ($tools.length) $tools.append($btn);
  else {
    $btn.css({
      position: 'fixed', right: '24px', bottom: '92px', zIndex: 890,
    }).appendTo(document.body);
  }
}

export default new NamedPage(['contest_detail', 'homework_detail', 'self_learning_detail'], () => {
  const uc = window.UiContext || {};
  const me = (window.UserContext || {})._id;
  const adoc = uc.tdoc || uc.sdoc; // contest/homework vs self-learning detail
  const isOwner = !!(adoc && me != null && adoc.owner === me);
  if (!uc.isDomainRoot && !isOwner) return; // the server enforces the same gate
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
  console.info('[pta-ui] AI Class Report ready (teacher)');
  injectButton();
});
