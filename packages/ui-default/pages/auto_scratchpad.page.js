import $ from 'jquery';
import MarkdownIt from 'markdown-it';
import Notification from 'vj/components/notification';
import { downloadAiReportPdf } from 'vj/components/ai-report/pdf';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, request } from 'vj/utils';

/** Tag the document once so scoped .pta-dark overrides can apply. */
function applyThemeTag() {
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
}

/** Markdown rendering for the AI report (html stays escaped). */
const mdReport = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * Site-wide PTA-style problem UI (all users, all domains, all surfaces):
 *
 * 1. Programming problems open directly in Scratchpad mode everywhere —
 *    problem set, contests, homework, training all route through
 *    `problem_detail`, so auto-entering here covers the whole site. The
 *    standalone submit page is retired and bounces back to the problem page.
 * 2. A PTA-style problem rail on the left follows the learner around
 *    (self-learning sessions get kind-grouped chips; contests/homework get
 *    the classic A/B/C grid) — in the IDE and, for quiz-style problems that
 *    have no IDE, below the navbar in normal page mode.
 * 3. The Scratchpad's records pane ("acceptance state below the editor") is
 *    disabled site-wide via UiContext.canViewRecord, which gates the pane,
 *    its toolbar button, and the auto-open on submit.
 * 4. The user's submission history renders below the problem description
 *    ("Submitted code": collapsible cards with verdict badges and code).
 * 5. After every submission a PTA-style "Submit Result" modal pops up:
 *    summary grid, per-test-case table (no hint column), the submitted
 *    source with line numbers, and the compiler output.
 *
 * The AI tutor is deliberately NOT part of this site-wide layer — it stays
 * exclusive to self-learning sessions, whose solve page runs its own richer
 * copy of this flow and is skipped by this module's page logic.
 */

const SCRATCHPAD_TYPES = ['default', 'remote_judge'];
// Contest and homework problem views share problem_detail.html but carry
// their own page names — the site-wide UI must register for all of them.
const PROBLEM_PAGES = ['problem_detail', 'contest_detail_problem', 'homework_detail_problem'];
const SUBMIT_PAGES = ['problem_submit', 'contest_detail_problem_submit', 'homework_detail_problem_submit'];
const RAIL_W = 190;
const RAIL_COLLAPSED_KEY = 'hydro:sl-rail-collapsed';

/* ------------------------------- shared helpers ------------------------------- */

function problemType() {
  try {
    return (window.UiContext && UiContext.pdoc && UiContext.pdoc.config && UiContext.pdoc.config.type) || '';
  } catch (e) {
    return '';
  }
}

