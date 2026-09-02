import $ from 'jquery';
import ProblemSelectAutoComplete from 'vj/components/autocomplete/ProblemSelectAutoComplete';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import { ensureAisStyle } from 'vj/pages/ai_studio.page';

/**
 * PTA fork: the DOMAIN KNOWLEDGE-POINT CATALOG (/knowledge-points).
 *
 * One table for the course's whole vocabulary of knowledge points — the
 * detailed skills its programming tasks are labeled with. Teachers search
 * it, add and describe points, rename (the tasks' tags follow), merge
 * duplicates, delete, open any point to see the tasks carrying it, and
 * attach / detach points on any task. Tags ARE knowledge points: the
 * problem edit page picks from this catalog, the AI Studio labels new
 * programming tasks against it, and tags in use on tasks that are not
 * catalog entries yet (older data, imports) are listed for import.
 *
 * 🌳 The catalog is a TREE (topic › subtopic › point, four levels at most).
 * The table shows it in tree order with indentation, each topic with the
 * distinct number of tasks beneath it; a parent picker on the add and edit
 * forms places (or moves) a point and everything under it; and "Organize
 * with AI" asks the model to group the loose points into topics — a
 * proposal the teacher reviews, edits and applies.
 */

const esc = (t) => $('<i>').text(String(t ?? '')).html();
const KIND_LABEL = { programming: 'Programming', objective: 'Objective', subjective: 'Subjective' };
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');
const base = () => window.location.pathname;
const jsonUrl = (params) => `${base()}?_fmt=json${params ? `&${params}` : ''}`;
const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];

