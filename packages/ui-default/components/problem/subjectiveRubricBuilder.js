import $ from 'jquery';
import { confirm } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { i18n, request } from 'vj/utils';

/**
 * PTA fork — SUBJECTIVE TASK PANEL on the problem create/edit page.
 *
 * Shown while the "Subjective" type card is selected (pages/
 * problem_type_select.page.js). Two things are configured here and posted
 * together as the hidden `subjectiveConfig` field (JSON {type, rubric}),
 * which handler/problem.ts applySubjectiveConfig validates and writes into
 * config.yaml:
 *
 *   TYPE    report  — the student hands in ONE PDF report; when the
 *                     homework ends the AI grades it against the rubric.
 *           project — a project packed in a zip (like a repository);
 *                     automatic grading of projects is not available yet.
 *   RUBRIC  criteria with points, an optional description and optional
 *           achievement levels (label + points + descriptor). The starter
 *           template mirrors lib/subjective_rubric.ts starterRubric().
 */

export const SUBJECTIVE_TYPES = [
  { key: 'report', name: 'Single report (one PDF)', desc: 'Each student uploads one PDF report. After the homework ends, the AI grades every report against the rubric below and highlights its comments in an annotated copy of the PDF.' },
  { key: 'project', name: 'Project (zip file)', desc: 'Each student uploads a project packed in a zip file (like a repository), plus an optional Markdown report. Automatic grading of projects is not available yet — the rubric is shown to students and used for manual grading.' },
];

export const STARTER_RUBRIC = {
  version: 1,
  total: 100,
  criteria: [
    {
      id: 'c1', title: 'Problem understanding', maxPoints: 20,
      description: 'The report states the problem, its scope and its constraints precisely, and explains why it matters.',
      levels: [
        { points: 20, label: 'Excellent', descriptor: 'Problem, scope and constraints are stated precisely and motivated.' },
        { points: 14, label: 'Good', descriptor: 'Problem is stated clearly; scope or motivation is thin.' },
        { points: 8, label: 'Partial', descriptor: 'Problem is only vaguely described.' },
        { points: 0, label: 'Missing', descriptor: 'The problem is not identified.' },
      ],
    },
    {
      id: 'c2', title: 'Method and correctness', maxPoints: 30,
      description: 'The approach is appropriate, described in enough detail to reproduce, and technically correct.',
      levels: [
        { points: 30, label: 'Excellent', descriptor: 'Appropriate, correct and reproducible method with justified design choices.' },
        { points: 21, label: 'Good', descriptor: 'Sound method with minor gaps in detail or justification.' },
        { points: 12, label: 'Partial', descriptor: 'Method is described but has notable errors or omissions.' },
        { points: 0, label: 'Missing', descriptor: 'No usable description of the method.' },
      ],
    },
    {
      id: 'c3', title: 'Results and analysis', maxPoints: 30,
      description: 'Results are presented clearly (tables/figures), interpreted honestly, and limitations are discussed.',
      levels: [
        { points: 30, label: 'Excellent', descriptor: 'Clear results, insightful analysis, limitations discussed.' },
        { points: 21, label: 'Good', descriptor: 'Results are clear; analysis is descriptive rather than insightful.' },
        { points: 12, label: 'Partial', descriptor: 'Results are incomplete or the analysis is superficial.' },
        { points: 0, label: 'Missing', descriptor: 'No results or no analysis.' },
      ],
    },
    {
      id: 'c4', title: 'Presentation', maxPoints: 20,
      description: 'Structure, clarity of writing, figures and references; length within the limit.',
      levels: [
        { points: 20, label: 'Excellent', descriptor: 'Well structured, clearly written, professional figures and references.' },
        { points: 14, label: 'Good', descriptor: 'Readable with minor structural or formatting issues.' },
        { points: 8, label: 'Partial', descriptor: 'Hard to follow; figures or references are inadequate.' },
        { points: 0, label: 'Missing', descriptor: 'Disorganized and unclear.' },
      ],
    },
  ],
  graderNotes: '',
  maxPages: 0,
};

