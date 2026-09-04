import $ from 'jquery';
import KnowledgePointSelectAutoComplete from 'vj/components/autocomplete/KnowledgePointSelectAutoComplete';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import { aiMarkdown } from 'vj/components/ai-report/pdf';
import { mountComposers } from 'vj/components/chat-composer';
import { AIS_POLISH, ensureAisStyle, fmtSize, langOptionsHtml, uploadContextFile } from 'vj/pages/ai_studio.page';

/**
 * AI Studio — draft detail. Left: artifact tabs (statement / reference
 * solution / cross-check solution / tests), each with Regenerate, AI-refine
 * and manual Save (teacher edits are first-class and go through the same
 * verification). Right: the live verification pipeline — the page polls
 * while the backend runs the sandbox/judge stages.
 */

const esc = (t) => $('<i>').text(String(t ?? '')).html();
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');
const base = () => window.location.pathname;
/*
 * The same path serves HTML to the browser and JSON to this XHR. Giving the
 * XHR its own query string means the document URL never acquires a JSON
 * entry in the HTTP cache, so Back/Forward cannot replay JSON as the page.
 * Belt and braces with the Vary/no-store headers the handler sets: a proxy
 * that strips Vary would otherwise reintroduce the bug.
 */
const jsonUrl = () => `${window.location.pathname}?_fmt=json`;
const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];

const DETAIL_STYLE = [
  '.aisd { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }',
  '.aisd__main { flex: 1 1 620px; min-width: 0; }',
  '.aisd__side { flex: 0 0 320px; max-width: 100%; }',
  '.aisd__tabs { display: flex; gap: 6px; padding: 10px 12px 0; flex-wrap: wrap; }',
  '.aisd__tab { border: 1px solid var(--pta-violet-line); border-bottom: none; border-radius: 10px 10px 0 0; background: var(--pta-card-2); color: var(--pta-violet-text); padding: 7px 16px; font-size: 12.5px; cursor: pointer; transition: background .15s ease, color .15s ease, box-shadow .15s ease; }',
  '.aisd__tab:hover { background: var(--pta-violet-soft); }',
  '.aisd__tab--on { background: var(--pta-card); color: var(--pta-violet-text); font-weight: bold; box-shadow: inset 0 -2px 0 var(--pta-violet); }',
  '.aisd__tab--locked { color: var(--pta-ink-faint); border-style: dashed; background: transparent; }',
  '.aisd__tab--locked:hover { color: var(--pta-ink-soft); }',
  '.aisd__locked { padding: 26px 18px; text-align: center; color: var(--pta-ink-soft); }',
  '.aisd__locked b { font-size: 14px; color: var(--pta-ink); }',
  '.aisd__locked p { max-width: 560px; margin: 8px auto 14px; line-height: 1.6; }',
  '.aisd__steps { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 10px 14px 0; }',
  '.aisd__step { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--pta-ink-faint); white-space: nowrap; }',
  '.aisd__step-n { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: bold; border: 1px solid var(--pta-line); background: var(--pta-card-2); color: var(--pta-ink-faint); }',
  '.aisd__step.is-done .aisd__step-n { background: var(--pta-ok-soft); border-color: var(--pta-ok-line); color: var(--pta-ok-text); }',
  '.aisd__step.is-done { color: var(--pta-ink-soft); }',
  '.aisd__step.is-now { color: var(--pta-violet-text); font-weight: 600; }',
  '.aisd__step.is-now .aisd__step-n { background: var(--pta-violet); border-color: var(--pta-violet); color: #fff; box-shadow: 0 0 0 3px var(--pta-violet-soft); }',
  '.aisd__step-line { flex: 0 0 18px; height: 1px; background: var(--pta-line); margin: 0 2px; }',
  '.aisd__pane { display: none; }',
  '.aisd__pane--on { display: block; animation: ptaFadeIn .18s ease; }',
  '.aisd__bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0 0 12px; }',
  '.aisd__stage { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 12.5px; }',
  '.aisd__dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(151, 117, 250, .45); background: transparent; box-sizing: border-box; flex: 0 0 auto; transition: background .3s ease, border-color .3s ease, transform .3s var(--pta-ease); position: relative; z-index: 1; }',
  '.aisd__dot--run { background: var(--pta-violet); border-color: var(--pta-violet); transform: scale(1.2); animation: ais-pulse 1.4s ease-out infinite; }',
  '.aisd__dot--ok { background: #40c057; border-color: #40c057; }',
  '.aisd__dot--bad { background: var(--pta-fail); border-color: var(--pta-fail); box-shadow: 0 0 10px rgba(224, 49, 49, .5); }',
  '.aisd__stage { position: relative; }',
  '.aisd__stage:not(:last-of-type)::after { content: ""; position: absolute; left: 5px; top: 17px; bottom: -6px; width: 2px; background: rgba(151, 117, 250, .22); border-radius: 2px; transition: background .3s ease; }',
  '.aisd__stage--done:not(:last-of-type)::after { background: #40c057; }',
  '.aisd__ev { background: #1e2227; color: #e6e6e6; border-radius: 10px; padding: 10px 12px; font: 11.5px/1.5 var(--font-family); font-variant-numeric: tabular-nums; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; scrollbar-width: thin; animation: ptaFadeIn .2s ease; }',
  '.aisd__meta { color: var(--pta-ink-faint); font-size: 11.5px; }',
  '.aisd__mtable { width: 100%; border-collapse: collapse; font-size: 11.5px; }',
  '.aisd__mtable td, .aisd__mtable th { padding: 3px 6px; border-bottom: 1px solid var(--pta-line-soft); text-align: left; }',
  '.aisd__case { border: 1px solid var(--pta-violet-line); border-radius: 10px; padding: 8px 10px; margin: 6px 0; font-size: 12px; transition: background .15s ease, border-color .15s ease; animation: ptaFadeUp .24s var(--pta-ease) backwards; }',
  '.aisd__case:hover { background: var(--pta-violet-soft); }',
  '.aisd__case pre { margin: 4px 0 0; background: var(--pta-card-2); border-radius: 6px; padding: 6px 8px; font-size: 11.5px; white-space: pre-wrap; }',
  '.pta-dark .aisd__case pre { background: #1e2227; }',
  /* ---- programming: knowledge-point labels ---- */
  '.aisk__chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 12px; min-height: 30px; }',
  '.aisk__chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; border: 1px solid var(--pta-violet-line); border-radius: 999px; padding: 4px 6px 4px 11px; font-size: 12.5px; background: var(--pta-violet-soft); color: var(--pta-violet-text); animation: ptaScaleIn .18s var(--pta-ease) backwards; }',
  '.aisk__chip b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px; }',
  '.aisk__chip-x { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; border-radius: 50%; opacity: .7; }',
  '.aisk__chip-x:hover { opacity: 1; background: rgba(0, 0, 0, .08); }',
  '.aisk__chip--new { border-style: dashed; }',
  '.aisk__addrow { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }',
  '.aisk__add { flex: 1 1 260px; max-width: 460px; }',
  '.aisk__src { font-size: 11px; color: var(--pta-ink-faint); }',
  '.pta-dark .aisk__chip { background: #322a48; color: #cdbdfb; border-color: #4a3d6b; }',
  '.aisk__targets { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--pta-ink-soft); margin: 0 0 8px; }',
  '.aisk__target { display: inline-block; border-radius: 999px; padding: 2px 9px; font-size: 11.5px; border: 1px dashed var(--pta-line); color: var(--pta-ink-soft); }',
  '.aisk__target--ok { border-style: solid; border-color: var(--pta-ok-line); background: var(--pta-ok-soft); color: var(--pta-ok-text); }',
  '.aisk__target--miss { border-style: solid; border-color: var(--pta-warn-line); background: var(--pta-warn-soft); color: var(--pta-warn-text); }',
  '.aisd__diff { display: flex; flex-direction: column; gap: 4px; }',
  '.aisd__diff-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
  '.aisd__diff-score { font-size: 22px; font-weight: 700; color: var(--pta-violet-text); line-height: 1; }',
  '.aisd__diff-score small { font-size: 12px; font-weight: 500; color: var(--pta-ink-faint); }',
  '.aisd__diff-score--none { color: var(--pta-ink-faint); }',
  '.aisd__diff-band { font-size: 12px; color: var(--pta-ink-soft); }',
  '.aisd__diff-input { width: 64px !important; text-align: center; }',
  '.aisd__diff-why { font-style: italic; }',
  '.aisk__side { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }',
  '.aisk__tag { display: inline-block; border-radius: 999px; padding: 2px 9px; font-size: 11.5px; background: var(--pta-violet-soft); color: var(--pta-violet-text); border: 1px solid var(--pta-violet-line); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.pta-dark .aisk__tag { background: #322a48; color: #cdbdfb; border-color: #4a3d6b; }',
  '.aisk__busy { display: inline-flex; align-items: center; gap: 8px; color: var(--pta-violet-text); font-size: 12.5px; }',
  '.aisk__busy i { width: 12px; height: 12px; border: 2px solid var(--pta-violet-line); border-top-color: var(--pta-violet); border-radius: 50%; animation: aisk-spin .8s linear infinite; }',
  '@keyframes aisk-spin { to { transform: rotate(360deg); } }',
  '.aisk__err { color: var(--pta-fail); font-size: 12px; margin: 0 0 10px; }',
  '.ais__mismatch { margin: 0 0 12px; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--pta-warn-line); border-left-width: 4px; border-left-color: var(--pta-warn); background: var(--pta-warn-soft); color: var(--pta-ink); font-size: 12.5px; line-height: 1.6; }',
  '.ais__mismatch code { font-family: var(--code-font-family); }',
  '.aisk__tabspin { display: inline-block; vertical-align: -2px; width: 11px; height: 11px; border: 2px solid var(--pta-violet-line); border-top-color: var(--pta-violet); border-radius: 50%; animation: aisk-spin .8s linear infinite; }',
  /* ---- objective: the quiz setup panel ---- */
  '.aisq__setup { border: 1px solid rgba(12, 166, 120, .35); border-radius: var(--pta-radius-lg); padding: 14px 16px 16px; margin-bottom: 18px; background: var(--pta-card); }',
  '.aisq__setup-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-weight: bold; font-size: 13.5px; color: var(--pta-ink); margin-bottom: 12px; }',
  '.aisq__setup-head .aisd__meta { font-weight: normal; }',
  '.aisq__grid { display: grid; grid-template-columns: repeat(3, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; }',
  '@media (max-width: 780px) { .aisq__grid { grid-template-columns: 1fr; } }',
  '.aisq__grid select { width: 100%; }',
  '.aisq__types { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }',
  '.aisq__type-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--pta-line); border-radius: 999px; padding: 5px 13px; font-size: 12.5px; cursor: pointer; background: var(--pta-card-2); color: var(--pta-ink-soft); transition: border-color .15s, background .15s, color .15s; }',
  '.aisq__type-chip:hover { border-color: rgba(12, 166, 120, .5); }',
  '.aisq__type-chip--on { border-color: #0ca678; background: #ebfbee; color: #0b7a56; font-weight: bold; }',
  '.pta-dark .aisq__type-chip--on { background: #10331d; color: #69db7c; }',
  '.aisq__type-chip input { margin: 0; accent-color: #0ca678; }',
  /* ---- per-kind page identity ---- */
  '.ais__head--obj { background: linear-gradient(100deg, #0ca678 0%, #20c997 55%, #63e6be 100%); }',
  '.ais__head--subj { background: linear-gradient(100deg, #7048e8 0%, #9775fa 55%, #d0bfff 100%); }',
  '.aisd--obj .aisd__tab--on { box-shadow: inset 0 -2px 0 #0ca678; }',
  '.aisd--subj .aisd__tab--on { box-shadow: inset 0 -2px 0 #7048e8; }',
  /* ---- objective: the quiz workbench ---- */
  '.aisq { margin: 4px 0 14px; }',
  '.aisq__summary { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; font-size: 12.5px; }',
  '.aisq__count { font-weight: bold; color: var(--pta-ink); }',
  '.aisq__pts { border-radius: 10px; padding: 2px 10px; background: #ebfbee; color: #2b8a3e; font-weight: bold; }',
  '.aisq__pts--warn { background: #fff4e6; color: #e8590c; }',
  '.pta-dark .aisq__pts { background: #10331d; color: #69db7c; }',
  '.pta-dark .aisq__pts--warn { background: #3a2410; color: #ffa94d; }',
  '.aisq__card { border: 1px solid var(--pta-line); border-radius: var(--pta-radius-lg); padding: 12px 14px; margin: 0 0 10px; background: var(--pta-card); animation: ptaFadeUp .22s var(--pta-ease) backwards; }',
  '.aisq__card:hover { border-color: rgba(12, 166, 120, .45); }',
  '.aisq__head { display: flex; align-items: center; gap: 9px; margin-bottom: 7px; flex-wrap: wrap; }',
  '.aisq__num { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 7px; background: linear-gradient(120deg, #20c997, #0ca678); color: #fff; font: bold 12px/1 var(--font-family); font-variant-numeric: tabular-nums; flex: 0 0 auto; }',
  '.aisq__type { font-size: 12px; font-weight: bold; color: var(--pta-ink-soft); }',
  '.aisq__id { font: 11px/1 var(--font-family); font-variant-numeric: tabular-nums; color: var(--pta-ink-faint); }',
  '.aisq__score { margin-left: auto; font-size: 11.5px; border-radius: 9px; padding: 2px 9px; background: var(--pta-card-2); color: var(--pta-ink-soft); }',
  '.aisq__stem { font-size: 13px; line-height: 1.6; }',
  '.aisq__stem p { margin: 0 0 6px; }',
  '.aisq__opts { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }',
  '.aisq__opt { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; border: 1px solid var(--pta-line-soft); border-radius: 9px; padding: 6px 10px; background: var(--pta-card-2); }',
  '.aisq__opt--ok { border-color: #40c057; background: #ebfbee; }',
  '.pta-dark .aisq__opt--ok { background: #10331d; }',
  '.aisq__letter { font: bold 11.5px/1.5 var(--font-family); font-variant-numeric: tabular-nums; color: var(--pta-ink-faint); flex: 0 0 auto; min-width: 14px; }',
  '.aisq__opt--ok .aisq__letter { color: #2b8a3e; }',
  '.aisq__tick { margin-left: auto; color: #2b8a3e; font-weight: bold; }',
  '.aisq__ans { margin-top: 8px; font-size: 12.5px; color: var(--pta-ink-soft); }',
  '.aisq__or { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--pta-ok-text); margin: 0 2px; }',
  '.aisq__ans code { background: #ebfbee; color: #2b8a3e; border-radius: 6px; padding: 1px 7px; }',
  '.pta-dark .aisq__ans code { background: #10331d; color: #69db7c; }',
  '.aisq__titlerow { margin-bottom: 12px; }',
  '.aisq__src { border: 1px dashed var(--pta-line); border-radius: var(--pta-radius-lg); padding: 10px 12px; margin: 4px 0 0; }',
  '.aisq__src > summary { cursor: pointer; font-size: 12.5px; font-weight: bold; color: var(--pta-ink-soft); }',
  '.aisq__src > summary .aisd__meta { font-weight: normal; display: block; margin-top: 3px; }',
  '.aisq__src textarea { margin-top: 10px; }',
  /* ---- shared: editor host + field headers + toolbar hint ---- */
  '.aisd__host { position: relative; }',
  /* The rich editor injects itself here, beside the textarea it replaces. */
  '.aisd__host .editor-container, .aisd__host .monaco-editor { border-radius: var(--pta-radius-lg); overflow: hidden; }',
  '.aisd__fieldhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 14px 0 6px; }',
  '.aisd__fieldhead .aisd__meta { text-transform: none; letter-spacing: 0; }',
  '.aisd__toolhint { margin: 8px 0 2px; font-size: 12.5px; color: var(--pta-ink-soft); line-height: 1.5; }',
  '.aisd__pidchip { margin-left: 8px; font-family: var(--font-family); font-weight: bold; letter-spacing: .03em; }',
  '.aisd__bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }'
].concat(AIS_POLISH).join('\n');