const STYLE = [
  '.kp__bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 0 0 14px; }',
  '.kp__search { flex: 1 1 260px; max-width: 420px; }',
  '.kp__stat { font-size: 12px; color: var(--pta-ink-faint); }',
  '.kp__form { display: grid; grid-template-columns: minmax(180px, 1.2fr) minmax(220px, 2fr) minmax(160px, 1.2fr) minmax(120px, .8fr) auto; gap: 8px; align-items: center; margin: 0 0 16px; }',
  '.kp__form input, .kp__edit input { width: 100%; }',
  '@media (max-width: 900px) { .kp__form { grid-template-columns: 1fr 1fr; } }',
  '.kp__table { width: 100%; border-collapse: collapse; font-size: 13px; }',
  '.kp__table th, .kp__table td { padding: 8px 8px; border-bottom: 1px solid var(--pta-line-soft); text-align: left; vertical-align: top; }',
  '.kp__table th { font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--pta-ink-faint); }',
  '.kp__name { font-weight: 600; color: var(--pta-ink); cursor: pointer; }',
  '.kp__name:hover { text-decoration: underline; }',
  '.kp__desc { color: var(--pta-ink-soft); font-size: 12.5px; }',
  '.kp__alias { display: inline-block; border-radius: 999px; padding: 1px 8px; margin: 1px 4px 1px 0; font-size: 11px; background: var(--pta-card-3); border: 1px solid var(--pta-line); color: var(--pta-ink-soft); }',
  '.kp__cat { display: inline-block; border-radius: 6px; padding: 1px 7px; font-size: 11px; background: var(--pta-blue-soft); border: 1px solid var(--pta-blue-line); color: var(--pta-blue-text); }',
  '.kp__count { display: inline-block; min-width: 28px; text-align: center; border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: bold; background: var(--pta-violet-soft); color: var(--pta-violet-text); border: 1px solid var(--pta-violet-line); cursor: pointer; }',
  '.kp__count--zero { background: var(--pta-card-3); color: var(--pta-ink-faint); border-color: var(--pta-line); }',
  '.kp__src { font-size: 11px; color: var(--pta-ink-faint); }',
  '.kp__actions { white-space: nowrap; }',
  '.kp__actions .ais__btn { margin-right: 4px; }',
  '.kp__edit { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(220px, 2fr) minmax(160px, 1fr) minmax(120px, .7fr); gap: 8px; align-items: center; }',
  '.kp__detail { background: var(--pta-card-2); border-radius: 10px; padding: 10px 12px; }',
  '.kp__tasks { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 10px; }',
  '.kp__task { display: flex; gap: 8px; align-items: center; font-size: 12.5px; }',
  '.kp__task code { font-family: var(--code-font-family); }',
  '.kp__task .kp__hidden { font-size: 11px; color: var(--pta-ink-faint); }',
  '.kp__attach { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
  '.kp__attach .kp__attach-input { flex: 1 1 320px; max-width: 520px; }',
  '.kp__untracked { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
  '.kp__untracked .ais__btn { margin: 0; }',
  '.kp__untag { display: inline-flex; gap: 6px; align-items: center; border-radius: 999px; padding: 3px 6px 3px 10px; font-size: 12px; background: var(--pta-card-3); border: 1px solid var(--pta-line); color: var(--pta-ink-soft); }',
  '.kp__empty { color: var(--pta-ink-faint); font-size: 12.5px; padding: 14px 0; }',
  // 🌳 tree rows
  '.kp__tree { display: inline-flex; align-items: center; gap: 6px; padding-left: calc(var(--kp-depth, 0) * 18px); }',
  '.kp__twist { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; border-radius: 4px; font-size: 10px; color: var(--pta-ink-faint); cursor: pointer; user-select: none; flex: 0 0 auto; }',
  '.kp__twist:hover { background: var(--pta-card-3); color: var(--pta-ink); }',
  '.kp__twist--leaf { visibility: hidden; }',
  '.kp__topic { color: var(--pta-violet-text); font-weight: 700; }',
  '.kp__rollup { font-size: 11px; color: var(--pta-ink-faint); margin-left: 4px; }',
  '.kp__path { font-size: 11px; color: var(--pta-ink-faint); }',
  '.kp__parent { max-width: 100%; }',
  '.kp__org { margin: 0 0 14px; padding: 10px 12px; border-radius: 12px; background: var(--pta-violet-soft); border: 1px solid var(--pta-violet-line); }',
  '.kp__org-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--pta-violet-text); font-weight: 600; }',
  '.kp__org-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; margin-top: 10px; }',
  '.kp__org-g { background: var(--pta-card); border: 1px solid var(--pta-line); border-radius: 10px; padding: 8px 10px; font-size: 12.5px; }',
  '.kp__org-g input { width: 100%; margin-bottom: 4px; }',
  '.kp__org-g .kp__org-pts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }',
  '.kp__org-g .kp__org-pt { display: inline-flex; align-items: center; gap: 3px; border-radius: 999px; padding: 1px 8px; font-size: 11.5px; background: var(--pta-card-3); border: 1px solid var(--pta-line); color: var(--pta-ink-soft); }',
  '.kp__org-g .kp__org-pt button { border: 0; background: none; cursor: pointer; color: var(--pta-ink-faint); padding: 0 2px; font-size: 12px; }',
  '.kp__org-g .kp__org-new { font-size: 10.5px; color: var(--pta-ok-text); font-weight: 600; margin-left: 6px; }',
  '.kp__org-un { margin-top: 8px; font-size: 12px; color: var(--pta-ink-soft); }',
  '.kp__org-actions { display: flex; gap: 8px; margin-top: 10px; }',
  '.kp__org-g .kp__org-pt--moves { border-color: var(--pta-violet-line); background: var(--pta-violet-soft); color: var(--pta-violet-text); }',
  '.kp__org-g .kp__org-from { font-size: 10px; opacity: .7; margin-left: 2px; }',
  '.kp__org-sub { margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: var(--pta-card-2); border: 1px dashed var(--pta-line); }',
  '.kp__org-sub input { width: 100%; margin-bottom: 4px; }',
  '.kp__org-stats { font-size: 12px; color: var(--pta-ink-soft); font-weight: normal; }',
  '.kp__org-emptied { margin-top: 10px; padding: 8px 10px; border-radius: 10px; background: var(--pta-warn-soft); border: 1px solid var(--pta-warn-line); color: var(--pta-warn-text); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; animation: kpSlideIn .3s var(--pta-ease, ease) both; }',
  // 🎬 the reorganize theatre: while the model reads the catalog, a card with a
  // spinning ring, a staged status line and a sweeping bar — never a dead button.
  '.kp__think { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 14px; background: linear-gradient(160deg, var(--pta-violet-soft), var(--pta-card) 70%); border: 1px solid var(--pta-violet-line); position: relative; overflow: hidden; animation: kpSlideIn .3s var(--pta-ease, ease) both; }',
  '.kp__think::before { content: ""; position: absolute; inset: -40% -60%; background: radial-gradient(closest-side, rgba(112,72,232,.14), transparent 70%); animation: kpDrift 6s ease-in-out infinite alternate; pointer-events: none; }',
  '@keyframes kpDrift { from { transform: translate(-10%, -6%); } to { transform: translate(12%, 8%); } }',
  '.kp__orb { position: relative; flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--pta-card); box-shadow: 0 4px 14px -6px rgba(112,72,232,.7); }',
  '.kp__orb::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, #7048e8, #ae3ec9, #e64980, #7048e8); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); animation: kpSpin 1.5s linear infinite; }',
  '.kp__orb span { font-size: 20px; line-height: 1; animation: kpBreathe 2.2s ease-in-out infinite; }',
  '@keyframes kpSpin { to { transform: rotate(360deg); } }',
  '@keyframes kpBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.14); } }',
  '.kp__think-body { position: relative; min-width: 0; flex: 1 1 auto; }',
  '.kp__think-title { font-size: 13.5px; font-weight: 700; color: var(--pta-violet-text); }',
  '.kp__think-stage { font-size: 12px; color: var(--pta-ink-soft); margin-top: 2px; transition: opacity .18s ease, transform .18s ease; }',
  '.kp__think-stage.is-swap { opacity: 0; transform: translateY(3px); }',
  '.kp__think-track { position: relative; height: 5px; border-radius: 999px; background: var(--pta-violet-soft); overflow: hidden; margin-top: 8px; }',
  '.kp__think-track i { position: absolute; top: 0; bottom: 0; left: 0; width: 38%; border-radius: 999px; background: linear-gradient(90deg, transparent, #7048e8, #ae3ec9, transparent); animation: kpSweep 1.4s ease-in-out infinite; }',
  '@keyframes kpSweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(270%); } }',
  '.kp__think-steps { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-size: 11.5px; color: var(--pta-ink-faint); }',
  '.kp__think-steps span { display: inline-flex; align-items: center; gap: 4px; transition: color .25s ease; }',
  '.kp__think-steps span.is-done { color: var(--pta-ok-text); }',
  '.kp__think-steps span.is-active { color: var(--pta-ink); font-weight: 600; }',
  '@keyframes kpSlideIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }',
  '@keyframes kpPop { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }',
  // the proposal: cards stagger in, moving points pulse once
  '.kp__org-groups .kp__org-g { animation: kpPop .38s var(--pta-ease, ease) both; animation-delay: calc(var(--i, 0) * 45ms); }',
  '.kp__org-sub { animation: kpPop .3s var(--pta-ease, ease) both; animation-delay: calc(var(--i, 0) * 45ms + 120ms); }',
  '@keyframes kpPulse { 0% { box-shadow: 0 0 0 0 rgba(112,72,232,.45); } 100% { box-shadow: 0 0 0 8px rgba(112,72,232,0); } }',
  '.kp__org-pt--moves { animation: kpPulse 1.1s ease-out 1; animation-delay: calc(var(--i, 0) * 45ms + 300ms); }',
  // after Apply: rows that were created or moved flash in the table
  '@keyframes kpFlash { 0% { background: rgba(112,72,232,.22); } 100% { background: transparent; } }',
  '.kp__row--flash > td { animation: kpFlash 2.4s ease-out 1; }',
  '.kp__row--flash .kp__name::after { content: "✦"; color: var(--pta-violet); margin-left: 6px; font-size: 11px; animation: kpFlash 2.4s ease-out 1; }',
  '@media (prefers-reduced-motion: reduce) { .kp__think, .kp__think::before, .kp__orb::before, .kp__orb span, .kp__think-track i, .kp__org-g, .kp__org-sub, .kp__org-pt--moves, .kp__row--flash > td, .kp__org-emptied { animation: none !important; } }',
].join('\n');