const STYLE = [
  '.ptss { margin: 0 0 18px; padding: 12px 14px; border: 1.5px solid #845ef7; border-radius: 12px; background: var(--pta-card); }',
  '.ptss__title { font-weight: bold; font-size: 13.5px; color: var(--pta-ink); margin-bottom: 4px; }',
  '.ptss__hint { font-size: 12px; line-height: 1.5; color: var(--pta-ink-soft); margin: 0 0 10px; }',
  '.ptss__row { display: grid; grid-template-columns: 260px 1fr; gap: 12px; align-items: start; margin-bottom: 10px; }',
  '@media (max-width: 780px) { .ptss__row { grid-template-columns: 1fr; } }',
  '.ptss label { display: block; font-size: 12px; color: var(--pta-ink-soft); margin-bottom: 3px; }',
  '.ptss__typedesc { font-size: 12px; line-height: 1.5; color: var(--pta-ink-soft); padding: 8px 10px; border-radius: 8px; background: var(--pta-violet-soft, #f3edff); border: 1px solid var(--pta-violet-line, #e5dbff); }',
  '.ptss__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 14px 0 8px; }',
  '.ptss__head b { font-size: 13px; color: var(--pta-ink); }',
  '.ptss__total { margin-left: auto; font-size: 12.5px; color: var(--pta-violet-text); font-weight: 600; }',
  '.ptss__btn { border: 1px solid var(--pta-violet-line, #e5dbff); background: var(--pta-card); color: var(--pta-violet-text, #5f3dc4); border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }',
  '.ptss__btn:hover { background: var(--pta-violet-soft, #f3edff); }',
  '.ptss__btn--danger { color: var(--pta-bad-text, #c0392b); border-color: var(--pta-bad-line, #f1c0c0); }',
  '.ptss__copy { width: auto; max-width: 320px; font-size: 12px; padding: 3px 8px; border-radius: 999px; }',
  '.ptss__crit { border: 1px solid var(--pta-line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; background: var(--pta-card-2); }',
  '.ptss__crit-row { display: grid; grid-template-columns: 1fr 110px auto; gap: 10px; align-items: end; }',
  '.ptss__crit input.textbox, .ptss__crit textarea.textbox, .ptss__lvl input.textbox { width: 100%; box-sizing: border-box; font-size: 12.5px; }',
  '.ptss__crit textarea.textbox { min-height: 44px; resize: vertical; margin-top: 6px; }',
  '.ptss__lvls { margin-top: 8px; }',
  '.ptss__lvl { display: grid; grid-template-columns: 90px 140px 1fr auto; gap: 8px; align-items: center; margin-top: 6px; }',
  '@media (max-width: 780px) { .ptss__crit-row, .ptss__lvl { grid-template-columns: 1fr; } }',
  '.ptss__lvl-add { margin-top: 6px; }',
  '.ptss__small { font-size: 11.5px; color: var(--pta-ink-faint); }',
  '.ptss__notes textarea.textbox { width: 100%; box-sizing: border-box; min-height: 56px; font-size: 12.5px; resize: vertical; }',
  '.ptss__foot { display: grid; grid-template-columns: 1fr 160px; gap: 12px; margin-top: 10px; }',
  '@media (max-width: 780px) { .ptss__foot { grid-template-columns: 1fr; } }',
  '.ptss__warn { color: var(--pta-warn, #e8590c); font-size: 12px; margin-top: 6px; }',
].join('\n');

const esc = (t) => $('<i>').text(String(t ?? '')).html();
const fmt = (n) => (Number.isFinite(+n) ? String(Math.round(+n * 100) / 100) : '');

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

/**
 * Mount the panel after `$after`. `prefill` is UiContext.subjectiveConfig
 * ({type, rubric}) on the edit page, absent on create. Returns the handle
 * the type-select page uses: show/hide, read the JSON, validate.
 */
