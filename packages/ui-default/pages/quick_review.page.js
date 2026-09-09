import $ from 'jquery';
import MarkdownIt from 'markdown-it';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, request } from 'vj/utils';

/**
 * ⚡ QUICK REVIEW — the teacher's instant review of a finished test (and
 * the exact question table on a finished homework).
 *
 * Opens from a "⚡ Quick Review" button next to the AI Class Report on the
 * activity page (owner / domain root, the server enforces the same gate).
 * Everything with a number is computed on the server the moment the test
 * ends (lib/quick_review.ts); the one AI call adds the misconception, a
 * 60-second re-teach script and a check question per item. The panel
 * renders the statistics at once and fills the diagnosis in when it
 * arrives, so it is usable in class even without an AI provider.
 *
 * Presentation mode (▶ Present): full screen, large type, one slide per
 * item, no names anywhere, ← → to move, R to reveal the answer and the
 * explanation, Esc to leave.
 *
 * URL: GET  <activity>/ai-class-report?quick=1        (state + statistics)
 *      GET  ...?quick=1&job=1                          (poll while running)
 *      POST {operation: 'quick'}                       (regenerate)
 *      POST {operation: 'release', released}           (student feedback, policy on_teacher)
 *      POST {operation: 'fix_point', pid, key, points} (knowledge point of a question)
 */