const STAGES = [
  ['generate', 'Generate'],
  ['precheck', 'Prepare'],
  ['build', 'Run reference'],
  ['crosscheck', 'Cross-check'],
  ['testdata', 'Upload testdata'],
  ['judge', 'Judge verify'],
  ['calibrate', 'Calibrate limits'],
  ['report', 'Teacher report'],
  ['label', 'Knowledge points'],
  ['rate', 'Difficulty'],
];

/** Objective drafts skip the sandbox entirely: validate -> assemble -> report. */
const OBJ_STAGES = [
  ['generate', 'Answer key'],
  ['precheck', 'Validate'],
  ['materialize', 'Assemble quiz'],
  ['report', 'Teacher report'],
];
/** Subjective drafts have nothing to verify — only assembly and the briefing. */
const SUBJ_STAGES = [
  ['materialize', 'Assemble assignment'],
  ['report', 'Grading briefing'],
];
const kindOf = (d) => (d?.kind || d?.brief?.kind || 'programming');
const isObjDraft = (d) => kindOf(d) === 'objective';
const isSubjDraft = (d) => kindOf(d) === 'subjective';
/**
 * Phase 1 runs a single step, and it is NOT the first step of the post-
 * approval pipeline: an objective draft busy writing its QUESTIONS was
 * previously labelled "Answer key", because both use stage id 'generate'.
 */
const REVIEW_STAGE = {
  objective: [['generate', 'Draft questions']],
  subjective: [['generate', 'Draft assignment']],
  programming: [['generate', 'Draft statement']],
};
function stageListFor(d) {
  const kind = kindOf(d);
  if (phaseOf(d) !== 'approved') return REVIEW_STAGE[kind] || REVIEW_STAGE.programming;
  return kind === 'objective' ? OBJ_STAGES : kind === 'subjective' ? SUBJ_STAGES : STAGES;
}

/**
 * Where the draft sits in the two-phase flow. The server computes this (it
 * owns the legacy-draft rule); this fallback only covers a stale payload.
 */
function phaseOf(d) {
  if (d?.phase) return d.phase;
  if (!d?.artifacts?.statement) return 'brief';
  if (d.approved) return 'approved';
  return (isObjDraft(d) ? d.artifacts.answers : d.artifacts.solution) ? 'approved' : 'review';
}

/** Wording for the statement pane, per kind. */
const STATEMENT_LABEL = {
  programming: 'Statement',
  objective: 'Questions',
  subjective: 'Assignment brief',
};
const STATEMENT_HINT = {
  programming: 'Markdown. Leave out samples — the judge computes them from your tests.',
  objective: 'Markdown with {{ input / select / multiselect / dropdown }} markers.',
  subjective: 'Markdown: the deliverables, what the report must contain, and the grading rubric.',
};

/**
 * The rich editor mounts by appending to its textarea's PARENT, so the
 * textarea needs its own wrapper — otherwise the editor is injected after
 * whatever follows it, which is how the Save button ended up floating above
 * the toolbar instead of below the text.
 */