function alphaLabel(i) {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

function esc(text) {
  return $('<i>').text(String(text)).html();
}

/** Bottom edge of the fixed navbar, or 0 when it is absent/hidden/slid away. */
function navTop() {
  const nav = document.querySelector('.nav');
  if (!nav) return 0;
  const r = nav.getBoundingClientRect();
  if (r.height <= 0 || r.bottom <= 0) return 0;
  return Math.round(r.bottom);
}

/** Stable display key for a test case (subtask-aware). */
function caseKey(c) {
  if (c == null) return null;
  if (c.subtaskId != null && c.id != null) return `${c.subtaskId}-${c.id}`;
  return c.id != null ? String(c.id) : null;
}

const PRISM_LANG = {
  py: 'python', cc: 'cpp', c: 'c', pas: 'pascal', java: 'java', kt: 'kotlin', js: 'javascript', ts: 'typescript', go: 'go', rs: 'rust', rb: 'ruby', cs: 'csharp', php: 'php', bash: 'bash',
};
const prismLang = (lang) => PRISM_LANG[String(lang || '').split('.')[0]] || 'none';
const STATUS_COLORS = {
  0: '#1c7ed6', // Waiting
  1: '#2f9e44', // Accepted
  2: '#e03131', // Wrong Answer
  3: '#e8590c', // Time Limit Exceeded
  4: '#9c36b5', // Memory Limit Exceeded
  5: '#e8590c', // Output Limit Exceeded
  6: '#c2255c', // Runtime Error
  7: '#5f3dc4', // Compile Error
  8: '#495057', // System Error
  9: '#868e96', // Canceled
  11: '#e03131', // Hacked
  20: '#1c7ed6', // Judging
  21: '#1c7ed6', // Compiling
};
/** Subjective (project-level) tasks: the display pid's S prefix is the marker. */
function isSubjectivePid() {
  const pdoc = window.UiContext && UiContext.pdoc;
  return /^s/i.test(String((pdoc && pdoc.pid) || ''));
}

function reportFileName() {
  const pdoc = (window.UiContext && UiContext.pdoc) || {};
  return `AI-Suggestions-${pdoc.pid ?? pdoc.docId ?? 'report'}.pdf`.replace(/[^\w.-]+/g, '-');
}

const DARK_STATUS_OVERRIDES = { 8: '#9aa4ad', 9: '#9aa4ad' }; // grays legible on dark
const statusColor = (st, accepted) => {
  if (accepted) return STATUS_COLORS[1];
  if (getTheme() === 'dark' && DARK_STATUS_OVERRIDES[st]) return DARK_STATUS_OVERRIDES[st];
  return STATUS_COLORS[st] || '#d9480f';
};
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');
const langDisplay = (l) => (window.LANGS && window.LANGS[l] && window.LANGS[l].display) || l || '-';

/** Canonical problem route prefix for API calls, wherever the page lives. */
function trajectoryUrl() {
  const domainPrefix = (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
  const docId = window.UiContext && UiContext.pdoc && UiContext.pdoc.docId;
  return `${domainPrefix}/p/${docId}/trajectory`;
}

/* ---------------------------------- the rail ---------------------------------- */

const RAIL_STYLE = [
  '@keyframes slRailIn { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: none; } }',
  '.sl-rail { position: fixed; left: 0; top: 0; bottom: 0; width: 190px; z-index: 260; background: linear-gradient(180deg, #ffffff 0%, #fafbfe 100%); border-right: 1px solid #e8ecf4; display: flex; flex-direction: column; font-size: 13px; box-shadow: 4px 0 18px -8px rgba(15,23,42,.12); animation: slRailIn .28s cubic-bezier(.2,.8,.3,1); }',
  '.sl-rail__head { display: flex; align-items: center; justify-content: space-between; padding: 11px 12px; font-weight: bold; font-size: 13.5px; letter-spacing: .01em; color: #33415c; flex: 0 0 auto; position: relative; }',
  '.sl-rail__head::after { content: ""; position: absolute; left: 12px; right: 12px; bottom: 0; height: 2px; border-radius: 2px; background: linear-gradient(90deg, #4dabf7, #845ef7, transparent); }',
  '.sl-rail__head button { border: none; background: transparent; cursor: pointer; font-size: 14px; color: #7d8aa3; width: 26px; height: 26px; line-height: 1; padding: 0; border-radius: 50%; transition: background .15s ease, color .15s ease; }',
  '.sl-rail__head button:hover { background: #eef2f9; color: #1c7ed6; }',
  '.sl-rail__body { flex: 1 1 auto; overflow-y: auto; padding-bottom: 10px; scrollbar-width: thin; }',
  '.sl-rail__cat { padding: 14px 12px 0; font-size: 11px; font-weight: bold; color: #93a0b5; letter-spacing: .08em; text-transform: uppercase; }',
  '.sl-rail__grid { padding: 8px 12px 2px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; align-content: start; }',
  '.sl-rail__grid--pts { row-gap: 24px; padding-bottom: 18px; }',
  '.sl-rail__chip.submitted { background: #e7f2fd; border-color: #a5d0f7; color: #1864ab; }',
  '.pta-dark .sl-rail__chip.submitted { background: #1e2b3c; border-color: #2b74b8; color: #8fc6ff; }',
  '.sl-rail__chip.has-pts { position: relative; }',
  '.sl-rail__chip.has-pts::after { content: attr(data-pts); position: absolute; left: 50%; bottom: -16px; transform: translateX(-50%); white-space: nowrap; font-size: 10px; font-weight: 600; letter-spacing: 0; color: #7d8aa3; text-transform: none; }',
  '.pta-dark .sl-rail__chip.has-pts::after { color: #8b97a3; }',
  '.sl-rail__timer:empty { display: none; }',
  '.sl-rail__timer { padding: 10px 12px 0; display: flex; justify-content: center; }',
  '.sl-rail__chip { display: flex; align-items: center; justify-content: center; height: 36px; border: 1px solid #dfe5ef; border-radius: 10px; color: #5b6b85; text-decoration: none; background: #fff; font-size: 13px; font-weight: 500; transition: transform .14s ease, box-shadow .14s ease, border-color .14s ease, color .14s ease, background .14s ease; }',
  '.sl-rail__chip:hover { border-color: #74b3f5; color: #1c7ed6; transform: translateY(-1px); box-shadow: 0 4px 10px -4px rgba(28,126,214,.35); }',
  '.sl-rail__chip.quiz { border-style: dashed; border-color: #9be2cd; color: #0ca678; background: #f2fbf8; }',
  '.sl-rail__chip.quiz:hover { border-color: #0ca678; }',
  '.sl-rail__chip.subj { border-style: dashed; border-color: #c3b2f7; color: #845ef7; background: #f8f5ff; }',
  '.sl-rail__chip.subj:hover { border-color: #845ef7; background: #f3edff; }',
  '.sl-rail__chip.tried { border-style: solid; border-color: #ffc9c9; color: #e03131; background: #fff5f5; }',
  '.sl-rail__chip.ac { border-style: solid; border-color: transparent; color: #fff; background: linear-gradient(135deg, #40c057, #2f9e44); box-shadow: 0 4px 10px -4px rgba(47,158,68,.55); }',
  '.sl-rail__chip.current { border-color: #339af0; box-shadow: 0 0 0 2px rgba(51,154,240,.28), 0 4px 12px -4px rgba(51,154,240,.5); }',
  '.sl-rail__chip.locked { border-style: dashed; color: #adb5bd; background: #f8f9fa; cursor: not-allowed; }',
  '.sl-rail__chip.locked:hover { transform: none; box-shadow: none; border-color: #dfe5ef; color: #adb5bd; }',
  '.sl-rail__chip.skipped { border-style: dashed; border-color: #ffd8a8; color: #e8590c; background: #fff4e6; }',
  '.sl-rail__chip.gate-now:not(.ac) { border-color: #7048e8; color: #5f3dc4; box-shadow: 0 0 0 2px rgba(112,72,232,.25); }',
  '.sl-rail__gate { flex: 0 0 auto; margin: 0 12px 6px; padding: 9px 10px; border-radius: 10px; background: #f3f0ff; border: 1px solid #d9cdff; font-size: 12px; color: #33415c; }',
  '.sl-rail__gate b { display: block; margin-bottom: 4px; color: #5f3dc4; }',
  '.sl-rail__gate .sl-gate__btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }',
  '.sl-rail__gate button { border-radius: 999px; border: 1px solid #d9cdff; background: #fff; color: #5f3dc4; font-size: 12px; padding: 4px 10px; cursor: pointer; }',
  '.sl-rail__gate button:disabled { opacity: .5; cursor: not-allowed; }',
  '.sl-rail__gate button.sl-gate__next { background: linear-gradient(120deg, #7048e8, #9c36b5); border-color: transparent; color: #fff; }',
  '.sl-rail__gate a.sl-gate__next { display: inline-flex; align-items: center; justify-content: center; gap: 4px; white-space: nowrap; border-radius: 999px; background: linear-gradient(120deg, #7048e8, #9c36b5); color: #fff; padding: 6px 13px; font-size: 12px; font-weight: 600; text-decoration: none; box-shadow: 0 6px 14px -7px rgba(112,72,232,.8); transition: transform .14s ease, box-shadow .14s ease, filter .14s ease; }',
  '.sl-rail__gate a.sl-gate__next:hover { color: #fff; filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 9px 18px -8px rgba(112,72,232,.9); }',
  '.sl-rail__gate .sl-gate__hint { margin-top: 5px; color: #7d8aa3; font-size: 11.5px; line-height: 1.4; }',
  '.sl-rail__chip.bonus { border-style: dashed; border-color: #d9cdff; color: #7048e8; background: #f3f0ff; font-size: 11.5px; }',
  '.sl-rail__chip.bonus:hover { border-color: #7048e8; }',
  '.sl-rail__chip.bonus.current { border-style: solid; border-color: #7048e8; box-shadow: 0 0 0 2px rgba(112,72,232,.28); }',
  '.sl-rail__chip.bonus-drafting { background: linear-gradient(90deg, #f3f0ff 0%, #e5dbff 50%, #f3f0ff 100%); background-size: 200% 100%; animation: slBonusShimmer 1.4s linear infinite; cursor: progress; }',
  '.sl-rail__chip.bonus-building { background: #f3f0ff; box-shadow: 0 0 0 0 rgba(112,72,232,.4); animation: slBonusPulse 1.8s ease-out infinite; }',
  '.sl-rail__chip.bonus-failed { border-color: #ffc9c9; color: #e03131; background: #fff5f5; cursor: not-allowed; }',
  '.sl-rail__chip.bonus-new { animation: slBonusPop .5s cubic-bezier(.2,.9,.3,1.3) backwards; }',
  '@keyframes slBonusShimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }',
  '@keyframes slBonusPulse { 0% { box-shadow: 0 0 0 0 rgba(112,72,232,.35); } 70% { box-shadow: 0 0 0 7px rgba(112,72,232,0); } 100% { box-shadow: 0 0 0 0 rgba(112,72,232,0); } }',
  '@keyframes slBonusPop { from { transform: scale(.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }',
  '.sl-rail__bonus { flex: 0 0 auto; margin: 0 12px 8px; }',
  '.sl-rail__bonus .sl-bonus__btn { width: 100%; border: none; border-radius: 12px; padding: 9px 10px; font-size: 12.5px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #7048e8, #ae3ec9); cursor: pointer; box-shadow: 0 6px 16px -8px #7048e8; transition: transform .15s ease, box-shadow .15s ease; }',
  '.sl-rail__bonus .sl-bonus__btn:hover { transform: translateY(-1px); box-shadow: 0 10px 20px -10px #7048e8; }',
  '.sl-rail__bonus .sl-bonus__btn:disabled { opacity: .55; cursor: default; transform: none; }',
  '.sl-rail__bonus .sl-bonus__note { margin-top: 5px; font-size: 11.5px; line-height: 1.4; color: #7d8aa3; }',
  '.sl-rail__bonus .sl-bonus__wait { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 12px; background: #f3f0ff; border: 1px dashed #d9cdff; font-size: 12px; color: #5f3dc4; }',
  '.sl-rail__bonus .sl-bonus__wait i { width: 12px; height: 12px; border: 2px solid #d9cdff; border-top-color: #7048e8; border-radius: 50%; animation: slBonusSpin .8s linear infinite; flex: 0 0 auto; }',
  '@keyframes slBonusSpin { to { transform: rotate(360deg); } }',
  // 🎁 The build card: the bonus task's background job, animated. Head with
  // a rotating conic ring around the phase icon, a three-step track, a
  // sweeping progress bar, a rotating stage line and weak-point chips.
  '.sl-rail__bonus .sl-bjob { position: relative; overflow: hidden; padding: 10px 11px 11px; border-radius: 14px; background: linear-gradient(160deg, #f6f3ff, #fdf7ff 60%, #f3f0ff); border: 1px solid #e2d9ff; box-shadow: 0 10px 24px -14px rgba(112,72,232,.5), inset 0 1px 0 rgba(255,255,255,.7); animation: slBonusPop .45s cubic-bezier(.2,.9,.3,1.2) backwards; }',
  '.sl-rail__bonus .sl-bjob::before { content: ""; position: absolute; inset: -40% -60%; background: radial-gradient(closest-side, rgba(174,62,201,.14), transparent 70%); animation: slBjobDrift 7s ease-in-out infinite alternate; pointer-events: none; }',
  '@keyframes slBjobDrift { from { transform: translate(-12%, -8%); } to { transform: translate(14%, 10%); } }',
  '.sl-rail__bonus .sl-bjob__head { position: relative; display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }',
  '.sl-rail__bonus .sl-bjob__orb { position: relative; flex: 0 0 auto; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; background: #fff; box-shadow: 0 4px 12px -6px rgba(112,72,232,.7); }',
  '.sl-rail__bonus .sl-bjob__orb::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, #7048e8, #ae3ec9, #e64980, #7048e8); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); animation: slBonusSpin 1.6s linear infinite; }',
  '.sl-rail__bonus .sl-bjob__orb-ico { font-size: 18px; line-height: 1; animation: slBjobBreathe 2.2s ease-in-out infinite; }',
  '@keyframes slBjobBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.14); } }',
  '.sl-rail__bonus .sl-bjob__titles { min-width: 0; display: flex; flex-direction: column; gap: 2px; }',
  '.sl-rail__bonus .sl-bjob__titles b { font-size: 12.5px; color: #5f3dc4; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }',
  '.sl-rail__bonus .sl-bjob__stage { font-size: 11px; color: #7d8aa3; line-height: 1.3; transition: opacity .18s ease, transform .18s ease; }',
  '.sl-rail__bonus .sl-bjob__stage.is-swap { opacity: 0; transform: translateY(3px); }',
  '.sl-rail__bonus .sl-bjob__steps { position: relative; list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 4px; }',
  '.sl-rail__bonus .sl-bjob__steps li { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: #9aa4b5; padding: 3px 6px; border-radius: 9px; transition: color .25s ease, background .25s ease; }',
  '.sl-rail__bonus .sl-bjob__steps li.is-active { color: #33415c; background: rgba(255,255,255,.75); font-weight: 600; }',
  '.sl-rail__bonus .sl-bjob__steps li.is-done { color: #2f9e44; }',
  '.sl-rail__bonus .sl-bjob__mark { flex: 0 0 auto; width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; background: #eceef3; color: #9aa4b5; }',
  '.sl-rail__bonus li.is-done .sl-bjob__mark { background: #d3f9d8; color: #2f9e44; }',
  '.sl-rail__bonus li.is-active .sl-bjob__mark { background: #e5dbff; }',
  '.sl-rail__bonus .sl-bjob__spin { width: 9px; height: 9px; border: 2px solid #d9cdff; border-top-color: #7048e8; border-radius: 50%; animation: slBonusSpin .8s linear infinite; }',
  '.sl-rail__bonus .sl-bjob__ico { flex: 0 0 auto; font-size: 12px; filter: grayscale(1); opacity: .6; transition: filter .25s ease, opacity .25s ease; }',
  '.sl-rail__bonus li.is-active .sl-bjob__ico, .sl-rail__bonus li.is-done .sl-bjob__ico { filter: none; opacity: 1; }',
  '.sl-rail__bonus .sl-bjob__track { position: relative; height: 5px; border-radius: 999px; background: #e9e3ff; overflow: hidden; }',
  '.sl-rail__bonus .sl-bjob__track i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #7048e8, #ae3ec9); transition: width .8s cubic-bezier(.2,.8,.2,1); position: relative; overflow: hidden; }',
  '.sl-rail__bonus .sl-bjob__track i::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent); transform: translateX(-100%); animation: slBjobSweep 1.6s ease-in-out infinite; }',
  '@keyframes slBjobSweep { to { transform: translateX(100%); } }',
  '.sl-rail__bonus .sl-bjob__kps { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 8px; }',
  '.sl-rail__bonus .sl-bjob__kps-ico { font-size: 12px; margin-right: 1px; }',
  '.sl-rail__bonus .sl-bjob__kp { font-size: 10.5px; line-height: 1.3; padding: 2px 8px; border-radius: 999px; background: #fff; border: 1px solid #d9cdff; color: #5f3dc4; animation: slBonusPop .4s cubic-bezier(.2,.9,.3,1.2) backwards; }',
  '.sl-rail__bonus .sl-bjob__kp:nth-child(2) { animation-delay: .05s; } .sl-rail__bonus .sl-bjob__kp:nth-child(3) { animation-delay: .1s; } .sl-rail__bonus .sl-bjob__kp:nth-child(4) { animation-delay: .15s; } .sl-rail__bonus .sl-bjob__kp:nth-child(5) { animation-delay: .2s; } .sl-rail__bonus .sl-bjob__kp:nth-child(6) { animation-delay: .25s; }',
  '.sl-rail__bonus .sl-bjob__note { margin-top: 8px; font-size: 11px; line-height: 1.4; color: #5f3dc4; padding: 6px 8px; border-radius: 9px; background: rgba(255,255,255,.7); border: 1px dashed #d9cdff; }',
  '.sl-rail__bonus .sl-bonus__retry { color: #7048e8; font-weight: 600; text-decoration: none; margin-left: 4px; }',
  '.sl-rail__bonus .sl-bonus__retry:hover { text-decoration: underline; }',
  '@media (prefers-reduced-motion: reduce) { .sl-rail__bonus .sl-bjob, .sl-rail__bonus .sl-bjob::before, .sl-rail__bonus .sl-bjob__orb::before, .sl-rail__bonus .sl-bjob__orb-ico, .sl-rail__bonus .sl-bjob__track i::after, .sl-rail__bonus .sl-bjob__kp { animation: none !important; } }',
  '.sl-rail__chip.subj.current { border-style: solid; border-color: #845ef7; box-shadow: 0 0 0 2px rgba(132,94,247,.28), 0 4px 12px -4px rgba(132,94,247,.5); color: #5f3dc4; background: #f3edff; }',
  '.sl-rail__expander { position: fixed; left: 0; top: 50%; transform: translateY(-50%); z-index: 260; width: 26px; height: 62px; border: 1px solid #dfe5ef; border-left: none; border-radius: 0 10px 10px 0; background: linear-gradient(180deg, #ffffff, #f6f8fc); cursor: pointer; color: #7d8aa3; font-size: 15px; box-shadow: 3px 0 12px -4px rgba(15,23,42,.18); transition: color .15s ease, box-shadow .15s ease; }',
  '.sl-rail__expander:hover { color: #1c7ed6; box-shadow: 3px 0 16px -4px rgba(28,126,214,.4); }',
  '.sl-rail__foot { flex: 0 0 auto; padding: 10px 12px; border-top: 1px solid #eef1f6; background: linear-gradient(180deg, #fbfcfe, #f6f8fc); }',
  '.sl-rail__lastsub { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; border: none; border-radius: 999px; padding: 7px 8px; font-size: 12px; font-weight: 500; white-space: nowrap; color: #fff; cursor: pointer; background: linear-gradient(120deg, #4dabf7, #1c7ed6); box-shadow: 0 6px 16px -6px rgba(28,126,214,.65); transition: filter .12s ease, transform .12s ease, box-shadow .12s ease; }',
  '.sl-rail__progress { padding: 9px 12px 0; flex: 0 0 auto; }',
  '.sl-rail__pbar { height: 5px; border-radius: 999px; background: #e8ecf4; overflow: hidden; }',
  '.sl-rail__pbar i { display: block; height: 100%; width: 0; border-radius: 999px; background: linear-gradient(90deg, #40c057, #2f9e44); transition: width .45s cubic-bezier(.2,.8,.3,1); }',
  '.sl-rail__ptext { margin-top: 4px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; color: #93a0b5; text-align: right; }',
  '.sl-rail__lastsub:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 9px 20px -6px rgba(28,126,214,.7); }',
  '.sl-rail__lastsub:active { transform: translateY(0); }',
  '.sl-rail__lastsub:disabled { opacity: .7; cursor: default; transform: none; }',
  '.pta-dark .sl-rail { background: linear-gradient(180deg, #1e2227, #1a1e23); border-right-color: #2e3338; box-shadow: 4px 0 18px -8px rgba(0,0,0,.6); }',
  '.pta-dark .sl-rail__head { color: #c6cdd4; }',
  '.pta-dark .sl-rail__head button { color: #8b97a3; }',
  '.pta-dark .sl-rail__head button:hover { background: #2a3036; color: #4dabf7; }',
  '.pta-dark .sl-rail__cat { color: #7f8b97; }',
  '.pta-dark .sl-rail__chip { background: #262b31; border-color: #3a424b; color: #cfd6dd; }',
  '.pta-dark .sl-rail__chip:hover { border-color: #4dabf7; color: #4dabf7; }',
  '.pta-dark .sl-rail__chip.quiz { background: #12241f; border-color: #1d5c49; color: #3dd6a5; }',
  '.pta-dark .sl-rail__chip.subj { background: #241f33; border-color: #4d3f7d; color: #b197fc; }',
  '.pta-dark .sl-rail__chip.tried { background: #2c1e21; border-color: #6e3038; color: #ff8787; }',
  '.pta-dark .sl-rail__chip.ac { background: linear-gradient(135deg, #2f9e44, #237032); color: #eafbea; }',
  '.pta-dark .sl-rail__chip.current { border-color: #4dabf7; box-shadow: 0 0 0 2px rgba(77,171,247,.35); }',
  '.pta-dark .sl-rail__chip.locked { background: #1f2327; border-color: #3a424b; color: #5c6670; }',
  '.pta-dark .sl-rail__chip.skipped { background: #2c2418; border-color: #6e4a1e; color: #ffa94d; }',
  '.pta-dark .sl-rail__chip.gate-now:not(.ac) { border-color: #b197fc; color: #d0bdfb; }',
  '.pta-dark .sl-rail__gate { background: #2c2440; border-color: #4d3f7d; color: #cfd6dd; }',
  '.pta-dark .sl-rail__gate b { color: #d0bdfb; }',
  '.pta-dark .sl-rail__gate button { background: #262b31; border-color: #4d3f7d; color: #d0bdfb; }',
  '.pta-dark .sl-rail__gate button.sl-gate__next { background: linear-gradient(120deg, #7048e8, #9c36b5); border-color: transparent; color: #fff; }',
  '.pta-dark .sl-rail__chip.bonus { background: #2c2440; border-color: #4d3f7d; color: #d0bdfb; }',
  '.pta-dark .sl-rail__chip.bonus-drafting { background: linear-gradient(90deg, #2c2440 0%, #3d3260 50%, #2c2440 100%); background-size: 200% 100%; }',
  '.pta-dark .sl-rail__chip.bonus-failed { background: #2c1e21; border-color: #6e3038; color: #ff8787; }',
  '.pta-dark .sl-rail__bonus .sl-bonus__wait { background: #2c2440; border-color: #4d3f7d; color: #d0bdfb; }',
  '.pta-dark .sl-rail__bonus .sl-bjob { background: linear-gradient(160deg, #2a2440, #302448 60%, #2c2440); border-color: #4d3f7d; box-shadow: 0 12px 26px -14px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.05); }',
  '.pta-dark .sl-rail__bonus .sl-bjob::before { background: radial-gradient(closest-side, rgba(174,62,201,.22), transparent 70%); }',
  '.pta-dark .sl-rail__bonus .sl-bjob__orb { background: #1f2327; box-shadow: 0 4px 14px -6px rgba(0,0,0,.8); }',
  '.pta-dark .sl-rail__bonus .sl-bjob__titles b { color: #d0bdfb; }',
  '.pta-dark .sl-rail__bonus .sl-bjob__stage { color: #9aa4ad; }',
  '.pta-dark .sl-rail__bonus .sl-bjob__steps li { color: #6f7a86; }',
  '.pta-dark .sl-rail__bonus .sl-bjob__steps li.is-active { color: #e6e9ee; background: rgba(255,255,255,.06); }',
  '.pta-dark .sl-rail__bonus .sl-bjob__steps li.is-done { color: #69b34c; }',
  '.pta-dark .sl-rail__bonus .sl-bjob__mark { background: #343a42; color: #7f8b97; }',
  '.pta-dark .sl-rail__bonus li.is-done .sl-bjob__mark { background: #1f3a24; color: #69b34c; }',
  '.pta-dark .sl-rail__bonus li.is-active .sl-bjob__mark { background: #3d3260; }',
  '.pta-dark .sl-rail__bonus .sl-bjob__spin { border-color: #4d3f7d; border-top-color: #b197fc; }',
  '.pta-dark .sl-rail__bonus .sl-bjob__track { background: #3a3352; }',
  '.pta-dark .sl-rail__bonus .sl-bjob__kp { background: #262b31; border-color: #4d3f7d; color: #d0bdfb; }',
  '.pta-dark .sl-rail__bonus .sl-bjob__note { background: rgba(255,255,255,.05); border-color: #4d3f7d; color: #d0bdfb; }',
  '.pta-dark .sl-rail__bonus .sl-bonus__retry { color: #b197fc; }',
  '.pta-dark .sl-rail__chip.subj.current { border-color: #b197fc; background: #2c2440; color: #d0bdfb; box-shadow: 0 0 0 2px rgba(177,151,252,.35); }',
  '.pta-dark .sl-rail__foot { background: linear-gradient(180deg, #22262c, #1e2227); border-top-color: #2e3338; }',
  '.pta-dark .sl-rail__expander { background: linear-gradient(180deg, #23272c, #1e2227); border-color: #2e3338; color: #9aa4ad; }',
  '.pta-dark .sl-rail__pbar { background: #2a3036; }',
  '.pta-dark .sl-rail__ptext { color: #7f8b97; }',
].join('\n');

/** 'scratchpad' | 'page' | null — which surface the rail is currently attached to. */
let railMode = null;

/** Cached fetch of the current contest/homework problems' kinds and titles. */
let activityKindsPromise = null;
function fetchActivityKinds() {
  const uc = window.UiContext || {};
  // Preferred path: the backend render hook serializes the kinds straight
  // into UiContext — synchronous, no extra request, no failure modes.
  if (Array.isArray(uc.tdocKinds) && uc.tdocKinds.length) {
    console.info('[pta-ui] rail kinds: server-rendered,', uc.tdocKinds.length, 'problem(s)');
    return Promise.resolve(uc.tdocKinds);
  }
  const tid = uc.tdoc && uc.tdoc.docId;
  if (!tid) return Promise.resolve(null);
  console.info('[pta-ui] rail kinds: not server-rendered (backend hook inactive?), trying the endpoint...');
  if (!activityKindsPromise) {
    const domainPrefix = (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
    activityKindsPromise = request.get(`${domainPrefix}/activity/${tid}/problem-kinds`)
      .then((res) => {
        if (res && res.pids && res.pids.length) {
          console.info('[pta-ui] rail kinds: fetched from endpoint,', res.pids.length, 'problem(s)');
          return res.pids;
        }
        console.warn('[pta-ui] rail kinds: endpoint returned no data — flat grid fallback');
        return null;
      })
      .catch((e) => {
        console.warn('[pta-ui] rail kinds: endpoint failed (%s) — the BACKEND is likely running old code; '
          + 'restart it with the latest files. Falling back to the flat A/B grid.', (e && e.message) || e);
        return null;
      });
  }
  return activityKindsPromise;
}

/** Contest/homework chip groups: kind-grouped when kinds are known, flat otherwise. */
/**
 * Test / homework rail sections, shared by the paper page and the task pages:
 * true/false, single/multiple choice, fill-in-the-blank, then programming
 * (and subjective). Objective chips carry the paper's running number
 * (item.index); programming chips number themselves 1..n and show their
 * points underneath. Items without a group (older backends) fall back to
 * their kind.
 */
const RAIL_SECTIONS = [
  ['tf', 'True / False'], ['choice', 'Single / Multiple Choice'], ['blank', 'Fill in the Blank'],
  ['objective', 'Objectives'], ['subjective', 'Subjective Tasks'], ['programming', 'Programming'],
];

function groupRailItems(items) {
  const bucket = Object.fromEntries(RAIL_SECTIONS.map(([k]) => [k, []]));
  for (const it of items) {
    const group = bucket[it.group] ? it.group : (it.kind || 'programming');
    bucket[group].push(it);
  }
  const groups = [];
  for (const [key, header] of RAIL_SECTIONS) if (bucket[key].length) groups.push({ key, header: i18n(header), items: bucket[key] });
  for (const g of groups) {
    g.items.forEach((it, i) => {
      const n = it.index || (i + 1);
      it.label = it.accepted ? '✓' : String(n);
      it.title = `${n}. ${it.name}${typeof it.points === 'number' ? ` — ${it.points} ${i18n('pts')}` : ''}`;
      // Points are visible on programming chips (objective points sit on the paper).
      if (g.key === 'programming' && typeof it.points === 'number') it.pts = it.points;
    });
  }
  return groups;
}

function buildTdocGroups(kinds) {
  const uc = window.UiContext || {};
  const prefix = window.location.pathname.split('/p/')[0];
  const current = uc.pdoc && uc.pdoc.docId;
  const pids = uc.tdoc.pids;
  if (kinds) {
    const byPid = {};
    for (const k of kinds) byPid[String(k.pid)] = k;
    const items = [];
    for (const pid of pids) {
      const info = byPid[String(pid)] || {};
      const kind3 = info.kind === 'subjective' ? 'subjective' : (info.kind && info.kind !== 'programming' ? 'objective' : 'programming');
      const st = info.status || 0;
      items.push({
        pid: String(pid),
        kind: kind3,
        group: info.group,
        index: info.index,
        points: info.points,
        accepted: st === 1,
        cls: `${st === 1 ? ' ac' : (st ? ' tried' : '')}${kind3 === 'objective' ? ' quiz' : (kind3 === 'subjective' ? ' subj' : '')}${String(pid) === String(current) ? ' current' : ''}`,
        name: info.title || String(pid),
        href: `${prefix}/p/${pid}?tid=${uc.tdoc.docId}`,
      });
    }
    return groupRailItems(items);
  }
  return [{
    header: null,
    items: pids.map((pid, i) => ({
      pid: String(pid),
      label: alphaLabel(i),
      cls: String(pid) === String(current) ? ' current' : '',
      title: alphaLabel(i),
      href: `${prefix}/p/${pid}?tid=${uc.tdoc.docId}`,
    })),
  }];
}

/**
 * Chip groups for the current activity, or null when the page has no
 * activity context. Self-learning sessions AND contests/homework both split
 * into quiz-style vs programming groups with independent 1..n numbering
 * (contest kinds arrive via the activity_problem_kinds endpoint; a flat grid
 * is the fallback when it is unavailable).
 */
async function getRailGroups() {
  const uc = window.UiContext || {};
  /*
   * Combined objective paper: the handler ships explicit per-item hrefs —
   * objective chips anchor to #q-<docId> INSIDE the paper while other kinds
   * link out to their own pages — so this branch honors item.href verbatim
   * instead of rebuilding it. The 'current' ring is driven live by the
   * paper's scrollspy rather than set here.
   */
  if (uc.paperRail && Array.isArray(uc.paperRail.items) && uc.paperRail.items.length) {
    /*
     * Test paper rail: one section per objective question type — true/false,
     * single/multiple choice, fill-in-the-blank — then programming (and
     * subjective, if any). Objective chips carry the paper's running number
     * (item.index) so the rail and the question badges agree; programming
     * chips number themselves 1..n.
     */
    return groupRailItems(uc.paperRail.items.map((p) => {
      const kindCls = p.kind === 'objective' ? ' quiz' : (p.kind === 'subjective' ? ' subj' : '');
      const st = p.status || 0;
      const handedIn = !st && p.submitted ? ' submitted' : '';
      return {
        pid: String(p.pid),
        kind: p.kind,
        group: p.group,
        index: p.index,
        points: p.points,
        accepted: st === 1,
        cls: `${st === 1 ? ' ac' : (st ? ' tried' : '')}${handedIn}${kindCls}`,
        name: p.title || String(p.pid),
        href: p.href,
      };
    }));
  }
  if (Array.isArray(uc.slProblems) && uc.slProblems.length) {
    const prefix = window.location.pathname.split('/self-learning/')[0];
    const quizzes = [];
    const subj = [];
    const programming = [];
    for (const p of uc.slProblems) {
      const kindCls = p.kind === 'objective' ? ' quiz' : (p.kind === 'subjective' ? ' subj' : '');
      // One task at a time (students): locked chips are inert, skipped and
      // finished ones stay open for retries, the current one is highlighted.
      const gate = p.gate || '';
      const item = {
        pid: String(p.pid),
        accepted: p.status === 1,
        gate,
        cls: `${p.status === 1 ? ' ac' : (p.status ? ' tried' : '')}${kindCls}`
          + (String(p.pid) === String(uc.slPid) ? ' current' : '')
          + (gate === 'locked' ? ' locked' : gate === 'skipped' ? ' skipped' : gate === 'current' ? ' gate-now' : ''),
        name: p.title || String(p.pid),
        href: gate === 'locked' ? 'javascript:;' : `${prefix}/self-learning/${uc.slSsid}/p/${p.pid}`,
      };
      (p.kind === 'programming' ? programming : (p.kind === 'subjective' ? subj : quizzes)).push(item);
    }
    const groups = [];
    if (quizzes.length) groups.push({ header: i18n('Objectives'), items: quizzes });
    if (subj.length) groups.push({ header: i18n('Subjective Tasks'), items: subj });
    if (programming.length) groups.push({ header: i18n('Programming'), items: programming });
    for (const g of groups) {
      g.items.forEach((it, i) => {
        it.label = it.gate === 'locked' ? '🔒' : it.gate === 'skipped' && !it.accepted ? '⏭' : it.accepted ? '✓' : String(i + 1);
        it.title = it.gate === 'locked' ? `${i + 1}. ${it.name} — ${i18n('Unlocks after you finish or skip the previous task')}`
          : it.gate === 'skipped' ? `${i + 1}. ${it.name} — ${i18n('Skipped — come back any time')}`
            : `${i + 1}. ${it.name}`;
      });
    }
    // Bonus tasks (students): chips after the session's tasks; a task that
    // is still being drafted shows as an animated placeholder.
    if (Array.isArray(uc.slBonuses) && uc.slBonuses.length) {
      groups.push({
        header: i18n('Bonus'),
        bonus: true,
        items: uc.slBonuses.map((b, i) => {
          // No statement to open yet: diagnosing (the AI reads the work)
          // and drafting (the statement is being written) look the same.
          const designing = b.status === 'diagnosing' || b.status === 'drafting';
          return {
            pid: b.docId ? String(b.docId) : '',
            bonusId: b.id,
            bonusStatus: b.status,
            cls: ` bonus${designing ? ' bonus-drafting' : b.status === 'building' ? ' bonus-building' : b.status === 'failed' ? ' bonus-failed' : ''}`
              + (b.docId && String(b.docId) === String(uc.slPid) ? ' current' : ''),
            name: b.title || i18n('Bonus task'),
            href: b.docId && b.status !== 'failed' ? `${prefix}/self-learning/${uc.slSsid}/p/${b.docId}` : 'javascript:;',
            label: designing ? '…' : b.status === 'failed' ? '⚠' : `🎁${i + 1}`,
            title: designing ? i18n('Designing your bonus task…')
              : b.status === 'building' ? `${b.title || i18n('Bonus task')} — ${i18n('read and code now; the judge is being prepared')}`
                : b.status === 'failed' ? `${i18n('Bonus task failed')}: ${b.message || ''}`
                  : `${b.title || i18n('Bonus task')} — ${(b.weakPoints || []).join(', ')}`,
          };
        }),
      });
    }
    return groups;
  }
  if (uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) {
    const serverRendered = Array.isArray(uc.tdocKinds) && uc.tdocKinds.length;
    const kinds = await fetchActivityKinds();
    console.info('[pta-ui] activity kinds source:',
      serverRendered ? 'server-rendered' : (kinds ? `fetched (${kinds.length})` : 'none -> flat grid (is the backend up to date?)'));
    return buildTdocGroups(kinds);
  }
  const tr = uc.trainingRail;
  if (tr && Array.isArray(tr.kinds) && tr.kinds.length > 1) {
    // Training: problems live on the plain problem page; ?trid=... carries
    // the context (decorated onto training links by this module) and keeps
    // it while hopping between chips.
    console.info('[pta-ui] rail kinds: server-rendered (training),', tr.kinds.length, 'problem(s)');
    const prefix = window.location.pathname.split('/p/')[0];
    const current = uc.pdoc && uc.pdoc.docId;
    const quizzes = [];
    const subj = [];
    const programming = [];
    for (const info of tr.kinds) {
      const kind3 = info.kind === 'subjective' ? 'subjective' : (info.kind && info.kind !== 'programming' ? 'objective' : 'programming');
      const st = info.status || 0;
      const item = {
        pid: String(info.pid),
        accepted: st === 1,
        cls: `${st === 1 ? ' ac' : (st ? ' tried' : '')}${kind3 === 'objective' ? ' quiz' : (kind3 === 'subjective' ? ' subj' : '')}${String(info.pid) === String(current) ? ' current' : ''}`,
        name: info.title || String(info.pid),
        href: `${prefix}/p/${info.pid}?trid=${tr.trid}`,
      };
      (kind3 === 'programming' ? programming : (kind3 === 'subjective' ? subj : quizzes)).push(item);
    }
    const groups = [];
    if (quizzes.length) groups.push({ header: i18n('Objectives'), items: quizzes });
    if (subj.length) groups.push({ header: i18n('Subjective Tasks'), items: subj });
    if (programming.length) groups.push({ header: i18n('Programming'), items: programming });
    for (const g of groups) {
      g.items.forEach((it, i) => {
        it.label = it.accepted ? '✓' : String(i + 1);
        it.title = `${i + 1}. ${it.name}`;
      });
    }
    return groups;
  }
  const ps = uc.psetRail;
  if (ps && Array.isArray(ps.kinds) && ps.kinds.length > 1) {
    // Problem set: a window of neighboring problems around the current one,
    // server-selected in docId order with visibility already applied.
    console.info('[pta-ui] rail kinds: server-rendered (problem set),', ps.kinds.length, 'problem(s)');
    const prefix = window.location.pathname.split('/p/')[0];
    const current = uc.pdoc && uc.pdoc.docId;
    const quizzes = [];
    const subj = [];
    const programming = [];
    for (const info of ps.kinds) {
      const kind3 = info.kind === 'subjective' ? 'subjective' : (info.kind && info.kind !== 'programming' ? 'objective' : 'programming');
      const st = info.status || 0;
      const item = {
        pid: String(info.pid),
        accepted: st === 1,
        cls: `${st === 1 ? ' ac' : (st ? ' tried' : '')}${kind3 === 'objective' ? ' quiz' : (kind3 === 'subjective' ? ' subj' : '')}${String(info.pid) === String(current) ? ' current' : ''}`,
        name: info.title || String(info.pid),
        href: `${prefix}/p/${info.pid}`,
      };
      (kind3 === 'programming' ? programming : (kind3 === 'subjective' ? subj : quizzes)).push(item);
    }
    const groups = [];
    if (quizzes.length) groups.push({ header: i18n('Objectives'), items: quizzes });
    if (subj.length) groups.push({ header: i18n('Subjective Tasks'), items: subj });
    if (programming.length) groups.push({ header: i18n('Programming'), items: programming });
    for (const g of groups) {
      g.items.forEach((it, i) => {
        it.label = it.accepted ? '✓' : String(i + 1);
        it.title = `${i + 1}. ${it.name}`;
      });
    }
    return groups;
  }
  return null;
}

/** Squeeze whichever content surface the current rail mode owns. */
function squeezeContent(width) {
  if (railMode === 'page') {
    $('.main, .footer').css('margin-left', width ? `${width}px` : '');
  } else {
    $('.scratchpad-container').css({ left: `${width}px`, width: `calc(100% - ${width}px)` });
    window.dispatchEvent(new Event('resize')); // let Monaco and the split panes relayout
  }
}

export function removeRail() {
  $('#sl-rail, #sl-rail-expander').remove();
  $('.scratchpad-container').css({ left: '0px', width: '100%' });
  $('.main, .footer').css('margin-left', '');
  railMode = null;
}

function setCollapsed(collapsed) {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '');
  } catch (e) { /* best-effort */ }
  $('#sl-rail').toggle(!collapsed);
  $('#sl-rail-expander').toggle(collapsed);
  squeezeContent(collapsed ? 0 : RAIL_W);
}

/** In BOTH modes the rail sits below the fixed navbar; keep that on resize. */
function syncRailTop() {
  if (!railMode) return;
  $('#sl-rail').css('top', `${navTop()}px`);
}

let railBuilding = false;

async function injectRail(mode) {
  if (document.getElementById('sl-rail')) {
    if (railMode === mode) return;
    removeRail(); // re-homing between the IDE and the page rebuilds cleanly
  }
  if (railBuilding) return;
  railBuilding = true;
  let groups = null;
  try {
    groups = await getRailGroups();
  } finally {
    railBuilding = false;
  }
  if (document.getElementById('sl-rail')) return; // a concurrent build won
  // The current task's points, next to its statement title (test pages).
  try {
    const uc = window.UiContext || {};
    const current = uc.pdoc && String(uc.pdoc.docId);
    let pts;
    for (const g of groups || []) for (const it of g.items) if (String(it.pid) === current && typeof it.points === 'number') pts = it.points;
    if (typeof pts === 'number' && !document.querySelector('.sl-pts-badge')) {
      const $title = $('.problem-content .section__title, .section__header .section__title').first();
      if ($title.length) $title.append(`<span class="sl-pts-badge" title="${esc(i18n('Points of this task'))}">${esc(`${pts} ${i18n('pts')}`)}</span>`);
    }
  } catch (e) { /* decoration only */ }
  if (!groups) {
    const uc = window.UiContext || {};
    console.info('[pta-ui] problem rail skipped:', {
      slProblems: Array.isArray(uc.slProblems) ? uc.slProblems.length : 'absent',
      tdocPids: uc.tdoc && Array.isArray(uc.tdoc.pids) ? uc.tdoc.pids.length : 'absent',
    });
    return;
  }
  applyThemeTag();
  if (!document.getElementById('sl-rail-style')) {
    $('<style>').attr('id', 'sl-rail-style').text(RAIL_STYLE).appendTo(document.head);
  }
  railMode = mode;
  console.info('[pta-ui] rail: attaching in', mode, 'mode with', groups.length, 'group(s)');
  // Progress readout: only counts chips that actually carry verdict state.
  let solved = 0;
  let tracked = 0;
  for (const g of groups) for (const it of g.items) if (Object.prototype.hasOwnProperty.call(it, 'accepted')) { tracked += 1; if (it.accepted) solved += 1; }
  const progressHtml = tracked
    ? `<div class="sl-rail__progress"><div class="sl-rail__pbar"><i style="width:${Math.round((solved / tracked) * 100)}%"></i></div>`
      + `<div class="sl-rail__ptext" data-total="${tracked}">${solved} / ${tracked} ${esc(i18n('solved'))}</div></div>`
    : '';
  const body = groups.map((g) => {
    const chips = g.items.map((it) => `<a class="sl-rail__chip${it.cls}${typeof it.pts === 'number' ? ' has-pts' : ''}"${it.pid ? ` data-pid="${esc(it.pid)}"` : ''}${typeof it.pts === 'number' ? ` data-pts="${esc(`${it.pts} ${i18n('pts')}`)}"` : ''}${it.bonusId ? ` data-bonus="${esc(it.bonusId)}" data-bonus-status="${esc(it.bonusStatus || '')}"` : ''} href="${it.href}" title="${esc(it.title)}">${esc(it.label)}</a>`).join('');
    const withPts = g.items.some((it) => typeof it.pts === 'number');
    return `${g.header ? `<div class="sl-rail__cat">${esc(g.header)}</div>` : ''}<div class="sl-rail__grid${withPts ? ' sl-rail__grid--pts' : ''}">${chips}</div>`;
  }).join('');
  $(`<div id="sl-rail" class="sl-rail" style="top:${navTop()}px">`
    + `<div class="sl-rail__head"><span>${esc(i18n('Problems'))}</span>`
    + `<button id="sl-rail-toggle" type="button" title="${esc(i18n('Collapse'))}">⟨</button></div>`
    + '<div class="sl-rail__timer" id="sl-rail-timer"></div>'
    + progressHtml
    + ((window.UiContext && UiContext.slGate) ? '<div id="sl-gate" class="sl-rail__gate"></div>' : '')
    + `<div class="sl-rail__body">${body}</div>`
    + ((window.UiContext && UiContext.slBonus) ? '<div id="sl-bonus" class="sl-rail__bonus"></div>' : '')
    + ((window.UiContext && UiContext.pdoc && UiContext.pdoc.docId)
      ? `<div class="sl-rail__foot"><button type="button" id="sl-rail-lastsub" class="sl-rail__lastsub">🕘 ${esc(i18n('View Last Submission'))}</button></div>`
      : '')
    + '</div>').appendTo(document.body);
  $('#sl-rail-lastsub').on('click', function onLastSub() {
    openLastSubmission($(this));
  });
  $(`<button id="sl-rail-expander" class="sl-rail__expander" type="button" style="display:none" title="${esc(i18n('Problems'))}">≡</button>`).appendTo(document.body);
  $('#sl-rail-toggle').on('click', () => setCollapsed(true));
  $('#sl-rail-expander').on('click', () => setCollapsed(false));
  let collapsed = false;
  try {
    const saved = localStorage.getItem(RAIL_COLLAPSED_KEY);
    if (saved === '1') collapsed = true;
    // First visit on a narrow page: content space beats the rail.
    else if (saved === null && mode === 'page' && window.matchMedia('(max-width: 600px)').matches) collapsed = true;
  } catch (e) { /* default expanded */ }
  setCollapsed(collapsed);
  // The IDE/nav layout settles asynchronously; keep the header out from
  // under the fixed navbar.
  syncRailTop();
  setTimeout(syncRailTop, 350);
  setTimeout(syncRailTop, 900);
}

/**
 * Live verdict -> rail: flip a problem's chip the moment its submission is
 * judged — green ✓ once accepted (sticky, mirroring the problem-status doc),
 * red outline after a failed try. Exposed on window so the self-learning
 * solve page (a separate bundle) can drive it too.
 */
export function markRailStatus(pid, accepted, submitted = false) {
  const key = (window.CSS && CSS.escape) ? CSS.escape(String(pid)) : String(pid);
  const chip = document.querySelector(`#sl-rail .sl-rail__chip[data-pid="${key}"]`);
  if (!chip) return;
  if (submitted && !accepted) {
    // An objective answer whose verdict is withheld: "handed in", not "wrong".
    if (!chip.classList.contains('ac')) {
      chip.classList.remove('tried');
      chip.classList.add('submitted');
    }
    return;
  }
  if (accepted) {
    chip.classList.remove('tried');
    if (!chip.classList.contains('ac')) {
      chip.classList.add('ac');
      chip.textContent = '✓';
    }
  } else if (!chip.classList.contains('ac')) {
    chip.classList.add('tried');
  }
  const bar = document.querySelector('#sl-rail .sl-rail__pbar i');
  const txt = document.querySelector('#sl-rail .sl-rail__ptext');
  if (bar && txt) {
    const total = Number(txt.getAttribute('data-total'))
      || document.querySelectorAll('#sl-rail .sl-rail__chip[data-pid]').length;
    const ac = document.querySelectorAll('#sl-rail .sl-rail__chip.ac').length;
    bar.style.width = `${total ? Math.round((ac / total) * 100) : 0}%`;
    txt.textContent = `${ac} / ${total} ${i18n('solved')}`;
  }
}
window.__ptaRailMark = markRailStatus;

/** Wait for scratchpad mode to be active, then attach the rail inside the IDE. */
export function injectRailWhenReady() {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if ($('body').hasClass('mode--scratchpad')) {
      clearInterval(timer);
      injectRail('scratchpad');
    } else if (tries > 50) clearInterval(timer);
  }, 100);
}

