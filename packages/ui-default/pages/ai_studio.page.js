import $ from 'jquery';
import KnowledgePointSelectAutoComplete from 'vj/components/autocomplete/KnowledgePointSelectAutoComplete';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getAvailableLangs, getTheme, i18n, request } from 'vj/utils';

/**
 * AI Studio — list page. Teachers describe a programming task (topic +
 * pasted slide text) and the backend drafts + judge-verifies it. This
 * module renders the draft list and the "new draft" form, and also drops a
 * small entry banner on the problem-create page (which is already
 * teacher-gated, so the banner never shows to students).
 */

const esc = (t) => $('<i>').text(String(t ?? '')).html();
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');

/* ==================================================================
 * AI Studio — visual system
 *
 * Direction: an instrument panel, not a marketing page. What the teacher
 * is authoring — the statement, the questions, the code — is the hero;
 * the chrome around it recedes.
 *
 * Signature: the KIND SPINE. Each workbench carries a 3px rule down its
 * left edge whose colour encodes the task kind, and that same accent
 * drives the tab underline, the question numerals and the pid chip.
 * It replaces three competing full-width gradient headers with one quiet
 * structural signal, so all three kinds share a calm identical layout and
 * differ by exactly one thing.
 *
 * The accents are semantic, not decorative: indigo for code and logic,
 * teal for right/wrong, amber for the one kind a human marks by hand.
 * ================================================================== */
export const AIS_POLISH = [
  ':root { --ais-prog: #4c6ef5; --ais-obj: #0ca678; --ais-subj: #e8590c; --ais-accent: var(--ais-prog); --ais-accent-soft: rgba(76,110,245,.10); }',
  '.aisd--obj { --ais-accent: var(--ais-obj); --ais-accent-soft: rgba(12,166,120,.10); }',
  '.aisd--subj { --ais-accent: var(--ais-subj); --ais-accent-soft: rgba(232,89,12,.10); }',

  /* ---- the card ---- */
  // overflow:clip rounds the corners WITHOUT creating a scroll container —
  // the inherited overflow:hidden would silently kill the sticky toolbar.
  '.ais { border: 1px solid var(--pta-line); border-left: 3px solid var(--ais-accent); border-radius: var(--pta-radius-lg); background: var(--pta-card); box-shadow: var(--pta-shadow); margin: 0 0 16px; overflow: clip; }',
  '.ais__head, .ais__head--obj, .ais__head--subj { background: var(--pta-card-2); color: var(--pta-ink); border-bottom: 1px solid var(--pta-line-soft); padding: 13px 18px; gap: 9px; }',
  '.ais__title { font-size: 15px; font-weight: 650; letter-spacing: -.01em; color: var(--pta-ink); }',
  '.ais__hint { color: var(--pta-ink-soft); opacity: 1; font-size: 12px; max-width: 46ch; line-height: 1.45; }',
  '.ais__body { padding: 16px 18px 20px; }',

  /* ---- type: labels label, they do not shout ---- */
  '.ais__label { font-size: 12.5px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--pta-ink); margin: 16px 0 6px; }',
  '.aisd__meta { font-size: 12px; color: var(--pta-ink-soft); line-height: 1.5; }',
  '.ais__empty { color: var(--pta-ink-faint); padding: 18px 2px; font-size: 13px; line-height: 1.6; }',

  /* ---- controls: quiet, square-ish, accent-driven ---- */
  '.ais__btn { border-radius: 9px; padding: 7px 16px; font-size: 12.5px; font-weight: 600; background: var(--ais-accent); box-shadow: none; border: 1px solid transparent; transition: filter .12s ease, transform .12s var(--pta-ease); }',
  '.ais__btn:hover:not(:disabled) { filter: brightness(1.07); transform: none; }',
  '.ais__btn:active:not(:disabled) { transform: translateY(1px); }',
  '.ais__btn--ghost { background: var(--pta-card); color: var(--ais-accent); border-color: var(--pta-line); }',
  '.ais__btn--ghost:hover:not(:disabled) { background: var(--ais-accent-soft); border-color: var(--ais-accent); filter: none; }',
  '.ais__btn--danger { background: var(--pta-card); color: var(--pta-crimson-text); border-color: var(--pta-crimson-line); }',
  '.ais__btn--danger:hover:not(:disabled) { background: var(--pta-crimson-soft); filter: none; }',
  '.ais__btn--sm { padding: 4px 12px; font-size: 12px; }',
  '.ais__btn:disabled { opacity: .45; }',
  '.ais :is(button, a, input, select, textarea, summary):focus-visible { outline: 2px solid var(--ais-accent); outline-offset: 2px; border-radius: 6px; }',
  '.ais :is(textarea, input[type=text], select) { border-color: var(--pta-line); border-radius: 8px; background: var(--pta-card); color: var(--pta-ink); transition: border-color .12s ease, box-shadow .12s ease; }',
  '.ais :is(textarea, input[type=text], select):focus { border-color: var(--ais-accent); box-shadow: 0 0 0 3px var(--ais-accent-soft); outline: none; }',

  /* ---- the action bar stays reachable in a long document ---- */
  // 45px matches the fixed site nav, the same offset pta_theme already uses
  // for sticky table headers on record_main.
  '.aisd__bar { position: sticky; top: 45px; z-index: 5; padding: 10px 0; margin: 0 0 4px; background: linear-gradient(var(--pta-card) 78%, transparent); backdrop-filter: saturate(140%) blur(2px); }',
  '.aisd__pane .aisd__bar { position: static; background: none; backdrop-filter: none; padding: 0; }',
  '.aisd__toolhint { color: var(--pta-ink-soft); border-left: 2px solid var(--ais-accent); padding-left: 9px; margin: 2px 0 10px; }',

  /* ---- tabs: the accent underlines the active one ---- */
  '.aisd__tabs { border-bottom: 1px solid var(--pta-line-soft); padding: 0 18px; gap: 2px; }',
  '.aisd__tab { border: none; background: none; border-radius: 8px 8px 0 0; padding: 10px 13px; font-size: 12.5px; font-weight: 550; color: var(--pta-ink-soft); box-shadow: none; }',
  '.aisd__tab:hover { color: var(--pta-ink); background: var(--pta-card-2); }',
  '.aisd--prog .aisd__tab--on, .aisd--obj .aisd__tab--on, .aisd--subj .aisd__tab--on, .aisd__tab--on { color: var(--ais-accent); background: none; box-shadow: inset 0 -2px 0 var(--ais-accent); }',

  /* ---- banner: one calm line, no animated border ---- */
  '.ais__banner { animation: ptaFadeUp .24s var(--pta-ease) backwards; background: var(--pta-card); border: 1px solid var(--pta-line); box-shadow: none; padding: 11px 15px; font-size: 13px; }',
  '.ais__banner a { color: var(--ais-accent); text-decoration: none; font-weight: 600; }',
  '.ais__banner a:hover { text-decoration: underline; }',
  '.ais__chip { background: var(--pta-card-2); color: var(--pta-ink-soft); border: 1px solid var(--pta-line-soft); border-radius: 8px; padding: 3px 9px; }',
  '.aisd__pidchip { background: var(--ais-accent-soft); color: var(--ais-accent); border-color: transparent; }',
  '.aisd__hidebox { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--pta-ink-soft); cursor: pointer; user-select: none; padding: 4px 2px; }',
  '.aisd__hidebox input { accent-color: var(--ais-accent); margin: 0; }',
  '.aisd__vischip { font-weight: 600; }',

  /* ---- kind cards on the create form ---- */
  '.ais__kind-body { border-radius: 10px; border-width: 1px; padding: 13px 14px; }',
  '.ais__kind:nth-child(1) { --ais-accent: var(--ais-prog); --ais-accent-soft: rgba(76,110,245,.10); }',
  '.ais__kind:nth-child(2) { --ais-accent: var(--ais-obj); --ais-accent-soft: rgba(12,166,120,.10); }',
  '.ais__kind:nth-child(3) { --ais-accent: var(--ais-subj); --ais-accent-soft: rgba(232,89,12,.10); }',
  '.ais__kind:hover .ais__kind-body { border-color: var(--ais-accent); box-shadow: none; transform: none; }',
  '.ais__kind input:checked + .ais__kind-body { border-color: var(--ais-accent); background: var(--ais-accent-soft); box-shadow: inset 3px 0 0 var(--ais-accent); }',
  '.ais__kind-name { font-weight: 650; font-size: 13.5px; }',
  '.ais__kindchip--p { background: var(--ais-prog); }',
  '.ais__kindchip--o { background: var(--ais-obj); }',
  '.ais__kindchip--s { background: var(--ais-subj); }',

  /* ---- question cards inherit the objective accent ---- */
  '.aisq__card { border-left: 2px solid var(--pta-line); transition: border-color .12s ease; }',
  '.aisq__card:hover { border-left-color: var(--ais-accent); border-color: var(--pta-line); }',
  '.aisq__num { background: var(--ais-accent); }',
  '.aisq__setup { border-color: var(--pta-line); border-left: 3px solid var(--ais-accent); }',
  '.aisq__type-chip--on { border-color: var(--ais-accent); background: var(--ais-accent-soft); color: var(--ais-accent); }',
  '.aisq__src { border-color: var(--pta-line); border-style: solid; background: var(--pta-card-2); }',

  /* ---- chat reads as a conversation, not a control panel ---- */
  '.aisc { border-color: var(--pta-line); background: var(--pta-card-2); }',
  '.aisc__head { background: none; border-bottom: 1px solid var(--pta-line-soft); color: var(--pta-ink); }',
  '.aisc__turn--user { background: var(--ais-accent); }',
  '.aisc__turn--ai { background: var(--pta-card); }',

  /* ---- sidebar ---- */
  '.aisd__side .ais { border-left-width: 3px; }',

  /* ---- quality floor ---- */
  '@media (prefers-reduced-motion: reduce) { .ais, .ais *, .aisd, .aisd * { animation: none !important; transition: none !important; } }',
  '@media (max-width: 900px) { .aisd { grid-template-columns: 1fr; } .aisd__tabs { overflow-x: auto; } .ais__hint { display: none; } }',
];