const editorHost = (rows, body) => `<div class="aisd__host"><textarea class="aisd__body-md" rows="${rows}" spellcheck="false">${esc(body)}</textarea></div>`;
const QT_LABEL = { tf: 'True / False', single: 'Single choice', multi: 'Multiple choice', fill: 'Fill in the blank', dropdown: 'Dropdown', short: 'Short answer' };
const answersCount = (yaml) => (String(yaml || '').match(/^\s*['"]?\d+(?:-\d+)?['"]?:/gm) || []).length;

/** Read-only per-question digest under the Answers editor. */
function answersPreview(d) {
  const yaml = (d.artifacts && d.artifacts.answers && d.artifacts.answers.yaml) || '';
  const body = (d.artifacts && d.artifacts.statement && d.artifacts.statement.body) || '';
  const kinds = {};
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const re = /\{\{ (input|select|multiselect|textarea|dropdown)\((\d+(?:-\d+)?)\)(?:\[[^\]]*\])? \}\}/g;
    let m;
    while (m = re.exec(line)) kinds[m[2]] = m[1]; // eslint-disable-line no-cond-assign
  }
  const rows = [];
  for (const line of yaml.split('\n')) {
    const m = /^\s*['"]?([\d-]+)['"]?:\s*\[(.*)\]\s*$/.exec(line);
    if (!m) continue;
    rows.push(`<div class="aisd__case"><b>Q${esc(m[1])}</b> <span class="ais__chip">${esc(kinds[m[1]] || '?')}</span> <span class="aisd__meta">[${esc(m[2])}]</span></div>`);
  }
  return rows.length ? rows.join('') : `<div class="ais__empty">${esc(i18n('No answer key yet.'))}</div>`;
}

let state = null; // the draft
let lastFp = ''; // artifact fingerprint: re-render tabs when it changes
const artifactFp = (d) => JSON.stringify([
  d?.artifacts?.statement?.title,
  d?.artifacts?.statement?.body?.length,
  d?.artifacts?.solution?.code?.length,
  d?.artifacts?.alt?.code?.length,
  (d?.artifacts?.tests || []).length,
  !!d?.artifacts?.report,
  d?.artifacts?.answers?.yaml?.length || 0,
  (d?.artifacts?.knowledge?.points || []).map((x) => x.name).join('\u0001'),
  d?.brief?.kind || 'programming',
  phaseOf(d),
  (d?.chat || []).length,
]);
let langsMap = {}; // judge languages from the server (scratchpad-identical set)
let backendBuild = ''; // AI_STUDIO_BUILD reported by the running process
let activePane = null; // which tab survives re-renders
let pollTimer = null;
let lastSideFp = ''; // sidebar re-renders only when this changes
const sideFp = () => {
  const p = state?.pipeline || {};
  return JSON.stringify([p.status, p.stage, p.message, (p.evidence || '').length,
    (state?.log || []).length, state?.measured?.time, state?.published,
    (state?.artifacts?.knowledge?.points || []).map((x) => x.name).join('\u0001'), knowledgeBusy,
    state?.artifacts?.difficulty?.score, state?.artifacts?.difficulty?.source, difficultyBusy]);
};
/** Difficulty rating state + the bands (intro 1-3, medium 4-7, challenge 8-10) — module scope. */
let difficultyBusy = false;
const DIFF_BANDS = { intro: [1, 3], medium: [4, 7], challenge: [8, 10] };
/*
 * Knowledge-point labeling state. `knowledgeBusy` is set while a model
 * call is in flight (auto or manual); `knowledgeAutoTried` makes the
 * automatic backfill run at most once per page load, so a failing provider
 * cannot loop.
 */
let knowledgeBusy = false;
let knowledgeAutoTried = false;
let knowledgeAutoError = '';

/*
 * Frontend/backend pairing. This page is written against one backend build
 * (AI_STUDIO_BUILD in handler/ai_author.ts); the stamps are date-prefixed,
 * so a plain string comparison orders them. When the running process is
 * older than this page, its handlers reject the newer operations and
 * targets with "Unknown target" — say so up front, with the fix, instead of
 * surfacing that message on every click.
 */
const UI_BUILD = '2026-08-30a-difficulty';
const backendOlderThanUi = () => (backendBuild || '') < UI_BUILD;
function buildMismatchHtml() {
  if (!backendOlderThanUi()) return ''; // an empty stamp means a backend from before stamping — older too
  return `<div class="ais__mismatch">⚠ <b>${esc(i18n('The backend is running an older build than this page.'))}</b> ${esc(i18n('Backend build'))}: <code>${esc(backendBuild || i18n('unknown'))}</code> · ${esc(i18n('this page needs'))} <code>${esc(UI_BUILD)}</code>. ${esc(i18n('Restart hydrooj (in dev mode, its watcher only re-applies the handler file that changed, so a full restart is the reliable way). Until then, new actions such as knowledge-point labeling fail with "Unknown target".'))}</div>`;
}
let statementEditor = null;

function j(v) {
  return JSON.stringify(v, null, 2);
}

/* --------------------------- rendering ---------------------------- */

function stageDots(p, list = STAGES) {
  const idx = list.findIndex(([k]) => k === p.stage);
  return list.map(([k, label], i) => {
    let cls = '';
    if (p.status === 'running') {
      if (i < idx) cls = 'aisd__dot--ok';
      else if (i === idx) cls = 'aisd__dot--run';
    } else if (p.status === 'passed') cls = 'aisd__dot--ok';
    else if (p.status === 'failed') {
      if (i < idx) cls = 'aisd__dot--ok';
      else if (i === idx || (idx < 0 && i === 0)) cls = 'aisd__dot--bad';
    }
    const rowCls = cls === 'aisd__dot--ok' ? ' aisd__stage--done' : '';
    const live = cls === 'aisd__dot--run';
    return `<div class="aisd__stage${rowCls}"><span class="aisd__dot ${cls}"></span><span style="${live ? 'font-weight:bold;' : ''}">${esc(i18n(label))}</span></div>`;
  }).join('');
}

function sideHtml(d) {
  const p = d.pipeline || {};
  const list = stageListFor(d);
  const badgeCls = { idle: 'ais__badge--idle', running: 'ais__badge--running', passed: 'ais__badge--passed', failed: 'ais__badge--failed' }[p.status] || 'ais__badge--idle';
  const measured = d.measured ? `
    <div class="ais__label">⏱ ${esc(i18n('Measured (reference solution)'))}</div>
    <table class="aisd__mtable"><tr><th>${esc(i18n('Case'))}</th><th>ms</th><th>KiB</th></tr>
      ${d.measured.cases.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.timeMs}</td><td>${c.memoryKiB}</td></tr>`).join('')}</table>
    <div class="aisd__meta" style="margin-top:6px;">${esc(i18n('Calibrated limits'))}: <b>${esc(d.measured.time)}</b> / <b>${esc(d.measured.memory)}</b></div>` : '';
  const logs = (d.log || []).slice(-8).reverse().map((l) => `<div class="aisd__meta">${esc(fmtTs(l.at))} · ${esc(l.actor)} · ${esc(l.action)}${l.detail ? ` — ${esc(l.detail)}` : ''}</div>`).join('');
  return `
    <div class="ais">
      <div class="ais__head">🧪 <span class="ais__title">${esc(i18n('Verification'))}</span>
        ${p.status === 'running' && p.startedAt ? `<span class="ais__chip">⏱ <span class="ais__timer">${Math.max(0, Math.round((Date.now() - new Date(p.startedAt).getTime()) / 1000))}</span>s</span>` : ''}
        <span class="ais__hint"><span class="ais__badge ${badgeCls}" style="background:rgba(255,255,255,.18);color:#fff;">${esc(i18n(p.status || 'idle'))}</span></span></div>
      <div class="ais__body">
        ${(() => {
    const idx = list.findIndex(([k]) => k === p.stage);
    if (!['running', 'failed', 'passed'].includes(p.status)) return '';
    const pct = p.status === 'passed' ? 100 : Math.round((Math.max(0, idx) / list.length) * 100);
    const mod = p.status === 'running' ? ' ais__progress--live' : p.status === 'failed' ? ' ais__progress--bad' : '';
    return `<div class="ais__progress${mod}"><i style="width:${Math.max(pct, p.status === 'running' ? 6 : 3)}%"></i></div>`;
  })()}
        ${stageDots(p, list)}
        ${p.message ? `<div class="aisd__meta${p.status === 'running' ? ' ais__msg--live' : ''}" style="margin-top:6px;">${esc(p.message)}</div>` : ''}
        ${p.evidence ? `<div class="ais__label">🔍 ${esc(i18n(p.stage === 'generate' ? 'What the AI actually replied' : 'Judge evidence'))}</div><div class="aisd__ev">${esc(p.evidence)}</div>` : ''}
        ${p.status === 'failed' && p.stage === 'crosscheck' ? `<div class="aisd__meta" style="margin-top:6px;">💡 ${esc(i18n('If the statement is ambiguous for this input (e.g. negative values), clarify it in the Statement tab and verify again — or edit either solution directly.'))}</div>
        <button class="ais__btn ais__btn--sm aisd__skipcc" style="margin-top:8px;">✋ ${esc(i18n('Trust the reference — re-verify without cross-check'))}</button>` : ''}
        ${measured}
        ${kindOf(d) === 'programming' && d.artifacts.statement ? difficultySideHtml(d) : ''}
        ${kindOf(d) === 'programming' && ((d.artifacts.knowledge || {}).points || []).length ? `
        <div class="ais__label">🏷️ ${esc(i18n('Knowledge points'))}</div>
        <div class="aisk__side">${d.artifacts.knowledge.points.map((x) => `<span class="aisk__tag" title="${esc(x.evidence || '')}">${esc(x.name)}</span>`).join('')}
          <a href="javascript:;" class="aisk__side-edit aisd__meta">${esc(i18n('edit'))}</a></div>` : ''}
        ${(d.docIds || []).length ? `<div class="aisd__meta" style="margin-top:10px;">${esc(i18n((d.docIds || []).length > 1 ? 'Draft problems (one per question)' : 'Draft problem'))}: ${(d.docIds || []).map((x, k) => `<a href="${domainPrefix()}/p/${x}" target="_blank" rel="noopener">${esc((d.pids || [])[k] || `#${x}`)}</a>`).join(' · ')}${d.published ? ` · <b>${esc(i18n('Published'))}</b>` : ` (${esc(i18n('hidden'))})`}</div>` : ''}
        ${logs ? `<div class="ais__label">📜 ${esc(i18n('Recent activity'))}</div>${logs}` : ''}
        ${backendBuild ? `<div class="aisd__meta" style="margin-top:10px;opacity:.65;">${esc(i18n('Backend build'))}: <code>${esc(backendBuild)}</code></div>` : ''}
      </div>
    </div>`;
}

function casesPreview(tests) {
  if (!tests?.length) return `<div class="ais__empty">${esc(i18n('No tests yet.'))}</div>`;
  return tests.map((c, i) => `<div class="aisd__case"><b>${i + 1}. ${esc(c.name)}</b>
    ${c.sample ? `<span class="ais__chip">${esc(i18n('sample'))}</span>` : ''}
    ${c.gen ? `<span class="ais__chip">⚙ ${esc(i18n('generator'))}</span>` : ''}
    <span class="aisd__meta">${esc(c.purpose || '')}</span>
    ${c.gen
    ? `<div class="aisd__meta" style="margin-top:4px;">${esc(i18n('Generated case — the Python program below produces the input in the sandbox.'))}</div><pre>${esc(c.gen)}</pre>`
    : `<pre>${esc(c.input)}</pre>`}</div>`).join('');
}

function reportPane(d) {
  const r = d.artifacts.report;
  if (!r) {
    return `<div class="ais__empty">${esc(i18n('No report yet — it is generated automatically after verification passes.'))}</div>`;
  }
  const list = (items) => (items?.length ? `<ul style="margin:4px 0 0 18px;padding:0;">${items.map((x) => `<li style="margin:3px 0;">${esc(x)}</li>`).join('')}</ul>` : '');
  return `
    <div class="ais__label">💡 ${esc(i18n('Key idea'))}</div>
    <div>${esc(r.summary || '')}</div>
    <div class="ais__label">🎯 ${esc(i18n('Knowledge points tested'))}</div>
    ${list(r.knowledgePoints)}
    <div class="ais__label">🧾 ${esc(i18n('Test case design'))}</div>
    <div>${esc(r.caseDesign || '')}</div>
    <div class="ais__label">⚠️ ${esc(i18n('Common pitfalls'))}</div>
    ${list(r.pitfalls)}`;
}

/**
 * The statement-review conversation. Rendered inside the statement pane so
 * the teacher can read the text they are discussing while they type.
 */
function chatPanel(d) {
  const turns = d.chat || [];
  const kind = kindOf(d);
  const what = kind === 'objective' ? i18n('these questions') : kind === 'subjective' ? i18n('this assignment') : i18n('this statement');
  const log = turns.length
    ? turns.map((t) => (t.role === 'user'
      ? `<div class="aisc__turn aisc__turn--user">${esc(t.content)}</div>`
      : `<div class="aisc__turn aisc__turn--ai"><span class="aisc__tag">${esc(i18n('AI'))}</span><br>${esc(t.content)}</div>`)).join('')
    : `<div class="aisc__empty">${esc(i18n('Ask for a change and the AI rewrites the text above — for example: "make the constraints smaller", "add a worked example", "写成中文".'))}</div>`;
  return `
    <div class="aisc">
      <div class="aisc__head">💬 ${esc(i18n('Refine with the AI'))}
        <span style="font-weight:normal;opacity:.8;">${esc(i18n('Tell it what to change about'))} ${esc(what)}</span>
        ${turns.length ? `<button class="ais__btn ais__btn--ghost ais__btn--sm aisc__clear">${esc(i18n('Clear chat'))}</button>` : ''}
      </div>
      <div class="aisc__log">${log}</div>
      <div class="aisc__form">
        <textarea class="aisc__input" rows="2" placeholder="${esc(i18n('Describe the change you want, then press Send (Ctrl+Enter)'))}"></textarea>
        <button class="ais__btn ais__btn--sm aisc__send">${esc(i18n('Send'))}</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/*  Objective quizzes: parse the markdown into per-question cards      */
/* ------------------------------------------------------------------ */
const MARKER_RE = /\{\{ (input|select|multiselect|textarea|dropdown)\((\d+(?:-\d+)?)\)(?:\[([^\]]*)\])? \}\}/;
const MARKER_RE_G = new RegExp(MARKER_RE.source, 'g');
const QKIND = {
  input: { key: 'fill', label: 'Fill in the blank', icon: '✏️' },
  textarea: { key: 'short', label: 'Short answer', icon: '📄' },
  select: { key: 'single', label: 'Single choice', icon: '🔘' },
  multiselect: { key: 'multi', label: 'Multiple choice', icon: '☑️' },
  dropdown: { key: 'dropdown', label: 'Dropdown', icon: '🔽' },
};
const letter = (i) => String.fromCharCode(65 + i);

/** One answer-key line: `'3': [[A, B], 20]` -> { answer, score }. */
function parseAnswerLine(line) {
  const m = /^\s*['"]?([\d-]+)['"]?:\s*\[(.*)\]\s*$/.exec(line);
  if (!m) return null;
  const inner = m[2];
  const cut = inner.lastIndexOf(',');
  if (cut < 0) return null;
  const raw = inner.slice(0, cut).trim();
  const score = Number(inner.slice(cut + 1).trim());
  const answer = /^\[.*\]$/.test(raw)
    ? raw.slice(1, -1).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter((x) => x)
    : raw.replace(/^['"]|['"]$/g, '');
  return { id: m[1], answer, score: Number.isFinite(score) ? score : null };
}

/**
 * Turn the quiz markdown (plus its key, when one exists) into structured
 * questions. Deliberately mirrors the server's extractQuestionMeta so the
 * cards show exactly what the judge will grade — if a card looks wrong, the
 * markup IS wrong.
 */
function parseQuestions(body, answersYaml) {
  const lines = String(body || '').split('\n');
  const out = [];
  let fence = false;
  let buf = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; buf.push(line); continue; }
    if (fence) { buf.push(line); continue; }
    const m = MARKER_RE.exec(line);
    if (!m) { buf.push(line); continue; }
    const [full, tag, id, inline] = m;
    const meta = QKIND[tag] || { key: tag, label: tag, icon: '•' };
    const q = { id, tag, kind: meta.key, label: meta.label, icon: meta.icon, options: [] };
    if (tag === 'dropdown' && inline) q.options = inline.split(',').map((x) => x.trim()).filter((x) => x);
    if (tag === 'select' || tag === 'multiselect') {
      for (let k = i + 1; k < lines.length; k++) {
        const t = lines[k].trim();
        if (!t) { if (q.options.length) break; continue; }
        const om = /^[-*]\s+(.*)$/.exec(t);
        if (!om) break;
        q.options.push(om[1].trim());
        i = k;
      }
    }
    // A blank marker stands in for missing text, so show a blank. A choice
    // marker only anchors the option list below it — leave nothing behind.
    const ph = (tag === 'select' || tag === 'multiselect') ? '' : ' ______ ';
    q.stem = [...buf, line.replace(full, ph)].join('\n')
      .replace(MARKER_RE_G, ph)
      .replace(/^\s*\d+[.、)]\s*/, '')
      .trim();
    buf = [];
    out.push(q);
  }
  const byId = {};
  for (const l of String(answersYaml || '').split('\n')) {
    const a = parseAnswerLine(l);
    if (a) byId[a.id] = a;
  }
  for (const q of out) {
    const a = byId[q.id];
    if (a) { q.answer = a.answer; q.score = a.score; }
  }
  return out;
}

/** Is this option letter part of the correct answer? */
function isCorrect(q, idx) {
  if (q.answer === undefined) return false;
  const L = letter(idx);
  return Array.isArray(q.answer) ? q.answer.includes(L) : q.answer === L;
}

/** The quiz workbench: one card per question, answers shown once they exist. */
function questionCards(d) {
  const qs = parseQuestions(d.artifacts.statement && d.artifacts.statement.body,
    d.artifacts.answers && d.artifacts.answers.yaml);
  if (!qs.length) {
    return `<div class="ais__empty">${esc(i18n('No question markers found. Check the markdown source below — every question needs a {{ ... }} marker.'))}</div>`;
  }
  const total = qs.reduce((a, q) => a + (q.score || 0), 0);
  const hasKey = qs.some((q) => q.answer !== undefined);
  const head = `<div class="aisq__summary">
    <span class="aisq__count">${qs.length} ${esc(i18n('questions'))}</span>
    ${qs.length > 1 ? `<span class="aisd__meta">${esc(i18n('publishes as'))} ${qs.length} ${esc(i18n('separate tasks — each worth 100 points on its own'))}</span>` : ''}
    ${hasKey ? `<span class="aisq__pts ${total === 100 ? '' : 'aisq__pts--warn'}">${total} ${esc(i18n('points total'))}${total === 100 ? '' : ` ⚠ ${esc(i18n('should be 100'))}`}</span>` : `<span class="aisd__meta">${esc(i18n('Answer key not written yet'))}</span>`}
  </div>`;
  const cards = qs.map((q, n) => {
    let opts = '';
    if (q.options.length) {
      opts = `<ol class="aisq__opts">${q.options.map((o, i) => {
        const ok = isCorrect(q, i);
        return `<li class="aisq__opt${ok ? ' aisq__opt--ok' : ''}"><span class="aisq__letter">${q.tag === 'dropdown' ? '·' : letter(i)}</span><span>${esc(o)}</span>${ok ? `<span class="aisq__tick">✓</span>` : ''}</li>`;
      }).join('')}</ol>`;
    }
    let ans = '';
    if (q.answer !== undefined && !q.options.length) {
      // A blank may accept several alternatives (the key holds an array).
      const alts = Array.isArray(q.answer) ? q.answer : [q.answer];
      ans = `<div class="aisq__ans">${esc(i18n('Expected'))}: ${alts.map((a) => `<code>${esc(a)}</code>`).join(` <span class="aisq__or">${esc(i18n('or'))}</span> `)}</div>`;
    } else if (q.answer !== undefined && q.tag === 'dropdown') {
      ans = `<div class="aisq__ans">${esc(i18n('Expected'))}: <code>${esc(Array.isArray(q.answer) ? q.answer.join(', ') : q.answer)}</code></div>`;
    }
    return `<div class="aisq__card">
      <div class="aisq__head">
        <span class="aisq__num">${n + 1}</span>
        <span class="aisq__type">${q.icon} ${esc(i18n(q.label))}</span>
        <span class="aisq__id">#${esc(q.id)}</span>
        ${q.score != null ? `<span class="aisq__score">${q.score} ${esc(i18n('pts'))}</span>` : ''}
      </div>
      <div class="aisq__stem typo">${aiMarkdown.render(q.stem || '')}</div>
      ${opts}${ans}
    </div>`;
  }).join('');
  return head + cards;
}

