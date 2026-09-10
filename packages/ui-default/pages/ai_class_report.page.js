import $ from 'jquery';
import { aiMarkdown, downloadAiReportPdf } from 'vj/components/ai-report/pdf';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, request } from 'vj/utils';

/**
 * Teacher-only "📊 AI Class Report" on test, homework and self-learning
 * session pages: one cached, regenerable class-level teaching report. The
 * button shows for domain roots / super-admins (UiContext.isDomainRoot) and
 * for the activity owner when the page exposes the tdoc; the server
 * enforces the same gate regardless.
 *
 * 📡 For EVERY kind the report is a BACKGROUND JOB on the server
 * (POST starts it, GET ?job=1 is polled): the AI reads every task with its
 * knowledge points and answer key, every student's every submission and
 * objective answer (and, for sessions, every tutor exchange) in batches,
 * then writes the report. Closing or refreshing the page does not stop
 * it; reopening the modal re-attaches to the running job and its progress
 * theatre (stages, bar, live feed, ETA).
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
  // 📊 the trigger: a real button beside "Evaluate all students now", not a bare label
  '.acr-btn { display: inline-flex; align-items: center; gap: 6px; border: none; border-radius: 999px; padding: 7px 16px; font-size: 13px; font-weight: 600; color: #fff; cursor: pointer; background: linear-gradient(120deg, #7048e8, #ae3ec9); box-shadow: 0 6px 14px -7px rgba(112,72,232,.8); transition: transform .14s var(--pta-ease, ease), box-shadow .14s ease, filter .14s ease; white-space: nowrap; }',
  '.acr-btn:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 9px 18px -8px rgba(112,72,232,.9); }',
  '.acr-btn:disabled { opacity: .6; cursor: default; transform: none; }',
  // 📡 the session job's progress: stages, a real bar (batches), elapsed time
  '.acr__job { display: flex; gap: 16px; align-items: flex-start; padding: 18px 16px; border-radius: 14px; background: linear-gradient(160deg, rgba(112,72,232,.08), transparent 70%); border: 1px solid rgba(112,72,232,.18); position: relative; overflow: hidden; }',
  '.acr__orb { position: relative; flex: 0 0 auto; width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; background: var(--pta-card, #fff); box-shadow: 0 4px 14px -6px rgba(112,72,232,.7); }',
  '.acr__orb::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, #7048e8, #ae3ec9, #e64980, #7048e8); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); animation: ptaSpin 1.5s linear infinite; }',
  '.acr__orb span { font-size: 21px; line-height: 1; animation: acrBreathe 2.2s ease-in-out infinite; }',
  '@keyframes acrBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.14); } }',
  '.acr__job-body { flex: 1 1 auto; min-width: 0; }',
  '.acr__job-title { font-size: 14px; font-weight: 700; color: var(--pta-violet-text, #5f3dc4); }',
  '.acr__job-stage { font-size: 12.5px; color: var(--pta-ink-soft, #5b6b85); margin-top: 3px; }',
  '.acr__job-track { position: relative; height: 6px; border-radius: 999px; background: rgba(112,72,232,.14); overflow: hidden; margin-top: 10px; }',
  '.acr__job-track i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #7048e8, #ae3ec9); transition: width .6s cubic-bezier(.2,.8,.2,1); position: relative; overflow: hidden; }',
  '.acr__job-track i::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.5), transparent); transform: translateX(-100%); animation: acrSweep 1.6s ease-in-out infinite; }',
  '@keyframes acrSweep { to { transform: translateX(100%); } }',
  '.acr__job-steps { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px; font-size: 12px; color: var(--pta-ink-faint, #98a2ac); }',
  '.acr__job-steps span.is-done { color: var(--pta-ok-text, #237032); }',
  '.acr__job-steps span.is-active { color: var(--pta-ink, #2b3a55); font-weight: 600; }',
  '.acr__job-meta { margin-top: 8px; font-size: 12px; color: var(--pta-ink-faint, #98a2ac); }',
  // 🛰 live activity feed under the bar: one line per stage / batch, newest last, each sliding in
  '.acr__feed { list-style: none; margin: 10px 0 0; padding: 8px 10px; max-height: 128px; overflow-y: auto; border-radius: 10px; background: var(--pta-card-2, rgba(0,0,0,.03)); border: 1px solid var(--pta-line, #e6e8ee); font-size: 12px; color: var(--pta-ink-soft, #5b6b85); scrollbar-width: thin; }',
  '.acr__feed li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; animation: acrFeedIn .35s var(--pta-ease, ease) backwards; }',
  '.acr__feed li time { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--pta-ink-faint, #98a2ac); font-size: 11px; }',
  '.acr__feed li.is-live { color: var(--pta-violet-text, #5f3dc4); font-weight: 600; }',
  '@keyframes acrFeedIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }',
  '.acr__dots::after { content: ""; display: inline-block; width: 1.4em; text-align: left; animation: acrDots 1.2s steps(4, end) infinite; }',
  '@keyframes acrDots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }',
  '.acr__eta { margin-left: 8px; color: var(--pta-ink-faint, #98a2ac); font-weight: normal; }',
  '.acr__pct { position: absolute; right: 0; top: -18px; font-size: 11px; font-weight: 700; color: var(--pta-violet-text, #5f3dc4); font-variant-numeric: tabular-nums; }',
  '.acr__job-track { margin-top: 22px; }',
  '@media (prefers-reduced-motion: reduce) { .acr__orb::before, .acr__orb span, .acr__job-track i::after, .acr__feed li, .acr__dots::after { animation: none !important; } }',
  '.acr__spinner { width: 28px; height: 28px; border: 3px solid #dbe7f8; border-top-color: #4c6ef5; border-right-color: #845ef7; border-radius: 50%; animation: ptaSpin .8s linear infinite; flex: 0 0 auto; }',
  '.pta-dark .acr__spinner { border-color: #3a4a63; border-top-color: #91a7ff; border-right-color: #845ef7; }',
  '.acr__report { line-height: 1.65; animation: ptaFadeIn .3s ease both; }',
  // 🧩 Remedial cards: the report's suggestions turned into editable Studio briefs.
  '.acr-rem { margin: 18px 0 6px; padding: 14px 16px; border: 1.5px solid #f08c00; border-radius: 14px; background: linear-gradient(180deg, #fff8ec, #fffdf8); animation: ptaFadeIn .3s ease both; }',
  '.pta-dark .acr-rem { background: linear-gradient(180deg, #2b2214, #23201a); }',
  '.acr-rem__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }',
  '.acr-rem__title { font-weight: 800; font-size: 15px; color: var(--pta-ink); }',
  '.acr-rem__lead { font-size: 12.5px; color: var(--pta-ink-soft); margin: 0 0 12px; line-height: 1.5; }',
  '.acr-rem__cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }',
  '.acr-rem__card { border: 1px solid var(--pta-line); border-radius: 12px; background: var(--pta-card); padding: 12px 13px; display: flex; flex-direction: column; gap: 8px; transition: opacity .15s ease; }',
  '.acr-rem__card.is-off { opacity: .55; }',
  '.acr-rem__card-top { display: flex; align-items: flex-start; gap: 8px; }',
  '.acr-rem__card-top input[type=checkbox] { margin-top: 3px; }',
  '.acr-rem__concept { font-weight: 700; font-size: 13.5px; color: var(--pta-ink); flex: 1; }',
  '.acr-rem__badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--pta-line); color: var(--pta-ink-soft); white-space: nowrap; }',
  '.acr-rem__badge--warn { border-color: #ffc9c9; background: #fff5f5; color: #c92a2a; }',
  '.acr-rem__row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }',
  '.acr-rem__row label, .acr-rem__lbl { display: block; font-size: 11px; color: var(--pta-ink-faint); margin-bottom: 2px; }',
  '.acr-rem__card select, .acr-rem__card input[type=text], .acr-rem__card textarea { width: 100%; font-size: 12.5px; }',
  '.acr-rem__card textarea { min-height: 96px; resize: vertical; line-height: 1.45; }',
  '.acr-rem__avoid { font-size: 11.5px; color: var(--pta-ink-soft); }',
  '.acr-rem__reuse { font-size: 12px; padding: 8px 10px; border-radius: 9px; background: var(--pta-card-2); border: 1px dashed var(--pta-line); }',
  '.acr-rem__reuse b { color: var(--pta-ink); }',
  '.acr-rem__reuse a { display: inline-block; margin: 3px 6px 0 0; padding: 2px 9px; border-radius: 999px; border: 1px solid #a5d0f7; color: #1864ab; background: #f4f9ff; font-size: 12px; text-decoration: none; }',
  '.pta-dark .acr-rem__reuse a { border-color: #2b74b8; background: #16222f; color: #8fc6ff; }',
  '.acr-rem__foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px; }',
  '.acr-rem__create { border: none; border-radius: 999px; padding: 8px 16px; font-weight: 700; color: #fff; cursor: pointer; background: linear-gradient(120deg, #fcc419, #f08c00); font-size: 13px; }',
  '.acr-rem__create:disabled { opacity: .55; cursor: default; }',
  '.acr-rem__auto { font-size: 12.5px; color: var(--pta-ink-soft); display: flex; align-items: center; gap: 6px; }',
  '.acr-rem__done { margin-top: 10px; font-size: 13px; color: var(--pta-ink); }',
  '.acr-rem__done a { margin-right: 10px; }',
  '.acr-rem__opens { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0; }',
  '.acr-rem__made { margin: 6px 0 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; }',
  '.acr-rem__madecard { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--pta-line); border-radius: 11px; background: var(--pta-card); font-size: 13px; }',
  '.acr-rem__madecard.is-gone { opacity: .55; }',
  '.acr-rem__madebody { flex: 1; min-width: 0; }',
  '.acr-rem__madetitle { font-weight: 700; color: var(--pta-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.acr-rem__madecpt { font-size: 11.5px; color: var(--pta-ink-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.acr-rem__st { font-size: 11px; padding: 2px 9px; border-radius: 999px; white-space: nowrap; border: 1px solid var(--pta-line); color: var(--pta-ink-soft); }',
  '.acr-rem__st--running { border-color: #a5d0f7; background: #eef6fe; color: #1864ab; }',
  '.acr-rem__st--idle { border-color: #ffd28a; background: #fff4e0; color: #e67700; }',
  '.acr-rem__st--passed { border-color: #a9e0b8; background: #f0fbf3; color: #2f7d43; }',
  '.acr-rem__st--published, .acr-rem__st--published_hidden { border-color: #40c057; background: #40c057; color: #fff; }',
  '.acr-rem__st--failed, .acr-rem__st--gone { border-color: #ffc9c9; background: #fff5f5; color: #c92a2a; }',
  '.acr-rem__madecard a.acr-rem__go { font-size: 12px; white-space: nowrap; }',
  '.acr-rem__row-open { font-size: 12.5px; }',
  '.acr-rem__tip { margin-top: 8px; padding: 9px 12px; border-radius: 10px; background: var(--pta-warn-soft, #fff4e0); border: 1px solid var(--pta-warn-line, #ffd28a); font-size: 12.5px; line-height: 1.5; color: var(--pta-ink); }',
  '.acr-rem__openall { margin-top: 6px; border: none; border-radius: 999px; padding: 5px 12px; font-weight: 600; color: #fff; cursor: pointer; background: linear-gradient(120deg, #fcc419, #f08c00); font-size: 12px; }',
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
  const legendRows = [];
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
  const specs = [];
  // 📊 Homework / test: the scoreboard distribution first — the teacher's first question.
  if (stats.scores && stats.scores.histogram && stats.scores.students) {
    specs.push({
      title: `${i18n('Score distribution')} · ${i18n('mean')} ${stats.scores.mean ?? '-'} · ${i18n('median')} ${stats.scores.median ?? '-'} / ${stats.scores.full}`,
      height: 200,
      cfg: {
        labels: stats.scores.histogram.map((h) => `${h.from}–${h.to}`),
        series: [{ name: i18n('Students'), color: '#845ef7', values: stats.scores.histogram.map((h) => h.count) }],
      },
    });
  }
  specs.push({
    title: i18n('Completion by problem'),
    height: 210,
    cfg: {
      labels,
      series: [
        { name: i18n('Attempted'), color: '#748ffc', values: probs.map((p) => p.attempted || 0) },
        { name: i18n('Solved'), color: '#2f9e44', values: probs.map((p) => p.solved || 0) },
      ],
    },
  });
  // 🎯 Objective questions: accuracy per question, one figure per objective task (up to 6).
  const objective = probs.filter((p) => p.kind === 'objective' && (p.questions || []).length);
  for (const p of objective.slice(0, 6)) {
    specs.push({
      title: `${i18n('Accuracy by question')} — ${p.label} ${p.title || ''}`.trim(),
      height: 190,
      cfg: {
        labels: p.questions.map((q) => `Q${q.key}`),
        series: [{ name: i18n('Correct %'), color: '#0ca678', values: p.questions.map((q) => q.accuracy || 0) }],
      },
    });
  }
  // 🗓 When students worked: submissions per day, the late ones in red.
  if (stats.timeline && stats.timeline.length > 1) {
    specs.push({
      title: `${i18n('Submissions per day')}${stats.endAt ? ` · ${i18n('deadline')} ${new Date(stats.endAt).toLocaleDateString()}` : ''}`,
      height: 190,
      cfg: {
        labels: stats.timeline.map((d) => d.day.slice(5)),
        stacked: true,
        series: [
          { name: i18n('On time'), color: '#4c6ef5', values: stats.timeline.map((d) => Math.max(0, d.count - (d.late || 0))) },
          { name: i18n('Late'), color: '#e03131', values: stats.timeline.map((d) => d.late || 0) },
        ],
      },
    });
  }
  // 🌳 Knowledge points: solved rate per point (before the AI classification exists).
  if (stats.points && stats.points.length && !(concepts || []).length) {
    const pts = stats.points.slice(0, 10);
    specs.push({
      title: i18n('Knowledge-point solved rate'),
      height: 200,
      cfg: {
        labels: pts.map((e) => (e.name.length > 18 ? `${e.name.slice(0, 17)}…` : e.name)),
        series: [{ name: i18n('Solved %'), color: '#1c7ed6', values: pts.map((e) => e.solvedRate || 0) }],
      },
    });
  }
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
    const prog = probs.filter((p) => !p.kind || p.kind === 'programming');
    const verdictNames = [...new Set(prog.flatMap((p) => Object.keys(p.firstFail || {})))]
      .sort((a, b) => prog.reduce((s, p) => s + ((p.firstFail || {})[b] || 0), 0)
        - prog.reduce((s, p) => s + ((p.firstFail || {})[a] || 0), 0))
      .slice(0, 7);
    if (verdictNames.length) {
      specs.push({
        title: i18n('First-failure verdicts by problem'),
        height: 250,
        cfg: {
          labels: prog.map((p) => p.label),
          stacked: true,
          series: verdictNames.map((v) => ({
            name: v, color: verdictColor(v), values: prog.map((p) => (p.firstFail || {})[v] || 0),
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
  const attemptProbs = probs.filter((p) => p.kind !== 'subjective');
  if (attemptProbs.length) {
    specs.push({
      title: i18n('Median attempts and grader-thrash students'),
      height: 210,
      cfg: {
        labels: attemptProbs.map((p) => p.label),
        series: [
          { name: i18n('Median attempts'), color: '#4c6ef5', values: attemptProbs.map((p) => p.medianAttempts || 0) },
          { name: i18n('Thrash students'), color: '#e8590c', values: attemptProbs.map((p) => p.thrashers || 0) },
        ],
      },
    });
  }
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
  html += `<span class="acr__stat">${esc(i18n('Participants'))}: <b>${esc(String(stats.participants ?? '-'))}</b>${stats.enrolled ? ` / ${esc(String(stats.enrolled))} ${esc(i18n('enrolled'))}` : ''}</span>`;
  if (stats.neverSubmitted) html += `<span class="acr__stat" title="${esc(i18n('Enrolled students without any submission'))}">🚫 ${esc(String(stats.neverSubmitted))} ${esc(i18n('never submitted'))}</span>`;
  if (stats.scores && stats.scores.students) html += `<span class="acr__stat" title="${esc(i18n('Scoreboard: mean / median'))}">Σ ${esc(String(stats.scores.mean ?? '-'))} · ${esc(String(stats.scores.median ?? '-'))} / ${esc(String(stats.scores.full))}</span>`;
  if (stats.late && stats.late.submissions) html += `<span class="acr__stat" title="${esc(i18n('Late submissions / students who submitted late'))}">⏱ ${esc(String(stats.late.submissions))} · ${esc(String(stats.late.students))}</span>`;
  for (const p of stats.problems || []) {
    if (p.kind === 'objective') html += `<span class="acr__stat" title="${esc(p.title || '')}">${esc(p.label)}: <b>${esc(String(p.accuracy ?? '-'))}%</b> ${esc(i18n('correct'))}</span>`;
    else if (p.kind === 'subjective') {
      html += `<span class="acr__stat" title="${esc(p.title || '')}">${esc(p.label)}: <b>${esc(String(p.handedIn || 0))}</b> ${esc(i18n('handed in'))}</span>`;
      // PTA fork: AI-graded report tasks — mean rubric total and the weakest criterion.
      const r = p.report;
      if (r && r.graded) {
        const weakest = (r.criteria || []).filter((c) => typeof c.mean === 'number' && c.maxPoints > 0)
          .sort((a, b) => (a.mean / a.maxPoints) - (b.mean / b.maxPoints))[0];
        html += `<span class="acr__stat" title="${esc(i18n('AI report grades: mean / max ({0} graded)').replace('{0}', r.graded))}">🤖 ${esc(p.label)}: <b>${esc(String(r.mean ?? '-'))}</b>/${esc(String(r.maxTotal))}${weakest ? ` · ${esc(i18n('weakest'))}: ${esc(weakest.title)} ${esc(String(weakest.mean))}/${esc(String(weakest.maxPoints))}` : ''}</span>`;
      }
    } else html += `<span class="acr__stat" title="${esc(p.title || '')}">${esc(p.label)}: <b>${esc(String(p.solved))}</b>/${esc(String(p.attempted))} ${esc(i18n('solved'))}</span>`;
  }
  if (stats.engagement) {
    const en = stats.engagement;
    html += `<span class="acr__stat" title="${esc(i18n('Tutor questions / student replies'))}">🤖 ${esc(String(en.questions))} / ${esc(String(en.replies))}</span>`;
    if (en.replies) html += `<span class="acr__stat" title="${esc(i18n('\u201CI don\u2019t know\u201D replies'))}">🤷 ${esc(String(Math.round((en.idk / en.replies) * 100)))}%</span>`;
    if (stats.results && stats.results.evaluated) html += `<span class="acr__stat" title="${esc(i18n('Mean rubric total'))}">Σ ${esc(String(stats.results.meanTotal))}/100</span>`;
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
  let pollTimer = null;
  const stopPolling = () => {
    clearTimeout(pollTimer);
    pollTimer = null;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stopPolling();
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
  let remedial = [];
  let remedialDrafts = [];
  let currentMd = '';
  let kind = 'contest';

  /* 📡 The self-learning report is a background job the page polls. */
  // A failed job is old news once a later report exists.
  const newerReportThan = (generatedAt, finishedAt) => !!(generatedAt && finishedAt && new Date(generatedAt) > new Date(finishedAt));
  const stepsFor = () => [
    ['collect', '📚', kind === 'self-learning' ? i18n('Collecting every submission and tutor dialogue') : i18n('Collecting every task, answer key, submission and answer')],
    ['map', '🔍', i18n('Reading each student\u2019s work')],
    ['reduce', '✍️', i18n('Writing the report')],
    ['finalize', '🏷️', i18n('Filling in names')],
  ];
  /*
   * 🛰 The progress theatre. The bar and stage labels come from the job
   * state the server stores; the FEED below them is written here from the
   * changes between polls (a stage that opened, a batch that finished),
   * and the ETA extrapolates the observed batch rate. All of it survives a
   * refresh: the feed is rebuilt from the job state on re-attach.
   */
  const feed = []; // { at: Date, text, live }
  let lastSeen = null; // the previous job state, to detect what changed
  let mapStartedAt = null;
  const feedPush = (text) => {
    if (feed.length && feed[feed.length - 1].text === text) return;
    feed.push({ at: new Date(), text });
    if (feed.length > 40) feed.shift();
  };
  const noteChanges = (job) => {
    const total = job.students || (stats && stats.participants) || 0;
    const m = (stats && (stats.problems || []).length) || 0;
    if (!lastSeen) {
      // Re-attaching to a job already under way: reconstruct what has happened so far.
      if (['map', 'reduce', 'finalize'].includes(job.stage)) feedPush(`📚 ${i18n('Collected {0} students × {1} tasks').replace('{0}', total).replace('{1}', m)}`);
      if (job.stage === 'map' && job.done) feedPush(`🔍 ${i18n('{0} of {1} batches read so far').replace('{0}', job.done).replace('{1}', job.total)}${job.cached ? ` · ${job.cached} ${i18n('from cache')}` : ''}`);
      if (job.stage === 'reduce' || job.stage === 'finalize') feedPush(`🔍 ${i18n('Every student read: {0} of {1}').replace('{0}', job.analyzed || 0).replace('{1}', total)}`);
      if (job.stage === 'finalize') feedPush(`✍️ ${i18n('Report written; filling in names')}`);
    } else {
      if (lastSeen.stage === 'collect' && job.stage !== 'collect') feedPush(`📚 ${i18n('Collected {0} students × {1} tasks').replace('{0}', total).replace('{1}', m)}`);
      if (job.stage === 'map' && lastSeen.stage !== 'map') {
        mapStartedAt = Date.now();
        feedPush(`🔍 ${i18n('{0} batches to read').replace('{0}', job.total)}${job.cached ? ` · ${job.cached} ${i18n('students unchanged since the last report, reused from cache')}` : ''}`);
      }
      if (job.stage === 'map' && job.done > (lastSeen.done || 0)) feedPush(`🔍 ${i18n('Batch {0} of {1} read').replace('{0}', job.done).replace('{1}', job.total)} · ${i18n('students analyzed')} ${job.analyzed || 0}/${total}`);
      if (job.stage === 'reduce' && lastSeen.stage !== 'reduce') feedPush(`✍️ ${i18n('All findings merged — writing the report ({0} students)').replace('{0}', job.analyzed || total)}${job.unanalyzed ? ` · ${job.unanalyzed} ${i18n('not analyzed')}` : ''}`);
      if (job.stage === 'finalize' && lastSeen.stage !== 'finalize') feedPush(`🏷️ ${i18n('Report written; filling in names')}`);
    }
    // ai-speedup WP5: the scheduler had no free slot for the current call.
    const waitKey = job.status === 'running' && job.waiting ? `${job.stage}:${job.waiting.ahead}` : '';
    if (waitKey && waitKey !== lastSeen.waitKey) {
      const secs = Math.max(1, Math.round((job.waiting.eta || 0) / 1000));
      feedPush(`⏳ ${i18n('waiting for capacity')} · ${i18n('{0} ahead').replace('{0}', String(Math.max(0, job.waiting.ahead || 0)))} · ~${secs} s`);
    }
    if (job.stage === 'map' && !mapStartedAt) mapStartedAt = Date.now();
    lastSeen = { stage: job.stage, done: job.done, total: job.total, waitKey };
  };
  const etaText = (job) => {
    if (job.stage === 'map' && mapStartedAt && job.done > 0 && job.total > job.done) {
      const per = (Date.now() - mapStartedAt) / job.done;
      const left = Math.round((per * (job.total - job.done) + 90000) / 1000); // + the reduce call
      return i18n('about {0} min left').replace('{0}', Math.max(1, Math.round(left / 60)));
    }
    if (job.stage === 'reduce') return i18n('about 1–3 min left');
    if (job.stage === 'finalize') return i18n('almost done');
    return '';
  };
  function jobHtml(job) {
    const JOB_STEPS = stepsFor();
    const n = (stats && stats.participants) || 0;
    const idx = Math.max(0, JOB_STEPS.findIndex(([k]) => k === job.stage));
    const frac = job.stage === 'collect' ? 0.05 : job.stage === 'map' ? 0.1 + 0.6 * (job.total ? job.done / job.total : 0) : job.stage === 'reduce' ? 0.78 : job.stage === 'finalize' ? 0.94 : 1;
    const elapsed = job.startedAt ? Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000)) : 0;
    const mm = Math.floor(elapsed / 60);
    const ss = String(elapsed % 60).padStart(2, '0');
    const stageText = job.stage === 'map' && job.total
      ? `${JOB_STEPS[1][2]} \u2014 ${i18n('batch {0} of {1}').replace('{0}', Math.min(job.done + 1, job.total)).replace('{1}', job.total)}`
      : (JOB_STEPS[idx] || JOB_STEPS[0])[2];
    const total = job.students || n;
    const coverage = job.stage === 'map' || job.stage === 'reduce' || job.stage === 'finalize'
      ? ` · ${i18n('students analyzed')} ${job.analyzed || 0}/${total}${job.cached ? ` (${job.cached} ${i18n('from cache')})` : ''}` : '';
    const eta = etaText(job);
    const title = kind === 'self-learning' ? i18n('Generating the session report') : kind === 'homework' ? i18n('Generating the homework report') : i18n('Generating the test report');
    const hint = kind === 'self-learning'
      ? i18n('Every submission and every tutor exchange goes through the AI in batches, then one report is written. This takes a few minutes; you can close this window — the job keeps running and the report will be here when you return.')
      : i18n('Every task, every submission and every objective answer goes through the AI in batches, then one report is written. This takes a few minutes; you can close this window or refresh the page — the job keeps running on the server and the report will be here when you return.');
    const bigClass = total >= 120 ? ` ${i18n('For a class of this size expect {0}–{1} minutes; the job is checked on by its progress heartbeat, not by a fixed time limit.').replace('{0}', Math.max(10, Math.round(total / 8))).replace('{1}', Math.max(20, Math.round(total / 3)))}` : '';
    // 💓 The heartbeat: the last progress write, so a long batch is visibly still alive.
    const beat = job.updatedAt ? Math.max(0, Math.round((Date.now() - new Date(job.updatedAt).getTime()) / 1000)) : null;
    const beatText = beat === null ? '' : ` · ${i18n('last progress update {0}s ago').replace('{0}', beat)}`;
    const feedHtml = feed.length
      ? `<ul class="acr__feed">${feed.map((f, i) => `<li class="${i === feed.length - 1 ? 'is-live' : ''}" style="animation-delay:${Math.min(i, 8) * 0.03}s"><time>${esc(f.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</time><span>${esc(f.text)}</span></li>`).join('')}</ul>`
      : '';
    return `${statsStrip(stats)
    }<div class="acr__job"><div class="acr__orb"><span>${(JOB_STEPS[idx] || JOB_STEPS[0])[1]}</span></div>`
      + '<div class="acr__job-body">'
      + `<div class="acr__job-title">🤖 ${esc(title)} (${total} ${esc(i18n('students'))})${eta ? `<span class="acr__eta">${esc(eta)}</span>` : ''}</div>`
      + `<div class="acr__job-stage"><span class="acr__dots">${esc(stageText)}</span>${esc(coverage)}</div>`
      + `<div class="acr__job-track"><span class="acr__pct">${Math.round(frac * 100)}%</span><i style="width:${Math.round(frac * 100)}%"></i></div>`
      + `<div class="acr__job-steps">${JOB_STEPS.map(([, ico, label], i) => `<span class="${i < idx ? 'is-done' : i === idx ? 'is-active' : ''}">${i < idx ? '✓' : ico} ${esc(label)}</span>`).join('')}</div>${
        feedHtml
      }<div class="acr__job-meta">${esc(hint + bigClass)} · ${mm}:${ss}${esc(beatText)}</div>`
      + '</div></div>';
  }
  function showJob(job) {
    noteChanges(job);
    $body.html(jobHtml(job));
    const $feed = $body.find('.acr__feed');
    if ($feed.length) $feed.scrollTop($feed[0].scrollHeight);
    $modal.find('.acr__regen, .acr__dl').hide();
  }
  /* 📡 Cheap polls (job state only, ?job=1) while the job runs; the full payload once it ends. */
  function pollJob() {
    stopPolling();
    pollTimer = setTimeout(async () => {
      if (closed) return;
      try {
        const probe = await request.get(`${reportUrl()}?job=1`);
        if (closed) return;
        const job = probe && probe.job;
        lastJob = job || lastJob;
        if (job && job.status === 'running') {
          showJob(job);
          pollJob();
          return;
        }
        const res = await request.get(reportUrl());
        if (closed) return;
        stats = (res && res.stats) || stats;
        concepts = (res && res.concepts) || [];
        remedial = (res && res.remedial) || [];
        remedialDrafts = (res && res.remedialDrafts) || [];
        if (job && job.status === 'failed' && !newerReportThan(res.generatedAt, job.finishedAt)) {
          Notification.error(job.error || i18n('The report could not be generated.'));
          if (res.report) showReport(res.report, res.generatedAt);
          else showGeneratePrompt();
        } else {
          showReport(res.report, res.generatedAt);
          Notification.success(i18n('Class report generated.'));
        }
      } catch (e) {
        if (!closed) pollJob(); // transient: keep watching
      }
    }, 2500);
  }

  let lastJob = null;
  /**
   * 🧩 REMEDIAL CARDS — the report's "what to re-teach" turned into
   * editable Studio briefs. Each card is what the teacher is approving:
   * the brief text, the task kind, the difficulty, all editable; a tick to
   * include it. Reuse comes first where it exists (a task already in the
   * problem set that most affected students have not solved is cheaper and
   * instantly targeted by the knowledge map); creating is the fallback.
   * "Create" makes the drafts, starts EVERY statement at once, and opens
   * ONE TAB PER DRAFT so the teacher watches them written side by side,
   * then decides each in its own tab: Continue (solutions, tests,
   * verification) or Discard. Nothing beyond the statement runs without
   * that decision.
   *
   * TABS AND POPUP BLOCKERS. Browsers allow exactly ONE new tab per user
   * gesture unless the site is allow-listed for pop-ups; Chrome consumes
   * the gesture on the first window.open and blocks the rest. So the order
   * matters: the FIRST tab — the one always allowed — is the Studio batch
   * overview (?ids=…), which shows every new draft with live status and an
   * Open button per row. The per-draft tabs are attempted after it; when
   * they are blocked the teacher still has the overview, plus per-draft
   * Open buttons here (each click is its own gesture, so each always
   * opens) and a one-line tip on allowing pop-ups for the site, after
   * which "Open all" works in one go. All tabs are opened synchronously
   * INSIDE the click, before the request — an await in between ends the
   * gesture and everything gets blocked.
   */
  // Remedial practice is always code: programming or function, never a quiz.
  const KIND_OPTS = [['programming', 'Programming task'], ['function', 'Function task']];
  const DIFF_OPTS = [['intro', 'intro'], ['medium', 'medium'], ['challenge', 'challenge']];
  const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
  const STATUS_LABEL = {
    idle: 'Statement ready — review', running: 'Working…', failed: 'Failed', passed: 'Verified — ready to publish', published: 'Published', published_hidden: 'Published · hidden', gone: 'Discarded',
  };
  /** The drafts already created from this report, with live Studio status. */
  function createdHtml(drafts) {
    if (!drafts || !drafts.length) return '';
    return `<div class="acr-rem__made">${drafts.map((d) => {
      const st = d.status || 'idle';
      const pid = (d.pids || [])[0];
      const go = d.gone ? '' : (st.startsWith('published') && d.problemUrl
        ? `<a class="acr-rem__go" href="${esc(d.problemUrl)}" target="_blank" rel="noopener">${esc(pid ? `${pid} ↗` : `${i18n('Open task')} ↗`)}</a>`
        : `<a class="acr-rem__go" href="${esc(d.url)}" target="_blank" rel="noopener">${esc(i18n('Open in Studio'))} ↗</a>`);
      return `<div class="acr-rem__madecard${d.gone ? ' is-gone' : ''}">
        <span class="acr-rem__st acr-rem__st--${esc(st)}">${esc(i18n(STATUS_LABEL[st] || st))}</span>
        <div class="acr-rem__madebody"><div class="acr-rem__madetitle">${esc(d.title || d.concept)}</div><div class="acr-rem__madecpt">${esc(d.concept)}${d.kind ? ` · ${esc(i18n(d.kind === 'function' ? 'Function task' : 'Programming task'))}` : ''}</div></div>
        ${go}</div>`;
    }).join('')}</div>`;
  }
  function remedialHtml(items, drafts) {
    const made = drafts || [];
    const covered = new Set(made.map((d) => String(d.concept || '').toLowerCase()));
    // Cards only for concepts that have no draft yet.
    const pending = (items || []).filter((r) => !covered.has(String(r.canonical || r.concept || '').toLowerCase()));
    if (!(items || []).length && !made.length) return '';
    if (!pending.length) {
      return `<div class="acr-rem">
        <div class="acr-rem__head"><span class="acr-rem__title">🧩 ${esc(i18n('Tasks created from this report'))}</span>
          <span class="acr-rem__badge">${esc(i18n('{0} created').replace('{0}', made.length))}</span></div>
        <p class="acr-rem__lead">${esc(i18n('Every suggestion has been turned into a draft. Status is live from the AI Studio: open a draft to review its statement and press Continue to generate tests and verify, or Discard it.'))}</p>
        ${createdHtml(made)}
        <div class="acr-rem__done"></div>
      </div>`;
    }
    items = pending;
    lastPending = pending;
    const sel = (cls, opts, cur) => `<select class="${cls}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(i18n(l))}</option>`).join('')}</select>`;
    const cards = items.map((r, i) => `<div class="acr-rem__card" data-i="${i}">
      <div class="acr-rem__card-top">
        <input type="checkbox" class="acr-rem__pick" checked>
        <span class="acr-rem__concept">${esc(r.canonical || r.concept)}</span>
        ${r.catalog ? `<span class="acr-rem__badge">${esc(i18n('{0} students').replace('{0}', (r.students || []).length))}</span>`
          : `<span class="acr-rem__badge acr-rem__badge--warn" title="${esc(i18n('Not a knowledge point in this domain yet — creating will add it to the catalog.'))}">⚠ ${esc(i18n('new point'))}</span>`}
      </div>
      ${(r.existing || []).length ? `<div class="acr-rem__reuse"><b>♻ ${esc(i18n('Already in the problem set'))}</b> — ${esc(i18n('the knowledge map will recommend these to the affected students as they are:'))}<br>${r.existing.map((t) => `<a href="${domainPrefix()}/p/${esc(t.docId)}" target="_blank" rel="noopener" title="${esc(t.title)}">${esc(t.pid)} · ${esc(i18n('{0} unsolved').replace('{0}', t.unsolvedBy))}</a>`).join('')}</div>` : ''}
      <div><span class="acr-rem__lbl">${esc(i18n('Working title'))}</span><input type="text" class="acr-rem__title-in textbox" value="${esc(r.title || '')}"></div>
      <div class="acr-rem__row">
        <label>${esc(i18n('Task kind'))}${sel('acr-rem__kind', KIND_OPTS, r.kind)}</label>
        <label>${esc(i18n('Difficulty'))}${sel('acr-rem__diff', DIFF_OPTS, r.difficulty)}</label>
      </div>
      <div><span class="acr-rem__lbl">${esc(i18n('Brief for the AI Studio (editable)'))}</span><textarea class="acr-rem__brief textbox">${esc(r.brief || '')}</textarea></div>
      ${(r.avoidTitles || []).length ? `<div class="acr-rem__avoid">🚫 ${esc(i18n('Must not resemble'))}: ${r.avoidTitles.map((a) => esc(a.title ? `${a.label} "${a.title}"` : a.label)).join(', ')}</div>` : ''}
    </div>`).join('');
    return `<div class="acr-rem">
      ${made.length ? `<div class="acr-rem__head"><span class="acr-rem__title">🧩 ${esc(i18n('Tasks created from this report'))}</span>
        <span class="acr-rem__badge">${esc(i18n('{0} created').replace('{0}', made.length))}</span></div>${createdHtml(made)}` : ''}
      <div class="acr-rem__head"><span class="acr-rem__title">🧩 ${esc(made.length ? i18n('Remaining suggestions') : i18n('Turn the suggestions into practice tasks'))}</span>
        <span class="acr-rem__badge">${esc(i18n('{0} suggested').replace('{0}', items.length))}</span></div>
      <p class="acr-rem__lead">${esc(i18n('One brief per concept the report found, written from the students’ actual mistakes. Edit anything, untick what you do not want, then create — each becomes an AI Studio draft targeting that knowledge point, and once published the knowledge map recommends it to exactly the students who need it.'))}</p>
      <div class="acr-rem__cards">${cards}</div>
      <div class="acr-rem__foot">
        <button type="button" class="acr-rem__create">✨ ${esc(i18n('Create {0} task(s) in AI Studio').replace('{0}', items.length))}</button>
        <span class="acr-rem__auto">${esc(i18n('Each draft opens in its own tab; the statements are written at the same time. In each tab, press Continue to generate tests and verify, or Discard.'))}</span>
      </div>
      <div class="acr-rem__done"></div>
    </div>`;
  }
  let lastPending = [];
  function wireRemedial() {
    const $rem = $body.find('.acr-rem');
    if (!$rem.length) return;
    const count = () => $rem.find('.acr-rem__pick:checked').length;
    const refresh = () => {
      $rem.find('.acr-rem__card').each(function mark() { $(this).toggleClass('is-off', !$(this).find('.acr-rem__pick').is(':checked')); });
      $rem.find('.acr-rem__create').text(`✨ ${i18n('Create {0} task(s) in AI Studio').replace('{0}', count())}`).prop('disabled', !count());
    };
    $rem.on('change', '.acr-rem__pick', refresh);
    $rem.on('click', '.acr-rem__create', async function onCreate() {
      const $b = $(this);
      const items = [];
      $rem.find('.acr-rem__card').each(function collect() {
        if (!$(this).find('.acr-rem__pick').is(':checked')) return;
        const r = lastPending[+$(this).data('i')] || {};
        items.push({
          concept: r.canonical || r.concept,
          title: String($(this).find('.acr-rem__title-in').val() || r.title || ''),
          kind: String($(this).find('.acr-rem__kind').val() || r.kind),
          difficulty: String($(this).find('.acr-rem__diff').val() || r.difficulty),
          brief: String($(this).find('.acr-rem__brief').val() || r.brief || ''),
          avoid: r.avoid || [],
        });
      });
      if (!items.length) return;
      // Open the tabs NOW, while the click still counts as a user gesture.
      const openBlank = (title, line) => {
        let w = null;
        try { w = window.open('', '_blank'); } catch (err) { w = null; }
        if (w) {
          try {
            w.document.write(`<!doctype html><title>${esc(title)}</title>`
              + `<body style="font-family:system-ui,sans-serif;padding:40px;color:#33415c"><h2>✨ ${esc(title)}</h2><p>${esc(line)}</p></body>`);
          } catch (err) { /* placeholder is cosmetic */ }
        }
        return w;
      };
      // First — the one tab every browser allows — the batch overview.
      const overview = openBlank(i18n('AI Studio'), i18n('Creating the drafts and starting their statements...'));
      const tabs = items.map((it) => openBlank(it.title || it.concept, i18n('Creating the draft and starting its statement...')));
      $b.prop('disabled', true).text(i18n('Creating...'));
      try {
        const res = await request.post(reportUrl(), { operation: 'remedial_create', items: JSON.stringify(items) });
        const created = res.created || [];
        const overviewUrl = `${res.studioUrl}?ids=${created.map((c) => encodeURIComponent(String(c.id))).join(',')}`;
        if (overview) overview.location.href = overviewUrl;
        created.forEach((c, i) => { if (tabs[i]) tabs[i].location.href = c.url; });
        tabs.slice(created.length).forEach((w) => { if (w) w.close(); });
        const blocked = created.filter((c, i) => !tabs[i]);
        const rows = created.map((c, i) => `<span class="acr-rem__row-open">${tabs[i] ? '✅' : '↗'} <a href="${esc(c.url)}" target="_blank" rel="noopener" class="acr-rem__open">${esc(c.title)}</a></span>`).join('');
        $rem.find('.acr-rem__done').html(`✅ ${esc(i18n('{0} draft(s) created — statements being written now.').replace('{0}', created.length))}`
          + ` <a href="${esc(overviewUrl)}" target="_blank" rel="noopener"><b>${esc(i18n('Overview of all {0} in AI Studio').replace('{0}', created.length))} →</b></a>`
          + `<div class="acr-rem__opens">${rows}</div>${
            blocked.length ? `<div class="acr-rem__tip">⚠ ${esc(i18n('Your browser allowed only one new tab per click and blocked {0} — the overview tab is open, and each draft above opens with a click of its own. To get all tabs at once next time, allow pop-ups for this site (the blocked-pop-up icon in the address bar).').replace('{0}', blocked.length))}
              <button type="button" class="acr-rem__openall">↗ ${esc(i18n('Open the remaining {0} now').replace('{0}', blocked.length))}</button></div>` : ` ${esc(i18n('Each draft is open in its own tab. In each, press Continue to generate tests and verify, or Discard.'))}`}`);
        $rem.find('.acr-rem__openall').on('click', () => {
          // One gesture: works in full once pop-ups are allowed; otherwise
          // opens one more and the rest stay as links.
          blocked.forEach((c) => { try { window.open(c.url, '_blank'); } catch (err) { /* blocked */ } });
        });
        Notification.success(i18n('Drafts created.'));
        // Flip the section to its "created" form right away, keeping the
        // note above; reopening the report later lands on the same view.
        try {
          const fresh = await request.get(reportUrl());
          remedial = fresh.remedial || remedial;
          remedialDrafts = fresh.remedialDrafts || remedialDrafts;
          const note = $rem.find('.acr-rem__done').html();
          const $next = $(remedialHtml(remedial, remedialDrafts));
          $rem.replaceWith($next);
          $next.find('.acr-rem__done').html(note);
          wireRemedial();
        } catch (err) { /* the next open shows it */ }
      } catch (e) {
        if (overview) overview.close();
        tabs.forEach((w) => { if (w) w.close(); });
        Notification.error(e.message);
        $b.prop('disabled', false);
        refresh();
      }
    });
    refresh();
  }

  function showReport(reportMd, generatedAt) {
    currentMd = String(reportMd || '');
    const html = aiMarkdown.render(currentMd);
    $body.html(`${statsStrip(stats)}<div class="acr__charts"></div>` + `<div class="acr__report typo">${html}</div>${remedialHtml(remedial, remedialDrafts)}`);
    renderCharts($body.find('.acr__charts'), stats, concepts);
    wireRemedial();
    import('vj/components/highlighter/prismjs')
      .then(({ default: prism }) => prism.highlightBlocks($body))
      .catch(() => { /* highlighting is optional */ });
    const cov = lastJob && lastJob.status === 'done' && lastJob.students
      ? ` · ${i18n('{0}/{1} students analyzed individually').replace('{0}', lastJob.analyzed || 0).replace('{1}', lastJob.students)}${lastJob.unanalyzed ? ` (${lastJob.unanalyzed} ${i18n('not analyzed')})` : ''}` : '';
    $modal.find('.acr__ts').text(generatedAt ? `${i18n('Saved')}: ${fmtTs(generatedAt)}${cov}` : '');
    $modal.find('.acr__regen, .acr__dl').show();
  }

  function showGeneratePrompt() {
    const n = (stats && stats.participants) || 0;
    const m = (stats && (stats.problems || []).length) || 0;
    $body.html(`${statsStrip(stats)
    }<div class="acr__charts"></div>`
      + `<div class="acr__empty">${esc(i18n('No report generated yet.'))}<br><small>${esc(i18n('The AI reads every task with its knowledge points and answer key, every student\u2019s every submission and answer, and the scoreboard — in the background, so you can leave this page.'))}</small></div>`
      + `<button type="button" class="acr__gen">🤖 ${esc(i18n('Generate Class Report'))} (${n} ${esc(i18n('students'))} × ${m} ${esc(i18n('tasks'))})</button>`);
    renderCharts($body.find('.acr__charts'), stats, concepts);
    $body.find('.acr__gen').on('click', () => generate());
  }

  async function generate() {
    // 📡 Start (or re-join) the background job, then watch it — every kind.
    $modal.find('.acr__regen, .acr__dl').prop('disabled', true);
    try {
      const res = await request.post(reportUrl(), {});
      if (closed) return;
      feed.length = 0;
      lastSeen = null;
      mapStartedAt = null;
      if (res.started) feedPush(`🚀 ${i18n('Report job started')}`);
      showJob(res.job || {
        status: 'running', stage: 'collect', done: 0, total: 0, startedAt: new Date(),
      });
      if (!res.started) Notification.info(i18n('A report is already being generated for this activity — showing its progress.'));
      pollJob();
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
    remedial = (res && res.remedial) || [];
    remedialDrafts = (res && res.remedialDrafts) || [];
    kind = (res && res.kind) || kind;
    lastJob = (res && res.job) || null;
    if (res && res.job && res.job.status === 'running') {
      showJob(res.job);
      pollJob();
    } else if (res && res.report) showReport(res.report, res.generatedAt);
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