const STYLE = [
  '.qr-mask { position: fixed; inset: 0; z-index: 3200; background: rgba(10,14,22,.5); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 20px; animation: ptaFadeIn .2s ease-out; }',
  '.qr { background: var(--pta-card); color: var(--pta-ink); border-radius: var(--pta-radius-lg); width: 1040px; max-width: 97vw; max-height: 94vh; display: flex; flex-direction: column; box-shadow: var(--pta-shadow-pop); overflow: hidden; animation: ptaPopIn .3s var(--pta-ease); }',
  '.qr__head { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--pta-line); flex-wrap: wrap; }',
  '.qr__title { font-size: 18px; font-weight: 800; margin: 0; flex: 1 1 auto; }',
  '.qr__title small { display: block; font-size: 12px; font-weight: 500; color: var(--pta-ink-soft); margin-top: 2px; }',
  '.qr__body { overflow: auto; padding: 16px 20px 24px; }',
  '.qr-btn { border: 1px solid var(--pta-line); background: var(--pta-card-2); color: var(--pta-ink); border-radius: 999px; padding: 6px 14px; font-weight: 700; font-size: 13px; cursor: pointer; transition: all var(--pta-speed) var(--pta-ease); }',
  '.qr-btn:hover { box-shadow: var(--pta-shadow-hover); transform: translateY(-1px); }',
  '.qr-btn--primary { background: var(--pta-grad-btn); color: #fff; border-color: transparent; }',
  '.qr-btn--ghost { background: transparent; }',
  '.qr-btn[disabled] { opacity: .55; cursor: default; transform: none; box-shadow: none; }',
  '.qr__strip { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 14px; }',
  '.qr__stat { background: var(--pta-card-2); border: 1px solid var(--pta-line-soft); border-radius: var(--pta-radius); padding: 8px 12px; font-size: 13px; }',
  '.qr__stat b { font-size: 16px; }',
  '.qr__note { background: var(--pta-warn-soft); border: 1px solid var(--pta-warn-line); color: var(--pta-warn-text); border-radius: var(--pta-radius); padding: 10px 12px; font-size: 13px; margin: 0 0 14px; }',
  '.qr__note--info { background: var(--pta-blue-soft); border-color: var(--pta-blue-line); color: var(--pta-blue-text); }',
  '.qr__summary { background: var(--pta-violet-soft); border: 1px solid var(--pta-violet-line); border-radius: var(--pta-radius); padding: 12px 14px; margin: 0 0 16px; }',
  '.qr__summary li { margin: 2px 0; }',
  '.qr__h { font-size: 15px; font-weight: 800; margin: 18px 0 10px; display: flex; align-items: center; gap: 8px; }',
  '.qr__h .qr__count { font-size: 12px; font-weight: 600; color: var(--pta-ink-soft); }',
  '.qr-item { border: 1px solid var(--pta-line); border-radius: var(--pta-radius-lg); padding: 14px 16px; margin: 0 0 12px; background: var(--pta-card); }',
  '.qr-item__top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }',
  '.qr-item__rank { width: 28px; height: 28px; border-radius: 999px; background: var(--pta-grad-crimson); color: #fff; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; }',
  '.qr-item__label { font-weight: 800; }',
  '.qr-chip { display: inline-block; border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 700; border: 1px solid var(--pta-line); background: var(--pta-card-2); color: var(--pta-ink-soft); }',
  '.qr-chip--bad { background: var(--pta-bad-soft); border-color: var(--pta-bad-line); color: var(--pta-bad-text); }',
  '.qr-chip--ok { background: var(--pta-ok-soft); border-color: var(--pta-ok-line); color: var(--pta-ok-text); }',
  '.qr-chip--gold { background: var(--pta-gold-soft); border-color: var(--pta-gold-line); color: var(--pta-gold-text); }',
  '.qr-chip--violet { background: var(--pta-violet-soft); border-color: var(--pta-violet-line); color: var(--pta-violet-text); }',
  '.qr-chip--point { cursor: pointer; }',
  '.qr-item__prompt { font-size: 14px; margin: 4px 0 10px; white-space: pre-wrap; }',
  '.qr-bars { display: grid; grid-template-columns: 34px 1fr 52px; gap: 6px 8px; align-items: center; margin: 6px 0 10px; }',
  '.qr-bars__letter { font-weight: 800; }',
  '.qr-bars__track { height: 18px; background: var(--pta-card-3); border-radius: 6px; overflow: hidden; position: relative; }',
  '.qr-bars__fill { height: 100%; background: var(--pta-crimson-2); border-radius: 6px; transition: width .5s var(--pta-ease); }',
  '.qr-bars__fill--ok { background: var(--pta-success); }',
  '.qr-bars__text { position: absolute; left: 8px; top: 0; line-height: 18px; font-size: 12px; color: var(--pta-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 95%; }',
  '.qr-bars__pct { font-size: 12px; font-weight: 700; text-align: right; }',
  '.qr-diag { border-top: 1px dashed var(--pta-line); margin-top: 10px; padding-top: 10px; display: grid; gap: 8px; }',
  '.qr-diag__k { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--pta-ink-soft); margin-bottom: 2px; }',
  '.qr-diag pre { background: var(--pta-card-3); border-radius: var(--pta-radius-sm); padding: 8px 10px; font-size: 12.5px; overflow: auto; margin: 4px 0; }',
  '.qr code, .qr pre { font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }',
  '.qr-diag p { margin: 0 0 4px; }',
  '.qr-reveal { display: none; }',
  '.qr-item.is-open .qr-reveal { display: block; }',
  '.qr-table { width: 100%; border-collapse: collapse; font-size: 13px; }',
  '.qr-table th, .qr-table td { padding: 6px 8px; border-bottom: 1px solid var(--pta-line-soft); text-align: left; vertical-align: top; }',
  '.qr-table th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--pta-ink-soft); }',
  '.qr-meter { height: 8px; border-radius: 999px; background: var(--pta-card-3); overflow: hidden; min-width: 90px; }',
  '.qr-meter i { display: block; height: 100%; border-radius: 999px; background: var(--pta-crimson-2); }',
  '.qr-meter i.ok { background: var(--pta-success); }',
  '.qr-meter i.mid { background: var(--pta-gold); }',
  '.qr-point { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--pta-line-soft); flex-wrap: wrap; }',
  '.qr-point__name { font-weight: 800; min-width: 180px; }',
  '.qr-point__path { font-size: 11px; color: var(--pta-ink-faint); }',
  '.qr-point__from { font-size: 12px; color: var(--pta-ink-soft); flex: 1 1 auto; }',
  '.qr-progress { display: flex; align-items: center; gap: 10px; padding: 14px; border: 1px dashed var(--pta-line); border-radius: var(--pta-radius); margin: 0 0 14px; font-size: 13px; }',
  /* ---- the generation theatre ---- */
  '.qrt { border: 1px solid var(--pta-line); border-radius: var(--pta-radius-lg); padding: 16px 18px 14px; margin: 0 0 16px; background: linear-gradient(180deg, var(--pta-card-2), var(--pta-card)); animation: ptaFadeIn .25s ease both; }',
  '.qrt__head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }',
  '.qrt__orb { position: relative; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--pta-card); flex: 0 0 auto; }',
  '.qrt__orb::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, #4c6ef5, #845ef7, #e64980, #f59f00, #4c6ef5); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); animation: ptaSpin 1.6s linear infinite; }',
  '.qrt__orb span { font-size: 20px; line-height: 1; animation: qrtBreathe 2.2s ease-in-out infinite; }',
  '@keyframes qrtBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.16); } }',
  '.qrt__title { font-weight: 800; font-size: 15px; flex: 1 1 auto; }',
  '.qrt__title small { display: block; font-weight: 500; font-size: 12px; color: var(--pta-ink-soft); margin-top: 2px; }',
  '.qrt__clock { font-variant-numeric: tabular-nums; font-size: 13px; color: var(--pta-ink-soft); background: var(--pta-card-3); border-radius: 999px; padding: 4px 10px; }',
  '.qrt__steps { display: flex; align-items: center; gap: 0; margin: 4px 0 12px; flex-wrap: wrap; }',
  '.qrt__step { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--pta-line); background: var(--pta-card); font-size: 12px; font-weight: 700; color: var(--pta-ink-faint); transition: all .3s var(--pta-ease); }',
  '.qrt__step em { font-style: normal; font-size: 14px; line-height: 1; filter: grayscale(1); opacity: .6; transition: all .3s ease; }',
  '.qrt__step.is-done { color: var(--pta-ok-text); border-color: var(--pta-ok-line); background: var(--pta-ok-soft); }',
  '.qrt__step.is-done em { filter: none; opacity: 1; }',
  '.qrt__step.is-active { color: #fff; background: var(--pta-grad-btn); border-color: transparent; box-shadow: 0 6px 16px -6px rgba(76,110,245,.7); animation: qrtPulse 1.6s ease-in-out infinite; }',
  '.qrt__step.is-active em { filter: none; opacity: 1; }',
  '@keyframes qrtPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }',
  '.qrt__link { width: 14px; height: 2px; background: var(--pta-line); margin: 0 2px; flex: 0 0 auto; }',
  '.qrt__link.is-done { background: var(--pta-ok-line); }',
  '.qrt__flow { display: block; width: 100%; height: 92px; margin: 2px 0 10px; }',
  '.qrt__flow .node { fill: var(--pta-card); stroke: var(--pta-line); stroke-width: 1.5; }',
  '.qrt__flow .node.is-active { stroke: #845ef7; stroke-width: 2.5; }',
  '.qrt__flow .lbl { font: 700 11px/1 var(--pta-font, system-ui, sans-serif); fill: var(--pta-ink); }',
  '.qrt__flow .sub { font: 500 10px/1 var(--pta-font, system-ui, sans-serif); fill: var(--pta-ink-soft); }',
  '.qrt__flow .pipe { fill: none; stroke: var(--pta-line); stroke-width: 2; stroke-dasharray: 4 5; }',
  '.qrt__flow .dot { fill: #845ef7; }',
  '.qrt__flow .dot.b { fill: #4c6ef5; } .qrt__flow .dot.c { fill: #e64980; }',
  '.qrt__bar { height: 10px; border-radius: 999px; background: var(--pta-card-3); overflow: hidden; position: relative; margin: 0 0 6px; }',
  '.qrt__bar i { display: block; height: 100%; width: 0; border-radius: 999px; background: var(--pta-grad-btn); position: relative; transition: width .6s var(--pta-ease); }',
  '.qrt__bar i::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent); transform: translateX(-100%); animation: qrtSweep 1.5s ease-in-out infinite; }',
  '.qrt__bar.is-busy i { width: 38% !important; animation: qrtSlide 1.6s ease-in-out infinite alternate; }',
  '@keyframes qrtSweep { to { transform: translateX(100%); } }',
  '@keyframes qrtSlide { from { margin-left: 0; } to { margin-left: 62%; } }',
  '.qrt__barlabel { display: flex; justify-content: space-between; font-size: 12px; color: var(--pta-ink-soft); margin-bottom: 8px; }',
  '.qrt__feed { list-style: none; margin: 0; padding: 8px 12px; background: var(--pta-card); border: 1px solid var(--pta-line-soft); border-radius: var(--pta-radius); font-size: 12.5px; min-height: 70px; }',
  '.qrt__feed li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; color: var(--pta-ink-soft); animation: qrtFeedIn .35s var(--pta-ease) backwards; }',
  '.qrt__feed li:last-child { color: var(--pta-ink); font-weight: 600; }',
  '.qrt__feed li:last-child::after { content: ""; display: inline-block; width: 1.2em; text-align: left; animation: qrtDots 1.2s steps(4, end) infinite; }',
  '.qrt__feed time { font-variant-numeric: tabular-nums; color: var(--pta-ink-faint); font-size: 11px; flex: 0 0 auto; }',
  '@keyframes qrtFeedIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }',
  '@keyframes qrtDots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }',
  '.qrt--done { border-color: var(--pta-ok-line); }',
  '.qrt--done .qrt__orb::before { animation: none; background: var(--pta-success); }',
  '@media (prefers-reduced-motion: reduce) { .qrt__orb::before, .qrt__orb span, .qrt__step.is-active, .qrt__bar i::after, .qrt__bar.is-busy i, .qrt__feed li, .qrt__feed li:last-child::after { animation: none !important; } .qrt__flow .dot { display: none; } }',
  '.qr__raw { margin: 0 0 14px; font-size: 12px; } .qr__raw summary { cursor: pointer; color: var(--pta-ink-soft); font-weight: 700; }',
  '.qr__raw pre { max-height: 320px; overflow: auto; background: var(--pta-card-3); border-radius: var(--pta-radius-sm); padding: 8px 10px; white-space: pre-wrap; word-break: break-word; font-size: 11.5px; }',
  '.qr-spin { width: 16px; height: 16px; border: 2px solid var(--pta-line); border-top-color: var(--pta-crimson); border-radius: 50%; animation: qrSpin .8s linear infinite; }',
  '@keyframes qrSpin { to { transform: rotate(360deg); } }',
  '.qr-fix { display: inline-flex; gap: 6px; align-items: center; }',
  '.qr-fix input { font-size: 12px; padding: 3px 8px; border: 1px solid var(--pta-line); border-radius: 6px; min-width: 220px; background: var(--pta-card); color: var(--pta-ink); }',
  /* presentation mode — every size is an em of the deck's root size, which
     scales with the viewport width and with the A-/A+ zoom (--qrp-zoom). */
  '.qrp { position: fixed; inset: 0; z-index: 3400; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; font-size: calc(clamp(22px, 2.3vw, 46px) * var(--qrp-zoom, 1)); }',
  '.qrp__bar { display: flex; align-items: center; gap: 10px; padding: 8px 20px; font-size: clamp(13px, 1vw, 18px); color: #94a3b8; border-bottom: 1px solid #1e293b; flex: 0 0 auto; }',
  '.qrp__bar .qr-btn { background: #1e293b; border-color: #334155; color: #e2e8f0; font-size: inherit; padding: 6px 14px; }',
  '.qrp__dots { display: flex; gap: 6px; flex: 1 1 auto; justify-content: center; flex-wrap: wrap; }',
  '.qrp__dots i { width: 9px; height: 9px; border-radius: 50%; background: #334155; }',
  '.qrp__dots i.on { background: #f8fafc; }',
  '.qrp__slide { flex: 1 1 auto; overflow: auto; padding: 2.5vh 4vw 3vh; display: flex; flex-direction: column; }',
  '.qrp__kicker { font-size: .62em; text-transform: uppercase; letter-spacing: .12em; color: #f472b6; font-weight: 800; margin-bottom: .3em; }',
  '.qrp__title { font-size: 1.9em; font-weight: 800; line-height: 1.12; margin: 0 0 .45em; }',
  '.qrp__sub { font-size: .55em; color: #94a3b8; font-weight: 600; margin-left: .6em; white-space: nowrap; }',
  '.qrp__prompt { font-size: 1.35em; line-height: 1.32; white-space: pre-wrap; margin: 0 0 .7em; }',
  '.qrp__bars { display: grid; grid-template-columns: 2.2em 1fr 4.6em; gap: .45em .6em; align-items: center; width: 100%; }',
  '.qrp__bars .letter { font-size: 1.25em; font-weight: 800; }',
  '.qrp__bars .track { height: 1.75em; background: #1e293b; border-radius: .35em; overflow: hidden; position: relative; }',
  /* answer bars: neutral until the teacher reveals — then the key goes green, the rest red */
  '.qrp__bars .fill { height: 100%; background: #60a5fa; border-radius: .35em; }',
  '.qrp.is-revealed .qrp__bars .fill { background: #f43f5e; }',
  '.qrp.is-revealed .qrp__bars .fill.ok { background: #22c55e; }',
  '.qrp__bars .ok-mark { opacity: 0; } .qrp.is-revealed .qrp__bars .ok-mark { opacity: 1; }',
  '.qrp__bars .txt { position: absolute; inset: 0; display: flex; align-items: center; padding-left: .5em; font-size: 1.05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '.qrp__bars .pct { font-size: 1.2em; font-weight: 800; text-align: right; }',
  '.qrp__hidden { filter: blur(10px); opacity: .35; transition: all .3s ease; pointer-events: none; }',
  '.qrp.is-revealed .qrp__hidden { filter: none; opacity: 1; }',
  '.qrp__section { margin-top: .9em; }',
  '.qrp__k { font-size: .6em; letter-spacing: .12em; text-transform: uppercase; color: #94a3b8; font-weight: 800; margin-bottom: .3em; }',
  '.qrp__p { font-size: 1.2em; line-height: 1.38; white-space: pre-wrap; }',
  /* code inside the deck: the site's global `code` rule (small rem size, red)
     must not leak in — sizes are em of the slide text, colours are the deck's */
  /* no ligature fonts and ligatures OFF: students must see `->` and `!=` as typed, never as arrows */
  '.qrp code, .qrp pre { font-family: Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace; font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0, "dlig" 0; }',
  '.qrp p { margin: 0 0 .35em; } .qrp p:last-child { margin-bottom: 0; }',
  '.qrp__why ul, .qrp__why ol, .qrp__p ul, .qrp__p ol, .qrp__prompt ul, .qrp__prompt ol { margin: .2em 0; padding-left: 1.2em; }',
  '.qrp code { font-size: .92em; color: #fde68a; background: #1e293b; border-radius: .25em; padding: .05em .35em; white-space: pre-wrap; word-break: break-word; }',
  '.qrp pre { background: #1e293b; color: #e2e8f0; border: 0; border-radius: .4em; padding: .5em .7em; font-size: .9em; line-height: 1.35; overflow: auto; margin: .4em 0; white-space: pre-wrap; word-break: break-word; }',
  '.qrp pre code { font-size: inherit; color: inherit; background: none; padding: 0; }',
  '.qrp__facts { font-size: .95em; line-height: 1.4; color: #cbd5e1; }',
  '.qrp__hint { font-size: .5em; color: #64748b; margin-top: auto; padding-top: 1.2em; }',
  '.qrp__list { font-size: 1.3em; line-height: 1.45; margin: 0; padding-left: 1.1em; }',
  '.qrp__list li { margin: .3em 0; }',
  '.qrp__points { display: grid; gap: .7em; width: 100%; }',
  '.qrp__point { display: grid; grid-template-columns: 1fr 36vw 4.6em; gap: .6em; align-items: center; font-size: 1.15em; }',
  '.qrp__point .track { height: 1.25em; background: #1e293b; border-radius: .3em; overflow: hidden; }',
  '.qrp__point .fill { height: 100%; background: #f43f5e; border-radius: .3em; }',
  '.qrp__point .fill.mid { background: #f59e0b; } .qrp__point .fill.ok { background: #22c55e; }',
  '.qrp__answer { color: #86efac; margin-top: .3em; }',
  '.qrp__why { font-size: 1.55em; line-height: 1.3; max-width: 30em; }',
  '.qrp__agenda { display: grid; grid-template-columns: 1.7em minmax(10em, 1fr) auto 2fr; gap: .5em 1em; align-items: center; margin-top: .3em; font-size: 1.05em; }',
  '.qrp__agenda .rank { width: 1.5em; height: 1.5em; border-radius: 50%; background: #f472b6; color: #0f172a; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; font-size: .95em; }',
  '.qrp__agenda .name { font-weight: 800; }',
  '.qrp__agenda .stat { color: #fca5a5; font-weight: 800; white-space: nowrap; }',
  '.qrp__agenda .head { color: #cbd5e1; }',
  '.qrp__aside { display: flex; gap: 3em; flex-wrap: wrap; margin-top: 1.2em; }',
  '.qrp__aside .qrp__k { margin-bottom: .15em; }',
  '.qrp__big { font-size: 1.6em; font-weight: 800; }',
  '.qrp__bullets { font-size: 1.35em; line-height: 1.4; margin: 0; padding-left: 1.1em; max-width: 30em; }',
  '.qrp__bullets li { margin: .45em 0; }',
  '.qrp__options { font-size: 1.2em; line-height: 1.45; list-style: none; margin: 0; padding: 0; }',
  '.qrp__options li { margin: .2em 0; }',
  '.qrp__code { font-size: 1.05em; line-height: 1.4; padding: .7em .9em; margin: .2em 0 .6em; white-space: pre; overflow: auto; tab-size: 4; }',
  '.qrp__takeaway { font-size: 1.25em; line-height: 1.35; border: 2px solid #f59e0b; border-radius: .5em; padding: .5em .8em; margin-top: .8em; max-width: 30em; }',
].join('\n');

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/*
 * The AI writes Markdown (backticks around every identifier, fenced code
 * with a language, **bold**); it is rendered with markdown-it, raw HTML
 * disabled. `richText` for paragraphs / bullets / prompts (block level),
 * `inlineText` for one-liners such as headlines, options and take-aways.
 */
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
function richText(text) {
  return md.render(String(text ?? ''));
}
function inlineText(text) {
  return md.renderInline(String(text ?? ''));
}
/** Verdict abbreviations of reviews stored before the digest spelled them out. */
const VERDICT_FULL = {
  AC: 'Accepted', WA: 'Wrong Answer', TLE: 'Time Limit Exceeded', MLE: 'Memory Limit Exceeded', OLE: 'Output Limit Exceeded', RE: 'Runtime Error', CE: 'Compile Error', SE: 'System Error', IGN: 'Ignored', HK: 'Hacked', FE: 'Format Error',
};
const fullVerdict = (v) => VERDICT_FULL[v] || v;
const pctClass = (v) => (v >= 80 ? 'ok' : v >= 60 ? 'mid' : '');
/** The re-teach block in both shapes: legacy prose (older reviews) or the slide-ready object. */
function reteachOf(diag) {
  const rt = diag && diag.reteach;
  if (rt && typeof rt === 'object') {
    return {
      points: Array.isArray(rt.points) ? rt.points : [], code: rt.code && rt.code.text ? rt.code : null, takeaway: rt.takeaway || '', text: rt.text || '',
    };
  }
  const text = String(rt || '');
  const m = /```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/.exec(text);
  return { points: [], code: m && m[2].trim() ? { lang: m[1], text: m[2].trimEnd() } : null, takeaway: '', text: text.replace(/```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/, '').trim() };
}
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');