let state = { points: [], tree: [], untracked: [], total: 0, canEditProblems: false, aiAvailable: false, q: '' };
let expanded = null; // point id whose task list is open
let editing = null; // point id whose row is in edit mode
const collapsed = new Set(); // 🌳 topic ids whose subtrees are folded in the table
let organize = null; // 🌳 the AI's organize proposal under review: [{ name, isNew, description, points: [{ name, from, moves }], subtopics: [...] }]
let organizeUnplaced = []; // 🌳 points the proposal leaves where they are
let emptied = []; // 🌳 topics an applied proposal left empty: [{ id, name }]
let organizeBusy = false; // 🎬 the model is reading the catalog
let organizeStageTimer = null;
let justChanged = new Set(); // 🎬 names created or moved by the last Apply — their rows flash once
const THINK_STAGES = [
  ['📖', 'Reading the whole catalog…'],
  ['🔍', 'Finding the themes that run through it…'],
  ['🧩', 'Grouping points into topics and sub-topics…'],
  ['🌳', 'Checking every point has one place…'],
  ['✍️', 'Writing the proposal…'],
];

/** 🌳 The tree flattened in display order: [{ node, depth, hasChildren }]. Search results stay flat. */
function treeRows() {
  const out = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      out.push({ node: n, depth, hasChildren: n.children.length > 0 });
      if (!collapsed.has(n.id)) walk(n.children, depth + 1);
    }
  };
  walk(state.tree || [], 0);
  return out;
}

/** 🌳 <select> of possible parents: every point in tree order, minus `self` and its own subtree. */
function parentOptions(selectedId, selfId) {
  const opts = [`<option value="">${esc(i18n('— top level —'))}</option>`];
  const walk = (nodes, depth, under) => {
    for (const n of nodes) {
      const excluded = under || n.id === selfId;
      if (!excluded && depth < (state.maxDepth || 4) - 1) {
        opts.push(`<option value="${esc(n.id)}"${n.id === selectedId ? ' selected' : ''}>${'\u00A0\u00A0'.repeat(depth)}${esc(n.name)}</option>`);
      }
      walk(n.children, depth + 1, excluded);
    }
  };
  walk(state.tree || [], 0, false);
  return opts.join('');
}

function ensureStyle() {
  ensureAisStyle();
  if (!document.getElementById('kp-style')) $('<style>').attr('id', 'kp-style').text(STYLE).appendTo(document.head);
}

async function load(q) {
  const data = await request.get(jsonUrl(q ? `q=${encodeURIComponent(q)}` : ''));
  state = { ...state, ...data, q: q || '' };
}