/* ------------------------------------------------------------------ */
/*  Shared page parts                                                  */
/* ------------------------------------------------------------------ */
const KIND_THEME = {
  programming: { cls: 'aisd--prog', icon: '💻', name: 'Programming task' },
  objective: { cls: 'aisd--obj', icon: '📝', name: 'Objective task' },
  subjective: { cls: 'aisd--subj', icon: '📄', name: 'Subjective task' },
};

function bannerHtml(d) {
  const kind = kindOf(d);
  const t = KIND_THEME[kind] || KIND_THEME.programming;
  return `<div class="ais__banner">← <a href="${domainPrefix()}/ai-studio">${esc(i18n('All drafts'))}</a>
    <span style="margin-left:6px;">${esc(d.brief.topic)}</span>
    ${d.pid ? `<span class="ais__chip aisd__pidchip" title="${esc(i18n('Problem ID — its prefix marks the task kind'))}">${esc(d.pid)}${(d.pids || []).length > 1 ? ` ×${d.pids.length}` : ''}</span>` : ''}
    <span class="ais__chip" style="margin-left:auto;">${t.icon} ${esc(i18n(t.name))} · ${esc(langsMap[d.brief.language] || d.brief.language)} · ${esc(i18n(d.brief.difficulty))}${d.artifacts.difficulty?.score ? ` ${d.artifacts.difficulty.score}/10` : ''} · 📚 ${(d.brief.files || []).length}</span></div>`;
}

/**
 * Toolbar by phase. The review phase deliberately offers exactly two forward
 * moves — regenerate, or Continue — so nothing downstream can start behind
 * the teacher's back while they are still deciding.
 */
function toolbarHtml(d) {
  const busy = d.pipeline.status === 'running';
  const kind = kindOf(d);
  const phase = phaseOf(d);
  const GEN = { objective: 'Generate questions', subjective: 'Draft the assignment', programming: 'Generate statement' };
  const HINT = {
    objective: 'Happy with the questions? Continue — the AI then writes the answer key.',
    subjective: 'Happy with the assignment? Continue to assemble and publish it.',
    programming: 'Happy with the statement? Continue — the AI then writes the solution, cross-check and tests.',
  };
  let mid;
  let hint = '';
  if (phase === 'brief') {
    mid = `<button class="ais__btn aisd__gen" ${busy ? 'disabled' : ''}>✨ ${esc(i18n(GEN[kind] || GEN.programming))}</button>`;
  } else if (phase === 'review') {
    mid = `<button class="ais__btn ais__btn--ghost aisd__gen" ${busy ? 'disabled' : ''}>♻ ${esc(i18n('Regenerate from scratch'))}</button>
            <button class="ais__btn aisd__continue" ${busy ? 'disabled' : ''}>▶ ${esc(i18n('Continue'))}</button>`;
    hint = HINT[kind] || HINT.programming;
  } else if (d.published) {
    /*
     * Published: the remaining decision is who can see it. "Published
     * hidden" is a deliberate state — verify tasks days ahead, reveal at
     * class time — so it gets a labelled chip and a one-click flip, not a
     * buried setting.
     */
    mid = d.publishedHidden
      ? `<span class="ais__chip aisd__vischip">🕶 ${esc(i18n('Published · hidden from students'))}</span>
            <button class="ais__btn aisd__reveal" ${busy ? 'disabled' : ''}>👁 ${esc(i18n('Reveal to students'))}</button>`
      : `<span class="ais__chip aisd__vischip">✅ ${esc(i18n('Published · visible to students'))}</span>
            <button class="ais__btn ais__btn--ghost aisd__unreveal" ${busy ? 'disabled' : ''}>🕶 ${esc(i18n('Hide from students'))}</button>`;
    hint = d.publishedHidden
      ? 'Students cannot see or open this task yet. Reveal it when the class is ready.'
      : 'Hiding pulls the task from the student problem list without unpublishing it.';
  } else {
    mid = `${kind === 'subjective' ? '' : `<button class="ais__btn aisd__verify" ${busy ? 'disabled' : ''}>🧪 ${esc(i18n(kind === 'objective' ? 'Re-validate' : 'Run verification'))}</button>`}
            <button class="ais__btn aisd__publish" ${d.pipeline.status === 'passed' ? '' : 'disabled'}>🚀 ${esc(i18n('Publish'))}</button>
            <label class="aisd__hidebox"><input type="checkbox" class="aisd__pubhidden"> ${esc(i18n('Keep hidden after publishing'))}</label>`;
    if (d.pipeline.status === 'passed') hint = 'Publishing finalizes the task. Tick the box to keep it invisible to students until you reveal it.';
  }
  return `<div class="aisd__bar">
            ${busy ? `<button class="ais__btn ais__btn--danger aisd__stop">⏹ ${esc(i18n('Stop'))}</button>` : ''}
            ${mid}
            <button class="ais__btn ais__btn--danger aisd__discard" ${busy || d.published ? 'disabled' : ''}>🗑 ${esc(i18n('Discard'))}</button>
          </div>${hint ? `<div class="aisd__toolhint">${esc(i18n(hint))}</div>` : ''}`;
}

/** Course material + free-text extras — the same for every kind. */
function materialHtml(d) {
  return `
            <div class="ais__label">📚 ${esc(i18n('Course material'))}</div>
            <div class="aisd__meta" style="margin-bottom:8px;">${esc(i18n('Slides and notes uploaded here ground the generated task. Text is extracted on upload; the original files are not stored.'))}</div>
            <div class="ais__drop aisd__ctx-drop">
              <div class="ais__drop-main">${esc(i18n('Drop the course files here, or click to choose'))}</div>
              <div class="ais__drop-sub">${esc(i18n('Slides, documents, spreadsheets, PDFs, notebooks and source code (.pptx .docx .xlsx .pdf .txt .ipynb .py .cpp …) · legacy .doc / .ppt / .xls are read best-effort · up to 8 files · 15 MB each. Text is extracted on upload; the original files are not stored.'))}</div>
            </div>
            <input type="file" class="aisd__ctx-pick" multiple style="display:none">
            <div class="ais__pills aisd__ctx-list" style="margin-top:10px;">
              ${(d.brief.files || []).length
    ? (d.brief.files || []).map((f) => `<span class="ais__pill">📄 ${esc(f.name)} <span class="aisd__meta">${fmtSize(f.size)} · ${f.chars} ${esc(i18n('chars extracted'))}</span><button type="button" data-name="${esc(f.name)}" title="${esc(i18n('Remove'))}">×</button></span>`).join('')
    : `<span class="ais__empty">${esc(i18n('No context files yet.'))}</span>`}
            </div>
            <div class="ais__label">🧷 ${esc(i18n('Extra requirements (optional)'))}</div>
            <textarea class="aisd__notes" rows="3">${esc(d.brief.notes || '')}</textarea>
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--sm aisd__notes-save">💾 ${esc(i18n('Save notes'))}</button>
            </div>`;
}

const DIFF_SELECT = (d) => `<select class="aisd__difficulty" style="max-width:180px;">
                  ${['intro', 'medium', 'challenge'].map((x) => `<option value="${x}" ${d.brief.difficulty === x ? 'selected' : ''}>${esc(i18n(x))}</option>`).join('')}
                </select>`;

/**
 * OBJECTIVE setup — a quiz brief, not a programming form. Every knob the
 * generator actually reads is here and editable: how many questions, which
 * types, which language they are about, and how hard. The task kind is NOT
 * offered again; it was chosen when the draft was created.
 */
function objectiveSetupHtml(d) {
  const QTYPES = [['tf', 'True / False'], ['single', 'Single choice'], ['multi', 'Multiple choice'],
    ['fill', 'Fill in the blank'], ['dropdown', 'Dropdown'], ['short', 'Short answer']];
  const chosen = new Set(d.brief.qtypes || []);
  const n = d.brief.qcount || 0;
  return `
          <div class="aisd__pane" data-pane="ctx">
            <div class="aisq__setup">
              <div class="aisq__setup-head">📝 ${esc(i18n('Quiz setup'))}
                <span class="aisd__meta">${esc(i18n('The generator reads exactly these settings.'))}</span></div>

              <div class="ais__label" style="margin-top:0;">${esc(i18n('What should the quiz cover?'))}</div>
              <textarea class="aisd__topic" rows="3" spellcheck="false" placeholder="${esc(i18n('e.g. the switch-case statement: syntax, fall-through, and when to prefer it over if-else'))}">${esc(d.brief.topic || '')}</textarea>

              <div class="aisq__grid">
                <div>
                  <div class="ais__label">${esc(i18n('How many questions?'))}</div>
                  <select class="aisd__qcount">
                    <option value="0" ${!n ? 'selected' : ''}>${esc(i18n('Let the AI decide'))}</option>
                    ${[3, 4, 5, 6, 8, 10, 12, 15, 20].map((x) => `<option value="${x}" ${n === x ? 'selected' : ''}>${x}</option>`).join('')}
                    ${n && ![3, 4, 5, 6, 8, 10, 12, 15, 20].includes(n) ? `<option value="${n}" selected>${n}</option>` : ''}
                  </select>
                </div>
                <div>
                  <div class="ais__label">${esc(i18n('Difficulty'))}</div>
                  ${DIFF_SELECT(d)}
                </div>
                <div>
                  <div class="ais__label">${esc(i18n('Language the questions are about'))}</div>
                  <select class="aisd__brieflang">${langOptionsHtml(langsMap, d.brief.language)}</select>
                </div>
              </div>

              <div class="ais__label">${esc(i18n('Question types'))}</div>
              <div class="aisq__types">
                ${QTYPES.map(([v, lb]) => `<label class="aisq__type-chip${chosen.has(v) ? ' aisq__type-chip--on' : ''}">
                  <input type="checkbox" class="aisd__qtype" value="${v}" ${chosen.has(v) ? 'checked' : ''}> ${esc(i18n(lb))}</label>`).join('')}
              </div>
              <div class="aisd__meta" style="margin-top:6px;">${esc(i18n('Leave every type unchecked to let the AI mix them sensibly.'))}</div>

              <div class="aisd__bar" style="margin-top:14px;">
                <button class="ais__btn ais__btn--sm aisd__brief-save">💾 ${esc(i18n('Save setup'))}</button>
                <span class="aisd__meta">${esc(i18n('Then press Generate questions to rebuild the quiz against it.'))}</span>
              </div>
            </div>
            ${materialHtml(d)}
          </div>`;
}

/** PROGRAMMING / SUBJECTIVE setup — the original brief form, minus the kind row. */
function ctxPaneHtml(d) {
  const kind = kindOf(d);
  return `
          <div class="aisd__pane" data-pane="ctx">
            <div class="ais__label">🧠 ${esc(i18n('Task requirement'))}</div>
            <textarea class="aisd__topic" rows="3" spellcheck="false">${esc(d.brief.topic || '')}</textarea>
            <div class="ais__row" style="margin-top:8px;align-items:center;gap:10px;display:flex;flex-wrap:wrap;">
              <div><div class="ais__label" style="margin-top:0;">${esc(i18n('Difficulty'))}</div>
                ${DIFF_SELECT(d)}</div>
              ${kind === 'subjective'
    ? '<div><div class="ais__label" style="margin-top:0;">' + esc(i18n('Language the project is written in')) + '</div><select class="aisd__brieflang" style="max-width:200px;">' + langOptionsHtml(langsMap, d.brief.language) + '</select></div>'
    : '<div style="min-width:230px;"><div class="ais__label" style="margin-top:0;">' + esc(i18n('Languages for students')) + '</div><div class="ais__langs-all">🌐 ' + esc(i18n('Every judge language')) + '</div><div class="aisd__meta">' + esc(i18n('Students may submit in any language the judge supports.')) + '</div></div>'}
              <button class="ais__btn ais__btn--sm aisd__brief-save" style="align-self:flex-end;">💾 ${esc(i18n('Save requirement'))}</button>
            </div>
            ${kind === 'programming' ? `
            <div class="ais__label">🎯 ${esc(i18n('Target knowledge points (optional)'))}</div>
            <div class="aisd__meta" style="margin-bottom:6px;">${esc(i18n('Pick from the domain catalog (or type new ones). The AI designs the task so that a correct solution needs every one of them, probes them in the tests, and labels the task with them.'))}</div>
            <input type="text" class="aisd__knowledge" value="${esc((d.brief.knowledge || []).map((k) => k.name).join(','))}">
            <div class="aisd__meta" style="margin:4px 0 0;">${esc(i18n('Saved with the requirement (Save requirement); regenerate the statement afterwards.'))}</div>` : ''}
            <div class="aisd__meta" style="margin:6px 0 14px;">${esc(i18n('After changing the requirement, regenerate the statement to synthesize the task against it.'))}</div>
            ${materialHtml(d)}
          </div>`;
}