export const AIS_STYLE = [
  '.ais { border: 1px solid #e9e2f9; border-radius: 14px; margin: 16px 0; background: #fff; overflow: hidden; box-shadow: 0 8px 28px rgba(95,61,196,.08); }',
  '.ais__head { display: flex; align-items: center; gap: 10px; padding: 12px 18px; background: linear-gradient(100deg, #7048e8 0%, #845ef7 55%, #b197fc 100%); color: #fff; }',
  '.ais__title { font-weight: bold; font-size: 14.5px; }',
  '.ais__hint { margin-left: auto; font-size: 11.5px; opacity: .92; text-align: right; }',
  '.ais__body { padding: 16px 18px 18px; font-size: 13px; }',
  '.ais__label { font-size: 11.5px; font-weight: bold; letter-spacing: .08em; text-transform: uppercase; color: #8a80b3; margin: 14px 0 6px; }',
  '.ais__label:first-child { margin-top: 0; }',
  '.ais__btn { border: none; border-radius: 18px; padding: 8px 22px; font-size: 13px; color: #fff; cursor: pointer; background: linear-gradient(90deg, #7048e8, #9775fa); box-shadow: 0 3px 12px rgba(112,72,232,.35); transition: filter .12s, transform .12s; }',
  '.ais__btn:hover { filter: brightness(1.08); transform: translateY(-1px); }',
  '.ais__btn:disabled { opacity: .55; cursor: default; transform: none; }',
  '.ais__btn--ghost { background: #fff; color: #7048e8; border: 1px solid #c7b8f5; box-shadow: none; }',
  '.ais__btn--ghost:hover { background: #f6f2ff; filter: none; }',
  '.ais__btn--sm { padding: 4px 14px; font-size: 12px; }',
  '.ais__btn--danger { background: #fff; color: #c2255c; border: 1px solid #f3c1d3; box-shadow: none; }',
  '.ais__btn--danger:hover { background: #fff0f4; filter: none; }',
  '.ais textarea, .ais input[type=text], .ais select { width: 100%; border: 1px solid #d5dbe7; border-radius: 10px; padding: 8px 10px; font-size: 13px; box-sizing: border-box; background: #fff; }',
  '.ais textarea { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px; line-height: 1.5; resize: vertical; }',
  '.ais__row { display: flex; gap: 14px; flex-wrap: wrap; }',
  '.ais__row > div { flex: 1 1 180px; }',
  '.ais__chip { display: inline-block; border-radius: 10px; padding: 2px 10px; font-size: 11.5px; background: #f1ecff; color: #7048e8; }',
  '.ais__kp { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; font-size: 11px; color: var(--pta-ink-faint); }',
  '.ais__kp-tag { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; background: #f1ecff; color: #7048e8; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.ais__kp-more { font-size: 11px; color: var(--pta-ink-faint); }',
  '.pta-dark .ais__kp-tag { background: #322a48; color: #cdbdfb; }',
  '.ais__badge { display: inline-block; border-radius: 10px; padding: 2px 10px; font-size: 11.5px; font-weight: bold; }',
  '.ais__badge--idle { background: #f1f3f5; color: #666; }',
  '.ais__badge--running { background: #e7f5ff; color: #1c7ed6; animation: ais-breathe 2.4s ease-in-out infinite; }',
  '.ais__badge--passed { background: #ebfbee; color: #2b8a3e; }',
  '.ais__badge--failed { background: #fff0f4; color: #c2255c; }',
  '.ais__badge--published { background: #f3f0ff; color: #7048e8; }',
  '.ais__table { width: 100%; border-collapse: separate; border-spacing: 0; }',
  '.ais__table th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: #8a80b3; padding: 8px 10px; border-bottom: 1px solid #ece7f8; background: #faf9ff; }',
  '.ais__table td { padding: 9px 10px; border-bottom: 1px solid #f1eefb; font-size: 12.5px; }',
  '.ais__table tr:hover td { background: #faf8ff; }',
  '.ais__th { cursor: pointer; user-select: none; white-space: nowrap; }',
  '.ais__th:hover { color: #5f3dc4; }',
  '.ais__th--on { color: #5f3dc4; }',
  '.ais__th-dir { font-size: 10px; opacity: .6; margin-left: 2px; }',
  '.ais__th--on .ais__th-dir { opacity: 1; }',
  '.ais__lf-head { display: flex; align-items: baseline; gap: 8px; }',
  '.ais__lf-count { font-size: 11.5px; font-weight: normal; color: #8a80b3; }',
  '.ais__lf { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 12px; padding: 10px 12px; border-radius: 12px; background: #faf9ff; border: 1px solid #ece7f8; }',
  '.ais__lf-row { display: flex; flex-wrap: wrap; gap: 8px 22px; align-items: flex-end; }',
  '.ais__lf-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }',
  '.ais__lf-label { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #8a80b3; }',
  '.ais__lf-qwrap { display: inline-flex; align-items: center; gap: 6px; height: 30px; box-sizing: border-box; padding: 0 10px; border-radius: 999px; border: 1px solid #ddd6f3; background: #fff; color: #8a80b3; font-size: 12px; }',
  '.ais__lf-qwrap:focus-within { border-color: #7048e8; box-shadow: 0 0 0 3px #efe9ff; }',
  '.ais__lf-q { width: 220px !important; height: 26px !important; border: none !important; background: transparent !important; box-shadow: none !important; padding: 0 !important; margin: 0 !important; font-size: 12.5px; color: #2c2a3a; outline: none; }',
  '.ais__lf-seg { display: inline-flex; flex-wrap: wrap; gap: 4px; }',
  '.ais__lf-pill { display: inline-flex; align-items: center; gap: 5px; height: 28px; box-sizing: border-box; padding: 0 11px; border-radius: 999px; border: 1px solid #ddd6f3; background: #fff; color: #2c2a3a; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap; transition: background .12s ease, border-color .12s ease, color .12s ease, transform .12s ease; }',
  '.ais__lf-pill i { font-style: normal; font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: #f1ecff; color: #7048e8; }',
  '.ais__lf-pill:hover { border-color: #7048e8; color: #5f3dc4; transform: translateY(-1px); }',
  '.ais__lf-pill.is-on { background: #7048e8; border-color: #7048e8; color: #fff; }',
  '.ais__lf-pill.is-on i { background: rgba(255, 255, 255, .22); color: #fff; }',
  '.ais__lf-pill.is-empty:not(.is-on) { opacity: .5; }',
  '.ais__lf-kp { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 30px; box-sizing: border-box; padding: 2px 8px; border-radius: 16px; border: 1px solid #ddd6f3; background: #fff; }',
  '.ais__lf-kp:focus-within { border-color: #7048e8; box-shadow: 0 0 0 3px #efe9ff; }',
  '.ais__lf-kpin { width: 190px !important; height: 24px !important; border: none !important; background: transparent !important; box-shadow: none !important; padding: 0 4px !important; margin: 0 !important; font-size: 12.5px; color: #2c2a3a; outline: none; }',
  '.ais__lf-kptag { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 2px 6px 2px 10px; font-size: 11.5px; background: #f1ecff; color: #7048e8; border: 1px solid #d9cdff; }',
  '.ais__lf-kptag button { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }',
  '.ais__lf-clear { align-self: flex-end; height: 28px; padding: 0 12px; border-radius: 999px; border: 1px dashed #c8bff0; background: transparent; color: #7048e8; font-size: 12px; cursor: pointer; }',
  '.ais__lf-clear:hover { background: #f1ecff; }',
  '.ais__pager { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 10px; }',
  '.ais__pg { min-width: 30px; height: 28px; border-radius: 8px; border: 1px solid #ddd6f3; background: #fff; color: #2c2a3a; font-size: 12.5px; cursor: pointer; padding: 0 8px; }',
  '.ais__pg:hover:not(:disabled) { border-color: #7048e8; color: #5f3dc4; }',
  '.ais__pg--on { background: #7048e8; border-color: #7048e8; color: #fff; }',
  '.ais__pg:disabled { opacity: .4; cursor: default; }',
  '.ais__pg-gap { padding: 0 4px; color: #8a80b3; }',
  '.ais__pager .ais__lf-count { margin-left: 8px; }',
  '.ais__empty { color: #98a2ac; padding: 10px 2px; font-size: 12.5px; }',
  '.ais__banner { position: relative; display: flex; align-items: center; gap: 12px; border: 1px solid transparent; border-radius: var(--pta-radius-lg); padding: 13px 16px; margin: 0 0 16px; background: linear-gradient(var(--pta-card), var(--pta-card)) padding-box, linear-gradient(120deg, #4dabf7, #845ef7, #4dabf7) border-box; background-size: 100% 100%, 220% 100%; box-shadow: 0 10px 28px -14px rgba(132, 94, 247, .45); font-size: 13.5px; color: var(--pta-ink); overflow: hidden; animation: ptaFadeUp .3s var(--pta-ease) backwards, ptaSheen 9s ease infinite; }',
  '.ais__banner-ic { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; background: var(--pta-grad-violet); color: #fff; font-size: 16px; flex: 0 0 auto; box-shadow: 0 6px 14px -6px rgba(112, 72, 232, .6); }',
  '.ais__banner-text { flex: 1 1 auto; min-width: 0; line-height: 1.5; color: var(--pta-ink-soft); }',
  '.ais__banner-cta { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: #fff !important; text-decoration: none !important; background: linear-gradient(120deg, #4c6ef5, #845ef7); box-shadow: 0 6px 16px -6px rgba(76, 110, 245, .6); transition: filter .12s ease, transform .12s var(--pta-ease), box-shadow .12s ease; }',
  '.ais__banner-cta:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 9px 20px -6px rgba(76, 110, 245, .7); }',
  '.ais__banner-arrow { font-style: normal; transition: transform .15s var(--pta-ease); }',
  '.ais__banner-cta:hover .ais__banner-arrow { transform: translateX(3px); }',
  '@media (max-width: 640px) { .ais__banner { flex-wrap: wrap; } .ais__banner-cta { width: 100%; justify-content: center; } }',
  '.ais__kinds { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 4px 0 12px; }',
  '@media (max-width: 640px) { .ais__kinds { grid-template-columns: 1fr; } }',
  '.ais__kind { display: block; cursor: pointer; margin: 0; position: relative; }',
  '.ais__kind input { position: absolute; opacity: 0; pointer-events: none; }',
  '.ais__kind-body { display: block; border: 1.5px solid var(--pta-line); border-radius: 12px; background: var(--pta-card); padding: 11px 13px; transition: border-color .15s, box-shadow .15s, background .15s, transform .15s var(--pta-ease); }',
  '.ais__kind:hover .ais__kind-body { border-color: var(--pta-violet-line); box-shadow: var(--pta-shadow-hover); transform: translateY(-1px); }',
  '.ais__kind input:checked + .ais__kind-body { border-color: #845ef7; background: var(--pta-violet-soft); box-shadow: 0 4px 16px -8px rgba(112, 72, 232, .5); }',
  '.ais__kind-name { font-weight: bold; font-size: 13.5px; color: var(--pta-ink); display: flex; align-items: center; gap: 7px; }',
  '.ais__kind-desc { display: block; margin-top: 3px; color: var(--pta-ink-soft); font-size: 12px; line-height: 1.45; }',
  '.ais__qts { display: flex; flex-wrap: wrap; gap: 7px; margin: 2px 0 4px; }',
  '.ais__qt { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--pta-violet-line); border-radius: 999px; padding: 4px 12px; font-size: 12px; color: var(--pta-violet-text); background: var(--pta-card); cursor: pointer; user-select: none; transition: background .13s, border-color .13s; }',
  '.ais__qt:hover { background: var(--pta-violet-soft); }',
  '.ais__qt input { accent-color: #845ef7; margin: 0; }',
  '.ais__kindchip { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 6px; font: bold 11px/1 ui-monospace, Consolas, monospace; color: #fff; margin-right: 7px; flex: 0 0 auto; vertical-align: -4px; }',
  '.ais__kindchip--p { background: linear-gradient(120deg, #339af0, #1c7ed6); }',
  '.ais__kindchip--o { background: linear-gradient(120deg, #20c997, #0ca678); }',
  '.ais__kindchip--s { background: linear-gradient(120deg, #9775fa, #7048e8); }',
  '.ais__kinds--3 { grid-template-columns: repeat(3, 1fr); }',
  '@media (max-width: 900px) { .ais__kinds--3 { grid-template-columns: 1fr; } }',
  /* ---- statement-review chat ---- */
  '.aisc { border: 1px solid var(--pta-violet-line); border-radius: var(--pta-radius-lg); overflow: hidden; margin-top: 12px; background: var(--pta-card); }',
  '.aisc__head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--pta-violet-soft); font-size: 12.5px; font-weight: bold; color: var(--pta-violet-text); }',
  '.aisc__head .aisc__clear { margin-left: auto; }',
  '.aisc__log { max-height: 320px; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; scrollbar-width: thin; }',
  '.aisc__empty { color: var(--pta-ink-faint); font-size: 12px; padding: 4px 0; }',
  '.aisc__turn { max-width: 88%; border-radius: 12px; padding: 7px 11px; font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; animation: ptaFadeUp .2s var(--pta-ease) backwards; }',
  '.aisc__turn--user { align-self: flex-end; background: var(--pta-grad-violet); color: #fff; border-bottom-right-radius: 4px; }',
  '.aisc__turn--ai { align-self: flex-start; background: var(--pta-card-2); color: var(--pta-ink); border: 1px solid var(--pta-line-soft); border-bottom-left-radius: 4px; }',
  '.aisc__tag { display: inline-block; font-size: 10.5px; font-weight: bold; letter-spacing: .05em; text-transform: uppercase; opacity: .75; margin-bottom: 2px; }',
  '.aisc__edited { display: inline-block; margin-left: 6px; font-size: 10.5px; border-radius: 8px; padding: 1px 7px; background: #ebfbee; color: #2b8a3e; }',
  '.pta-dark .aisc__edited { background: #12341c; color: #69db7c; }',
  '.aisc__form { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--pta-line-soft); align-items: flex-end; }',
  '.aisc__input { flex: 1 1 auto; resize: vertical; min-height: 44px; }',
  '.aisc__typing { display: inline-flex; gap: 3px; align-items: center; }',
  '.aisc__typing i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .35; animation: ais-breathe 1.1s ease-in-out infinite; }',
  '.aisc__typing i:nth-child(2) { animation-delay: .16s; }',
  '.aisc__typing i:nth-child(3) { animation-delay: .32s; }',
  '.ais__drop { border: 2px dashed #cdb9f7; border-radius: 12px; padding: 14px 12px; text-align: center; color: #7a6fae; cursor: pointer; background: #fcfbff; transition: background .15s, border-color .15s; user-select: none; }',
  '.ais__drop:hover, .ais__drop--over { background: #f6f1ff; border-color: #9775fa; }',
  '.ais__drop--busy { opacity: .6; pointer-events: none; }',
  '.ais__drop-main { font-weight: bold; font-size: 12.5px; }',
  '.ais__drop-sub { font-size: 11px; color: #a49ac9; margin-top: 3px; }',
  '.ais__pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }',
  '.ais__pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #e3dcf5; border-radius: 12px; padding: 3px 10px; font-size: 11.5px; background: #faf9ff; }',
  '.ais__pill button { border: none; background: transparent; color: #c2255c; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }',
  '.ais__pill span { color: #8a94a6; font-size: 11px; }',
  '.ais__dd { position: relative; display: inline-block; }',
  '.ais__dd-panel { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; background: #fff; border: 1px solid #e3dcf5; border-radius: 12px; padding: 10px 12px; max-height: 280px; overflow: auto; min-width: 300px; box-shadow: 0 10px 28px rgba(80,60,140,.2); display: grid; grid-template-columns: 1fr 1fr; gap: 4px 14px; }',
  '.ais__dd-panel[hidden] { display: none; }',
  '.ais__dd-panel label { font-size: 12px; white-space: nowrap; cursor: pointer; display: flex; align-items: center; gap: 5px; }',
  '.ais__dd-actions { grid-column: 1 / -1; margin-top: 8px; }',
  '@keyframes ais-flow { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }',
  '@keyframes ais-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .72; } }',
  '@keyframes ais-pulse { 0% { box-shadow: 0 0 0 0 rgba(112, 72, 232, .45); } 70% { box-shadow: 0 0 0 9px rgba(112, 72, 232, 0); } 100% { box-shadow: 0 0 0 0 rgba(112, 72, 232, 0); } }',
  '@keyframes ais-stripes { from { background-position: 0 0; } to { background-position: 28px 0; } }',
  '@keyframes ais-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }',
  '@keyframes ais-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }',
  '.ais { animation: ais-in .28s ease both; }',
  '.ais__head { background: linear-gradient(120deg, #7048e8, #9775fa, #845ef7, #7048e8); background-size: 260% 260%; animation: ais-flow 9s ease infinite; }',
  '.ais__btn { transition: transform .15s ease, box-shadow .15s ease, filter .15s ease; }',
  '.ais__btn:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(112, 72, 232, .28); }',
  '.ais__btn:not(:disabled):active { transform: translateY(0); box-shadow: 0 2px 6px rgba(112, 72, 232, .25); }',
  '.ais__btn:focus-visible { outline: 2px solid #9775fa; outline-offset: 2px; }',
  'input.textbox:focus, .ais textarea:focus, .ais select:focus { border-color: #9775fa; box-shadow: 0 0 0 3px rgba(151, 117, 250, .18); transition: box-shadow .15s ease, border-color .15s ease; }',
  '.ais__drop { transition: background .2s ease, border-color .2s ease, transform .2s ease; }',
  '.ais__drop--over { transform: scale(1.01); }',
  '.ais__row-hover:hover, .ais tbody tr:hover { background: rgba(151, 117, 250, .06); }',
  '.ais__progress { height: 6px; border-radius: 999px; background: rgba(151, 117, 250, .18); overflow: hidden; margin: 8px 0 10px; }',
  '.ais__progress > i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #7048e8, #9775fa); transition: width .6s ease; }',
  '.ais__progress--live > i { background-image: repeating-linear-gradient(45deg, #7048e8 0 10px, #9775fa 10px 20px); background-size: 28px 28px; animation: ais-stripes .9s linear infinite; }',
  '.ais__progress--bad > i { background: linear-gradient(90deg, #e03131, #ff6b6b); }',
  '.ais__msg--live { background: linear-gradient(90deg, #7a6fae 35%, #b197fc 50%, #7a6fae 65%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: ais-shimmer 2.2s linear infinite; }',
  '@media (prefers-reduced-motion: reduce) { .ais, .ais * { animation: none !important; transition: none !important; } }',
  /* dark */
  '.pta-dark .ais { background: #23272c; border-color: #37313f; box-shadow: 0 8px 28px rgba(0,0,0,.4); }',
  '.pta-dark .ais__body { color: #d5dade; }',
  '.pta-dark .ais__label { color: #9d93c9; }',
  '.pta-dark .ais textarea, .pta-dark .ais input[type=text], .pta-dark .ais select { background: #1e2227; border-color: #3a424b; color: #d5dade; }',
  '.pta-dark .ais__btn--ghost { background: #23272c; color: #b197fc; border-color: #5c4a8a; }',
  '.pta-dark .ais__btn--ghost:hover { background: #2c2440; }',
  '.pta-dark .ais__btn--danger { background: #23272c; }',
  '.pta-dark .ais__chip { background: #322a48; color: #cdbdfb; }',
  '.pta-dark .ais__table th { background: #262b31; color: #9d93c9; border-bottom-color: #37313f; }',
  '.pta-dark .ais__th:hover, .pta-dark .ais__th--on { color: #cdbdfb; }',
  '.pta-dark .ais__lf { background: #1f1d2b; border-color: #37313f; }',
  '.pta-dark .ais__lf-qwrap, .pta-dark .ais__lf-kp, .pta-dark .ais__lf-pill, .pta-dark .ais__pg { background: #232032; border-color: #3d3750; color: #e7e3f5; }',
  '.pta-dark .ais__lf-q, .pta-dark .ais__lf-kpin { color: #e7e3f5; }',
  '.pta-dark .ais__lf-qwrap:focus-within, .pta-dark .ais__lf-kp:focus-within { box-shadow: 0 0 0 3px #322a48; }',
  '.pta-dark .ais__lf-pill i { background: #322a48; color: #cdbdfb; }',
  '.pta-dark .ais__lf-pill.is-on { background: #7048e8; border-color: #7048e8; color: #fff; }',
  '.pta-dark .ais__lf-pill.is-on i { background: rgba(255, 255, 255, .22); color: #fff; }',
  '.pta-dark .ais__lf-clear { border-color: #4a3d6b; color: #cdbdfb; }',
  '.pta-dark .ais__lf-clear:hover { background: #322a48; }',
  '.pta-dark .ais__lf-kptag { background: #322a48; color: #cdbdfb; border-color: #4a3d6b; }',
  '.pta-dark .ais__pg--on { background: #7048e8; border-color: #7048e8; color: #fff; }',
  '.pta-dark .ais__table td { border-bottom-color: #2c3238; }',
  '.pta-dark .ais__table tr:hover td { background: #2a2536; }',
  '.pta-dark .ais__empty { color: #7f8b97; }',
  '.pta-dark .ais__banner { box-shadow: 0 12px 30px -14px rgba(0, 0, 0, .65); }',
  '.pta-dark .ais__drop { background: #221f2c; border-color: #4d4070; color: #a99ed0; }',
  '.pta-dark .ais__drop:hover, .pta-dark .ais__drop--over { background: #292339; border-color: #7a5fd0; }',
  '.pta-dark .ais__drop-sub { color: #7f75a8; }',
  '.pta-dark .ais__pill { background: #262b31; border-color: #37313f; }',
  '.pta-dark .ais__dd-panel { background: #23202c; border-color: #4d4070; box-shadow: 0 10px 28px rgba(0,0,0,.5); }',
  '.pta-dark .ais__progress { background: rgba(151, 117, 250, .14); }',
  '.pta-dark .ais__msg--live { background: linear-gradient(90deg, #a99ed0 35%, #d0bfff 50%, #a99ed0 65%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; }',
  '.pta-dark .ais__row-hover:hover, .pta-dark .ais tbody tr:hover { background: rgba(151, 117, 250, .09); }',
  '.pta-dark .ais__badge--idle { background: #2a3036; color: #9aa4ad; }',
  '.pta-dark .ais__badge--running { background: #16283a; color: #4dabf7; }',
  '.pta-dark .ais__badge--passed { background: #1e3524; color: #69db7c; }',
  '.pta-dark .ais__badge--failed { background: #3a1f2c; color: #faa2c1; }',
  '.pta-dark .ais__badge--published { background: #2c2440; color: #d0bdfb; }',
].concat(AIS_POLISH).join('\n');