function rowHtml(p) {
  const can = state.canEditProblems;
  if (editing === p._id) {
    return `<tr class="kp__row" data-id="${esc(p._id)}"><td colspan="7">
      <div class="kp__edit">
        <input type="text" class="textbox kp__e-name" maxlength="40" value="${esc(p.name)}" placeholder="${esc(i18n('Name'))}">
        <input type="text" class="textbox kp__e-desc" maxlength="400" value="${esc(p.description)}" placeholder="${esc(i18n('Description (one or two sentences)'))}">
        <input type="text" class="textbox kp__e-alias" value="${esc((p.aliases || []).join(', '))}" placeholder="${esc(i18n('Aliases, comma-separated'))}">
        <select class="select kp__parent kp__e-parent" title="${esc(i18n('Under (parent topic) — moving a topic moves everything beneath it'))}">${parentOptions(p.parent || '', p._id)}</select>
      </div>
      <div class="aisd__bar" style="margin-top:8px;">
        <button class="ais__btn ais__btn--sm kp__e-save">💾 ${esc(i18n('Save'))}</button>
        <button class="ais__btn ais__btn--ghost ais__btn--sm kp__e-cancel">${esc(i18n('Cancel'))}</button>
        <span class="aisd__meta">${esc(i18n('Renaming rewrites the tag on every task that carries this point; the old name is kept as an alias.'))}</span>
      </div>
    </td></tr>`;
  }
  // 🌳 In tree order the row indents by depth and carries a fold twist; a
  // topic also shows the distinct number of tasks beneath it.
  const depth = p._depth || 0;
  const hasKids = !!p._hasChildren;
  const isTopic = hasKids || (p.childCount || 0) > 0;
  return `<tr class="kp__row${justChanged.has(String(p.name).toLowerCase()) ? ' kp__row--flash' : ''}" data-id="${esc(p._id)}">
    <td><span class="kp__tree" style="--kp-depth: ${depth}"><span class="kp__twist${hasKids ? '' : ' kp__twist--leaf'}" data-id="${esc(p._id)}" title="${esc(i18n('Fold or unfold'))}">${collapsed.has(p._id) ? '▸' : '▾'}</span><span class="kp__name${isTopic ? ' kp__topic' : ''}" title="${esc(i18n('Show the tasks carrying this point'))}">${esc(p.name)}</span>${isTopic && p.rollup ? `<span class="kp__rollup" title="${esc(i18n('Distinct tasks under this topic'))}">Σ${p.rollup}</span>` : ''}</span></td>
    <td class="kp__desc">${esc(p.description || '')}</td>
    <td>${(p.aliases || []).map((a) => `<span class="kp__alias">${esc(a)}</span>`).join('')}</td>
    <td>${state.q && p.pathText ? `<span class="kp__path">${esc(p.pathText)}</span>` : (p.parentName && !state.q && depth === 0 ? `<span class="kp__cat">${esc(p.parentName)}</span>` : '')}</td>
    <td><span class="kp__count${p.count ? '' : ' kp__count--zero'}" title="${esc(i18n('Tasks carrying this point'))}">${p.count}</span></td>
    <td class="kp__src">${esc(i18n(p.source === 'ai' ? 'AI' : p.source === 'import' ? 'imported' : 'teacher'))}<br>${esc(fmtTs(p.updateAt))}</td>
    <td class="kp__actions">
      <button class="ais__btn ais__btn--ghost ais__btn--sm kp__edit-btn" title="${esc(i18n('Edit'))}">✎</button>
      ${can ? `<button class="ais__btn ais__btn--ghost ais__btn--sm kp__merge-btn" title="${esc(i18n('Merge into another point'))}">⇄</button>
      <button class="ais__btn ais__btn--ghost ais__btn--sm kp__del-btn" title="${esc(i18n('Delete'))}">🗑</button>` : ''}
    </td>
  </tr>${expanded === p._id ? `<tr class="kp__detail-row" data-id="${esc(p._id)}"><td colspan="7"><div class="kp__detail" data-id="${esc(p._id)}">${esc(i18n('Loading...'))}</div></td></tr>` : ''}`;
}

/** 🌳 The rows to draw: tree order (with depth) normally, the flat search hits under a query. */
function rowsToDraw() {
  if (state.q) return state.points;
  const byId = new Map((state.points || []).map((p) => [p._id, p]));
  return treeRows().map(({ node, depth, hasChildren }) => {
    const p = byId.get(node.id) || { _id: node.id, name: node.name, description: node.description, aliases: [], count: node.count, rollup: node.rollup, source: 'teacher' };
    return { ...p, rollup: node.rollup, childCount: node.children.length, _depth: depth, _hasChildren: hasChildren };
  });
}

/** 🌳 One proposed topic (or sub-topic) card. */
function orgGroupHtml(g, gi, si) {
  const key = si === undefined ? `data-g="${gi}"` : `data-g="${gi}" data-s="${si}"`;
  const pts = g.points.map((pt, pi) => `<span class="kp__org-pt${pt.moves ? ' kp__org-pt--moves' : ''}" title="${esc(pt.moves ? (pt.from ? i18n('Moves here from \u201C{0}\u201D').replace('{0}', pt.from) : i18n('Moves here from the top level')) : i18n('Stays where it is'))}">${esc(pt.name)}${pt.moves && pt.from ? `<span class="kp__org-from">← ${esc(pt.from)}</span>` : ''}<button type="button" class="kp__org-rm" ${key} data-p="${pi}" title="${esc(i18n('Leave this point where it is'))}">×</button></span>`).join('');
  const tag = g.isNew ? `<span class="kp__org-new">${esc(i18n('new topic'))}</span>` : (g.movesTopic ? `<span class="kp__org-new">${esc(i18n('topic moves'))}</span>` : `<span class="aisd__meta">${esc(i18n('existing topic'))}</span>`);
  return `<input type="text" class="textbox kp__org-name" maxlength="40" value="${esc(g.name)}">${tag}
    ${g.isNew ? `<input type="text" class="textbox kp__org-desc" maxlength="300" value="${esc(g.description || '')}" placeholder="${esc(i18n('Description'))}">` : ''}
    <div class="kp__org-pts">${pts || `<span class="aisd__meta">${esc(i18n('(no points of its own)'))}</span>`}</div>`;
}

/** 🎬 The theatre shown while the model works (stage text advances on a timer; there is no progress signal). */
function thinkHtml() {
  return `<div class="kp__org"><div class="kp__think" data-stage="0">
    <div class="kp__orb"><span>${THINK_STAGES[0][0]}</span></div>
    <div class="kp__think-body">
      <div class="kp__think-title">🔁 ${esc(i18n('Reorganizing the catalog'))}</div>
      <div class="kp__think-stage">${esc(i18n(THINK_STAGES[0][1]))}</div>
      <div class="kp__think-track"><i></i></div>
      <div class="kp__think-steps">${THINK_STAGES.map(([ico, label], i) => `<span class="${i === 0 ? 'is-active' : ''}">${ico} ${esc(i18n(label))}</span>`).join('')}</div>
    </div></div></div>`;
}