/**
 * Knowledge points (programming tasks): the DETAILED skills and pitfalls the
 * task exercises, drafted by the pipeline after verification and written
 * into the problem's tags. Chips are edited in place — Save sends the
 * current chip set; Regenerate / AI refine ask the model.
 *
 * The pane is self-contained (own button classes, own wiring, own refresh)
 * so a background labeling call can update it WITHOUT re-rendering the
 * whole page — a full render would wipe whatever the teacher is typing in
 * another tab meanwhile.
 */
function knowledgeTabLabel(d) {
  const n = ((d.artifacts.knowledge || {}).points || []).length;
  return `🏷️ ${esc(i18n('Knowledge points'))} ${knowledgeBusy ? '<i class="aisk__tabspin"></i>' : `(${n})`}`;
}

function knowledgePaneHtml(d) {
  const busy = d.pipeline.status === 'running' || knowledgeBusy;
  const k = d.artifacts.knowledge;
  const points = (k && k.points) || [];
  const hasStmt = !!d.artifacts.statement;
  const chip = (p) => `<span class="aisk__chip" data-name="${esc(p.name)}" data-evidence="${esc(p.evidence || '')}" title="${esc(p.evidence || '')}"><b>${esc(p.name)}</b><button type="button" class="aisk__chip-x" title="${esc(i18n('Remove'))}">×</button></span>`;
  const src = k
    ? `<div class="aisk__src">${esc(k.source === 'teacher' ? i18n('Last edited by you') : i18n('Labeled by the AI'))} · ${esc(fmtTs(k.at))}${(d.knowledgeTags || []).length ? ` · ${esc(i18n('applied to the problem\u2019s tags'))}` : ''}</div>`
    : '';
  // Targets the teacher pre-selected: show which ones the current labels
  // cover, so a task that drifted away from its goal is visible at a glance.
  const targets = (d.brief.knowledge || []).map((t) => t.name);
  const haveLower = new Set(points.map((p) => p.name.toLowerCase()));
  const targetsHtml = targets.length ? `<div class="aisk__targets">🎯 ${esc(i18n('Targets'))}: ${targets.map((t) => `<span class="aisk__target${haveLower.has(t.toLowerCase()) ? ' aisk__target--ok' : (points.length ? ' aisk__target--miss' : '')}" title="${esc(haveLower.has(t.toLowerCase()) ? i18n('Covered by the labels') : (points.length ? i18n('Not among the labels — the task may not exercise it; check the statement or regenerate') : ''))}">${esc(t)}</span>`).join('')}</div>` : '';
  // Knowledge-local disabling must survive setLocked(false), which
  // re-enables every .ais__btn: data-hard-disabled is its opt-out.
  const dis = (cond) => (cond ? 'disabled data-hard-disabled' : '');
  const body = knowledgeBusy
    ? `<div class="aisk__busy" style="margin:6px 0 14px;"><i></i>${esc(i18n('Labeling knowledge points from the statement, the reference solution and the tests…'))}</div>`
    : `${points.length ? points.map(chip).join('') : `<span class="aisd__meta">${esc(i18n('No knowledge points yet — they are labeled automatically after verification passes, or press Generate now.'))}</span>`}`;
  return `
          <div class="aisd__pane" data-pane="knowledge">
            <div class="aisd__meta" style="margin-bottom:8px;">${esc(i18n('Detailed skills, techniques and pitfalls this task exercises — its attributes. They become the problem\u2019s tags when it is published: filterable in the problem set and the activity pickers, and reused by the class report. Specific beats broad: \u201cOff-by-one in loop bounds\u201d, not \u201cloops\u201d.'))}
              ${esc(i18n('Labels are drawn from the domain\u2019s shared catalog; new ones are added to it.'))} <a href="${domainPrefix()}/knowledge-points" target="_blank" rel="noopener">${esc(i18n('Manage the catalog'))} ↗</a></div>
            ${hasStmt ? `
            ${knowledgeAutoError ? `<div class="aisk__err">⚠ ${esc(i18n('Automatic labeling did not succeed'))}: ${esc(knowledgeAutoError)}</div>` : ''}
            ${targetsHtml}
            ${src}
            <div class="aisk__chips">${body}</div>
            <div class="aisk__addrow">
              <input type="text" class="textbox aisk__add" maxlength="40" list="aisk-catalog" placeholder="${esc(i18n('Add a knowledge point (2\u20136 words)…'))}" ${busy ? 'disabled' : ''}>
              <datalist id="aisk-catalog"></datalist>
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisk__add-btn" type="button" ${dis(busy)}>➕ ${esc(i18n('Add'))}</button>
            </div>
            <div class="aisd__bar">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisk__regen" ${dis(busy)}>✨ ${esc(points.length ? i18n('Regenerate') : i18n('Generate now'))}</button>
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisk__refine" ${dis(busy || !points.length)}>💬 ${esc(i18n('AI refine…'))}</button>
              <button class="ais__btn ais__btn--sm aisk__save" ${dis(busy)}>💾 ${esc(i18n('Save'))}</button>
              <span class="aisd__meta">${esc(i18n('Saving updates the problem\u2019s tags right away; it never invalidates verification.'))}</span>
            </div>`
    : `<div class="ais__empty">${esc(i18n('No statement yet — press Generate statement above.'))}</div>`}
          </div>`;
}

/**
 * Difficulty (programming tasks): the 1-10 score the problem set shows,
 * rated by the AI inside the teacher's band (intro 1-3, medium 4-7,
 * challenge 8-10) once verification passes. The teacher can move it within
 * the band or ask for a new rating; both write straight to the problem.
 */
function difficultySideHtml(d) {
  const band = d.brief.difficulty || 'intro';
  const [lo, hi] = DIFF_BANDS[band] || DIFF_BANDS.intro;
  const df = d.artifacts.difficulty;
  const busy = difficultyBusy || d.pipeline.status === 'running';
  const dis = busy ? 'disabled data-hard-disabled' : '';
  return `
        <div class="ais__label">🎚 ${esc(i18n('Difficulty'))}</div>
        <div class="aisd__diff">
          ${difficultyBusy ? `<span class="aisk__busy"><i></i>${esc(i18n('Rating the difficulty\u2026'))}</span>` : `
          <div class="aisd__diff-row">
            <span class="aisd__diff-score${df ? '' : ' aisd__diff-score--none'}">${df ? `${df.score}<small>/10</small>` : '–'}</span>
            <span class="aisd__diff-band">${esc(i18n(band))} · ${lo}–${hi}</span>
            <input type="number" class="textbox aisd__diff-input" min="${lo}" max="${hi}" step="1" value="${df ? df.score : ''}" title="${esc(i18n('Score inside the band'))}" ${dis}>
            <button class="ais__btn ais__btn--sm aisd__diff-save" ${dis}>💾</button>
            <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__diff-regen" title="${esc(i18n('Ask the AI to rate it again'))}" ${dis}>✨</button>
          </div>
          ${df?.rationale ? `<div class="aisd__meta aisd__diff-why">${esc(df.rationale)}</div>` : ''}
          <div class="aisd__meta">${df
    ? `${esc(df.source === 'teacher' ? i18n('Set by you') : i18n('Rated by the AI'))} · ${esc(fmtTs(df.at))}${d.docId ? ` · ${esc(i18n('shown in the problem set'))}` : ''}`
    : esc(i18n('Rated automatically after verification passes, or press ✨ now.'))}</div>`}
        </div>`;
}

/** Repaint only the knowledge tab, its pane and the side panel. */
function refreshKnowledge($root) {
  if (!state) return;
  $root.find('.aisd__tab[data-pane="knowledge"]').html(knowledgeTabLabel(state));
  const $pane = $root.find('.aisd__pane[data-pane="knowledge"]');
  if ($pane.length) {
    const on = $pane.hasClass('aisd__pane--on');
    const $next = $(knowledgePaneHtml(state).trim()); // jQuery needs the markup to start with '<'
    if (on) $next.addClass('aisd__pane--on');
    $pane.replaceWith($next);
    wireKnowledge($root);
  }
  renderSide($root);
}

/** One model call for the labels; `auto` = the silent backfill on view. */
async function runKnowledgeGenerate($root, auto) {
  if (knowledgeBusy) return;
  if (backendOlderThanUi()) {
    if (!auto) Notification.error(i18n('The backend is running an older build than this page.') + ' ' + i18n('Restart hydrooj (in dev mode, its watcher only re-applies the handler file that changed, so a full restart is the reliable way). Until then, new actions such as knowledge-point labeling fail with "Unknown target".'));
    return;
  }
  knowledgeBusy = true;
  refreshKnowledge($root);
  try {
    const res = await request.post(base(), { operation: 'generate', target: 'knowledge' });
    state = res.draft;
    knowledgeAutoError = '';
    if (!auto) {
      Notification.success((state.knowledgeTags || []).length
        ? i18n('Knowledge points labeled — the problem\u2019s tags were updated.')
        : i18n('Knowledge points labeled — the problem\u2019s tags follow once the task is verified.'));
    }
  } catch (e) {
    if (auto) knowledgeAutoError = e.message;
    else Notification.error(e.message);
  } finally {
    knowledgeBusy = false;
    refreshKnowledge($root);
  }
}

/**
 * Backfill on view: a verified (or published) programming task that has no
 * labels yet — verified before labeling existed, or whose labeling stage
 * failed — gets labeled the first time the teacher opens it. Once per page
 * load, never while a run is in progress.
 */
function autoLabelKnowledge($root) {
  if (knowledgeAutoTried || !state) return;
  if (kindOf(state) !== 'programming') return;
  if (backendOlderThanUi()) {
    // Calling would only produce "Unknown target"; the banner explains.
    knowledgeAutoTried = true;
    knowledgeAutoError = i18n('the backend is running an older build — restart hydrooj (see the notice at the top of the page)');
    refreshKnowledge($root);
    return;
  }
  if (!state.artifacts?.statement || state.artifacts?.knowledge) return;
  if (state.pipeline?.status === 'running') return;
  if (state.pipeline?.status !== 'passed' && !state.published) return;
  knowledgeAutoTried = true;
  runKnowledgeGenerate($root, true);
}

/** The domain catalog's names, fetched once per page load for the add-box suggestions. */
let catalogNamesPromise = null;
function catalogNames() {
  catalogNamesPromise ||= request.get(`${domainPrefix()}/knowledge-points?_fmt=json&limit=500`)
    .then((r) => (r.points || []).map((p) => p.name))
    .catch(() => []);
  return catalogNamesPromise;
}

function wireKnowledge($root) {
  const $pane = $root.find('.aisd__pane[data-pane="knowledge"]');
  if (!$pane.length) return;
  catalogNames().then((names) => {
    const $dl = $pane.find('#aisk-catalog');
    if ($dl.length) $dl.html(names.map((n) => `<option value="${esc(n)}"></option>`).join(''));
  });
  const addChip = () => {
    const $in = $pane.find('.aisk__add');
    const name = String($in.val() || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) return;
    const exists = $pane.find('.aisk__chip').get().some((el) => String($(el).data('name') || '').toLowerCase() === name.toLowerCase());
    if (exists) {
      Notification.warn(i18n('That knowledge point is already listed.'));
      return;
    }
    const $chips = $pane.find('.aisk__chips');
    $chips.find('.aisd__meta').remove(); // the "none yet" placeholder
    $chips.append(`<span class="aisk__chip aisk__chip--new" data-name="${esc(name)}" data-evidence="" title="${esc(i18n('Added by you — press Save to keep it'))}"><b>${esc(name)}</b><button type="button" class="aisk__chip-x" title="${esc(i18n('Remove'))}">×</button></span>`);
    $in.val('').trigger('focus');
  };
  $pane.find('.aisk__add-btn').on('click', addChip);
  $pane.find('.aisk__add').on('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      addChip();
    }
  });
  $pane.find('.aisk__chips').on('click', '.aisk__chip-x', function onChipRemove() {
    $(this).closest('.aisk__chip').remove();
  });
  $pane.find('.aisk__regen').on('click', () => runKnowledgeGenerate($root, false));
  $pane.find('.aisk__refine').on('click', async function onRefine() {
    const instruction = window.prompt(i18n('Tell the AI how to revise this artifact:'));
    if (!instruction?.trim()) return;
    if (knowledgeBusy) return;
    knowledgeBusy = true;
    refreshKnowledge($root);
    try {
      const res = await request.post(base(), { operation: 'refine', target: 'knowledge', instruction });
      state = res.draft;
    } catch (e) {
      Notification.error(e.message);
    } finally {
      knowledgeBusy = false;
      refreshKnowledge($root);
    }
  });
  $pane.find('.aisk__save').on('click', async function onSave() {
    const $b = $(this).prop('disabled', true);
    try {
      const payload = collectPayload($root, 'knowledge');
      const res = await request.post(base(), { operation: 'save', target: 'knowledge', payload: JSON.stringify(payload) });
      state = res.draft;
      knowledgeAutoError = '';
      refreshKnowledge($root);
      Notification.success(Array.isArray(res.tags)
        ? i18n('Knowledge points saved — the problem\u2019s tags were updated.')
        : i18n('Knowledge points saved — they are applied to the problem\u2019s tags once it has been verified.'));
    } catch (e) {
      Notification.error(e.message);
      $b.prop('disabled', false);
    }
  });
}