/** Attach the rail to a normal document page (quiz / answer-submission pages). */
export function injectRailForPage() {
  injectRail('page');
}

$(window).on('resize', syncRailTop);

/* ------------------- training links carry their context ------------------- */

/**
 * Training problems link to the plain problem page with no activity context,
 * so the sidebar could never know its siblings there. Decorate every problem
 * link on the training page with ?trid=<trainingId>; the backend rail hook
 * resolves it into the grouped sidebar, and chip navigation keeps it alive.
 */
function decorateTrainingLinks() {
  const m = window.location.pathname.match(/\/training\/([0-9a-f]{24})/i);
  if (!m) return;
  const trid = m[1];
  let n = 0;
  document.querySelectorAll('a[href]').forEach((a) => {
    let u;
    try {
      u = new URL(a.getAttribute('href'), window.location.origin);
    } catch (e) {
      return;
    }
    if (u.origin !== window.location.origin) return;
    if (!/^(\/d\/[^/]+)?\/p\/[^/?#]+\/?$/.test(u.pathname)) return;
    if (u.searchParams.has('trid') || u.searchParams.has('tid')) return;
    u.searchParams.set('trid', trid);
    a.setAttribute('href', u.pathname + u.search + u.hash);
    n += 1;
  });
  if (n) console.info('[pta-ui] training: decorated', n, 'problem link(s) with trid=', trid);
}

/* --------------- site-wide submit-result modal + judging pill --------------- */

const SITE_UI_STYLE = `
/* Beautify pass: the .slm result modal, the #sl-judging pill and the
   .sl-attempt "Submitted code" panel now ship once from the compiled
   design system (pages/pta_theme.page.styl, tokens + shared motion) in
   both themes. This injected sheet is kept only so every existing
   ensureSiteStyle() call site stays valid. */
`;

function ensureSiteStyle() {
  applyThemeTag();
  if (!document.getElementById('sw-ui-style')) {
    $('<style>').attr('id', 'sw-ui-style').text(SITE_UI_STYLE).appendTo(document.head);
  }
}

function showJudging() {
  ensureSiteStyle();
  if (!document.getElementById('sl-judging')) {
    $(`<div id="sl-judging">⏳ ${esc(i18n('Judging...'))}</div>`).appendTo(document.body);
  }
}

function hideJudging() {
  $('#sl-judging').remove();
}

/**
 * The PTA-style "Submit Result" modal: summary grid, per-test-case detail
 * (deliberately WITHOUT any hint column), the submitted source with line
 * numbers, and the compiler output.
 */
export function showSubmitModal(data, onClose) {
  ensureSiteStyle();
  const conf = (window.UiContext && UiContext.pdoc && typeof UiContext.pdoc.config === 'object' && UiContext.pdoc.config) || {};
  const timeLimit = conf.timeMax || conf.time || null;
  const memLimitKB = conf.memoryMax ? conf.memoryMax * 1024 : null;
  const stColor = statusColor(data.status, data.accepted);
  const pdoc = (window.UiContext && UiContext.pdoc) || {};
  const problemName = `${pdoc.pid ?? pdoc.docId ?? ''}. ${pdoc.title || ''}`;
  const userName = (window.UserContext && (UserContext.uname || UserContext.displayName)) || `#${(window.UserContext || {})._id ?? ''}`;
  const cell = (k, v, cls = '') => `<div><div class="slm__k">${esc(i18n(k))}</div><div class="slm__v ${cls}">${v}</div></div>`;
  let html = '<div class="slm__summary">';
  html += cell('Problem', esc(problemName));
  html += cell('User', esc(userName));
  html += cell('Submit At', esc(fmtTs(data.submitAt)));
  html += cell('Compiler', esc(langDisplay(data.lang)));
  html += cell('Memory Usage', esc(`${data.memory}${memLimitKB ? ` / ${memLimitKB}` : ''} KB`));
  html += cell('Time Usage', esc(`${data.time}${timeLimit ? ` / ${timeLimit}` : ''} ms`));
  html += `<div><div class="slm__k">${esc(i18n('Status'))}</div><div class="slm__v" style="color:${stColor};font-weight:bold">${esc(data.statusText || '')}</div></div>`;
  html += cell('Score', esc(String(data.score ?? 0)));
  html += cell('Judge At', esc(fmtTs(data.judgeAt)));
  html += '</div>';
  if (data.cases && data.cases.length) {
    html += `<div class="slm__sect"><div class="slm__secthead">${esc(i18n('Submission Detail'))}</div>`
      + `<table class="slm__table"><thead><tr><th>${esc(i18n('Test Case'))}</th><th>${esc(i18n('Memory(KB)'))}</th>`
      + `<th>${esc(i18n('Time(ms)'))}</th><th>${esc(i18n('Status'))}</th><th>${esc(i18n('Score'))}</th></tr></thead><tbody>`;
    for (const c of data.cases) {
      const key = caseKey(c) ?? '?';
      // Full status name in its semantic color, with the judge's per-case
      // detail message (when any) right beneath it.
      html += `<tr><td>${esc(String(key))}</td><td>${esc(String(c.memory ?? '-'))}</td>`
        + `<td>${esc(String(c.time ?? '-'))}</td>`
        + `<td class="slm__st" style="color:${statusColor(c.status)}">${esc(c.statusText || '')}`
        + (c.message ? `<div class="slm__msg">${esc(c.message)}</div>` : '')
        + `</td><td>${esc(String(c.score ?? '-'))}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  html += `<div class="slm__sect"><div class="slm__secthead">${esc(i18n('Submission Code'))}`
    + `<span class="slm__langtag">[ ${esc(langDisplay(data.lang))} ]</span></div>`
    + `<div class="slm__codearea"><pre class="slm__code line-numbers"><code class="language-${prismLang(data.lang)}">${esc(data.code || '')}</code></pre></div></div>`;
  if (data.compilerTexts) {
    html += `<div class="slm__sect"><div class="slm__secthead">${esc(i18n('Compilation Output'))}</div>`
      + `<pre class="slm__compile">${esc(data.compilerTexts)}</pre></div>`;
  }
  const aiEligible = !!data.accepted && SCRATCHPAD_TYPES.includes(problemType());
  const $mask = $('<div class="slm-mask"></div>').appendTo(document.body);
  const $modal = $(`<div class="slm" role="dialog" aria-label="${esc(i18n('Submit Result'))}">`
    + `<div class="slm__head"><span class="slm__title">${esc(i18n('Submit Result'))}</span>`
    + `<button type="button" class="slm__close" title="${esc(i18n('Close'))}">×</button></div>`
    + `<div class="slm__body">${html}</div>`
    + '<div class="slm__foot">'
    + (aiEligible ? `<button type="button" class="slm__ai-btn">🤖 ${esc(i18n('AI Suggestions'))}</button>` : '')
    + '<span class="slm__spacer"></span>'
    + `<button type="button" class="rounded primary button slm__ok">${esc(i18n('OK'))}</button></div>`
    + '</div>').appendTo($mask);
  import('vj/components/highlighter/prismjs')
    .then(({ default: prism }) => prism.highlightBlocks($modal))
    .catch(() => { /* highlighting is optional */ });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    $(document).off('keydown.slmodal');
    // Smooth disappear: fade the mask, sink the dialog, then remove.
    $mask.addClass('slm-mask--closing');
    setTimeout(() => {
      $mask.remove();
      if (onClose) onClose();
    }, 190);
  };
  $modal.find('.slm__close, .slm__ok').on('click', close);
  // Requirement: post-acceptance AI report — statement + FULL trajectory as
  // context, rendered as Markdown inside this modal, downloadable as PDF.
  // Saved-report probe: if this problem already has a generated report in the
  // database, the button flips to an instant, token-free "View" affordance.
  let aiSaved = null; // { report, updateAt }
  const aiUrl = () => trajectoryUrl().replace(/\/trajectory$/, '/ai-suggestions');
  if (aiEligible) {
    request.get(aiUrl()).then((r) => {
      if (r && r.report) {
        aiSaved = { report: String(r.report), updateAt: r.updateAt };
        $modal.find('.slm__ai-btn').html(`📄 ${esc(i18n('View AI Suggestions'))}`);
      }
    }).catch(() => { /* no saved report — the button stays in generate mode */ });
  }

  /** Render a report section (used for saved, fresh, and regenerated). */
  function renderReportSection(report, updateAt, $replaceEl) {
    const reportMd = String(report || '');
    const reportHtml = mdReport.render(reportMd);
    const $sect = $('<div class="slm__sect slm__sect--ai">'
      + `<div class="slm__aihead">🤖 <span class="slm__aititle">${esc(i18n('AI Suggestions'))}</span>`
      + (updateAt ? `<span class="slm__aits">${esc(i18n('Saved'))}: ${esc(fmtTs(updateAt))}</span>` : '')
      + `<button type="button" class="slm__pdf slm__regen" title="${esc(i18n('Regenerate'))}">↻ ${esc(i18n('Regenerate'))}</button>`
      + `<button type="button" class="slm__pdf slm__dl">⬇ ${esc(i18n('Download PDF'))}</button></div>`
      + '<div class="slm__ai typo"></div></div>');
    $sect.find('.slm__ai').html(reportHtml);
    if ($replaceEl) $replaceEl.replaceWith($sect);
    else $modal.find('.slm__body').append($sect);
    import('vj/components/highlighter/prismjs')
      .then(({ default: prism }) => prism.highlightBlocks($sect))
      .catch(() => { /* highlighting is optional */ });
    $sect[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
    $sect.find('.slm__dl').on('click', function onPdfClick() {
      const $p = $(this);
      $p.prop('disabled', true);
      downloadAiReportPdf(reportMd, reportHtml, reportFileName()).finally(() => $p.prop('disabled', false));
    });
    $sect.find('.slm__regen').on('click', () => startGeneration($sect, null));
    return $sect;
  }

  /** Generate (or regenerate): spinner section -> LLM -> saved server-side. */
  async function startGeneration($replaceEl, $btn) {
    if ($btn) $btn.prop('disabled', true).html(`<span class="slm__btnspin"></span>${esc(i18n('Generating suggestions...'))}`);
    const $gen = $('<div class="slm__sect slm__sect--ai">'
      + `<div class="slm__aihead">🤖 <span class="slm__aititle">${esc(i18n('AI Suggestions'))}</span></div>`
      + '<div class="slm__genwrap"><div class="slm__spinner"></div>'
      + `<div class="slm__gentext"><b>${esc(i18n('The AI is generating your report...'))}</b><br>`
      + `${esc(i18n('This usually takes 10-30 seconds. Please keep this window open and do not quit.'))}</div></div></div>`);
    if ($replaceEl) $replaceEl.replaceWith($gen);
    else $modal.find('.slm__body').append($gen);
    $gen[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const res = await request.post(aiUrl(), {});
      aiSaved = { report: String((res && res.report) || ''), updateAt: res && res.updateAt };
      renderReportSection(aiSaved.report, aiSaved.updateAt, $gen);
      if ($btn) $btn.remove();
    } catch (e) {
      $gen.remove();
      Notification.error(e.message);
      if ($btn) $btn.prop('disabled', false).text(aiSaved ? `📄 ${i18n('View AI Suggestions')}` : `🤖 ${i18n('AI Suggestions')}`);
    }
  }

  $modal.find('.slm__ai-btn').on('click', function onAiClick() {
    const $btn = $(this);
    if (aiSaved) {
      // Instant view straight from the database — no LLM call, no tokens.
      renderReportSection(aiSaved.report, aiSaved.updateAt, null);
      $btn.remove();
      return;
    }
    startGeneration(null, $btn);
  });
  $(document).on('keydown.slmodal', (ev) => {
    if (ev.key === 'Escape') close();
  });
}

/* -------------- "Submitted code" panel below the problem statement -------------- */

/**
 * Requirement: every submitted program of the current user on this problem,
 * as collapsible cards at the bottom of the problem description. The panel
 * lives inside .problem-content, which the Scratchpad reuses as its
 * statement pane, so it shows both in and out of the IDE. Pretest runs are
 * excluded server-side.
 */
export async function refreshAttemptsPanel() {
  const uc = window.UiContext || {};
  if (!uc.pdoc || !uc.pdoc.docId) return;
  if (!SCRATCHPAD_TYPES.includes(problemType())) return; // code history only
  let res;
  try {
    res = await request.get(trajectoryUrl());
  } catch (e) {
    return; // guests / errors: the panel is best-effort
  }
  const attempts = res.attempts || [];
  ensureSiteStyle();
  let $panel = $('#sl-attempts');
  if (!$panel.length) {
    const $content = $('.problem-content');
    if (!$content.length) return;
    $panel = $('<div id="sl-attempts" class="typo"></div>').appendTo($content);
  }
  const rowHtml = (a, num, open) => {
    const score = Math.max(0, Math.min(100, Number(a.score ?? 0)));
    const whenFull = a.at ? new Date(a.at).toLocaleString() : '';
    const when = a.at ? new Date(a.at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const tone = a.accepted ? ' pass' : (score > 0 ? ' part' : ' zero');
    const barTone = a.accepted ? ' pass' : (score > 0 ? ' part' : '');
    return `<details class="sl-attempt"${open ? ' open' : ''}>`
      + `<summary title="${esc(`${i18n('Attempt')} #${num} · ${score} · ${a.lang || ''}${whenFull ? ` · ${whenFull}` : ''}`)}">`
      + `<span class="sl-attempt__num">#${num}</span>`
      + `<span class="sl-badge${a.accepted ? ' pass' : ''}">${esc(a.statusText || '')}</span>`
      + `<span class="sl-attempt__meta">${esc(a.lang || '')}${when ? ` · ${esc(when)}` : ''}</span>`
      + `<span class="sl-attempt__score${tone}">${score}</span>`
      + (score > 0 ? `<i class="sl-attempt__bar${barTone}" style="transform:scaleX(${(score / 100).toFixed(3)})"></i>` : '')
      + '</summary>'
      + `<pre><code class="language-${prismLang(a.lang)}">${esc(a.code || '')}</code></pre>`
      + '</details>';
  };
  const best = attempts.reduce((m, a) => Math.max(m, Number(a.score ?? 0)), 0);
  const anyAc = attempts.some((x) => x.accepted);
  let html = `<div class="sl-attempts__head"><h3>${esc(i18n('Submitted code'))}</h3>`
    + (attempts.length ? `<span class="sl-attempts__count">${attempts.length}</span>` : '')
    + (attempts.length ? `<span class="sl-attempts__best${anyAc ? ' pass' : ''}">${esc(i18n('Best'))} ${best}</span>` : '')
    + '</div>';
  if (!attempts.length) {
    html += `<p class="text-gray">${esc(i18n('No submissions yet.'))}</p>`;
    $panel.html(html);
    return;
  }
  // Newest first: the row that matters sits on top and starts expanded;
  // chronological attempt numbers are preserved.
  const rows = attempts.map((a, idx) => ({ a, num: idx + 1 })).reverse();
  const VISIBLE = 5;
  const fold = rows.length > VISIBLE + 1;
  rows.forEach(({ a, num }, i) => {
    if (fold && i === VISIBLE) html += '<div class="sl-attempts__rest" hidden>';
    html += rowHtml(a, num, i === 0);
  });
  if (fold) {
    html += '</div>'
      + `<button type="button" class="sl-attempts__more">▾ ${esc(i18n('Earlier attempts'))} (${rows.length - VISIBLE})</button>`;
  }
  $panel.html(html);
  $panel.find('.sl-attempts__more').on('click', function onMore() {
    $panel.find('.sl-attempts__rest').removeAttr('hidden');
    $(this).remove();
  });
  import('vj/components/highlighter/prismjs')
    .then(({ default: prism }) => prism.highlightBlocks($panel))
    .catch(() => { /* highlighting is optional */ });
}

/* --------------------- submission tracking (poll -> modal) --------------------- */

let lastTrackedRid = null;

/**
 * Rail footer: re-open the Submit Result modal for the user's LATEST
 * submission on the current problem — works on every surface (the
 * self-learning pages share this rail and modal too).
 */
async function openLastSubmission($btn) {
  const label = $btn.html();
  try {
    $btn.prop('disabled', true).text(i18n('Loading...'));
    const list = await request.get(trajectoryUrl());
    const attempts = (list && list.attempts) || [];
    if (!attempts.length) {
      Notification.info(i18n('No submissions yet.'));
      return;
    }
    const rid = attempts[attempts.length - 1].rid;
    const data = await request.get(`${trajectoryUrl()}?rid=${rid}`);
    showSubmitModal(data);
  } catch (e) {
    Notification.error(e.message);
  } finally {
    $btn.prop('disabled', false).html(label);
  }
}

/**
 * Poll a submission until judged, then refresh the history panel and pop
 * the result modal. Used for scratchpad submissions (via the store hook
 * below) and for inline objective submissions (called from the core problem
 * page instead of redirecting to the record page).
 */
export async function trackSubmission(rid) {
  if (!rid || rid === lastTrackedRid) return;
  lastTrackedRid = rid;
  console.info('[pta-ui] tracking submission', rid, '— judging pill up, modal on verdict');
  showJudging();
  let verdict = null;
  for (let i = 0; i < 120; i++) {
    try {
      const data = await request.get(`${trajectoryUrl()}?rid=${rid}`); // eslint-disable-line no-await-in-loop
      if (data.judged) {
        verdict = data;
        break;
      }
    } catch (e) {
      hideJudging();
      console.warn('[pta-ui] verdict poll failed:', e && e.message);
      Notification.error((e && e.message) || i18n('Submit failed.'));
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, 1500); }); // eslint-disable-line no-await-in-loop
  }
  hideJudging();
  if (!verdict) return;
  refreshAttemptsPanel();
  const railPid = window.UiContext && UiContext.pdoc && UiContext.pdoc.docId;
  if (railPid) markRailStatus(railPid, !!(verdict.accepted ?? (verdict.status === 1)));
  showSubmitModal(verdict);
}

let hookedStore = null;
let lastToastAt = 0;
let lastToastMsg = '';
let lastSubmitErrorAt = 0;

/** Rejections (e.g. empty code failing server validation) become a toast (deduped across layers). */
function submitErrorToast(e) {
  const msg = String((e && e.message) || e || '');
  const now = Date.now();
  lastSubmitErrorAt = now;
  if (msg === lastToastMsg && now - lastToastAt < 1500) return; // both layers may observe the same failure
  lastToastAt = now;
  lastToastMsg = msg;
  Notification.error(/Field code|\bcode\b.*validation|validation.*\bcode\b/i.test(msg)
    ? i18n('Please write some code before submitting.')
    : (msg || i18n('Submit failed.')));
}

/** Last resort: the newest attempt in the trajectory IS the fresh submission. */
async function latestAttemptRid() {
  try {
    const res = await request.get(trajectoryUrl());
    const attempts = (res && res.attempts) || [];
    return attempts.length ? attempts[attempts.length - 1].rid : null;
  } catch (e) {
    return null;
  }
}

/** Shared rid derivation + tracking for both observation layers. */
async function trackFromSubmitResponse(res, source) {
  let rid = res && res.rid;
  if (!rid && res && res.url) rid = String(res.url).split('/record/')[1];
  if (!rid) {
    // Self-record-hidden contests/homework return { tid } with no rid and no
    // /record/ URL; the backend restores it, and this covers a stale backend.
    rid = await latestAttemptRid();
    if (rid) console.info('[pta-ui] submit rid derived from the trajectory (backend rid-restore hook inactive?)');
  }
  if (rid) trackSubmission(String(rid).split(/[/?#]/)[0]); // lastTrackedRid dedupes across layers
  else {
    console.warn('[pta-ui] submission accepted (via %s) but no rid was derivable — no result modal. '
      + 'Is the backend running the latest self_learning.ts?', source);
  }
}

/**
 * Capture-proof submission tracking at the NETWORK layer — the primary path.
 * react-redux captures store.dispatch BY REFERENCE when the toolbar mounts,
 * so a dispatch wrapper installed after mount sees nothing: that is why every
 * store-level hook was silently inert on core problem pages while the
 * self-learning page (which wraps before mounting) worked. The exported
 * `request` helper is a shared mutable object, so patching request.post is
 * seen by every caller: observe posts to UiContext.postSubmitUrl and drive
 * the judging pill + result modal from their responses.
 */
let submitObserverInstalled = false;
function installSubmitObserver() {
  if (submitObserverInstalled) return;
  submitObserverInstalled = true;
  const origPost = request.post.bind(request);
  request.post = (url, data, ...rest) => {
    const p = origPost(url, data, ...rest);
    try {
      const target = window.UiContext && UiContext.postSubmitUrl;
      if (target && String(url) === String(target)) {
        const isPretest = !!(data && data.pretest);
        p.catch(submitErrorToast); // real submits and pretests both get a friendly failure toast
        if (!isPretest) {
          console.info('[pta-ui] submit observed at the network layer');
          p.then((res) => trackFromSubmitResponse(res, 'network observer'))
            .catch(() => { /* the toast above already handled it */ });
        }
      }
    } catch (e) { /* observation is best-effort */ }
    return p;
  };
  // The promise middleware re-rejects internally on failed submits, and the
  // toolbar discards that derived promise — nothing can catch it. Suppress
  // only rejections that immediately follow a submit failure WE toasted.
  window.addEventListener('unhandledrejection', (ev) => {
    if (Date.now() - lastSubmitErrorAt < 3000) ev.preventDefault();
  });
  console.info('[pta-ui] network-layer submit observer installed — result modal armed');
}

const HOOKED_ACTIONS = ['SCRATCHPAD_POST_SUBMIT', 'SCRATCHPAD_POST_PRETEST'];

/**
 * Action-layer tracking — effective ONLY when installed BEFORE the React
 * tree mounts (react-redux captures the dispatch reference at mount). The
 * core problem page now calls this right after creating the store, mirroring
 * the self-learning page; the late poller below is a harmless no-op belt.
 */
export function hookScratchpadStore() {
  const s = window.store;
  if (!s || typeof s.dispatch !== 'function' || hookedStore === s) return false;
  hookedStore = s;
  console.info('[pta-ui] store.dispatch wrapped (action-layer tracking)');
  const orig = s.dispatch.bind(s);
  s.dispatch = (action) => {
    const hooked = action && HOOKED_ACTIONS.includes(action.type)
      && action.payload && typeof action.payload.then === 'function';
    if (hooked) {
      action.payload.then((res) => {
        if (action.type !== 'SCRATCHPAD_POST_SUBMIT') return;
        return trackFromSubmitResponse(res, 'action layer');
      }).catch(submitErrorToast);
    } else if (action && action.type === 'SCRATCHPAD_POST_SUBMIT_FULFILLED' && action.payload && action.payload.rid) {
      trackSubmission(String(action.payload.rid)); // fallback, if middleware ever routes it here
    }
    const result = orig(action);
    // The toast already fired via the payload catch; this catch only marks
    // the middleware's returned promise as handled.
    if (hooked && result && typeof result.catch === 'function') result.catch(() => {});
    return result;
  };
  return true;
}

function pollStoreHook() {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (hookScratchpadStore() || tries > 150) clearInterval(timer);
  }, 200);
}

/* --------------------------------- page wiring --------------------------------- */

export default new NamedPage([...PROBLEM_PAGES, ...SUBMIT_PAGES, 'self_learning_solve', 'training_detail'], (pagename) => {
  console.info('[pta-ui] site-wide problem UI active on', pagename);
  if (pagename === 'training_detail') {
    // The training page itself only needs its problem links decorated so the
    // problem pages know their training siblings.
    decorateTrainingLinks();
    $(document).on('vjContentNew', decorateTrainingLinks); // pjax section loads
    return;
  }
  // The rail follows the IDE everywhere: any open control (core sidebar or the
  // self-learning button) attaches it; the quit control detaches it.
  $(document).on('click', '[name="problem-sidebar__open-scratchpad"], #sl-open-scratchpad', () => {
    console.info('[pta-ui] rail: scratchpad opening, waiting to attach');
    injectRailWhenReady();
  });
  // Only detach the IDE-mode rail here: on the self-learning solve page the
  // quit flow re-homes the rail into page mode, and that must survive
  // regardless of delegated-handler binding order.
  $(document).on('click', '[name="problem-sidebar__quit-scratchpad"]', () => {
    if (railMode !== 'scratchpad') return;
    removeRail();
    // Contest/homework navigation keeps the same left sidebar on the plain
    // page too, re-homed below the navbar.
    const uc = window.UiContext || {};
    if (PROBLEM_PAGES.includes(pagename) && ((uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) || uc.trainingRail || uc.psetRail)) {
      injectRailForPage();
    }
  });

  if (pagename === 'self_learning_solve') return; // the solve page runs its own richer copy

  if (PROBLEM_PAGES.includes(pagename)) {
    // Requirement 3: no acceptance state below the editor, site-wide. The
    // flag gates the records pane, its toolbar button, and the auto-open on
    // submit — and the scratchpad reads it lazily, after this line runs.
    window.UiContext = window.UiContext || {};
    UiContext.canViewRecord = false;
    fetchActivityKinds(); // warm the kind-grouped rail for contests/homework
  }

  const type = problemType();

  if (!SCRATCHPAD_TYPES.includes(type)) {
    // Quiz-style problems have no IDE, but contest/homework navigation still
    // deserves the same left sidebar, below the navbar in page mode. Their
    // submit flow pops the result modal via trackSubmission, called from the
    // core problem page instead of redirecting to the record page.
    const uc = window.UiContext || {};
    if (PROBLEM_PAGES.includes(pagename) && ((uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) || uc.trainingRail || uc.psetRail)) {
      injectRailForPage();
    }
    return;
  }

  const isDomainRoot = !!(window.UiContext && UiContext.isDomainRoot);
  if (SUBMIT_PAGES.includes(pagename)) {
    if (isSubjectivePid()) return; // subjective tasks have no code submit page
    if (isDomainRoot) return; // problem authors keep the classic submit page
    // The plain paste-code page is superseded by the IDE.
    const target = window.location.pathname.replace(/\/submit\/?$/, '') + window.location.search;
    window.location.replace(target);
    return;
  }

  if (isSubjectivePid()) {
    // Project-level subjective task (pid S...): no judge pipeline at all —
    // the dedicated module renders the submission UI; only the rail applies.
    const uc = window.UiContext || {};
    if (PROBLEM_PAGES.includes(pagename) && ((uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) || uc.trainingRail || uc.psetRail)) {
      injectRailForPage();
    }
    return;
  }

  // Problem pages, programming: submission history + result-modal tracking.
  refreshAttemptsPanel();
  $(document).on('vjContentNew', refreshAttemptsPanel); // statement pjax swaps rebuild the panel
  installSubmitObserver(); // capture-proof primary: observes the submit POST itself
  pollStoreHook(); // belt: no-op once the core page wraps the store before mount

  if (isDomainRoot) {
    // Requirement: domain roots (and super-admins) keep the ORIGINAL problem
    // page — with its edit sidebar — instead of auto-entering the IDE. The
    // page's own "Enter IDE" button still works manually, and the rail plus
    // submission features above remain available.
    console.info('[pta-ui] domain root detected — keeping the original problem page');
    return;
  }

  // Auto-enter: the core page binds the open handler in its own module; poll
  // briefly so module ordering never matters, then enter exactly once.
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if ($('body').hasClass('mode--scratchpad')) {
      clearInterval(timer);
      injectRailWhenReady();
      return;
    }
    const $btn = $('[name="problem-sidebar__open-scratchpad"]');
    if ($btn.length) {
      clearInterval(timer);
      $btn.first().trigger('click'); // the click hook above attaches the rail
    } else if (tries > 30) {
      clearInterval(timer); // ~3s: no scratchpad affordance on this page
    }
  }, 100);
});