export function mountSubjectivePanel($after, prefill) {
  if (!document.getElementById('ptss-style')) $('<style>').attr('id', 'ptss-style').text(STYLE).appendTo(document.head);
  const state = {
    type: prefill && SUBJECTIVE_TYPES.some((t) => t.key === prefill.type) ? prefill.type : 'report',
    rubric: prefill && prefill.rubric && Array.isArray(prefill.rubric.criteria) ? deepClone(prefill.rubric) : { version: 1, total: 0, criteria: [], graderNotes: '', maxPages: 0 },
  };
  let nextId = 1;
  const freshId = () => {
    for (;;) {
      const id = `c${nextId++}`;
      if (!state.rubric.criteria.some((c) => c.id === id)) return id;
    }
  };
  const typeOpts = SUBJECTIVE_TYPES.map((t) => `<option value="${t.key}"${t.key === state.type ? ' selected' : ''}>${esc(i18n(t.name))}</option>`).join('');
  const $panel = $(`<div class="ptss" hidden>
      <div class="ptss__title">📁 ${esc(i18n('Subjective task'))}</div>
      <p class="ptss__hint">${esc(i18n('Choose what students hand in, then write the rubric the report is graded against. The rubric is shown to students on the task page.'))}</p>
      <div class="ptss__row">
        <div><label>${esc(i18n('What students hand in'))}</label><select class="textbox ptss__type">${typeOpts}</select></div>
        <div class="ptss__typedesc"></div>
      </div>
      <div class="ptss__head"><b>📋 ${esc(i18n('Grading rubric'))}</b>
        <button type="button" class="ptss__btn ptss__starter">✦ ${esc(i18n('Load the starter template'))}</button>
        <select class="textbox ptss__copy" title="${esc(i18n('Copy the rubric of another task of this course'))}"><option value="">📋 ${esc(i18n('Copy from another task…'))}</option></select>
        <button type="button" class="ptss__btn ptss__add">+ ${esc(i18n('Add criterion'))}</button>
        <span class="ptss__total"></span></div>
      <div class="ptss__list"></div>
      <div class="ptss__foot">
        <div class="ptss__notes"><label>${esc(i18n('Notes for the grader (optional)'))}</label><textarea class="textbox ptss__gnotes" placeholder="${esc(i18n('Course context, what to be strict or lenient about, expected length…'))}"></textarea></div>
        <div><label>${esc(i18n('Max pages read (0 = all)'))}</label><input type="number" min="0" step="1" class="textbox ptss__maxpages"></div>
      </div>
      <div class="ptss__warn" hidden></div>
    </div>`);
  $after.after($panel);
  const $list = $panel.find('.ptss__list');
  const $type = $panel.find('.ptss__type');
  const $desc = $panel.find('.ptss__typedesc');
  const $total = $panel.find('.ptss__total');
  const $warn = $panel.find('.ptss__warn');
  $panel.find('.ptss__gnotes').val(state.rubric.graderNotes || '');
  $panel.find('.ptss__maxpages').val(state.rubric.maxPages || 0);

  const renderTypeDesc = () => {
    const t = SUBJECTIVE_TYPES.find((x) => x.key === state.type) || SUBJECTIVE_TYPES[0];
    $desc.text(i18n(t.desc));
  };
  const total = () => Math.round(state.rubric.criteria.reduce((a, c) => a + (+c.maxPoints || 0), 0) * 100) / 100;
  const renderTotal = () => {
    const t = total();
    $total.text(`${i18n('Total')}: ${fmt(t)} ${i18n('pts')} · ${state.rubric.criteria.length} ${i18n('criteria')}`);
    if (state.type === 'report' && !state.rubric.criteria.length) {
      $warn.text(i18n('A report task needs a rubric for the AI to grade it — add at least one criterion (or load the starter template).')).prop('hidden', false);
    } else if (state.rubric.criteria.some((c) => (c.levels || []).some((l) => +l.points > +c.maxPoints))) {
      $warn.text(i18n('A level cannot be worth more than its criterion.')).prop('hidden', false);
    } else $warn.prop('hidden', true);
  };

  const levelHtml = (ci, li, l) => `<div class="ptss__lvl" data-ci="${ci}" data-li="${li}">
      <input type="number" step="0.5" min="0" class="textbox ptss__lpts" value="${esc(fmt(l.points))}" placeholder="${esc(i18n('pts'))}">
      <input type="text" class="textbox ptss__llabel" value="${esc(l.label || '')}" placeholder="${esc(i18n('Label'))}">
      <input type="text" class="textbox ptss__ldesc" value="${esc(l.descriptor || '')}" placeholder="${esc(i18n('What a submission at this level looks like'))}">
      <button type="button" class="ptss__btn ptss__btn--danger ptss__ldel" title="${esc(i18n('Remove level'))}">×</button>
    </div>`;
  const render = () => {
    let html = '';
    state.rubric.criteria.forEach((c, ci) => {
      html += `<div class="ptss__crit" data-ci="${ci}">
        <div class="ptss__crit-row">
          <div><label>${esc(i18n('Criterion'))} ${ci + 1}</label><input type="text" class="textbox ptss__ctitle" value="${esc(c.title || '')}" placeholder="${esc(i18n('e.g. Method and correctness'))}"></div>
          <div><label>${esc(i18n('Max points'))}</label><input type="number" step="0.5" min="0" class="textbox ptss__cmax" value="${esc(fmt(c.maxPoints))}"></div>
          <div><button type="button" class="ptss__btn ptss__btn--danger ptss__cdel">${esc(i18n('Remove'))}</button></div>
        </div>
        <textarea class="textbox ptss__cdesc" placeholder="${esc(i18n('What is assessed and what evidence to look for (optional)'))}">${esc(c.description || '')}</textarea>
        <div class="ptss__lvls"><span class="ptss__small">${esc(i18n('Levels (optional): highest first — the grader picks the level whose description fits best.'))}</span>
          ${(c.levels || []).map((l, li) => levelHtml(ci, li, l)).join('')}
          <div class="ptss__lvl-add"><button type="button" class="ptss__btn ptss__ladd">+ ${esc(i18n('Add level'))}</button></div>
        </div>
      </div>`;
    });
    if (!state.rubric.criteria.length) html = `<p class="ptss__hint">${esc(i18n('No criteria yet.'))}</p>`;
    $list.html(html);
    renderTotal();
  };

  // ---- events: every edit lands in `state`, the DOM is re-rendered only for structural changes ----
  $type.on('change', () => {
    state.type = String($type.val());
    renderTypeDesc();
    renderTotal();
    $panel.trigger('change');
  });
  $panel.find('.ptss__starter').on('click', async () => {
    if (state.rubric.criteria.length && !await confirm(i18n('Replace the current rubric with the starter template?'))) return;
    state.rubric = deepClone(STARTER_RUBRIC);
    $panel.find('.ptss__gnotes').val('');
    $panel.find('.ptss__maxpages').val(0);
    render();
    $panel.trigger('change');
  });
  /* ---- copy the rubric of another task (PTA fork: /subjective/rubrics) ---- */
  const $copy = $panel.find('.ptss__copy');
  let copyList = null;
  const loadCopyList = async () => {
    if (copyList) return copyList;
    const domainPrefix = (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
    const res = await request.get(`${domainPrefix}/subjective/rubrics`);
    copyList = res.rubrics || [];
    for (const r of copyList) {
      $copy.append($('<option>').attr('value', String(r.docId)).text(`${r.pid} ${r.title} (${r.rubric.total} ${i18n('pts')}, ${r.rubric.criteria.length} ${i18n('criteria')})`));
    }
    if (!copyList.length) $copy.append($('<option disabled>').text(i18n('No other task has a rubric yet.')));
    return copyList;
  };
  $copy.on('focus mousedown', () => { loadCopyList().catch((e) => Notification.error(e.message)); });
  $copy.on('change', async () => {
    const docId = String($copy.val() || '');
    if (!docId) return;
    const src = (copyList || []).find((r) => String(r.docId) === docId);
    $copy.val('');
    if (!src) return;
    if (state.rubric.criteria.length && !await confirm(i18n('Replace the current rubric with the rubric of {0}?').replace('{0}', src.pid))) return;
    const copied = deepClone(src.rubric);
    copied.criteria = copied.criteria.map((c, i) => ({ ...c, id: `c${i + 1}` }));
    state.rubric = { version: 1, total: copied.total, criteria: copied.criteria, graderNotes: copied.graderNotes || '', maxPages: copied.maxPages || 0 };
    $panel.find('.ptss__gnotes').val(state.rubric.graderNotes);
    $panel.find('.ptss__maxpages').val(state.rubric.maxPages);
    render();
    $panel.trigger('change');
    Notification.success(i18n('Rubric copied from {0}.').replace('{0}', src.pid));
  });

  $panel.find('.ptss__add').on('click', () => {
    state.rubric.criteria.push({ id: freshId(), title: '', maxPoints: 10, description: '', levels: [] });
    render();
    $list.find('.ptss__crit').last().find('.ptss__ctitle').trigger('focus');
    $panel.trigger('change');
  });
  const critOf = (el) => state.rubric.criteria[+$(el).closest('.ptss__crit').data('ci')];
  $list.on('input change', '.ptss__ctitle', function onTitle() { critOf(this).title = String($(this).val()); });
  $list.on('input change', '.ptss__cmax', function onMax() {
    critOf(this).maxPoints = +$(this).val() || 0;
    renderTotal();
  });
  $list.on('input change', '.ptss__cdesc', function onDesc() { critOf(this).description = String($(this).val()); });
  $list.on('click', '.ptss__cdel', function onDel() {
    state.rubric.criteria.splice(+$(this).closest('.ptss__crit').data('ci'), 1);
    render();
    $panel.trigger('change');
  });
  $list.on('click', '.ptss__ladd', function onAddLevel() {
    const c = critOf(this);
    c.levels ||= [];
    c.levels.push({ points: c.levels.length ? 0 : (+c.maxPoints || 0), label: '', descriptor: '' });
    render();
    $panel.trigger('change');
  });
  const levelOf = (el) => {
    const $l = $(el).closest('.ptss__lvl');
    return state.rubric.criteria[+$l.data('ci')].levels[+$l.data('li')];
  };
  $list.on('input change', '.ptss__lpts', function onLPts() {
    levelOf(this).points = +$(this).val() || 0;
    renderTotal();
  });
  $list.on('input change', '.ptss__llabel', function onLLabel() { levelOf(this).label = String($(this).val()); });
  $list.on('input change', '.ptss__ldesc', function onLDesc() { levelOf(this).descriptor = String($(this).val()); });
  $list.on('click', '.ptss__ldel', function onLDel() {
    const $l = $(this).closest('.ptss__lvl');
    state.rubric.criteria[+$l.data('ci')].levels.splice(+$l.data('li'), 1);
    render();
    $panel.trigger('change');
  });
  $panel.find('.ptss__gnotes').on('input change', function onNotes() { state.rubric.graderNotes = String($(this).val()); });
  $panel.find('.ptss__maxpages').on('input change', function onPages() { state.rubric.maxPages = Math.max(0, Math.floor(+$(this).val() || 0)); });

  renderTypeDesc();
  render();

  return {
    $panel,
    setVisible(on) { $panel.prop('hidden', !on); },
    /** The JSON the server validates (handler/problem.ts applySubjectiveConfig). */
    json() {
      const criteria = state.rubric.criteria.map((c) => ({
        id: c.id, title: String(c.title || '').trim(), maxPoints: +c.maxPoints || 0, description: String(c.description || '').trim(),
        levels: (c.levels || []).map((l) => ({ points: +l.points || 0, label: String(l.label || '').trim(), descriptor: String(l.descriptor || '').trim() })),
      }));
      return JSON.stringify({
        type: state.type,
        rubric: criteria.length ? { version: 1, total: total(), criteria, graderNotes: String(state.rubric.graderNotes || '').trim(), maxPages: state.rubric.maxPages || 0 } : null,
      });
    },
    /** Client-side check mirroring lib/subjective_rubric.ts; returns an error message or ''. */
    validate() {
      for (let i = 0; i < state.rubric.criteria.length; i++) {
        const c = state.rubric.criteria[i];
        if (!String(c.title || '').trim()) return i18n('Criterion {0} needs a title.').replace('{0}', String(i + 1));
        if (!(+c.maxPoints > 0)) return i18n('Criterion "{0}" needs a positive maximum of points.').replace('{0}', c.title);
        for (const l of c.levels || []) if (+l.points > +c.maxPoints) return i18n('A level cannot be worth more than its criterion.');
      }
      return '';
    },
    type() { return state.type; },
    hasRubric() { return state.rubric.criteria.length > 0; },
  };
}