function reportPaneHtml(d) {
  const kind = kindOf(d);
  const busy = d.pipeline.status === 'running';
  const BLURB = {
    subjective: 'A briefing for you, not for students: what a strong submission looks like, and how to apply the rubric consistently.',
    objective: 'A briefing for you, not for students: what the quiz covers, the correct answer for each question and why, and the misconception each distractor targets.',
    programming: 'A briefing for you, not for students: the key idea, the knowledge points the task tests, how the cases probe them, and likely pitfalls.',
  };
  return `
          <div class="aisd__pane" data-pane="report">
            <div class="aisd__meta" style="margin-bottom:8px;">${esc(i18n(BLURB[kind] || BLURB.programming))}</div>
            ${reportPane(d)}
            ${phaseOf(d) === 'approved' ? `<div class="aisd__bar" style="margin-top:12px;">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__regen" data-t="report" ${busy ? 'disabled' : ''}>✨ ${esc(i18n('Regenerate'))}</button>
            </div>` : ''}
          </div>`;
}

/* ------------------------------------------------------------------ */
/*  PROGRAMMING page — the original layout, unchanged                  */
/* ------------------------------------------------------------------ */
function renderProgramming(d) {
  const s = d.artifacts.statement || { title: '', body: '' };
  const sol = d.artifacts.solution || { language: d.brief.language, code: '' };
  const alt = d.artifacts.alt || { language: d.brief.language, code: '' };
  const busy = d.pipeline.status === 'running';
  const phase = phaseOf(d);
  const hasStmt = !!d.artifacts.statement;
  const langSel = (cls, cur) => `<select class="${cls}" style="max-width:240px;">${langOptionsHtml(langsMap, cur)}</select>`;
  const showDownstream = phase === 'approved';
  /*
   * The two-phase flow: the statement is drafted first and reviewed; only
   * Continue (approval) creates the solution, cross-check and tests and
   * runs verification; labels, difficulty and the report follow that. The
   * tabs list every artifact in that order — the ones not reached yet are
   * shown locked with what unlocks them, instead of being absent.
   */
  const verified = d.pipeline.status === 'passed' || !!d.published;
  const lockedTab = (pane, label, why) => `<button class="aisd__tab aisd__tab--locked" data-pane="${pane}" data-why="${esc(why)}" title="${esc(why)}">🔒 ${label}</button>`;
  const whyApprove = hasStmt
    ? i18n('Unlocks when you approve the statement with Continue — the AI then writes the solution, cross-check and tests.')
    : i18n('Unlocks after the statement exists and you approve it with Continue.');
  const whyVerify = i18n('Filled in automatically once verification passes (after Continue), or generate it by hand from this tab afterwards.');
  const progTabs = showDownstream ? [
    '<button class="aisd__tab" data-pane="sol">✅ ' + esc(i18n('Reference solution')) + '</button>',
    '<button class="aisd__tab" data-pane="alt">🔁 ' + esc(i18n('Cross-check solution')) + '</button>',
    '<button class="aisd__tab" data-pane="tests">🧾 ' + esc(i18n('Tests')) + ' (' + (d.artifacts.tests || []).length + ')</button>',
  ].join('\n          ') : [
    lockedTab('sol', '✅ ' + esc(i18n('Reference solution')), whyApprove),
    lockedTab('alt', '🔁 ' + esc(i18n('Cross-check solution')), whyApprove),
    lockedTab('tests', '🧾 ' + esc(i18n('Tests')), whyApprove),
  ].join('\n          ');
  const hasKnowledge = !!(d.artifacts.knowledge?.points?.length);
  const knowledgeTab = (hasStmt && (showDownstream || hasKnowledge))
    ? `<button class="aisd__tab" data-pane="knowledge">${knowledgeTabLabel(d)}</button>`
    : lockedTab('knowledge', knowledgeTabLabel(d), hasStmt ? whyVerify : i18n('Unlocks after the statement exists.'));
  const reportTab = (showDownstream || d.artifacts.report)
    ? `<button class="aisd__tab" data-pane="report">📊 ${esc(i18n('Teacher report'))}</button>`
    : lockedTab('report', '📊 ' + esc(i18n('Teacher report')), whyVerify);
  // Workflow stepper: which step this draft is at.
  const step = !hasStmt ? 1 : phase === 'review' ? 2 : !verified ? 3 : !d.published ? 4 : 5;
  const STEPS = [
    ['1', i18n('Statement'), i18n('The AI drafts the statement from your brief.')],
    ['2', i18n('Review'), i18n('Edit it, chat to refine it, then press Continue.')],
    ['3', i18n('Solution, tests & verification'), i18n('Reference solution, cross-check, tests; the judge verifies everything.')],
    ['4', i18n('Labels & difficulty'), i18n('Knowledge points, difficulty and the teacher report are filled in.')],
    ['5', i18n('Publish'), i18n('Reveal the task to students, now or later.')],
  ];
  const stepper = `<div class="aisd__steps">${STEPS.map(([n, lb, tip], i) => `<div class="aisd__step${i + 1 < step ? ' is-done' : i + 1 === step ? ' is-now' : ''}" title="${esc(tip)}"><span class="aisd__step-n">${i + 1 < step ? '✓' : n}</span><span class="aisd__step-l">${esc(lb)}</span></div>`).join('<div class="aisd__step-line"></div>')}</div>`;
  return `
  ${bannerHtml(d)}
  <div class="aisd aisd--prog">
    <div class="aisd__main">
      <div class="ais">
        <div class="ais__head">✨ <span class="ais__title">${esc(s.title || i18n('Untitled draft'))}</span>
          <span class="ais__hint">${esc(phase === 'review'
    ? i18n('Review step — edit the text directly, or ask the AI below. Nothing else runs until you press Continue.')
    : i18n('Every artifact is editable — your edits go through the same verification.'))}</span></div>
        ${stepper}
        <div class="aisd__tabs">
          <button class="aisd__tab" data-pane="stmt">📝 ${esc(i18n('Statement'))}</button>
          ${progTabs}
          ${knowledgeTab}
          ${reportTab}
          <button class="aisd__tab" data-pane="ctx">📚 ${esc(i18n('Context'))} (${(d.brief.files || []).length})</button>
        </div>
        <div class="ais__body">
          ${toolbarHtml(d)}
          ${ctxPaneHtml(d)}
          <div class="aisd__pane" data-pane="stmt">
            ${hasStmt ? `
            <div class="ais__label">${esc(i18n('Title'))}</div>
            <input type="text" class="aisd__title" value="${esc(s.title)}">
            <div class="aisd__fieldhead">
              <span class="ais__label" style="margin:0;">${esc(i18n(STATEMENT_LABEL.programming))}</span>
              <span class="aisd__meta">${esc(i18n(STATEMENT_HINT.programming))}</span>
            </div>
            ${editorHost(16, s.body)}
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--sm aisd__save" data-t="statement">💾 ${esc(i18n('Save my edits'))}</button>
              ${phase === 'approved' ? `<span class="aisd__meta">${esc(i18n('Editing this sends the draft back to review — press Continue again afterwards.'))}</span>` : ''}
            </div>
            ${chatPanel(d)}`
    : `<div class="ais__empty">${esc(i18n('No statement yet — press Generate statement above.'))}</div>`}
          </div>

          <div class="aisd__pane" data-pane="sol" ${showDownstream ? '' : 'hidden'}>
            <div class="ais__label">${esc(i18n('Language'))}</div>${langSel('aisd__sol-lang', sol.language)}
            <div class="ais__label">${esc(i18n('Reference solution (must read stdin, write stdout only)'))}</div>
            <textarea class="aisd__sol-code" rows="18" spellcheck="false">${esc(sol.code)}</textarea>
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__regen" data-t="solution" ${busy ? 'disabled' : ''}>✨ ${esc(i18n('Regenerate'))}</button>
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__refine" data-t="solution" ${busy ? 'disabled' : ''}>💬 ${esc(i18n('AI refine…'))}</button>
              <button class="ais__btn ais__btn--sm aisd__save" data-t="solution">💾 ${esc(i18n('Save'))}</button>
            </div>
          </div>

          <div class="aisd__pane" data-pane="alt" ${showDownstream ? '' : 'hidden'}>
            <div class="aisd__meta" style="margin-bottom:8px;">${d.brief.crosscheck
    ? `${esc(i18n('Cross-check is ON: a second, independently written solution must agree with the reference on every test.'))} <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__cc-toggle" data-on="0">${esc(i18n('Turn off'))}</button>`
    : `${esc(i18n('Cross-check is OFF: the reference solution\u2019s outputs are trusted as-is \u2014 read it yourself before publishing.'))} <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__cc-toggle" data-on="1">${esc(i18n('Turn on'))}</button>`}</div>
            <div class="aisd__meta" style="margin-bottom:8px;">${esc(i18n('An independent second solution: during verification its outputs are diffed against the reference to catch a wrong reference solution.'))}</div>
            <div class="ais__label">${esc(i18n('Language'))}</div>${langSel('aisd__alt-lang', alt.language)}
            <div class="ais__label">${esc(i18n('Cross-check solution'))}</div>
            <textarea class="aisd__alt-code" rows="16" spellcheck="false">${esc(alt.code)}</textarea>
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__regen" data-t="alt" ${busy ? 'disabled' : ''}>✨ ${esc(i18n('Regenerate'))}</button>
              <button class="ais__btn ais__btn--sm aisd__save" data-t="alt">💾 ${esc(i18n('Save'))}</button>
            </div>
          </div>

          <div class="aisd__pane" data-pane="tests" ${showDownstream ? '' : 'hidden'}>
            <div class="ais__label">${esc(i18n('Cases (JSON — inputs only; outputs come from running the reference solution)'))}</div>
            <textarea class="aisd__tests" rows="12" spellcheck="false">${esc(j(d.artifacts.tests || []))}</textarea>
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__regen" data-t="tests" ${busy ? 'disabled' : ''}>✨ ${esc(i18n('Regenerate'))}</button>
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__refine" data-t="tests" ${busy ? 'disabled' : ''}>💬 ${esc(i18n('AI refine…'))}</button>
              <button class="ais__btn ais__btn--sm aisd__save" data-t="tests">💾 ${esc(i18n('Save'))}</button>
            </div>
            <div class="ais__label">👁 ${esc(i18n('Preview'))}</div>
            ${casesPreview(d.artifacts.tests)}
          </div>
          ${knowledgePaneHtml(d)}
          ${reportPaneHtml(d)}
        </div>
      </div>
    </div>
    <div class="aisd__side">${sideHtml(d)}</div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/*  OBJECTIVE page — a quiz workbench, not a statement editor          */