function startThinkStages($root) {
  clearInterval(organizeStageTimer);
  let k = 0;
  organizeStageTimer = setInterval(() => {
    const $t = $root.find('.kp__think');
    if (!$t.length) {
      clearInterval(organizeStageTimer);
      return;
    }
    k = Math.min(k + 1, THINK_STAGES.length - 1);
    const $st = $t.find('.kp__think-stage');
    $st.addClass('is-swap');
    setTimeout(() => $st.text(i18n(THINK_STAGES[k][1])).removeClass('is-swap'), 180);
    $t.find('.kp__orb span').text(THINK_STAGES[k][0]);
    $t.find('.kp__think-steps span').each(function mark(i) { $(this).toggleClass('is-done', i < k).toggleClass('is-active', i === k); });
    if (k === THINK_STAGES.length - 1) clearInterval(organizeStageTimer);
  }, 4500);
}

/** 🌳 The organize panel: the button, the theatre, the proposal under review, or the emptied-topics follow-up. */
function organizeHtml() {
  if (!state.aiAvailable) return '';
  if (organizeBusy) return thinkHtml();
  if (emptied.length) {
    return `<div class="kp__org"><div class="kp__org-emptied">🧹 ${esc(i18n('{0} topic(s) are now empty — no points beneath them and no task labeled with them:').replace('{0}', emptied.length))} <b>${emptied.map((t) => esc(t.name)).join(', ')}</b>
      <button class="ais__btn ais__btn--sm kp__org-del-empty">🗑 ${esc(i18n('Delete them'))}</button><button class="ais__btn ais__btn--ghost ais__btn--sm kp__org-keep-empty">${esc(i18n('Keep'))}</button></div></div>`;
  }
  if (!organize) {
    return `<div class="kp__org"><div class="kp__org-head">🔁 ${esc(i18n('Reorganize with AI'))}
      <span class="aisd__meta" style="font-weight:normal;">${esc(i18n('The AI re-thinks the whole tree — every point may move, topics may gain sub-topics, new topics may appear. You review the proposal before anything changes.'))}</span>
      <button class="ais__btn ais__btn--sm kp__org-run" style="margin-left:auto;">🔁 ${esc(i18n('Reorganize everything'))}</button></div></div>`;
  }
  const moves = organize.reduce((n, g) => n + g.points.filter((p) => p.moves).length + (g.subtopics || []).reduce((m, sg) => m + sg.points.filter((p) => p.moves).length, 0), 0);
  const created = organize.filter((g) => g.isNew).length + organize.reduce((n, g) => n + (g.subtopics || []).filter((sg) => sg.isNew).length, 0);
  return `<div class="kp__org">
    <div class="kp__org-head">✨ ${esc(i18n('Proposed re-organization of the whole catalog'))}
      <span class="kp__org-stats">${esc(i18n('{0} point(s) would move · {1} new topic(s)').replace('{0}', moves).replace('{1}', created))}</span>
      <span class="aisd__meta" style="font-weight:normal;flex-basis:100%;">${esc(i18n('Edit topic names, remove points you disagree with, then apply. Highlighted points move (from where is shown); dim ones stay. Points you remove stay where they are.'))}</span></div>
    <div class="kp__org-groups">${organize.map((g, gi) => `<div class="kp__org-g" data-g="${gi}" style="--i:${gi}">${orgGroupHtml(g, gi)}
      ${(g.subtopics || []).map((sg, si) => `<div class="kp__org-sub" data-g="${gi}" data-s="${si}" style="--i:${gi}">${orgGroupHtml(sg, gi, si)}</div>`).join('')}
    </div>`).join('')}</div>
    ${organizeUnplaced.length ? `<div class="kp__org-un">${esc(i18n('Not placed'))}: ${organizeUnplaced.map(esc).join(', ')}</div>` : ''}
    <div class="kp__org-actions"><button class="ais__btn ais__btn--sm kp__org-apply">✓ ${esc(i18n('Apply'))}</button><button class="ais__btn ais__btn--ghost ais__btn--sm kp__org-cancel">${esc(i18n('Discard'))}</button></div>
  </div>`;
}