function quickUrl() {
  return `${window.location.pathname.replace(/\/(contest|homework)\//, '/activity/')}/ai-class-report`;
}

/* ------------------------------------------------------------------ */
/*  Rendering                                                          */
/* ------------------------------------------------------------------ */

function kindLabel(q) {
  if (q.kind === 'input') return i18n('Fill in the blank');
  if (q.kind === 'multiselect') return i18n('Multiple choice');
  return i18n('Single choice');
}

function bars(q, big) {
  if (!q.options || !q.options.length) return '';
  const cls = big ? 'qrp__bars' : 'qr-bars';
  let html = `<div class="${cls}">`;
  for (const o of q.options) {
    html += big
      ? `<span class="letter">${esc(o.letter)}</span><div class="track"><div class="fill${o.correct ? ' ok' : ''}" style="width:${o.share}%"></div><span class="txt">${esc(o.text)}</span></div><span class="pct">${o.share}%${o.correct ? '<span class="ok-mark"> ✓</span>' : ''}</span>`
      : `<span class="qr-bars__letter">${esc(o.letter)}</span><div class="qr-bars__track"><div class="qr-bars__fill${o.correct ? ' qr-bars__fill--ok' : ''}" style="width:${o.share}%"></div><span class="qr-bars__text">${esc(o.text)}</span></div><span class="qr-bars__pct">${o.share}%${o.correct ? ' ✓' : ''}</span>`;
  }
  html += '</div>';
  return html;
}

function wrongLines(q) {
  const lines = [];
  if (q.dominantWrong) lines.push(`${i18n('Dominant wrong answer')}: <b>${esc(q.dominantWrong.answer)}</b> — ${q.dominantWrong.share}% ${i18n('of the wrong answers')}`);
  if (q.kind === 'input' && q.wrong && q.wrong.length) lines.push(`${i18n('Most frequent wrong answers')}: ${q.wrong.map((w) => `<b>${esc(w.answer)}</b> ×${w.count}`).join(', ')}${q.nearMissRate ? ` · ${q.nearMissRate}% ${i18n('are one typo away from the key')}` : ''}`);
  if (q.kind === 'multiselect') {
    if (q.missed && q.missed.length) lines.push(`${i18n('Correct options most often left out')}: ${q.missed.map((m) => `<b>${esc(m.letter)}</b> (${m.rate}%)`).join(', ')}`);
    if (q.added && q.added.length) lines.push(`${i18n('Wrong options most often added')}: ${q.added.map((m) => `<b>${esc(m.letter)}</b> (${m.rate}%)`).join(', ')}`);
  }
  if (q.blankRate) lines.push(`${q.blankRate}% ${i18n('left it blank')}`);
  return lines;
}

function pointChips(names, editable, q) {
  const chips = (names || []).map((n) => `<span class="qr-chip qr-chip--violet">${esc(n)}</span>`).join(' ');
  if (!editable || !q) return chips;
  return `${chips} <button type="button" class="qr-btn qr-btn--ghost qr-fix-open" data-pid="${q.pid}" data-key="${esc(q.key)}" data-points="${esc((names || []).join(', '))}" title="${esc(i18n('Fix the knowledge points of this question'))}">✎</button>`;
}