export function ensureAisStyle() {
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
  if (!document.getElementById('ais-style')) {
    $('<style>').attr('id', 'ais-style').text(AIS_STYLE).appendTo(document.head);
  }
}

const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];

export const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Upload one context file (slides/notes) to a draft; server extracts the text. */
/**
 * Hydro serializes errors as { message: <i18n template>, params: [...] } —
 * for classes like BadRequestError the template is just the class name and
 * the human sentence rides in params. Reassemble whichever shape arrives.
 */
function hydroErrorText(body, status) {
  const err = (body && body.error) || {};
  let msg = String(err.message || '');
  const params = Array.isArray(err.params) ? err.params : [];
  if (/\{\d+\}/.test(msg)) msg = msg.replace(/\{(\d+)\}/g, (_, i) => String(params[+i] ?? ''));
  else if ((!msg || /^[A-Za-z]*Error$/.test(msg)) && params.length) msg = params.join(' ');
  return msg || `Upload failed (HTTP ${status})`;
}

export async function uploadContextFile(url, file) {
  const fd = new FormData();
  fd.append('csrfToken', (window.UiContext || {}).csrfToken || '');
  fd.append('operation', 'uploadContext');
  fd.append('file', file);
  const resp = await fetch(url, { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(hydroErrorText(body, resp.status));
  return body;
}

/** Language options: the server's judge config, same filter as the scratchpad. */
export function langEntries(serverLangs) {
  let langs = serverLangs;
  if (!langs || !Object.keys(langs).length) {
    const avail = getAvailableLangs();
    langs = {};
    for (const k of Object.keys(avail)) langs[k] = avail[k].display || k;
  }
  return langs;
}

const ddLabel = (n) => (n ? `${n} ${i18n('languages selected')}` : i18n('All languages allowed'));

/** Compact multi-select dropdown for language restriction. */
export function renderAllowLangsDd(langsMap, selected, disabled) {
  const sel = new Set(selected || []);
  return `<div class="ais__dd">
    <button type="button" class="ais__btn ais__btn--ghost ais__btn--sm ais__dd-btn" ${disabled ? 'disabled' : ''}>🌐 <span class="ais__dd-label">${esc(ddLabel(sel.size))}</span> ▾</button>
    <div class="ais__dd-panel" hidden>
      ${Object.entries(langsMap).map(([id, disp]) => `<label><input type="checkbox" class="ais__dd-cb" value="${id}" ${sel.has(id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}> ${esc(disp)}</label>`).join('')}
      <div class="ais__dd-actions"><button type="button" class="ais__btn ais__btn--ghost ais__btn--sm ais__dd-clear" ${disabled ? 'disabled' : ''}>${esc(i18n('Clear (allow all)'))}</button></div>
    </div></div>`;
}

export function wireAllowLangsDd($scope, onChange) {
  const $dd = $scope.find('.ais__dd');
  if (!$dd.length) return;
  const $panel = $dd.find('.ais__dd-panel');
  $dd.find('.ais__dd-btn').on('click', (ev) => { ev.stopPropagation(); $panel.prop('hidden', !$panel.prop('hidden')); });
  $panel.on('click', (ev) => ev.stopPropagation());
  $(document).off('click.aisdd').on('click.aisdd', () => $panel.prop('hidden', true));
  const emit = () => {
    const langs = $dd.find('.ais__dd-cb:checked').map(function cv() { return $(this).val(); }).get();
    $dd.find('.ais__dd-label').text(ddLabel(langs.length));
    if (onChange) onChange(langs);
  };
  $dd.find('.ais__dd-cb').on('change', emit);
  $dd.find('.ais__dd-clear').on('click', () => { $dd.find('.ais__dd-cb').prop('checked', false); emit(); });
}

export function langOptionsHtml(serverLangs, selected) {
  const langs = langEntries(serverLangs);
  const keys = Object.keys(langs);
  // Must match pickPreferredLang() on the server. A bare 'cc' is absent from
  // many judge configs (they publish cc.cc11 / cc.cc17 / ... instead), and
  // the old list fell through to 'c' — so a C++ course got C by default.
  const PREF = ['cc', 'cc.cc17', 'cc.cc14', 'cc.cc11', 'cc.cc20', 'cc.cc23', 'cc.cc98', 'c', 'py.py3', 'py', 'java'];
  const sel = selected && keys.includes(selected) ? selected
    : PREF.find((k) => keys.includes(k)) || keys.find((k) => k.startsWith('cc')) || keys[0];
  return keys.map((k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${$('<i>').text(langs[k]).html()}</option>`).join('');
}

/**
 * Does this requirement read like a quiz rather than a coding exercise?
 * Only ever used to OFFER a switch — the teacher's card selection wins.
 * Two independent signals, because teachers phrase this very differently:
 *   1. explicit quiz vocabulary ("multiple choice", "选择题", …)
 *   2. a countable number of "questions" / "题", which programming tasks are
 *      essentially never described with (those are "a problem"/"an exercise")
 */
const QUIZ_WORDS = /single[- ]?choice|multiple[- ]?choice|true[/ ]?(?:or )?false|fill[- ]?in[- ]?the[- ]?blank|\bquiz(?:zes)?\b|\bmcqs?\b|判断题|选择题|填空题|单选|多选|小测|测验|問答題|選擇題|判斷題|填空題|單選|多選/i;
const QUIZ_COUNT = /\b\d+\s*(?:-|\s)?\s*questions?\b|\bquestions?\b[^.]{0,40}\b(?:check|test|assess|verify|understand|comprehension)\b|\d+\s*(?:道|个|個)\s*(?:题|題)|(?:出|设计|設計|生成)\s*\d*\s*(?:道|个|個)?\s*(?:题目|題目|题|題)/i;
export const looksObjective = (t) => QUIZ_WORDS.test(t) || QUIZ_COUNT.test(t);

const STATUS_LABEL = {
  idle: 'Draft', running: 'Verifying…', passed: 'Verified', failed: 'Failed',
};

function badge(d) {
  if (d.published) {
    return d.publishedHidden
      ? `<span class="ais__badge ais__badge--idle" title="${esc(i18n('Published but not yet visible to students'))}">🕶 ${esc(i18n('Published · hidden'))}</span>`
      : `<span class="ais__badge ais__badge--published">✓ ${esc(i18n('Published'))}</span>`;
  }
  const cls = `ais__badge--${d.status || 'idle'}`;
  return `<span class="ais__badge ${cls}">${esc(i18n(STATUS_LABEL[d.status] || d.status))}</span>`;
}

/* ------------------------------------------------------------------ */
/*  Drafts list: sortable columns, filters, 10 per page                 */
/* ------------------------------------------------------------------ */
const PAGE_SIZE = 10;
const KIND_CHIP = {
  programming: ['p', 'P', 'Programming task'],
  objective: ['o', 'O', 'Objective task'],
  subjective: ['s', 'S', 'Subjective task'],
};
const BAND_ORDER = { intro: 0, medium: 1, challenge: 2 };
/** One status key per draft, in the order sorting uses. */
const STATUS_ORDER = ['idle', 'running', 'failed', 'passed', 'published_hidden', 'published'];
const STATUS_FILTER_LABEL = {
  idle: 'Draft', running: 'Verifying…', failed: 'Failed', passed: 'Verified', published_hidden: 'Published · hidden', published: 'Published',
};
const statusKey = (d) => (d.published ? (d.publishedHidden ? 'published_hidden' : 'published') : (d.status || 'idle'));

/** Sort/filter/page state — remembered per domain across visits. */
const LIST_STATE_KEY = () => `hydro:ai-studio-list:${UiContext.domainId || ''}`;
const DEFAULT_LIST_STATE = { sort: 'updateAt', dir: 'desc', page: 1, q: '', kind: '', difficulty: '', status: '', knowledge: [] };
let listState = { ...DEFAULT_LIST_STATE };
try {
  const saved = JSON.parse(localStorage.getItem(LIST_STATE_KEY()) || 'null');
  if (saved && typeof saved === 'object') listState = { ...DEFAULT_LIST_STATE, ...saved, knowledge: Array.isArray(saved.knowledge) ? saved.knowledge : [] };
} catch (e) { /* defaults */ }
const saveListState = () => {
  try { localStorage.setItem(LIST_STATE_KEY(), JSON.stringify(listState)); } catch (e) { /* ignore */ }
};

const SORT_KEYS = {
  title: (d) => String(d.title || d.topic || '').toLowerCase(),
  language: (d) => (d.kind === 'subjective' ? '\uffff' : String(d.language || '').toLowerCase()),
  difficulty: (d) => (BAND_ORDER[d.difficulty] ?? 0) * 10 + (d.difficultyScore || 0),
  status: (d) => STATUS_ORDER.indexOf(statusKey(d)),
  updateAt: (d) => new Date(d.updateAt || 0).getTime(),
};

function applyListState(drafts, state = listState) {
  const st = state;
  const q = st.q.trim().toLowerCase();
  const kp = st.knowledge.map((x) => x.toLowerCase());
  let list = drafts.filter((d) => {
    if (st.kind && d.kind !== st.kind) return false;
    if (st.difficulty && d.difficulty !== st.difficulty) return false;
    if (st.status && statusKey(d) !== st.status) return false;
    if (q && !`${d.title || ''} ${d.topic || ''} ${(d.pids || []).join(' ')}`.toLowerCase().includes(q)) return false;
    if (kp.length) {
      const have = (d.knowledge || []).map((x) => String(x).toLowerCase());
      if (!kp.every((k) => have.includes(k))) return false;
    }
    return true;
  });
  const key = SORT_KEYS[st.sort] || SORT_KEYS.updateAt;
  const dir = st.dir === 'asc' ? 1 : -1;
  list = [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const c = typeof ka === 'string' ? ka.localeCompare(kb) : ka - kb;
    // Stable tie-break: newest first.
    return c ? c * dir : new Date(b.updateAt || 0) - new Date(a.updateAt || 0);
  });
  return list;
}

function draftRowHtml(d) {
  const [cls, letter, label] = KIND_CHIP[d.kind] || KIND_CHIP.programming;
  return '<tr>'
    + `<td><span class="ais__kindchip ais__kindchip--${cls}" title="${esc(i18n(label))}">${letter}</span><b>${esc(d.title || d.topic)}</b>${d.bonus ? ` <span class="ais__chip" title="${esc(i18n('Generated for one student of a self-learning session (hidden; reachable only through that session)'))}">🎁 ${esc(i18n('bonus for user {0}').replace('{0}', d.bonus.uid))}</span>` : ''}${knowledgeRow(d)}</td>`
    + `<td>${d.kind === 'subjective' ? '—' : `<span class="ais__chip">${esc(d.language)}</span>`}</td>`
    + `<td>${esc(i18n(d.difficulty))}${d.difficultyScore ? ` <span class="aisd__meta">${d.difficultyScore}/10</span>` : ''}</td>`
    + `<td>${badge(d)}</td>`
    + `<td>${esc(fmtTs(d.updateAt))}</td>`
    + `<td><a class="ais__btn ais__btn--ghost ais__btn--sm" href="${domainPrefix()}/ai-studio/${d._id}">${esc(i18n('Open'))}</a></td>`
    + '</tr>';
}

/**
 * The "My drafts" section. Owns its state and re-renders alone, so sorting,
 * filtering or paging never disturbs the "New draft" form above it.
 */
function renderDrafts($sec, drafts) {
  const st = listState;
  const all = drafts || [];
  const list = applyListState(all);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (st.page > pages) st.page = pages;
  if (st.page < 1) st.page = 1;
  const from = (st.page - 1) * PAGE_SIZE;
  const pageItems = list.slice(from, from + PAGE_SIZE);
  const kpNames = [...new Set(all.flatMap((d) => d.knowledge || []).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const filtering = !!(st.q || st.kind || st.difficulty || st.status || st.knowledge.length);
  const th = (key, label) => `<th class="ais__th${st.sort === key ? ' ais__th--on' : ''}" data-sort="${key}" title="${esc(i18n('Sort by {0}').replace('{0}', i18n(label)))}">${esc(i18n(label))} <span class="ais__th-dir">${st.sort === key ? (st.dir === 'asc' ? '▲' : '▼') : '⇅'}</span></th>`;
  // A segment's count = drafts matching every OTHER active filter plus this
  // value, so the teacher sees what each choice would leave.
  const countWith = (patch) => applyListState(all, { ...st, ...patch, page: 1 }).length;
  const seg = (field, current, options, allLabel) => `<div class="ais__lf-seg" data-field="${field}">
      <button type="button" class="ais__lf-pill${current === '' ? ' is-on' : ''}" data-value="">${esc(i18n(allLabel))}</button>
      ${options.map(([v, lb]) => {
    const n = countWith({ [field]: v });
    return `<button type="button" class="ais__lf-pill${current === v ? ' is-on' : ''}${n ? '' : ' is-empty'}" data-value="${esc(v)}">${esc(i18n(lb))}<i>${n}</i></button>`;
  }).join('')}
    </div>`;
  const group = (label, inner) => `<div class="ais__lf-group"><span class="ais__lf-label">${esc(i18n(label))}</span>${inner}</div>`;
  const pageBtn = (p, label, disabled, on) => `<button type="button" class="ais__pg${on ? ' ais__pg--on' : ''}" data-page="${p}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  // Page numbers: first, last, and a window around the current page.
  const nums = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - st.page) <= 2) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  $sec.html(`
        <div class="ais__label ais__lf-head" style="margin-top:22px;">🗂 ${esc(i18n('My drafts'))} <span class="ais__lf-count">${list.length === all.length ? all.length : `${list.length} / ${all.length}`}</span></div>
        <div class="ais__lf">
          <div class="ais__lf-row">
            ${group('Search', `<span class="ais__lf-qwrap">🔍<input type="text" class="ais__lf-q" value="${esc(st.q)}" placeholder="${esc(i18n('Title, topic or pid'))}"></span>`)}
            ${group('Type', seg('kind', st.kind, [['programming', 'Programming'], ['objective', 'Objective'], ['subjective', 'Subjective']], 'All'))}
            ${group('Difficulty', seg('difficulty', st.difficulty, [['intro', 'intro'], ['medium', 'medium'], ['challenge', 'challenge']], 'All'))}
          </div>
          <div class="ais__lf-row">
            ${group('Status', seg('status', st.status, STATUS_ORDER.map((k) => [k, STATUS_FILTER_LABEL[k]]), 'All'))}
            ${group('Knowledge points', `<span class="ais__lf-kp">
              ${st.knowledge.map((n) => `<span class="ais__lf-kptag" data-name="${esc(n)}">${esc(n)}<button type="button" title="${esc(i18n('Remove'))}">×</button></span>`).join('')}
              <input type="text" class="ais__lf-kpin" list="ais-lf-kplist" placeholder="${esc(st.knowledge.length ? i18n('Add another…') : i18n('Type to filter by a label…'))}">
              <datalist id="ais-lf-kplist">${kpNames.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
            </span>`)}
            ${filtering ? `<button type="button" class="ais__lf-clear">✕ ${esc(i18n('Clear filters'))}</button>` : ''}
          </div>
        </div>
        ${pageItems.length ? `<table class="ais__table"><tr>${th('title', 'Title / Topic')}${th('language', 'Language')}${th('difficulty', 'Difficulty')}${th('status', 'Status')}${th('updateAt', 'Updated')}<th></th></tr>${pageItems.map(draftRowHtml).join('')}</table>`
    : `<div class="ais__empty">${esc(all.length ? i18n('No draft matches these filters.') : i18n('No drafts yet.'))}</div>`}
        ${list.length > PAGE_SIZE ? `<div class="ais__pager">
          ${pageBtn(1, '«', st.page === 1)}${pageBtn(st.page - 1, '‹', st.page === 1)}
          ${nums.map((n) => (n === '…' ? '<span class="ais__pg-gap">…</span>' : pageBtn(n, n, false, n === st.page))).join('')}
          ${pageBtn(st.page + 1, '›', st.page === pages)}${pageBtn(pages, '»', st.page === pages)}
          <span class="ais__lf-count">${esc(i18n('{0}–{1} of {2}').replace('{0}', from + 1).replace('{1}', Math.min(from + PAGE_SIZE, list.length)).replace('{2}', list.length))}</span>
        </div>` : ''}`);

  const update = (patch, keepPage = false) => {
    Object.assign(listState, patch);
    if (!keepPage) listState.page = 1;
    saveListState();
    renderDrafts($sec, all);
  };
  $sec.find('.ais__th').on('click', function onSort() {
    const key = $(this).attr('data-sort');
    update(listState.sort === key
      ? { dir: listState.dir === 'asc' ? 'desc' : 'asc' }
      : { sort: key, dir: key === 'updateAt' ? 'desc' : 'asc' }, true);
  });
  let qTimer = null;
  $sec.find('.ais__lf-q').on('input', function onQ() {
    const v = String($(this).val() || '');
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const focused = document.activeElement === this;
      update({ q: v });
      if (focused) {
        const el = $sec.find('.ais__lf-q').trigger('focus').get(0);
        if (el && el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 250);
  });
  $sec.find('.ais__lf-pill').on('click', function onPill() {
    const field = $(this).closest('.ais__lf-seg').attr('data-field');
    update({ [field]: String($(this).attr('data-value') || '') });
  });
  const addKp = () => {
    const v = String($sec.find('.ais__lf-kpin').val() || '').trim();
    if (!v) return;
    if (!listState.knowledge.some((x) => x.toLowerCase() === v.toLowerCase())) update({ knowledge: [...listState.knowledge, v] });
    else $sec.find('.ais__lf-kpin').val('');
  };
  $sec.find('.ais__lf-kpin').on('change', addKp).on('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      addKp();
    }
  });
  $sec.find('.ais__lf-kptag button').on('click', function onRmKp() {
    const name = $(this).closest('.ais__lf-kptag').attr('data-name');
    update({ knowledge: listState.knowledge.filter((x) => x !== name) });
  });
  $sec.find('.ais__lf-clear').on('click', () => update({ q: '', kind: '', difficulty: '', status: '', knowledge: [] }));
  $sec.find('.ais__pg').on('click', function onPage() {
    const p = Number($(this).attr('data-page'));
    if (Number.isFinite(p)) update({ page: p }, true);
  });
}

/** Knowledge-point labels under a programming draft's title (first six, then a +n). */
function knowledgeRow(d) {
  const names = Array.isArray(d.knowledge) ? d.knowledge.filter(Boolean) : [];
  if (!names.length) return '';
  const shown = names.slice(0, 6);
  const more = names.length - shown.length;
  return `<div class="ais__kp" title="${esc(names.join(' · '))}">🏷️ ${shown.map((n) => `<span class="ais__kp-tag">${esc(n)}</span>`).join('')}${more > 0 ? `<span class="ais__kp-more">+${more}</span>` : ''}</div>`;
}

function renderList($root, data) {
  const provider = data.provider || {};
  $root.html(`
    <div class="ais">
      <div class="ais__head">✨ <span class="ais__title">${esc(i18n('AI Studio'))}</span>
        <a class="ais__btn ais__btn--ghost ais__btn--sm" href="${domainPrefix()}/knowledge-points" style="margin-left:12px;">🏷️ ${esc(i18n('Knowledge points'))}</a>
        <span class="ais__hint">${esc(i18n('Model'))}: ${esc(provider.provider || '?')} / ${esc(provider.model || '?')}${provider.build ? ` · ${esc(i18n('build'))} ${esc(provider.build)}` : ''}</span></div>
      <div class="ais__body">
        <div class="ais__label">🧠 ${esc(i18n('New draft'))}</div>
        <div class="ais__label" style="text-transform:none;letter-spacing:0;font-weight:normal;">${esc(i18n('Describe the task you want and attach the relevant slides below. The AI drafts the statement first — you review it, refine it by chat, and only then does it continue.'))}</div>
        <div class="ais__label">${esc(i18n('What kind of task?'))}</div>
        <div class="ais__kinds ais__kinds--3">
          <label class="ais__kind"><input type="radio" name="ais-kind" value="programming" checked>
            <span class="ais__kind-body"><span class="ais__kind-name">💻 ${esc(i18n('Programming task'))}</span>
            <span class="ais__kind-desc">${esc(i18n('Statement + reference solution + tests — the judge verifies everything in the sandbox before publishing.'))}</span></span></label>
          <label class="ais__kind"><input type="radio" name="ais-kind" value="objective">
            <span class="ais__kind-body"><span class="ais__kind-name">📝 ${esc(i18n('Objective task'))}</span>
            <span class="ais__kind-desc">${esc(i18n('Auto-graded quiz — true/false, choice, fill-in-the-blank — you approve the questions, then the AI writes the answer key.'))}</span></span></label>
          <label class="ais__kind"><input type="radio" name="ais-kind" value="subjective">
            <span class="ais__kind-body"><span class="ais__kind-name">📄 ${esc(i18n('Subjective task'))}</span>
            <span class="ais__kind-desc">${esc(i18n('Project-level assignment — students submit files and a report; you grade it. Written by chatting with the AI.'))}</span></span></label>
        </div>
        <textarea class="ais__topic" rows="2" placeholder="${esc(i18n('e.g. A problem practicing prefix sums, based on the attendance example from today\'s lecture'))}"></textarea>
        <div class="ais__row" style="margin-top:10px;">
          <div><div class="ais__label ais__lang-label">${esc(i18n('Solution language'))}</div>
            <select class="ais__lang">${langOptionsHtml(data.langs)}</select></div>
          <div><div class="ais__label">${esc(i18n('Difficulty'))}</div>
            <select class="ais__diff"><option value="intro">${esc(i18n('intro'))}</option><option value="medium">${esc(i18n('medium'))}</option><option value="challenge">${esc(i18n('challenge'))}</option></select></div>
          <div class="ais__prog-only"><div class="ais__label">${esc(i18n('Cross-check'))}</div>
            <select class="ais__cross"><option value="1">${esc(i18n('On (recommended)'))}</option><option value="0">${esc(i18n('Off'))}</option></select></div>
          <div class="ais__prog-only" style="min-width:230px;"><div class="ais__label">${esc(i18n('Allowed languages for students'))}</div>
            ${renderAllowLangsDd(langEntries(data.langs), [], false)}
            <div class="aisd__meta">${esc(i18n('Empty = every judge language.'))}</div></div>
        </div>
        <div class="ais__prog-only">
          <div class="ais__label">🎯 ${esc(i18n('Target knowledge points (optional)'))}</div>
          <div class="aisd__meta" style="margin-bottom:6px;">${esc(i18n('Pick from the domain catalog (or type new ones). The AI designs the task so that a correct solution needs every one of them, probes them in the tests, and labels the task with them.'))}</div>
          <input type="text" class="ais__knowledge" placeholder="${esc(i18n('Search knowledge points…'))}">
        </div>
        <div class="ais__obj-only" hidden>
          <div class="ais__label">${esc(i18n('How many questions?'))}</div>
          <select class="ais__qcount" style="max-width:200px;">
            <option value="0">${esc(i18n('Let the AI decide'))}</option>
            ${[3, 4, 5, 6, 8, 10, 12, 15, 20].map((x) => `<option value="${x}">${x}</option>`).join('')}
          </select>
          <div class="ais__label">${esc(i18n('Question types (optional — the AI mixes them sensibly)'))}</div>
          <div class="ais__qts">
            ${[['tf', 'True / False'], ['single', 'Single choice'], ['multi', 'Multiple choice'], ['fill', 'Fill in the blank'], ['dropdown', 'Dropdown'], ['short', 'Short answer']]
    .map(([v, lb]) => `<label class="ais__qt"><input type="checkbox" class="ais__qt-cb" value="${v}"> ${esc(i18n(lb))}</label>`).join('')}
          </div>
        </div>
        <div class="ais__label">📚 ${esc(i18n('Context files (slides, notes)'))}</div>
        <div class="ais__drop">
          <div class="ais__drop-main">${esc(i18n('Drop the course files here, or click to choose'))}</div>
          <div class="ais__drop-sub">${esc(i18n('Slides, documents, spreadsheets, PDFs, notebooks and source code (.pptx .docx .xlsx .pdf .txt .ipynb .py .cpp …) · legacy .doc / .ppt / .xls are read best-effort · up to 8 files · 15 MB each. Text is extracted on upload; the original files are not stored.'))}</div>
        </div>
        <input type="file" class="ais__pick" multiple style="display:none">
        <div class="ais__pills"></div>
        <div class="ais__label">🧷 ${esc(i18n('Extra requirements (optional)'))}</div>
        <textarea class="ais__notes" rows="3" placeholder="${esc(i18n('e.g. must use a loop and no arrays; write the statement in English'))}"></textarea>
        <div style="margin-top:12px;"><button type="button" class="ais__btn ais__create">✨ ${esc(i18n('Create draft'))}</button></div>
        <div class="ais__drafts"></div>
      </div>
    </div>`);
  renderDrafts($root.find('.ais__drafts'), data.drafts || []);
  let allowSel = [];
  wireAllowLangsDd($root, (langs) => { allowSel = langs; });
  const LANG_LABEL = {
    programming: i18n('Solution language'),
    objective: i18n('Language the questions are about'),
    subjective: i18n('Language the project is written in'),
  };
  const PLACEHOLDER = {
    programming: i18n('e.g. A problem practicing prefix sums, based on the attendance example from today\'s lecture'),
    objective: i18n("e.g. A 6-question check-in quiz on loops and conditionals, based on this week's slides"),
    subjective: i18n('e.g. A mini-project: build a command-line address book in C and report on your data-structure choices'),
  };
  const currentKind = () => String($root.find('input[name="ais-kind"]:checked').val() || 'programming');
  // Target knowledge points: a catalog-backed multi-select; its value is a
  // comma-joined list of names, sent with the create request.
  const kpPicker = KnowledgePointSelectAutoComplete.getOrConstruct($root.find('.ais__knowledge'), { multi: true, freeSolo: true, clearDefaultValue: false });
  $root.find('input[name="ais-kind"]').on('change', function onKind() {
    const kind = currentKind();
    // Programming needs the full judge configuration; an objective quiz is
    // still ABOUT a language (so it keeps the picker) but has nothing to
    // cross-check or restrict; a subjective task has no judge at all.
    $root.find('.ais__prog-only').toggle(kind === 'programming');
    $root.find('.ais__obj-only').prop('hidden', kind !== 'objective');
    // The picker stays visible for every kind. It used to be hidden for
    // subjective drafts while still submitting its value, so a project brief
    // silently carried whatever language happened to be preselected.
    $root.find('.ais__lang-label').text(LANG_LABEL[kind] || LANG_LABEL.programming);
    $root.find('.ais__topic').attr('placeholder', PLACEHOLDER[kind] || PLACEHOLDER.programming);
  });

  const pending = []; // File objects picked before the draft exists
  const $pills = $root.find('.ais__pills');
  const renderPills = () => {
    $pills.html(pending.map((f, i) => `<span class="ais__pill">📄 ${esc(f.name)} <span class="aisd__meta">${fmtSize(f.size)}</span><button type="button" data-i="${i}" title="${esc(i18n('Remove'))}">×</button></span>`).join(''));
  };
  $pills.on('click', 'button', function onRm() {
    pending.splice(+$(this).data('i'), 1);
    renderPills();
  });
  const addFiles = (list) => {
    for (const f of Array.from(list || [])) {
      if (f.size > 15 * 1024 * 1024) Notification.error(`${f.name}: ${i18n('The file exceeds the 15 MB limit.')}`);
      else if (pending.length >= 8) Notification.warn(i18n('At most 8 context files.'));
      else pending.push(f);
    }
    renderPills();
  };
  const $drop = $root.find('.ais__drop');
  const $pick = $root.find('.ais__pick');
  $drop.on('click', () => $pick.trigger('click'));
  $pick.on('change', function onPick() { addFiles(this.files); this.value = ''; });
  $drop.on('dragenter dragover', (ev) => { ev.preventDefault(); $drop.addClass('ais__drop--over'); });
  $drop.on('dragleave drop', (ev) => { ev.preventDefault(); $drop.removeClass('ais__drop--over'); });
  $drop.on('drop', (ev) => {
    const dt = ev.originalEvent && ev.originalEvent.dataTransfer;
    if (dt?.files?.length) addFiles(dt.files);
  });

  $root.find('.ais__create').on('click', async function onCreate() {
    const topic = String($root.find('.ais__topic').val() || '').trim();
    if (!topic) {
      Notification.warn(i18n('Please describe the task first.'));
      return;
    }
    const $b = $(this).prop('disabled', true);
    try {
      let kind = currentKind();
      const smellsObjective = looksObjective(topic);
      if (kind === 'programming' && smellsObjective
        && window.confirm(i18n('This requirement sounds like an objective quiz. Create it as an OBJECTIVE task instead? (OK = objective task, Cancel = keep programming)'))) {
        kind = 'objective';
        $root.find('input[name="ais-kind"][value="objective"]').prop('checked', true).trigger('change');
      }
      const qtypes = $root.find('.ais__qt-cb:checked').map(function qv() { return $(this).val(); }).get();
      const res = await request.post(window.location.pathname, {
        operation: 'create',
        kind,
        topic,
        language: $root.find('.ais__lang').val(),
        difficulty: $root.find('.ais__diff').val(),
        crosscheck: $root.find('.ais__cross').val() === '1',
        notes: String($root.find('.ais__notes').val() || ''),
        ...(kind === 'programming'
          ? { allowLangs: allowSel.join(','), knowledge: kpPicker.names().join(',') }
          : kind === 'objective'
            ? { qtypes: qtypes.join(','), qcount: String($root.find('.ais__qcount').val() || '0') }
            : {}),
      });
      const url = res.url || `${domainPrefix()}/ai-studio/${res.id}`;
      for (let k = 0; k < pending.length; k++) {
        $b.text(`${i18n('Uploading context')} ${k + 1}/${pending.length}…`);
        try {
          await uploadContextFile(url, pending[k]); // eslint-disable-line no-await-in-loop
        } catch (e) {
          Notification.error(`${pending[k].name}: ${e.message}`);
        }
      }
      window.location.href = url;
    } catch (e) {
      Notification.error(e.message);
      $b.prop('disabled', false).text(`✨ ${i18n('Create draft')}`);
    }
  });
}

// The Studio's entry point is the "AI Studio" row in the problem set's
// "Create Problem" side panel (injected in handler/self_learning.ts). The
// create-problem page used to prepend its own promo banner as well; that
// duplicate entry has been retired, so this module now only drives the
// Studio's own pages.
export default new NamedPage(['ai_studio'], () => {
  ensureAisStyle();
  const $root = $('#ais-root');
  // Distinct URL for the XHR so the document URL never caches JSON (see
  // the Vary/no-store headers in AiStudioBaseHandler#prepare).
  request.get(`${window.location.pathname}?_fmt=json`)
    .then((data) => renderList($root, data))
    .catch((e) => $root.html(`<div class="ais"><div class="ais__body"><div class="ais__empty">⚠ ${esc(e.message)}</div></div></div>`));
});