function render($root) {
  const untracked = state.untracked || [];
  const rows = rowsToDraw();
  $root.html(`
    <div class="ais">
      <div class="ais__head">🏷️ <span class="ais__title">${esc(i18n('Knowledge points'))}</span>
        <span class="ais__hint">${esc(i18n('The domain\u2019s shared vocabulary. A task\u2019s tags are its knowledge points: the edit page picks from this catalog, and the AI Studio labels programming tasks against it.'))}</span></div>
      <div class="ais__body">
        <div class="kp__bar">
          <input type="text" class="textbox kp__search" value="${esc(state.q)}" placeholder="${esc(i18n('Search by name, alias or description…'))}">
          <span class="kp__stat">${esc(i18n('{0} points in this domain').replace('{0}', state.total))}${state.q ? ` · ${esc(i18n('{0} shown').replace('{0}', state.points.length))}` : ''}</span>
          <a class="ais__btn ais__btn--ghost ais__btn--sm" href="${domainPrefix()}/ai-studio">✨ ${esc(i18n('AI Studio'))}</a>
        </div>
        <div class="ais__label">➕ ${esc(i18n('Add a knowledge point'))}</div>
        <div class="kp__form">
          <input type="text" class="textbox kp__n-name" maxlength="40" placeholder="${esc(i18n('Name (2\u20136 words, e.g. \u201cOff-by-one in loop bounds\u201d)'))}">
          <input type="text" class="textbox kp__n-desc" maxlength="400" placeholder="${esc(i18n('Description (one or two sentences)'))}">
          <input type="text" class="textbox kp__n-alias" placeholder="${esc(i18n('Aliases, comma-separated'))}">
          <select class="select kp__parent kp__n-parent" title="${esc(i18n('Under (parent topic)'))}">${parentOptions('', '')}</select>
          <button class="ais__btn ais__btn--sm kp__n-add">➕ ${esc(i18n('Add'))}</button>
        </div>
        ${organizeHtml()}
        ${rows.length ? `<table class="kp__table">
          <thead><tr><th>${esc(i18n('Name'))}</th><th>${esc(i18n('Description'))}</th><th>${esc(i18n('Aliases'))}</th><th>${esc(state.q ? i18n('Under') : '')}</th><th>${esc(i18n('Tasks'))}</th><th>${esc(i18n('Source'))}</th><th></th></tr></thead>
          <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table>` : `<div class="kp__empty">${esc(state.q ? i18n('No knowledge point matches your search.') : i18n('The catalog is empty. Add points here, import the tags below, or let the AI Studio label a task — its points are registered automatically.'))}</div>`}
        ${untracked.length ? `
        <div class="ais__label" style="margin-top:18px;">📥 ${esc(i18n('Tags on programming tasks that are not catalog entries yet'))}</div>
        <div class="aisd__meta" style="margin-bottom:8px;">${esc(i18n('Import the ones that are knowledge points; remove organizational leftovers (e.g. \u201cai-draft\u201d) from every task with the bin button, or leave them alone.'))}</div>
        <div class="kp__untracked">
          ${untracked.map((t) => `<span class="kp__untag"><b>${esc(t.name)}</b> <span class="aisd__meta">×${t.count}</span><button class="ais__btn ais__btn--ghost ais__btn--sm kp__import" data-name="${esc(t.name)}">${esc(i18n('Import'))}</button>${state.canEditProblems ? `<button class="ais__btn ais__btn--ghost ais__btn--sm kp__untag-rm" data-name="${esc(t.name)}" title="${esc(i18n('Remove this tag from every task'))}">🗑</button>` : ''}</span>`).join('')}
          ${untracked.length > 1 ? `<button class="ais__btn ais__btn--ghost ais__btn--sm kp__import-all">${esc(i18n('Import all'))}</button>` : ''}
        </div>` : ''}
      </div>
    </div>`);
  wire($root);
  if (expanded) loadDetail($root, expanded);
}

async function loadDetail($root, id) {
  const $box = $root.find(`.kp__detail[data-id="${id}"]`);
  if (!$box.length) return;
  try {
    const data = await request.get(jsonUrl(`id=${encodeURIComponent(id)}`));
    const problems = data.problems || [];
    const can = state.canEditProblems;
    $box.html(`
      <div class="ais__label" style="margin-top:0;">${esc(i18n('Tasks carrying \u201c{0}\u201d').replace('{0}', data.point.name))} (${problems.length})</div>
      ${problems.length ? `<div class="kp__tasks">${problems.map((p) => `<div class="kp__task" data-doc="${p.docId}">
          <span class="problem-select__kind problem-select__kind--${esc(p.kind || 'programming')}">${esc(i18n(KIND_LABEL[p.kind] || KIND_LABEL.programming))}</span>
          <a href="${domainPrefix()}/p/${esc(p.pid)}" target="_blank" rel="noopener"><code>${esc(p.pid)}</code> ${esc(p.title)}</a>
          ${p.hidden ? `<span class="kp__hidden">(${esc(i18n('hidden'))})</span>` : ''}
          ${can ? `<button class="ais__btn ais__btn--ghost ais__btn--sm kp__detach" data-doc="${p.docId}" title="${esc(i18n('Remove this point from the task'))}">×</button>` : ''}
        </div>`).join('')}</div>` : `<div class="kp__empty">${esc(i18n('No task carries this point yet.'))}</div>`}
      ${can ? `<div class="kp__attach">
        <span class="aisd__meta">${esc(i18n('Attach to a task'))}:</span>
        <input type="text" class="textbox kp__attach-input" placeholder="${esc(i18n('Search a task…'))}">
      </div>` : ''}`);
    if (can) {
      const $in = $box.find('.kp__attach-input');
      const picker = ProblemSelectAutoComplete.getOrConstruct($in, { multi: false, clearDefaultValue: false });
      picker.onChange(async (v) => {
        const docId = String(v || '').split(',')[0].trim();
        if (!docId) return;
        try {
          await request.post(base(), { operation: 'attach', pid: docId, id });
          Notification.success(i18n('Attached.'));
          await refresh($root);
        } catch (e) {
          Notification.error(e.message);
        }
      });
    }
    $box.find('.kp__detach').on('click', async function onDetach() {
      const docId = $(this).attr('data-doc');
      try {
        await request.post(base(), { operation: 'detach', pid: docId, id });
        await refresh($root);
      } catch (e) {
        Notification.error(e.message);
      }
    });
  } catch (e) {
    $box.html(`<div class="kp__empty">⚠ ${esc(e.message)}</div>`);
  }
}