function itemCard(rank, it, state) {
  const { digest, diagnosis } = state;
  const diag = diagnosis && diagnosis.items ? diagnosis.items[it.id] : null;
  let html = `<div class="qr-item" data-id="${esc(it.id)}"><div class="qr-item__top"><span class="qr-item__rank">${rank}</span>`;
  if (it.type === 'question') {
    const q = digest.questions.find((x) => x.id === it.id);
    if (!q) return '';
    html += `<span class="qr-item__label">${esc(q.label)} · Q${esc(q.key)}</span><span class="qr-chip">${esc(kindLabel(q))}</span>`;
    html += `<span class="qr-chip qr-chip--bad">${q.accuracy}% ${i18n('correct')}</span>`;
    if (q.polarised) html += `<span class="qr-chip qr-chip--gold">${esc(i18n('Polarised'))}</span>`;
    html += ` ${pointChips(q.points, state.kind === 'contest', q)}</div>`;
    html += `<div class="qr-item__prompt">${esc(q.prompt)}</div>`;
    html += bars(q, false);
    if (!q.options.length) html += `<div><span class="qr-chip">${esc(i18n('Key'))}: <b>${esc(q.answer.join(' / '))}</b></span></div>`;
    const wl = wrongLines(q);
    if (wl.length) html += `<div style="font-size:13px;color:var(--pta-ink-soft);margin-top:6px">${wl.join('<br>')}</div>`;
  } else {
    const t = digest.tasks.find((x) => x.id === it.id);
    if (!t) return '';
    html += `<span class="qr-item__label">${esc(t.label)} · ${esc(t.title)}</span><span class="qr-chip">${esc(i18n('Programming'))}</span>`;
    html += `<span class="qr-chip qr-chip--bad">${t.solvedRate}% ${i18n('solved')}</span> ${pointChips(t.points, false)}</div>`;
    if (t.errorLabels && t.errorLabels.length) {
      html += `<table class="qr-table"><tr><th>${esc(i18n('Error patterns'))}</th><th>≈ ${esc(i18n('Students'))}</th><th></th><th>${esc(i18n('Evidence'))}</th></tr>`;
      for (const l of t.errorLabels) html += `<tr><td><b>${esc(l.label)}</b></td><td>${l.estimated}</td><td><div class="qr-meter"><i style="width:${l.share}%"></i></div></td><td style="color:var(--pta-ink-soft)">${inlineText(l.note || '')}</td></tr>`;
      html += '</table>';
      if (t.mapCoverage) html += `<div style="font-size:12px;color:var(--pta-ink-soft);margin-top:4px">${esc(i18n('Estimated from'))} ${t.mapCoverage.sampled} ${esc(i18n('labelled excerpts covering every failure cluster of'))} ${t.mapCoverage.unsolved} ${esc(i18n('unsolved students'))} (${t.mapCoverage.calls} ${esc(i18n('calls'))})</div>`;
    }
    html += `<table class="qr-table" style="margin-top:8px"><tr><th>${esc(i18n('Unsolved students by last verdict'))}</th><th>${esc(i18n('Students'))}</th><th></th></tr>`;
    for (const c of t.clusters) html += `<tr><td>${esc(fullVerdict(c.verdict))}</td><td>${c.students}</td><td><div class="qr-meter"><i style="width:${c.share}%"></i></div></td></tr>`;
    html += '</table>';
    const ff = Object.entries(t.firstFail || {});
    if (ff.length) html += `<div style="font-size:13px;color:var(--pta-ink-soft);margin-top:6px">${esc(i18n('First-attempt verdicts'))}: ${ff.map(([k, v]) => `${esc(k)} ${v}`).join(', ')}</div>`;
  }
  if (diag) {
    const rt = reteachOf(diag);
    html += '<div class="qr-diag">';
    if (diag.headline) html += `<div style="font-weight:800;font-size:14px">${inlineText(diag.headline)}</div>`;
    html += `<div><div class="qr-diag__k">${esc(i18n('Misconception'))}</div><div>${richText(diag.misconception)}</div></div>`;
    html += `<div><div class="qr-diag__k">${esc(i18n('60-second re-teach'))}</div>`;
    if (rt.points.length) html += `<ul style="margin:0;padding-left:18px">${rt.points.map((pt) => `<li>${inlineText(pt)}</li>`).join('')}</ul>`;
    if (rt.text) html += `<div>${richText(rt.text)}</div>`;
    if (rt.code) html += `<pre>${esc(rt.code.text)}</pre>`;
    if (rt.takeaway) html += `<div style="margin-top:4px">💡 <b>${inlineText(rt.takeaway)}</b></div>`;
    html += '</div>';
    if (diag.check) {
      html += `<div><div class="qr-diag__k">${esc(i18n('Check question'))}</div><div>${richText(diag.check.prompt)}${diag.check.options && diag.check.options.length ? `<div style="margin-top:4px">${diag.check.options.map((o) => inlineText(o)).join('<br>')}</div>` : ''}</div>`;
      html += `<div style="margin-top:6px"><button type="button" class="qr-btn qr-btn--ghost qr-toggle">${esc(i18n('Reveal answer'))}</button> <span class="qr-reveal"><b>${esc(i18n('Answer'))}:</b> ${esc(diag.check.answer)}${diag.check.why ? ` — ${inlineText(diag.check.why)}` : ''}</span></div></div>`;
    }
    if (diag.points && diag.points.length) html += `<div style="font-size:12px;color:var(--pta-ink-soft)">${esc(i18n('Knowledge points'))}: ${diag.points.map((p) => `<span class="qr-chip qr-chip--violet">${esc(p)}</span>`).join(' ')}</div>`;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function pointsBlock(digest, opts = {}) {
  if (!digest.points || !digest.points.length) return '';
  let html = `<div class="qr__h">🧭 ${esc(i18n('Knowledge points'))} <span class="qr__count">${esc(i18n('weakest first'))}</span></div>`;
  for (const p of digest.points.slice(0, opts.limit || 12)) {
    const from = [...p.questions.map((q) => `${q.label} Q${q.key} (${q.accuracy}%)`), ...p.tasks.map((t) => `${t.label} (${t.solvedRate}%)`)].join(', ');
    html += `<div class="qr-point"><div><div class="qr-point__name">${esc(p.name)}</div>${p.path && p.path !== p.name ? `<div class="qr-point__path">${esc(p.path)}</div>` : ''}</div>`;
    html += `<div class="qr-meter" style="width:160px"><i class="${pctClass(p.mastery)}" style="width:${p.mastery}%"></i></div><span class="qr-chip ${p.mastery < 60 ? 'qr-chip--bad' : p.mastery < 80 ? 'qr-chip--gold' : 'qr-chip--ok'}">${p.mastery}% ${esc(i18n('mastery'))}</span>`;
    html += `<span class="qr-chip" title="${esc(i18n('Share of students below 60% on this point'))}">${p.studentsBelow}% ${esc(i18n('below 60%'))}</span>`;
    html += `<span class="qr-point__from">${esc(from)}</span></div>`;
  }
  return html;
}

function allQuestionsTable(digest, editable) {
  if (!digest.questions.length) return '';
  let html = `<div class="qr__h">📋 ${esc(i18n('All questions'))}</div><table class="qr-table"><tr><th>#</th><th>${esc(i18n('Question'))}</th><th>${esc(i18n('Correct'))}</th><th>${esc(i18n('Dominant wrong'))}</th><th>${esc(i18n('Knowledge points'))}</th></tr>`;
  for (const q of digest.questions) {
    html += `<tr><td><b>${esc(q.label)} Q${esc(q.key)}</b></td><td>${esc(q.prompt.slice(0, 120))}${q.prompt.length > 120 ? '…' : ''}</td>`;
    html += `<td><div style="display:flex;align-items:center;gap:8px"><div class="qr-meter"><i class="${pctClass(q.accuracy)}" style="width:${q.accuracy}%"></i></div><b>${q.accuracy}%</b></div></td>`;
    html += `<td>${q.dominantWrong ? `<b>${esc(q.dominantWrong.answer)}</b> · ${q.dominantWrong.share}%` : '—'}</td>`;
    html += `<td>${pointChips(q.points, editable, q)}${q.pointSource === 'inferred' ? ` <span class="qr-chip" title="${esc(i18n('Inferred by the AI from the catalog; click ✎ to fix'))}">AI</span>` : ''}</td></tr>`;
  }
  html += '</table>';
  if (digest.fine && digest.fine.length) html += `<div style="margin-top:10px;font-size:13px"><b>${esc(i18n('These are fine'))}:</b> ${digest.fine.map((f) => `<span class="qr-chip qr-chip--ok">${esc(f.label)} ${f.accuracy}%</span>`).join(' ')}</div>`;
  return html;
}

/* ------------------------------------------------------------------ */
/*  The generation theatre                                             */
/* ------------------------------------------------------------------ */

/** Stages of lib/quick_review.ts generateQuickReview, in order. */
const STAGES = [
  { id: 'collect', icon: '📥', label: 'Results' },
  { id: 'points', icon: '🏷️', label: 'Knowledge points' },
  { id: 'digest', icon: '📊', label: 'Statistics' },
  { id: 'map', icon: '🧩', label: 'Code patterns' },
  { id: 'diagnose', icon: '🤖', label: 'Diagnosis' },
  { id: 'evidence', icon: '🧭', label: 'Knowledge maps' },
];
/** What the feed says while a stage runs; {n} students, {q} questions, {p} programming tasks, {d}/{t} batches. */
const CAPTIONS = {
  collect: ['Loading every submission and answer sheet of {n} students', 'Reading final results after the end of the test'],
  points: ['Matching each question to the knowledge catalog', 'Inferring knowledge points where none are set'],
  digest: ['Counting every answer of {q} questions — accuracy, distractors, blanks', 'Clustering unsolved submissions of {p} programming tasks by failure signature', 'Ranking what to re-teach first'],
  map: ['Labelling code excerpts of every failure cluster ({d}/{t})', 'Extrapolating the labels over the whole class'],
  diagnose: ['Condensing the digest to fit the model\'s context', 'Asking the AI for misconceptions, re-teach bullets and check questions', 'Validating the reply as strict JSON'],
  evidence: ['Writing quiz evidence into each student\'s knowledge map', 'Scheduling the map rebuilds, one at a time'],
  done: ['Review ready'],
};
const theatre = { timer: null, startedAt: 0, stage: null, captionIdx: 0, lastCaptionAt: 0, feed: [], waitingKey: '' };

/** ai-speedup WP5: "waiting for capacity · 7 ahead · ~20 s" from the job's `waiting` block. */
function waitingText(w) {
  if (!w) return '';
  const secs = Math.max(1, Math.round((w.eta || 0) / 1000));
  return `${i18n('waiting for capacity')} · ${i18n('{0} ahead').replace('{0}', String(Math.max(0, w.ahead || 0)))} · ~${secs} s`;
}

function fmtClock(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
function fill(text, job, stats) {
  const q = stats && stats.problems ? stats.problems.reduce((a, p) => a + ((p.questions && p.questions.length) || 0), 0) : 0;
  const pTasks = stats && stats.problems ? stats.problems.filter((p) => p.kind === 'programming').length : 0;
  return text.replace('{n}', stats && stats.participants != null ? stats.participants : '?').replace('{q}', q || '?').replace('{p}', pTasks || '?')
    .replace('{d}', job && job.progress ? job.progress.done : 0).replace('{t}', job && job.progress ? job.progress.total : '?');
}

function flowSvg() {
  const node = (x, icon, label, id) => `<g class="fnode" data-node="${id}"><rect class="node" x="${x}" y="16" width="150" height="58" rx="12"></rect><text class="lbl" x="${x + 40}" y="41">${esc(label)}</text><text class="sub" x="${x + 40}" y="58" data-sub="${id}"></text><text x="${x + 12}" y="52" font-size="20">${icon}</text></g>`;
  const pipe = (x1, x2) => `<path class="pipe" d="M${x1} 45 C ${x1 + 40} 45, ${x2 - 40} 45, ${x2} 45"></path>`
    + [0, 1, 2].map((i) => `<circle class="dot ${['', 'b', 'c'][i]}" r="4"><animateMotion dur="2.4s" begin="${i * 0.8}s" repeatCount="indefinite" path="M${x1} 45 C ${x1 + 40} 45, ${x2 - 40} 45, ${x2} 45"></animateMotion></circle>`).join('');
  return `<svg class="qrt__flow" viewBox="0 0 760 92" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${pipe(160, 305)}${pipe(465, 610)}`
    + node(10, '👥', i18n('Students'), 'students') + node(305, '⬡', i18n('Failure clusters'), 'clusters') + node(610, '🤖', i18n('AI diagnosis'), 'ai') + '</svg>';
}

function theatreHtml() {
  const steps = STAGES.map((st, i) => `${i ? '<span class="qrt__link" data-link="' + st.id + '"></span>' : ''}<span class="qrt__step" data-stage="${st.id}"><em>${st.icon}</em>${esc(i18n(st.label))}</span>`).join('');
  return `<div class="qrt" id="qr-theatre">
    <div class="qrt__head"><div class="qrt__orb"><span>⚡</span></div><div class="qrt__title">${esc(i18n('Building the Quick Review'))}<small data-role="subtitle"></small></div><span class="qrt__clock" data-role="clock">00:00</span></div>
    <div class="qrt__steps">${steps}</div>
    ${flowSvg()}
    <div class="qrt__bar" data-role="bar"><i></i></div><div class="qrt__barlabel"><span data-role="barleft"></span><span data-role="barright"></span></div>
    <ul class="qrt__feed" data-role="feed"></ul>
  </div>`;
}

function stopTheatre() {
  if (theatre.timer) clearInterval(theatre.timer);
  theatre.timer = null;
  theatre.stage = null;
  theatre.feed = [];
}

function pushFeed($t, text) {
  const line = `${fmtClock(Date.now() - theatre.startedAt)} ${text}`;
  if (theatre.feed[theatre.feed.length - 1] === line) return;
  theatre.feed.push(line);
  theatre.feed = theatre.feed.slice(-4);
  $t.find('[data-role="feed"]').html(theatre.feed.map((l) => `<li><time>${esc(l.slice(0, 5))}</time><span>${esc(l.slice(6))}</span></li>`).join(''));
}

/** Update the theatre for the current job (called on every poll and every second). */
function updateTheatre($body, job, stats) {
  const $t = $body.find('#qr-theatre');
  if (!$t.length || !job) return;
  const stage = job.status === 'done' ? 'done' : job.stage;
  const idx = STAGES.findIndex((st) => st.id === stage);
  STAGES.forEach((st, i) => {
    const done = stage === 'done' || i < idx;
    $t.find(`[data-stage="${st.id}"]`).toggleClass('is-done', done).toggleClass('is-active', st.id === stage);
    $t.find(`[data-link="${st.id}"]`).toggleClass('is-done', done);
  });
  const active = stage === 'collect' || stage === 'points' || stage === 'digest' ? 'students' : stage === 'map' ? 'clusters' : 'ai';
  $t.find('.fnode .node').removeClass('is-active');
  $t.find(`.fnode[data-node="${active}"] .node`).addClass('is-active');
  if (stats) {
    $t.find('[data-sub="students"]').text(stats.participants != null ? `${stats.participants} ${i18n('participants')}` : '');
    const pTasks = (stats.problems || []).filter((p) => p.kind === 'programming').length;
    $t.find('[data-sub="clusters"]').text(pTasks ? `${pTasks} ${i18n('programming tasks')}` : i18n('objective only'));
  }
  $t.find('[data-sub="ai"]').text(stage === 'map' && job.progress && job.progress.total ? `${job.progress.done}/${job.progress.total} ${i18n('batches')}` : stage === 'diagnose' ? i18n('one condensed call') : '');
  // bar: determinate for the map stage, otherwise a moving band
  const $bar = $t.find('[data-role="bar"]');
  if (stage === 'map' && job.progress && job.progress.total) {
    $bar.removeClass('is-busy').find('i').css('width', `${Math.round((job.progress.done / job.progress.total) * 100)}%`);
    $t.find('[data-role="barleft"]').text(i18n('Labelling code excerpts'));
    $t.find('[data-role="barright"]').text(`${job.progress.done} / ${job.progress.total} ${i18n('batches')}`);
  } else if (stage === 'done') {
    $bar.removeClass('is-busy').find('i').css('width', '100%');
    $t.find('[data-role="barleft"]').text(i18n('Done'));
    $t.find('[data-role="barright"]').text('');
  } else {
    $bar.addClass('is-busy');
    $t.find('[data-role="barleft"]').text(`${i18n('Stage')} ${Math.max(1, idx + 1)} / ${STAGES.length}`);
    $t.find('[data-role="barright"]').text(i18n(`stage:${stage}`));
  }
  $t.find('[data-role="subtitle"]').text(i18n(`stage:${stage}`));
  // ai-speedup WP5: the scheduler had no free slot for the current call.
  const waiting = job.status === 'running' && job.waiting ? job.waiting : null;
  if (waiting) $t.find('[data-role="barright"]').text(waitingText(waiting));
  const waitingKey = waiting ? `${stage}:${waiting.ahead}` : '';
  if (waitingKey !== theatre.waitingKey) {
    theatre.waitingKey = waitingKey;
    if (waiting) pushFeed($t, `⏳ ${waitingText(waiting)}`);
  }
  $t.find('[data-role="clock"]').text(fmtClock(Date.now() - theatre.startedAt));
  // captions: a new line when the stage changes, then rotate every 3.5 s
  const now = Date.now();
  if (stage !== theatre.stage) {
    theatre.stage = stage;
    theatre.captionIdx = 0;
    theatre.lastCaptionAt = now;
    pushFeed($t, fill(i18n((CAPTIONS[stage] || [stage])[0]), job, stats));
  } else if (now - theatre.lastCaptionAt > 3500 && (CAPTIONS[stage] || []).length > 1) {
    theatre.captionIdx = (theatre.captionIdx + 1) % CAPTIONS[stage].length;
    theatre.lastCaptionAt = now;
    pushFeed($t, fill(i18n(CAPTIONS[stage][theatre.captionIdx]), job, stats));
  } else if (stage === 'map') {
    // keep the counter fresh on the current line
    const $last = $t.find('[data-role="feed"] li:last-child span');
    if ($last.length) $last.text(fill(i18n(CAPTIONS.map[theatre.captionIdx]), job, stats));
  }
  if (stage === 'done') {
    $t.addClass('qrt--done');
    stopTheatre();
  }
}

function startTheatre($body, job, stats) {
  stopTheatre();
  theatre.startedAt = job && job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
  if (Number.isNaN(theatre.startedAt)) theatre.startedAt = Date.now();
  theatre.stage = null;
  updateTheatre($body, job, stats);
  let last = job;
  theatre.timer = setInterval(() => updateTheatre($body, last, stats), 1000);
  return (next) => {
    last = next;
    updateTheatre($body, next, stats);
  };
}

function renderPanel($body, state) {
  const { quick, job, stale, kind, ended, studentFeedback, policy } = state;
  let html = '';
  if (!ended) html += `<div class="qr__note qr__note--info">${esc(i18n('The review is built from final results once the activity has ended for everyone.'))}</div>`;
  if (job && job.status === 'running') {
    html += theatreHtml();
  } else if (job && job.status === 'failed') {
    html += `<div class="qr__note">⚠ ${esc(job.error || i18n('The review could not be generated.'))}</div>`;
  }
  if (!quick) {
    if ((!job || job.status !== 'running') && ended) html += `<div class="qr__note qr__note--info">${esc(i18n('No review yet — click Generate.'))}</div>`;
    $body.html(html);
    if (job && job.status === 'running') state.updateJob = startTheatre($body, job, state.stats);
    return;
  }
  const { digest, diagnosis } = quick;
  if (stale) html += `<div class="qr__note">${esc(i18n('The scores changed since this review was built (a re-grade or a score adjustment) — it is being rebuilt.'))}</div>`;
  html += '<div class="qr__strip">';
  html += `<div class="qr__stat">${esc(i18n('Participants'))}: <b>${digest.participants}</b> · ${esc(i18n('answered'))} ${digest.answered}</div>`;
  html += `<div class="qr__stat">${esc(i18n('Mean'))} <b>${digest.scores.mean ?? '-'}</b> / ${digest.scores.full} · ${esc(i18n('median'))} ${digest.scores.median ?? '-'}</div>`;
  html += `<div class="qr__stat">${esc(i18n('Questions'))}: <b>${digest.questions.length}</b>${digest.tasks.length ? ` · ${esc(i18n('programming tasks'))}: <b>${digest.tasks.length}</b>` : ''}</div>`;
  html += `<div class="qr__stat" title="${esc(fmtTs(quick.generatedAt))}">${esc(i18n('Generated'))}: ${esc(fmtTs(quick.generatedAt))}</div>`;
  if (kind === 'contest') {
    html += `<div class="qr__stat">${esc(i18n('Student feedback'))}: ${studentFeedback ? `<span class="qr-chip qr-chip--ok">${esc(i18n('visible'))}</span>` : `<span class="qr-chip">${esc(i18n('hidden'))}</span>`}`;
    if (policy === 'on_teacher') html += ` <button type="button" class="qr-btn qr-btn--ghost qr-release" data-released="${quick.released ? '0' : '1'}">${esc(quick.released ? i18n('Hide from students') : i18n('Release to students'))}</button>`;
    html += '</div>';
    if (quick.prewarm && quick.prewarm.queued) html += `<div class="qr__stat" title="${esc(i18n('Explain reports generated in advance for the most-missed questions'))}">${esc(i18n('Pre-warmed explanations'))}: ${quick.prewarm.done}/${quick.prewarm.queued}</div>`;
  }
  html += '</div>';
  if (quick.diagnosisNote && quick.diagnosisNote !== 'homework') html += `<div class="qr__note qr__note--info">${esc(quick.diagnosisNote)}</div>`;
  if (diagnosis && diagnosis.items) {
    const incomplete = digest.items.filter((it) => {
      const d = diagnosis.items[it.id];
      if (!d) return true;
      const rt = reteachOf(d);
      return !d.misconception || (!rt.points.length && !rt.text);
    });
    if (incomplete.length) html += `<div class="qr__note">⚠ ${esc(i18n('The AI reply had no explanation or re-teach block for'))} ${incomplete.map((it) => esc(it.label)).join(', ')} — ${esc(i18n('click Generate to try again, or inspect the raw reply below.'))}</div>`;
  }
  if (quick.diagnosisRaw) html += `<details class="qr__raw"><summary>${esc(i18n('Raw AI reply'))}</summary><pre>${esc(quick.diagnosisRaw)}</pre></details>`;
  if (diagnosis && diagnosis.summary && diagnosis.summary.length) html += `<div class="qr__summary"><ul style="margin:0;padding-left:18px">${diagnosis.summary.map((s) => `<li>${inlineText(s)}</li>`).join('')}</ul></div>`;
  if (digest.items.length) {
    html += `<div class="qr__h">🎯 ${esc(i18n('Re-teach now'))} <span class="qr__count">${esc(i18n('priority order'))}</span></div>`;
    digest.items.forEach((it, i) => { html += itemCard(i + 1, it, { digest, diagnosis, kind }); });
  } else html += `<div class="qr__note qr__note--info">${esc(i18n('Nothing to re-teach: every question is above the fine threshold.'))}</div>`;
  html += pointsBlock(digest);
  html += allQuestionsTable(digest, kind === 'contest');
  $body.html(html);
  if (job && job.status === 'running') state.updateJob = startTheatre($body, job, state.stats);
}

/* ------------------------------------------------------------------ */
/*  Presentation mode                                                  */
/* ------------------------------------------------------------------ */

function buildSlides(state) {
  const { digest, diagnosis } = state.quick;
  const diagOf = (id) => (diagnosis && diagnosis.items ? diagnosis.items[id] : null);
  const slides = [{ kind: 'title' }];
  digest.items.forEach((it, i) => {
    const rank = i + 1;
    const diag = diagOf(it.id);
    slides.push({ kind: 'error', it, rank });
    if (!diag) return;
    if (diag.misconception) slides.push({ kind: 'why', it, rank, diag });
    const rt = reteachOf(diag);
    if (rt.points.length || rt.text) slides.push({ kind: 'reteach', it, rank, diag, rt });
    if (rt.code) slides.push({ kind: 'example', it, rank, diag, rt });
  });
  if (digest.points.length) slides.push({ kind: 'points' });
  const checks = digest.items.filter((it) => diagOf(it.id) && diagOf(it.id).check);
  checks.forEach((it, i) => slides.push({ kind: 'qa', it, index: i + 1, total: checks.length, check: diagOf(it.id).check }));
  const takeaways = digest.items.map((it) => ({ it, rt: diagOf(it.id) ? reteachOf(diagOf(it.id)) : null })).filter((x) => x.rt && x.rt.takeaway);
  if (takeaways.length) slides.push({ kind: 'end', takeaways });
  return slides;
}

/** The one-line statistic of an item: "50% solved" / "40% correct". */
function itemStat(it, digest) {
  if (it.type === 'question') {
    const q = digest.questions.find((x) => x.id === it.id);
    return q ? `${q.accuracy}% ${i18n('correct')}` : '';
  }
  const t = digest.tasks.find((x) => x.id === it.id);
  return t ? `${t.solvedRate}% ${i18n('solved')}` : '';
}
/** The slide title of an item: the AI headline, else a fact from the data. */
function itemHeadline(it, digest, diag) {
  if (diag && diag.headline) return inlineText(diag.headline);
  if (it.type === 'question') {
    const q = digest.questions.find((x) => x.id === it.id);
    return q && q.dominantWrong ? esc(`${q.dominantWrong.share}% ${i18n('of the wrong answers')}: ${q.dominantWrong.answer}`) : esc(i18n('Common error'));
  }
  const t = digest.tasks.find((x) => x.id === it.id);
  return t && t.clusters[0] ? esc(`${i18n('Most common')}: ${fullVerdict(t.clusters[0].verdict)}`) : esc(i18n('Common error'));
}

/** "O1 · Q3" / "P9 · Triangle Type Counter" — the item's short name for a slide header. */
function itemName(it, digest) {
  if (it.type === 'question') {
    const q = digest.questions.find((x) => x.id === it.id);
    return q ? `${q.label} · Q${q.key}` : it.label;
  }
  const t = digest.tasks.find((x) => x.id === it.id);
  return t ? `${t.label} · ${t.title}` : it.label;
}

function hintLine() {
  return `<div class="qrp__hint">${esc(i18n('R: reveal · ← →: move · +/−: text size · Esc: leave'))}</div>`;
}

function slideHtml(slide, state) {
  const { digest, diagnosis } = state.quick;
  if (slide.kind === 'title') {
    const diagOf = (id) => (diagnosis && diagnosis.items ? diagnosis.items[id] : null);
    let html = `<div class="qrp__kicker">${esc(i18n('Quiz review'))}</div><div class="qrp__title">${esc(state.title || i18n('How did we do?'))}</div>`;
    html += `<div class="qrp__facts">${digest.participants} ${esc(i18n('students'))} · ${esc(i18n('mean'))} <b>${digest.scores.mean ?? '-'}</b> / ${digest.scores.full}</div>`;
    if (digest.items.length) {
      html += `<div class="qrp__section"><div class="qrp__k">${esc(i18n('Today'))}</div><div class="qrp__agenda">`;
      digest.items.forEach((it, i) => {
        html += `<span class="rank">${i + 1}</span><span class="name">${esc(itemName(it, digest))}</span><span class="stat">${esc(itemStat(it, digest))}</span><span class="head">${itemHeadline(it, digest, diagOf(it.id))}</span>`;
      });
      html += '</div></div>';
    } else html += `<div class="qrp__section qrp__big">${esc(i18n('Nothing to re-teach: every question is above the fine threshold.'))}</div>`;
    html += '<div class="qrp__aside">';
    if (digest.fine && digest.fine.length) html += `<div><div class="qrp__k">${esc(i18n('Fine'))}</div><div class="qrp__facts">${digest.fine.map((f) => esc(f.label)).join(' · ')}</div></div>`;
    if (digest.points && digest.points.length) html += `<div><div class="qrp__k">${esc(i18n('Weakest knowledge point'))}</div><div class="qrp__facts">${esc(digest.points[0].name)} · ${digest.points[0].mastery}% ${esc(i18n('mastery'))}</div></div>`;
    html += '</div>';
    return html + hintLine();
  }
  if (slide.kind === 'error') {
    const { it, rank } = slide;
    const diag = diagnosis && diagnosis.items ? diagnosis.items[it.id] : null;
    let html = `<div class="qrp__kicker">${esc(i18n('Common error'))} ${rank} / ${digest.items.length} · ${esc(itemName(it, digest))}</div>`;
    html += `<div class="qrp__title">${itemHeadline(it, digest, diag)}<span class="qrp__sub">${esc(itemStat(it, digest))}</span></div>`;
    if (it.type === 'question') {
      const q = digest.questions.find((x) => x.id === it.id);
      html += `<div class="qrp__prompt">${esc(q.prompt)}</div>`;
      html += bars(q, true);
      const facts = [];
      if (q.dominantWrong) facts.push(`<b>${q.dominantWrong.share}%</b> ${esc(i18n('of the wrong answers'))}: <b>${esc(q.dominantWrong.answer)}</b>`);
      if (q.kind === 'multiselect' && q.missed && q.missed.length) facts.push(`${esc(i18n('Most often left out'))}: <b>${esc(q.missed[0].letter)}</b> (${q.missed[0].rate}%)`);
      if (q.blankRate) facts.push(`${q.blankRate}% ${esc(i18n('left it blank'))}`);
      if (facts.length) html += `<div class="qrp__section qrp__facts">${facts.join(' · ')}</div>`;
      html += `<div class="qrp__section qrp__hidden"><div class="qrp__k">${esc(i18n('Key'))}</div><div class="qrp__big">${esc(q.answer.join(' / '))}</div></div>`;
    } else {
      const t = digest.tasks.find((x) => x.id === it.id);
      if (t.errorLabels && t.errorLabels.length) {
        // the map pass: every unsolved submission clustered, samples labelled, extrapolated
        const top = t.errorLabels.slice(0, 5);
        const max = Math.max(...top.map((l) => l.estimated), 1);
        html += `<div class="qrp__k" style="margin-top:.4em">${esc(i18n('What went wrong'))} · ≈ ${esc(i18n('students'))}</div>`;
        html += `<div class="qrp__bars">${top.map((l) => `<span class="letter">${l.estimated}</span><div class="track"><div class="fill" style="width:${Math.round((l.estimated / max) * 100)}%"></div><span class="txt">${esc(l.label)}</span></div><span class="pct">${l.share}%</span>`).join('')}</div>`;
        html += `<div class="qrp__section qrp__facts">${t.clusters.map((c) => `${esc(fullVerdict(c.verdict))} ${c.students}`).join(' · ')}${t.mapCoverage ? ` · ${esc(i18n('of'))} ${t.mapCoverage.unsolved} ${esc(i18n('unsolved students'))}` : ''}</div>`;
      } else {
        html += `<div class="qrp__k" style="margin-top:.4em">${esc(i18n('Unsolved students by last verdict'))}</div>`;
        html += `<div class="qrp__bars">${t.clusters.map((c) => `<span class="letter">${c.students}</span><div class="track"><div class="fill" style="width:${c.share}%"></div><span class="txt">${esc(fullVerdict(c.verdict))}</span></div><span class="pct">${c.share}%</span>`).join('')}</div>`;
      }
    }
    return html + hintLine();
  }
  if (slide.kind === 'why') {
    const { it, rank, diag } = slide;
    const q = it.type === 'question' ? digest.questions.find((x) => x.id === it.id) : null;
    let html = `<div class="qrp__kicker">${esc(i18n('Why'))} · ${esc(itemName(it, digest))}</div>`;
    if (diag.headline) html += `<div class="qrp__title">${inlineText(diag.headline)}</div>`;
    if (q && q.dominantWrong) html += `<div class="qrp__facts" style="margin-bottom:.6em">${q.dominantWrong.share}% ${esc(i18n('of the wrong answers'))}: <b>${esc(q.dominantWrong.answer)}</b> · ${esc(i18n('key'))}: <b>${esc(q.answer.join(' / '))}</b></div>`;
    html += `<div class="qrp__why">${richText(diag.misconception)}</div>`;
    if (diag.points && diag.points.length) html += `<div class="qrp__section qrp__facts">${esc(i18n('Knowledge points'))}: ${diag.points.map((p) => esc(p)).join(' · ')}</div>`;
    void rank;
    return html + hintLine();
  }
  if (slide.kind === 'reteach') {
    const { it, rt } = slide;
    let html = `<div class="qrp__kicker">${esc(i18n('Re-teach'))} · ${esc(itemName(it, digest))}</div>`;
    if (rt.points.length) html += `<ul class="qrp__bullets">${rt.points.map((pt) => `<li>${inlineText(pt)}</li>`).join('')}</ul>`;
    if (rt.text) html += `<div class="qrp__p">${richText(rt.text)}</div>`;
    if (rt.takeaway && !rt.code) html += `<div class="qrp__takeaway">💡 ${inlineText(rt.takeaway)}</div>`;
    return html + hintLine();
  }
  if (slide.kind === 'example') {
    const { it, rt } = slide;
    let html = `<div class="qrp__kicker">${esc(i18n('Example'))} · ${esc(itemName(it, digest))}${rt.code.lang ? ` · ${esc(rt.code.lang)}` : ''}</div>`;
    html += `<pre class="qrp__code">${esc(rt.code.text)}</pre>`;
    if (rt.takeaway) html += `<div class="qrp__takeaway">💡 ${inlineText(rt.takeaway)}</div>`;
    return html + hintLine();
  }
  if (slide.kind === 'points') {
    let html = `<div class="qrp__kicker">${esc(i18n('Knowledge points'))}</div><div class="qrp__title">${esc(i18n('Where the class stands'))}</div><div class="qrp__points">`;
    for (const p of digest.points.slice(0, 6)) html += `<div class="qrp__point"><div>${esc(p.name)}</div><div class="track"><div class="fill ${pctClass(p.mastery)}" style="width:${p.mastery}%"></div></div><div style="font-weight:800;text-align:right">${p.mastery}%</div></div>`;
    html += '</div>';
    return html + hintLine();
  }
  if (slide.kind === 'qa') {
    const { check, index, total, it } = slide;
    let html = `<div class="qrp__kicker">${esc(i18n('Quick check'))} ${index} / ${total} · ${esc(itemName(it, digest))}</div>`;
    html += `<div class="qrp__prompt">${richText(check.prompt)}</div>`;
    if (check.options && check.options.length) html += `<ul class="qrp__options">${check.options.map((o) => `<li>${inlineText(o)}</li>`).join('')}</ul>`;
    html += `<div class="qrp__section qrp__hidden"><div class="qrp__k">${esc(i18n('Answer'))}</div><div class="qrp__big qrp__answer">${esc(check.answer)}</div>${check.why ? `<div class="qrp__p" style="margin-top:.3em">${richText(check.why)}</div>` : ''}</div>`;
    return html + hintLine();
  }
  if (slide.kind === 'end') {
    let html = `<div class="qrp__kicker">${esc(i18n('Remember'))}</div><div class="qrp__title">${esc(i18n('Take-aways'))}</div>`;
    html += `<ul class="qrp__bullets">${slide.takeaways.map((x) => `<li>${inlineText(x.rt.takeaway)}</li>`).join('')}</ul>`;
    return html + hintLine();
  }
  return '';
}

function injectStyle() {
  if (!document.getElementById('qr-style')) $('<style>').attr('id', 'qr-style').text(STYLE).appendTo(document.head);
}

/** Text-size multiplier of the deck, kept for the session (A−/A+, +/− keys). */
let presentZoom = 1;

function openPresentation(state) {
  const slides = buildSlides(state);
  let idx = 0;
  const $p = $('<div class="qrp"></div>').appendTo(document.body);
  const $bar = $('<div class="qrp__bar"></div>').appendTo($p);
  const $prev = $(`<button type="button" class="qr-btn">← ${esc(i18n('Previous'))}</button>`).appendTo($bar);
  const $dots = $('<div class="qrp__dots"></div>').appendTo($bar);
  const $reveal = $(`<button type="button" class="qr-btn">${esc(i18n('Reveal'))} (R)</button>`).appendTo($bar);
  const $smaller = $('<button type="button" class="qr-btn" title="−">A−</button>').appendTo($bar);
  const $bigger = $('<button type="button" class="qr-btn" title="+">A+</button>').appendTo($bar);
  const $next = $(`<button type="button" class="qr-btn">${esc(i18n('Next'))} →</button>`).appendTo($bar);
  const $exit = $(`<button type="button" class="qr-btn">✕ ${esc(i18n('Exit'))}</button>`).appendTo($bar);
  const $slide = $('<div class="qrp__slide"></div>').appendTo($p);
  // Text size: the deck's root size scales with the viewport; A−/A+ (and
  // the +/− keys) multiply it, remembered for the rest of the session.
  const applyZoom = () => $p.css('--qrp-zoom', String(presentZoom));
  const zoom = (delta) => {
    presentZoom = Math.round(Math.min(2.2, Math.max(0.6, presentZoom + delta)) * 10) / 10;
    applyZoom();
  };
  applyZoom();
  const draw = () => {
    $p.removeClass('is-revealed');
    $slide.html(slideHtml(slides[idx], state)).scrollTop(0);
    $dots.html(slides.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join(''));
    $prev.prop('disabled', idx === 0);
    $next.prop('disabled', idx === slides.length - 1);
  };
  const close = () => {
    $(document).off('keydown.qrp');
    $p.remove();
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  };
  const go = (delta) => {
    const next = idx + delta;
    if (next < 0 || next >= slides.length) return;
    idx = next;
    draw();
  };
  $prev.on('click', () => go(-1));
  $next.on('click', () => go(1));
  $reveal.on('click', () => $p.toggleClass('is-revealed'));
  $smaller.on('click', () => zoom(-0.1));
  $bigger.on('click', () => zoom(0.1));
  $exit.on('click', close);
  $(document).on('keydown.qrp', (e) => {
    const actions = {
      ArrowRight: () => go(1), PageDown: () => go(1), ' ': () => go(1), ArrowLeft: () => go(-1), PageUp: () => go(-1), r: () => $p.toggleClass('is-revealed'), R: () => $p.toggleClass('is-revealed'), Escape: close,
      '+': () => zoom(0.1), '=': () => zoom(0.1), '-': () => zoom(-0.1), _: () => zoom(-0.1),
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  });
  if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  draw();
}

/* ------------------------------------------------------------------ */
/*  The modal                                                          */
/* ------------------------------------------------------------------ */

let $mask = null;
let pollTimer = null;

function closeModal() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  stopTheatre();
  if ($mask) $mask.remove();
  $mask = null;
}

async function load($body, $tools) {
  const state = await request.get(quickUrl(), { quick: 1 });
  renderPanel($body, state);
  const canPresent = !!(state.quick && state.kind === 'contest');
  $tools.find('.qr-present').prop('disabled', !canPresent).off('click').on('click', () => openPresentation(state));
  $tools.find('.qr-regen').prop('disabled', !state.ended || (state.job && state.job.status === 'running'));
  if (state.job && state.job.status === 'running') {
    const poll = async () => {
      try {
        const probe = await request.get(quickUrl(), { quick: 1, job: 1 });
        if (probe.job && probe.job.status === 'running') {
          if (state.updateJob) state.updateJob(probe.job);
          pollTimer = setTimeout(poll, 2000);
        } else {
          // let the theatre settle on "done" for a beat, then show the review
          if (state.updateJob) state.updateJob({ ...(probe.job || {}), status: 'done', stage: 'done' });
          Notification.success(i18n('Quick Review ready.'));
          pollTimer = setTimeout(() => load($body, $tools), 900);
        }
      } catch (e) {
        pollTimer = setTimeout(poll, 4000);
      }
    };
    pollTimer = setTimeout(poll, 2000);
  }
  return state;
}

function openModal() {
  if ($mask) return;
  $mask = $('<div class="qr-mask"></div>').appendTo(document.body);
  const $m = $('<div class="qr" role="dialog"></div>').appendTo($mask);
  const $head = $('<div class="qr__head"></div>').appendTo($m);
  $(`<h2 class="qr__title">⚡ ${esc(i18n('Quick Review'))}<small>${esc(i18n('What to re-teach now, from the final results'))}</small></h2>`).appendTo($head);
  const $tools = $('<div style="display:flex;gap:8px;flex-wrap:wrap"></div>').appendTo($head);
  $(`<button type="button" class="qr-btn qr-btn--primary qr-present" disabled>▶ ${esc(i18n('Present'))}</button>`).appendTo($tools);
  const $regen = $(`<button type="button" class="qr-btn qr-regen" disabled>↻ ${esc(i18n('Generate'))}</button>`).appendTo($tools);
  $(`<button type="button" class="qr-btn qr-btn--ghost qr-full">📊 ${esc(i18n('Full report'))}</button>`).appendTo($tools).on('click', () => {
    closeModal();
    $('#acr-open').trigger('click');
  });
  $(`<button type="button" class="qr-btn qr-btn--ghost">✕</button>`).appendTo($tools).on('click', closeModal);
  const $body = $('<div class="qr__body"></div>').appendTo($m);
  $body.html(`<div class="qr-progress"><span class="qr-spin"></span><span>${esc(i18n('Loading'))}…</span></div>`);
  $mask.on('click', (e) => { if (e.target === $mask[0]) closeModal(); });

  $regen.on('click', async () => {
    $regen.prop('disabled', true);
    try {
      await request.post(quickUrl(), { operation: 'quick' });
      await load($body, $tools);
    } catch (e) {
      Notification.error(e.message || i18n('Could not start the review.'));
      $regen.prop('disabled', false);
    }
  });
  $body.on('click', '.qr-toggle', function () { $(this).closest('.qr-item').toggleClass('is-open'); });
  $body.on('click', '.qr-release', async function () {
    const released = $(this).data('released') === 1 || $(this).data('released') === '1';
    try {
      await request.post(quickUrl(), { operation: 'release', released });
      Notification.success(released ? i18n('Feedback released to students.') : i18n('Feedback hidden from students.'));
      await load($body, $tools);
    } catch (e) { Notification.error(e.message); }
  });
  $body.on('click', '.qr-fix-open', function () {
    const $b = $(this);
    if ($b.next('.qr-fix').length) return;
    const $box = $(`<span class="qr-fix"><input type="text" value="${esc($b.data('points'))}" placeholder="${esc(i18n('Knowledge points, comma-separated'))}"><button type="button" class="qr-btn qr-btn--primary qr-fix-save">${esc(i18n('Save'))}</button></span>`);
    $b.after($box);
    $box.find('input').trigger('focus');
    $box.find('.qr-fix-save').on('click', async () => {
      const points = $box.find('input').val().split(/[,;]/).map((s) => s.trim()).filter((s) => s);
      try {
        await request.post(quickUrl(), { operation: 'fix_point', pid: $b.data('pid'), key: String($b.data('key')), points: JSON.stringify(points) });
        Notification.success(i18n('Knowledge points saved — the review is being rebuilt.'));
        await load($body, $tools);
      } catch (e) { Notification.error(e.message); }
    });
  });
  load($body, $tools).catch((e) => {
    $body.html(`<div class="qr__note">⚠ ${esc(e.message || i18n('Could not load the review.'))}</div>`);
  });
}

function injectButton(kind) {
  injectStyle();
  const label = kind === 'contest' ? i18n('Quick Review') : i18n('Question analysis');
  const $btn = $(`<button type="button" class="acr-btn qr-btn qr-btn--primary" id="qr-open" style="margin-right:8px">⚡ ${esc(label)}</button>`).on('click', openModal);
  const $tools = $('.section__tools').first();
  if ($tools.length) $tools.prepend($btn);
  else $btn.css({ position: 'fixed', right: '24px', bottom: '140px', zIndex: 890 }).appendTo(document.body);
}

/**
 * Students: the "📽 Class review" button of the weak-points card
 * (contest_detail.html, only when the feedback policy shows it) opens the
 * same deck the teacher projects, from the deck endpoint.
 */
function bindStudentDeck() {
  const $btn = $('#qr-deck-open');
  if (!$btn.length) return;
  injectStyle();
  $btn.on('click', async () => {
    $btn.prop('disabled', true);
    try {
      const state = await request.get($btn.data('url'), { deck: 1 });
      if (!state.quick) {
        Notification.info(i18n('The class review is not ready yet — try again in a minute.'));
        return;
      }
      openPresentation(state);
    } catch (e) {
      Notification.error(e.message || i18n('Could not load the review.'));
    } finally {
      $btn.prop('disabled', false);
    }
  });
}

export default new NamedPage(['contest_detail', 'homework_detail'], (pageName) => {
  const uc = window.UiContext || {};
  const me = (window.UserContext || {})._id;
  const tdoc = uc.tdoc;
  const isOwner = !!(tdoc && me != null && tdoc.owner === me);
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
  if (!uc.isDomainRoot && !isOwner) {
    bindStudentDeck(); // students: only the deck, and only when the page offers it
    return;
  }
  injectButton(pageName === 'contest_detail' ? 'contest' : 'homework');
});