/* ------------------------------------------------------------------ */
function renderObjective(d) {
  const s = d.artifacts.statement || { title: '', body: '' };
  const busy = d.pipeline.status === 'running';
  const phase = phaseOf(d);
  const hasStmt = !!d.artifacts.statement;
  const hasKey = !!(d.artifacts.answers && d.artifacts.answers.yaml);
  return `
  ${bannerHtml(d)}
  <div class="aisd aisd--obj">
    <div class="aisd__main">
      <div class="ais">
        <div class="ais__head ais__head--obj">📝 <span class="ais__title">${esc(s.title || i18n('Untitled quiz'))}</span>
          <span class="ais__hint">${esc(phase === 'brief'
    ? i18n('Auto-graded quiz — Hydro objective format')
    : phase === 'review'
      ? i18n('Check every question below. The answer key is written only after you press Continue.')
      : i18n('Questions and key are set — publish when you are happy.'))}</span></div>
        <div class="aisd__tabs">
          <button class="aisd__tab" data-pane="stmt">🧩 ${esc(i18n('Questions'))}${hasStmt ? ` (${parseQuestions(s.body).length})` : ''}</button>
          ${phase === 'approved' ? `<button class="aisd__tab" data-pane="ans">🔑 ${esc(i18n('Answer key'))} (${answersCount(d.artifacts.answers && d.artifacts.answers.yaml)})</button>` : ''}
          <button class="aisd__tab" data-pane="report">📊 ${esc(i18n('Teacher report'))}</button>
          <button class="aisd__tab" data-pane="ctx">⚙️ ${esc(i18n('Quiz setup'))}${(d.brief.files || []).length ? ` · 📚 ${(d.brief.files || []).length}` : ''}</button>
        </div>
        <div class="ais__body">
          ${toolbarHtml(d)}
          ${objectiveSetupHtml(d)}

          <div class="aisd__pane" data-pane="stmt">
            ${hasStmt ? `
            <div class="aisq__titlerow">
              <input type="text" class="aisd__title" value="${esc(s.title)}" placeholder="${esc(i18n('Quiz title'))}">
            </div>
            <div class="aisq">${questionCards(d)}</div>
            <details class="aisq__src"${hasKey ? '' : ' open'}>
              <summary>${esc(i18n('Edit the markdown source'))} <span class="aisd__meta">${esc(i18n('Hydro objective format: {{ input(n) }} · {{ select(n) }} + option list · {{ multiselect(n) }} · {{ dropdown(n)[a, b] }}'))}</span></summary>
              ${editorHost(16, s.body)}
              <div class="aisd__bar" style="margin-top:10px;">
                <button class="ais__btn ais__btn--sm aisd__save" data-t="statement">💾 ${esc(i18n('Save my edits'))}</button>
                ${phase === 'approved' ? `<span class="aisd__meta">${esc(i18n('Editing the questions sends the draft back to review — press Continue again afterwards.'))}</span>` : ''}
              </div>
            </details>
            ${chatPanel(d)}`
    : `<div class="ais__empty">${esc(i18n('No questions yet — press Generate questions above.'))}</div>`}
          </div>

          <div class="aisd__pane" data-pane="ans" ${phase === 'approved' ? '' : 'hidden'}>
            <div class="aisd__meta" style="margin-bottom:8px;">${esc(i18n('The key the judge grades with. One line per question — id: [answer, score]. Choice answers are option letters; scores must total 100.'))}</div>
            <div class="aisq">${questionCards(d)}</div>
            <div class="ais__label">🔑 ${esc(i18n('Answer key (YAML)'))}</div>
            <textarea class="aisd__answers" rows="10" spellcheck="false">${esc((d.artifacts.answers && d.artifacts.answers.yaml) || '')}</textarea>
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__regen" data-t="answers" ${busy ? 'disabled' : ''}>✨ ${esc(i18n('Regenerate the key'))}</button>
              <button class="ais__btn ais__btn--sm aisd__save" data-t="answers">💾 ${esc(i18n('Validate & save'))}</button>
            </div>
          </div>
          ${reportPaneHtml(d)}
        </div>
      </div>
    </div>
    <div class="aisd__side">${sideHtml(d)}</div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/*  SUBJECTIVE page — a document workbench with a live preview         */
/* ------------------------------------------------------------------ */
function renderSubjective(d) {
  const s = d.artifacts.statement || { title: '', body: '' };
  const phase = phaseOf(d);
  const hasStmt = !!d.artifacts.statement;
  return `
  ${bannerHtml(d)}
  <div class="aisd aisd--subj">
    <div class="aisd__main">
      <div class="ais">
        <div class="ais__head ais__head--subj">📄 <span class="ais__title">${esc(s.title || i18n('Untitled assignment'))}</span>
          <span class="ais__hint">${esc(i18n('Graded by you — students upload files and a report. No judge, no test data.'))}</span></div>
        <div class="aisd__tabs">
          <button class="aisd__tab" data-pane="stmt">📄 ${esc(i18n('Assignment'))}</button>
          <button class="aisd__tab" data-pane="report">📊 ${esc(i18n('Grading briefing'))}</button>
          <button class="aisd__tab" data-pane="ctx">📚 ${esc(i18n('Context'))} (${(d.brief.files || []).length})</button>
        </div>
        <div class="ais__body">
          ${toolbarHtml(d)}
          ${ctxPaneHtml(d)}

          <div class="aisd__pane" data-pane="stmt">
            ${hasStmt ? `
            <div class="ais__label">${esc(i18n('Title'))}</div>
            <input type="text" class="aisd__title" value="${esc(s.title)}">
            <div class="aisd__fieldhead">
              <span class="ais__label" style="margin:0;">${esc(i18n(STATEMENT_LABEL.subjective))}</span>
              <span class="aisd__meta">${esc(i18n(STATEMENT_HINT.subjective))}</span>
            </div>
            ${editorHost(22, s.body)}
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--sm aisd__save" data-t="statement">💾 ${esc(i18n('Save my edits'))}</button>
              <span class="aisd__meta">${esc(i18n('The preview toggle in the toolbar shows exactly what students will see.'))}</span>
            </div>
            ${chatPanel(d)}`
    : `<div class="ais__empty">${esc(i18n('No assignment yet — press Draft the assignment above, or just start chatting once it exists.'))}</div>`}
          </div>
          ${reportPaneHtml(d)}
        </div>
      </div>
    </div>
    <div class="aisd__side">${sideHtml(d)}</div>
  </div>`;
}

function render($root) {
  const d = state;
  lastFp = artifactFp(d);
  lastSideFp = sideFp();
  const kind = kindOf(d);
  const html = buildMismatchHtml() + (kind === 'objective' ? renderObjective(d)
    : kind === 'subjective' ? renderSubjective(d)
      : renderProgramming(d));
  $root.html(html);
  wire($root);
  const pane = (activePane && activePane !== 'locked') ? activePane : (d.artifacts.statement ? 'stmt' : 'ctx');
  const $tab = $root.find(`.aisd__tab[data-pane="${pane}"]`);
  const shown = $tab.length ? pane : 'ctx'; // the tab may not exist in this phase
  $root.find('.aisd__tab').removeClass('aisd__tab--on').filter(`[data-pane="${shown}"]`).addClass('aisd__tab--on');
  $root.find('.aisd__pane').removeClass('aisd__pane--on').filter(`[data-pane="${shown}"]`).addClass('aisd__pane--on');
  // The rich markdown editor suits prose. Quiz markup is easier to edit as
  // plain text — and the source box lives inside a <details>, where a
  // freshly mounted editor would measure zero height.
  if (kind !== 'objective') mountStatementEditor($root);
}

/**
 * The one place that decides what is clickable. Every AI round-trip — chat
 * turn, generation, verification — locks the whole page except Stop, so the
 * teacher can never start a second run against a statement that is being
 * rewritten underneath them.
 */
function setLocked($root, locked) {
  $root.find('.ais__btn').not('.aisd__stop').not('[data-hard-disabled]').prop('disabled', !!locked);
  $root.find('.aisc__input, .aisd__body-md, .aisd__title, .aisd__answers').prop('disabled', !!locked);
  $root.find('.aisc__send').text(locked ? i18n('Thinking…') : i18n('Send'));
  if (locked) return;
  // Re-apply the rules that are independent of the lock.
  $root.find('.aisd__publish').prop('disabled', !(state.pipeline.status === 'passed' && !state.published));
  $root.find('.aisd__discard').prop('disabled', !!state.published);
}

/* Only the sidebar refreshes during polling, so editors keep focus. */
function renderSide($root) {
  const fp = sideFp();
  if (fp === lastSideFp) {
    // Nothing changed: tick the timer in place so the panel's animations
    // run uninterrupted instead of restarting on every poll (that DOM
    // replacement was what made the whole panel "blink").
    const p = state?.pipeline || {};
    if (p.status === 'running' && p.startedAt) {
      $root.find('.ais__timer').text(Math.max(0, Math.round((Date.now() - new Date(p.startedAt).getTime()) / 1000)));
    }
    return;
  }
  lastSideFp = fp;
  $root.find('.aisd__side').html(sideHtml(state));
  setLocked($root, state.pipeline.status === 'running');
}

async function mountStatementEditor($root) {
  const $ta = $root.find('.aisd__body-md');
  // Before the first draft exists (phase 'brief') the statement pane renders
  // an empty-state message and NO textarea. Editor.getOrConstruct would then
  // dereference $dom.get(0) -> undefined inside initMarkdownEditor, and
  // because the constructor kicks that off without awaiting it, the
  // rejection escapes the try/catch below and surfaces as an uncaught
  // runtime error overlay instead of a silent fallback.
  if (!$ta.length) {
    statementEditor = null;
    return;
  }
  try {
    const { default: Editor } = await import('vj/components/editor');
    // The editor appends to the textarea's PARENT — the pane div hosts it
    // right under the label, and mirrors keystrokes back into the textarea.
    statementEditor = Editor.getOrConstruct($ta, { language: 'markdown' });
  } catch (e) {
    console.warn('[ai-studio] markdown editor unavailable, keeping the plain textarea:', (e && e.message) || e);
  }
}

/* ---------------------------- actions ----------------------------- */

function collectPayload($root, target) {
  if (target === 'answers') {
    return { yaml: String($root.find('.aisd__answers').val() || '') };
  }
  if (target === 'statement') {
    return { title: String($root.find('.aisd__title').val() || ''), body: String($root.find('.aisd__body-md').val() || '') };
  }
  if (target === 'solution') {
    return { language: $root.find('.aisd__sol-lang').val(), code: String($root.find('.aisd__sol-code').val() || '') };
  }
  if (target === 'alt') {
    return { language: $root.find('.aisd__alt-lang').val(), code: String($root.find('.aisd__alt-code').val() || '') };
  }
  if (target === 'knowledge') {
    // Whatever the chips show, including a point typed but not yet added.
    const points = $root.find('.aisk__chip').map(function chipVal() {
      return { name: String($(this).data('name') || ''), evidence: String($(this).data('evidence') || '') };
    }).get().filter((p) => p.name.trim());
    const pending = String($root.find('.aisk__add').val() || '').trim();
    if (pending) points.push({ name: pending });
    return { points };
  }
  const raw = String($root.find('.aisd__tests').val() || '[]');
  const cases = JSON.parse(raw); // throws -> caught by caller with a friendly message
  return { cases };
}

function startPolling($root) {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const data = await request.get(jsonUrl());
      const hadStmt = !!state?.artifacts?.statement;
      state = data.draft;
      if (!hadStmt && state?.artifacts?.statement && (!activePane || activePane === 'ctx')) activePane = 'stmt';
      if (artifactFp(state) !== lastFp) render($root); // new artifact — show it live
      else renderSide($root);
      if (state.pipeline.status !== 'running') {
        clearInterval(pollTimer);
        pollTimer = null;
        if (state.pipeline.status === 'idle' && phaseOf(state) === 'review') {
          Notification.success(isObjDraft(state)
            ? i18n('Questions drafted — review them, then press Continue.')
            : i18n('Statement drafted — review it, then press Continue.'));
        } else if (state.pipeline.status === 'passed') {
          Notification.success(isSubjDraft(state) ? i18n('Ready to publish.') : i18n('Verification passed.'));
        } else if (state.pipeline.status === 'failed') {
          Notification.error(`${i18n('Verification failed at')} ${state.pipeline.stage}: ${state.pipeline.message}`);
        }
        render($root); // full refresh: repaired artifacts / samples / limits
        setLocked($root, false); // the run is over — hand the page back
        autoLabelKnowledge($root); // a verified task without labels gets them now
      }
    } catch (e) { /* transient poll error; keep polling */ }
  }, 2000);
}

function wire($root) {
  // Every box the teacher talks to the AI through — the requirement, the
  // notes and the refine chat — is a chat composer. wire() runs after each
  // re-render, and mounting is idempotent per element.
  mountComposers($root, '.aisc__input, .aisd__topic, .aisd__notes', { i18n });
  $root.find('.aisd__tab').on('click', function onTab() {
    if ($(this).hasClass('aisd__tab--locked')) {
      // Not reachable yet: show what unlocks it, and the button that does.
      const why = $(this).attr('data-why') || '';
      const hasStmt = !!state?.artifacts?.statement;
      const phase = phaseOf(state);
      let $lock = $root.find('.aisd__pane[data-pane="locked"]');
      if (!$lock.length) $lock = $('<div class="aisd__pane" data-pane="locked"></div>').appendTo($root.find('.ais__body').first());
      $lock.html(`<div class="aisd__locked">🔒 <b>${esc($(this).text().replace(/^🔒\s*/, ''))}</b><p>${esc(why)}</p>
        ${!hasStmt ? `<button type="button" class="ais__btn aisd__lock-go" data-go="generate">✨ ${esc(i18n('Generate statement'))}</button>`
    : phase === 'review' ? `<button type="button" class="ais__btn aisd__lock-go" data-go="continue">▶ ${esc(i18n('Continue'))}</button>` : ''}</div>`);
      $root.find('.aisd__tab').removeClass('aisd__tab--on');
      $(this).addClass('aisd__tab--on');
      activePane = 'locked';
      $root.find('.aisd__pane').removeClass('aisd__pane--on');
      $lock.addClass('aisd__pane--on');
      return;
    }
    $root.find('.aisd__tab').removeClass('aisd__tab--on');
    $(this).addClass('aisd__tab--on');
    const pane = $(this).data('pane');
    activePane = pane;
    $root.find('.aisd__pane').removeClass('aisd__pane--on');
    $root.find(`.aisd__pane[data-pane="${pane}"]`).addClass('aisd__pane--on');
  });
  // The unlock buttons forward to the real toolbar actions.
  $root.on('click', '.aisd__lock-go', function onLockGo() {
    const go = $(this).attr('data-go');
    if (go === 'generate') $root.find('.aisd__gen').first().trigger('click');
    else if (go === 'continue') $root.find('.aisd__continue').first().trigger('click');
  });

  // ---- Context files: sequential upload; the server extracts the text ----
  const $ctxDrop = $root.find('.aisd__ctx-drop');
  const $ctxPick = $root.find('.aisd__ctx-pick');
  const uploadCtx = async (list) => {
    const files = Array.from(list || []);
    if (!files.length) return;
    $ctxDrop.addClass('ais__drop--busy');
    try {
      for (let k = 0; k < files.length; k++) {
        $ctxDrop.find('.ais__drop-main').text(`${i18n('Uploading context')} ${k + 1}/${files.length}: ${files[k].name}`);
        try {
          const res = await uploadContextFile(base(), files[k]); // eslint-disable-line no-await-in-loop
          state = res.draft;
        } catch (e) {
          Notification.error(`${files[k].name}: ${e.message}`);
        }
      }
    } finally {
      render($root);
    }
  };
  $ctxDrop.on('click', () => $ctxPick.trigger('click'));
  $ctxPick.on('change', function onPick() { uploadCtx(this.files); this.value = ''; });
  $ctxDrop.on('dragenter dragover', (ev) => { ev.preventDefault(); $ctxDrop.addClass('ais__drop--over'); });
  $ctxDrop.on('dragleave drop', (ev) => { ev.preventDefault(); $ctxDrop.removeClass('ais__drop--over'); });
  $ctxDrop.on('drop', (ev) => {
    const dt = ev.originalEvent && ev.originalEvent.dataTransfer;
    if (dt?.files?.length) uploadCtx(dt.files);
  });
  $root.find('.aisd__ctx-list').on('click', 'button', async function onDelCtx() {
    try {
      const res = await request.post(base(), { operation: 'deleteContext', name: $(this).data('name') });
      state = res.draft;
      render($root);
    } catch (e) {
      Notification.error(e.message);
    }
  });
  const setCrosscheck = async (enabled, thenVerify) => {
    const res = await request.post(base(), { operation: 'save', target: 'crosscheck', payload: JSON.stringify({ enabled }) });
    state = res.draft;
    if (thenVerify) {
      const r2 = await request.post(base(), { operation: 'verify' });
      if (r2.draft) state = r2.draft;
      render($root);
      startPolling($root);
    } else {
      render($root);
    }
  };
  $root.find('.aisd__cc-toggle').on('click', function onCcToggle() {
    const enabled = String($(this).data('on')) === '1';
    act($(this), () => setCrosscheck(enabled, false));
  });
  $root.find('.aisd__skipcc').on('click', function onSkipCc() {
    act($(this), async () => {
      await setCrosscheck(false, true);
      Notification.success(i18n('Cross-check disabled — re-verifying with the reference trusted.'));
    });
  });

  wireKnowledge($root);
  // The side panel's label list links back to the tab.
  $root.find('.aisd__side').on('click', '.aisk__side-edit', () => {
    $root.find('.aisd__tab[data-pane="knowledge"]').trigger('click');
  });
  // Difficulty: save the teacher's number, or ask for a new AI rating.
  const withDifficulty = async (fn) => {
    if (difficultyBusy) return;
    difficultyBusy = true;
    renderSide($root);
    try {
      await fn();
    } catch (e) {
      Notification.error(e.message);
    } finally {
      difficultyBusy = false;
      renderSide($root);
    }
  };
  $root.find('.aisd__side').on('click', '.aisd__diff-save', () => {
    const band = state.brief.difficulty || 'intro';
    const [lo, hi] = DIFF_BANDS[band] || DIFF_BANDS.intro;
    const raw = Number($root.find('.aisd__diff-input').val());
    if (!Number.isFinite(raw) || raw < lo || raw > hi) {
      Notification.warn(i18n('Pick a score between {0} and {1} — the band you chose for this task.').replace('{0}', lo).replace('{1}', hi));
      return;
    }
    withDifficulty(async () => {
      const res = await request.post(base(), { operation: 'save', target: 'difficulty', payload: JSON.stringify({ score: raw }) });
      state = res.draft;
      Notification.success(state.docId ? i18n('Difficulty saved and written to the problem.') : i18n('Difficulty saved — written to the problem once it is verified.'));
    });
  });
  $root.find('.aisd__side').on('click', '.aisd__diff-regen', () => {
    withDifficulty(async () => {
      const res = await request.post(base(), { operation: 'generate', target: 'difficulty' });
      state = res.draft;
    });
  });

  $root.find('.aisd__qtype').on('change', function onQType() {
    $(this).closest('.aisq__type-chip').toggleClass('aisq__type-chip--on', $(this).prop('checked'));
  });

  // Target knowledge points picker (programming drafts), attached to the
  // requirement pane's input; its names ride along with "Save requirement".
  const $kpTarget = $root.find('.aisd__knowledge');
  const kpTargetPicker = $kpTarget.length
    ? KnowledgePointSelectAutoComplete.getOrConstruct($kpTarget, { multi: true, freeSolo: true, clearDefaultValue: false })
    : null;

  $root.find('.aisd__brief-save').on('click', function onBrief() {
    act($(this), async () => {
      const res = await request.post(base(), {
        operation: 'save',
        target: 'brief',
        payload: JSON.stringify({
          topic: String($root.find('.aisd__topic').val() || ''),
          difficulty: $root.find('.aisd__difficulty').val(),
          ...(kpTargetPicker ? { knowledge: kpTargetPicker.names() } : {}),
          // Objective-only controls; absent on the other pages, and the
          // server ignores them unless the draft is a quiz.
          ...($root.find('.aisd__qcount').length ? { qcount: $root.find('.aisd__qcount').val() } : {}),
          ...($root.find('.aisd__brieflang').length ? { language: $root.find('.aisd__brieflang').val() } : {}),
          ...($root.find('.aisd__qtype').length
            ? { qtypes: $root.find('.aisd__qtype:checked').map(function qv() { return $(this).val(); }).get() }
            : {}),
        }),
      });
      state = res.draft;
      render($root);
      Notification.success(isObjDraft(state)
        ? i18n('Setup saved — press Generate questions to rebuild the quiz.')
        : i18n('Requirement saved — regenerate the statement to synthesize against it.'));
    });
  });

  $root.find('.aisd__notes-save').on('click', async function onNotes() {
    const $b = $(this).prop('disabled', true);
    try {
      const res = await request.post(base(), { operation: 'save', target: 'notes', payload: JSON.stringify({ notes: String($root.find('.aisd__notes').val() || '') }) });
      state = res.draft;
      Notification.success(i18n('Notes saved.'));
    } catch (e) {
      Notification.error(e.message);
    } finally {
      $b.prop('disabled', false);
    }
  });

  const act = async ($b, fn) => {
    $b.prop('disabled', true);
    try {
      await fn();
    } catch (e) {
      Notification.error(e.message);
    } finally {
      $b.prop('disabled', false);
    }
  };

  $root.find('.aisd__stop').on('click', function onStop() {
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'stop' });
      state = res.draft;
      render($root);
      Notification.info(i18n('Stopping — the run will halt at its next checkpoint.'));
      startPolling($root);
    });
  });

  // PHASE 1: draft the statement only. Nothing downstream is touched.
  $root.find('.aisd__gen').on('click', function onGen() {
    if (phaseOf(state) === 'review'
      && !window.confirm(i18n('Regenerate from scratch? The current text and this conversation will be replaced.'))) return;
    act($(this), async () => {
      setLocked($root, true);
      const res = await request.post(base(), { operation: 'generate', target: 'questions' });
      state = res.draft;
      activePane = 'stmt';
      render($root);
      startPolling($root);
    });
  });

  // PHASE 2: the teacher signs off on the statement.
  $root.find('.aisd__continue').on('click', function onContinue() {
    act($(this), async () => {
      setLocked($root, true);
      const res = await request.post(base(), { operation: 'continue' });
      state = res.draft;
      render($root);
      Notification.success(isObjDraft(state)
        ? i18n('Questions approved — writing the answer key.')
        : isSubjDraft(state)
          ? i18n('Assignment approved — assembling it now.')
          : i18n('Statement approved — drafting the solution, cross-check and tests.'));
      startPolling($root);
    });
  });

  /* ---- statement-review chat ---- */
  const $chatLog = $root.find('.aisc__log');
  const $chatInput = $root.find('.aisc__input');
  const sendChat = async () => {
    const text = String($chatInput.val() || '').trim();
    if (!text) return;
    setLocked($root, true);
    // Echo the teacher's turn immediately: the round-trip can take a while
    // and an empty box with no trace of what was just asked reads as a bug.
    $chatLog.append(`<div class="aisc__turn aisc__turn--user">${esc(text)}</div>`)
      .append(`<div class="aisc__turn aisc__turn--ai aisc__pending"><span class="aisc__typing"><i></i><i></i><i></i></span></div>`);
    if ($chatLog.length) $chatLog.scrollTop($chatLog[0].scrollHeight);
    $chatInput.val('');
    try {
      const res = await request.post(base(), { operation: 'chat', text });
      state = res.draft;
      // Keep the teacher on the statement they are discussing.
      activePane = 'stmt';
      render($root);
      if (res.changed) Notification.success(i18n('The AI applied your change — check the text above.'));
    } catch (e) {
      $chatLog.find('.aisc__pending').remove();
      Notification.error(e.message);
      $chatInput.val(text); // don't lose what they typed
      setLocked($root, false);
    }
  };
  $root.find('.aisc__send').on('click', sendChat);
  $chatInput.on('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      sendChat();
    }
  });
  $root.find('.aisc__clear').on('click', function onClearChat() {
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'chatReset' });
      state = res.draft;
      render($root);
    });
  });

  $root.find('.aisd__regen').on('click', function onRegen() {
    const t = $(this).data('t');
    act($(this), async () => {
      setLocked($root, true);
      try {
        const res = await request.post(base(), { operation: 'generate', target: t });
        state = res.draft;
        render($root);
      } finally {
        setLocked($root, false);
      }
    });
  });
  $root.find('.aisd__refine').on('click', function onRefine() {
    const t = $(this).data('t');
    const instruction = window.prompt(i18n('Tell the AI how to revise this artifact:'));
    if (!instruction?.trim()) return;
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'refine', target: t, instruction });
      state = res.draft;
      render($root);
    });
  });
  $root.find('.aisd__save').on('click', function onSave() {
    const t = $(this).data('t');
    act($(this), async () => {
      let payload;
      try {
        payload = collectPayload($root, t);
      } catch (e) {
        throw new Error(i18n('The tests JSON is invalid — fix it and try again.'));
      }
      const res = await request.post(base(), { operation: 'save', target: t, payload: JSON.stringify(payload) });
      state = res.draft;
      render($root);
      Notification.success(i18n('Saved.'));
    });
  });
  $root.find('.aisd__verify').on('click', function onVerify() {
    act($(this), async () => {
      await request.post(base(), { operation: 'verify' });
      state.pipeline = { status: 'running', stage: 'queued', message: i18n('Starting…') };
      renderSide($root);
      startPolling($root);
    });
  });
  $root.find('.aisd__reveal, .aisd__unreveal').on('click', function onVis() {
    const visible = $(this).hasClass('aisd__reveal');
    act($(this), async () => {
      try {
        const res = await request.post(base(), { operation: 'visibility', visible });
        state = res.draft;
        render($root);
        Notification.success(visible
          ? i18n('Students can now see this task.')
          : i18n('Hidden — students can no longer see this task.'));
      } catch (e) {
        // An older backend has no postVisibility (the framework throws
        // MethodNotAllowedError("Visibility") from its dispatch check). The
        // problem list's bulk hide/unhide operations are CORE and take the
        // docId, setting exactly { hidden } and nothing else — so fall back
        // to those and keep the teacher unblocked. The draft's own
        // publishedHidden record cannot be updated on that path; it resyncs
        // the first time postVisibility succeeds on a current backend.
        if (!/MethodNotAllowed|Visibility/i.test(e.message || '')) throw e;
        if (!state.docId) throw new Error(i18n('The running backend does not have this feature yet. Restart hydrooj, then confirm the Studio header shows build 2026-08-30a-difficulty or later. Until then, toggle visibility from the problem\'s own edit page.'));
        await request.post(`${domainPrefix()}/p`, { operation: visible ? 'unhide' : 'hide', pids: [state.docId] });
        state.publishedHidden = !visible;
        render($root);
        Notification.success((visible
          ? i18n('Students can now see this task.')
          : i18n('Hidden — students can no longer see this task.'))
          + ' ' + i18n('(applied via the problem list — the backend is running an older build; restart it when you can)'));
      }
    });
  });

  $root.find('.aisd__publish').on('click', function onPub() {
    const keepHidden = $root.find('.aisd__pubhidden').prop('checked');
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'publish', hidden: keepHidden });
      const backendKnows = !!res.draft; // older backends return no draft — and IGNORED the checkbox
      if (backendKnows) state = res.draft;
      else { state.published = true; state.publishedHidden = false; }
      render($root); // the toolbar becomes the visibility switch
      if (keepHidden && !backendKnows) {
        Notification.error(i18n('The server ignored "Keep hidden" — it is running an older backend build, so the task was published VISIBLE to students. Hide it from the problem\'s edit page, then restart hydrooj and check the build stamp in the Studio header.'));
      } else {
        const pubList = (res.pids || [res.pid]).join(', ');
      Notification.success(keepHidden
          ? `${i18n('Published as')} ${pubList} — ${i18n('hidden from students until you reveal it')}`
          : `${i18n('Published as')} ${pubList}`);
      }
      window.open(res.url || `${domainPrefix()}/p/${res.pid}`, '_blank');
    });
  });
  $root.find('.aisd__discard').on('click', function onDiscard() {
    if (!window.confirm(i18n('Discard this draft and delete its hidden scratch problem?'))) return;
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'discard' });
      window.location.href = res.url || `${domainPrefix()}/ai-studio`;
    });
  });
}

export default new NamedPage(['ai_studio_detail'], () => {
  ensureAisStyle();
  if (!document.getElementById('aisd-style')) {
    $('<style>').attr('id', 'aisd-style').text(DETAIL_STYLE).appendTo(document.head);
  }
  const $root = $('#ais-root');
  request.get(jsonUrl()).then((data) => {
    state = data.draft;
    langsMap = data.langs || {};
    backendBuild = (data.provider && data.provider.build) || '';
    render($root);
    if (state.pipeline.status === 'running') startPolling($root);
    else autoLabelKnowledge($root);
  }).catch((e) => $root.html(`<div class="ais"><div class="ais__body"><div class="ais__empty">⚠ ${esc(e.message)}</div></div></div>`));
});