async function refresh($root) {
  await load(state.q);
  render($root);
}

function wire($root) {
  let searchTimer = null;
  $root.find('.kp__search').on('input', function onSearch() {
    const q = String($(this).val() || '');
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        await load(q);
        const keepFocus = document.activeElement === this;
        render($root);
        if (keepFocus) {
          const $s = $root.find('.kp__search').trigger('focus');
          const el = $s.get(0);
          if (el && el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
        }
      } catch (e) {
        Notification.error(e.message);
      }
    }, 250);
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

  $root.find('.kp__n-add').on('click', function onAdd() {
    const name = String($root.find('.kp__n-name').val() || '').trim();
    if (!name) {
      Notification.warn(i18n('A knowledge point needs a name.'));
      return;
    }
    act($(this), async () => {
      await request.post(base(), {
        operation: 'create',
        name,
        description: String($root.find('.kp__n-desc').val() || ''),
        aliases: String($root.find('.kp__n-alias').val() || ''),
        parent: String($root.find('.kp__n-parent').val() || ''),
      });
      Notification.success(i18n('Knowledge point added.'));
      await refresh($root);
    });
  });
  $root.find('.kp__n-name, .kp__n-desc, .kp__n-alias').on('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      $root.find('.kp__n-add').trigger('click');
    }
  });

  $root.find('.kp__name, .kp__count').on('click', function onToggle() {
    const id = $(this).closest('tr').attr('data-id');
    expanded = expanded === id ? null : id;
    render($root);
  });
  // 🌳 fold / unfold a topic's subtree in the table
  $root.find('.kp__twist').on('click', function onTwist() {
    const id = $(this).attr('data-id');
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    render($root);
  });

  // 🌳 Organize with AI: propose (loose points, or everything) → review → apply → clean up emptied topics
  $root.find('.kp__org-run').on('click', async () => {
    // 🎬 The theatre replaces the button for the whole round trip.
    organizeBusy = true;
    render($root);
    startThinkStages($root);
    try {
      const res = await request.post(base(), { operation: 'organize' });
      organize = res.proposal || [];
      organizeUnplaced = res.unplaced || [];
      if (!organize.length) Notification.warn(i18n('The AI found nothing to change.'));
    } catch (e) {
      Notification.error(e.message);
    } finally {
      organizeBusy = false;
      clearInterval(organizeStageTimer);
      render($root);
    }
  });
  $root.find('.kp__org-rm').on('click', function onRm() {
    const g = Number($(this).attr('data-g'));
    const si = $(this).attr('data-s');
    const pi = Number($(this).attr('data-p'));
    const grp = organize && organize[g] && (si === undefined ? organize[g] : (organize[g].subtopics || [])[Number(si)]);
    if (grp) {
      organizeUnplaced.push(grp.points[pi].name);
      grp.points.splice(pi, 1);
      if (si !== undefined && !grp.points.length && grp.isNew) organize[g].subtopics.splice(Number(si), 1);
      if (!organize[g].points.length && !(organize[g].subtopics || []).length && organize[g].isNew) organize.splice(g, 1);
    }
    render($root);
  });
  $root.find('.kp__org-cancel').on('click', () => {
    organize = null;
    organizeUnplaced = [];
    render($root);
  });
  $root.find('.kp__org-apply').on('click', function onApply() {
    // Read the (possibly edited) names and descriptions back from the cards.
    const readGroup = ($g, g) => ({
      name: String($g.find('.kp__org-name').first().val() || g.name),
      description: String($g.find('.kp__org-desc').first().val() || g.description || ''),
      points: g.points.map((p) => p.name),
    });
    const groups = organize.map((g, gi) => {
      const $g = $root.find(`.kp__org-g[data-g="${gi}"]`);
      const top = readGroup($g, g);
      top.subtopics = (g.subtopics || []).map((sg, si) => readGroup($root.find(`.kp__org-sub[data-g="${gi}"][data-s="${si}"]`), sg)).filter((sg) => sg.name.trim());
      return top;
    }).filter((g) => g.name.trim() && (g.points.length || g.subtopics.length));
    if (!groups.length) return;
    // 🎬 What the proposal actually CHANGES — new or moved topics, moved
    // points — flashes in the table on the next paint; the rest stays calm.
    const changed = new Set();
    organize.forEach((g, gi) => {
      const $g = $root.find(`.kp__org-g[data-g="${gi}"]`);
      if (g.isNew || g.movesTopic) changed.add(String($g.find('.kp__org-name').first().val() || g.name).toLowerCase());
      for (const p of g.points) if (p.moves) changed.add(p.name.toLowerCase());
      (g.subtopics || []).forEach((sg, si) => {
        const $s = $root.find(`.kp__org-sub[data-g="${gi}"][data-s="${si}"]`);
        if (sg.isNew || sg.movesTopic) changed.add(String($s.find('.kp__org-name').first().val() || sg.name).toLowerCase());
        for (const p of sg.points) if (p.moves) changed.add(p.name.toLowerCase());
      });
    });
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'applyOrganize', proposal: JSON.stringify(groups) });
      organize = null;
      organizeUnplaced = [];
      emptied = res.emptied || [];
      justChanged = changed;
      Notification.success(i18n('Applied: {0} topic(s) created, {1} point(s) moved.').replace('{0}', res.created || 0).replace('{1}', res.moved || 0));
      if (res.errors && res.errors.length) Notification.warn(res.errors.join(' · '));
      await refresh($root);
      // One flash only: the next render must not repeat it.
      setTimeout(() => { justChanged = new Set(); }, 2600);
    });
  });
  $root.find('.kp__org-del-empty').on('click', function onDelEmpty() {
    const list = emptied.slice();
    act($(this), async () => {
      for (const t of list) {
        try {
          await request.post(base(), { operation: 'delete', id: t.id });
        } catch (e) {
          Notification.error(`${t.name}: ${e.message}`);
        }
      }
      emptied = [];
      Notification.success(i18n('Deleted {0} empty topic(s).').replace('{0}', list.length));
      await refresh($root);
    });
  });
  $root.find('.kp__org-keep-empty').on('click', () => {
    emptied = [];
    render($root);
  });

  $root.find('.kp__edit-btn').on('click', function onEdit() {
    editing = $(this).closest('tr').attr('data-id');
    render($root);
    $root.find('.kp__e-name').trigger('focus');
  });
  $root.find('.kp__e-cancel').on('click', () => {
    editing = null;
    render($root);
  });
  $root.find('.kp__e-save').on('click', function onSave() {
    const $row = $(this).closest('tr');
    const id = $row.data('id');
    act($(this), async () => {
      const res = await request.post(base(), {
        operation: 'update',
        id,
        name: String($row.find('.kp__e-name').val() || ''),
        description: String($row.find('.kp__e-desc').val() || ''),
        aliases: String($row.find('.kp__e-alias').val() || ''),
        parent: String($row.find('.kp__e-parent').val() || ''),
      });
      editing = null;
      Notification.success(res.touched
        ? i18n('Saved — the tag was rewritten on {0} task(s).').replace('{0}', res.touched)
        : i18n('Saved.'));
      await refresh($root);
    });
  });

  $root.find('.kp__del-btn').on('click', function onDel() {
    const $row = $(this).closest('tr');
    const id = $row.data('id');
    const p = state.points.find((x) => x._id === id);
    if (!p) return;
    const msg = p.count
      ? i18n('Delete \u201c{0}\u201d? It is removed from the {1} task(s) that carry it.').replace('{0}', p.name).replace('{1}', p.count)
      : i18n('Delete \u201c{0}\u201d?').replace('{0}', p.name);
    if (!window.confirm(msg)) return;
    act($(this), async () => {
      await request.post(base(), { operation: 'delete', id });
      if (expanded === id) expanded = null;
      Notification.success(i18n('Deleted.'));
      await refresh($root);
    });
  });

  $root.find('.kp__merge-btn').on('click', function onMerge() {
    const $row = $(this).closest('tr');
    const id = $row.data('id');
    const p = state.points.find((x) => x._id === id);
    if (!p) return;
    const others = state.points.filter((x) => x._id !== id);
    if (!others.length) {
      Notification.warn(i18n('There is no other knowledge point to merge into.'));
      return;
    }
    const target = window.prompt(
      `${i18n('Merge \u201c{0}\u201d into which knowledge point? Type its exact name.').replace('{0}', p.name)}\n\n${others.slice(0, 40).map((x) => `• ${x.name}`).join('\n')}${others.length > 40 ? '\n…' : ''}`,
    );
    if (!target?.trim()) return;
    const dst = others.find((x) => x.name.toLowerCase() === target.trim().toLowerCase())
      || others.find((x) => (x.aliases || []).some((a) => a.toLowerCase() === target.trim().toLowerCase()));
    if (!dst) {
      Notification.error(i18n('No knowledge point named \u201c{0}\u201d.').replace('{0}', target.trim()));
      return;
    }
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'merge', id, into: dst._id });
      if (expanded === id) expanded = null;
      Notification.success(i18n('Merged into \u201c{0}\u201d — {1} task(s) relabeled.').replace('{0}', res.point.name).replace('{1}', res.touched || 0));
      await refresh($root);
    });
  });

  $root.find('.kp__import').on('click', function onImport() {
    const name = $(this).attr('data-name');
    act($(this), async () => {
      await request.post(base(), { operation: 'import', names: name });
      await refresh($root);
    });
  });
  $root.find('.kp__untag-rm').on('click', function onRemoveTag() {
    const name = $(this).attr('data-name');
    const t = (state.untracked || []).find((x) => x.name === name);
    const count = t ? t.count : 0;
    if (!window.confirm(i18n('Remove the tag \u201c{0}\u201d from all {1} task(s)? This cannot be undone.').replace('{0}', name).replace('{1}', count))) return;
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'removeTag', name });
      Notification.success(i18n('Removed \u201c{0}\u201d from {1} task(s).').replace('{0}', name).replace('{1}', res.touched || 0));
      await refresh($root);
    });
  });
  $root.find('.kp__import-all').on('click', function onImportAll() {
    const names = (state.untracked || []).map((t) => t.name).join('\n');
    if (!window.confirm(i18n('Import all {0} tags as knowledge points?').replace('{0}', state.untracked.length))) return;
    act($(this), async () => {
      await request.post(base(), { operation: 'import', names });
      await refresh($root);
    });
  });
}

export default new NamedPage('knowledge_points', () => {
  ensureStyle();
  const $root = $('#kp-root');
  load('').then(() => render($root))
    .catch((e) => $root.html(`<div class="ais"><div class="ais__body"><div class="ais__empty">⚠ ${esc(e.message)}</div></div></div>`));
});
