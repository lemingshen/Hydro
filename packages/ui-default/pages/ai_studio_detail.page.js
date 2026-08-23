import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import { ensureAisStyle, fmtSize, langEntries, langOptionsHtml, renderAllowLangsDd, uploadContextFile, wireAllowLangsDd } from 'vj/pages/ai_studio.page';

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
const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];

const DETAIL_STYLE = [
  '.aisd { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }',
  '.aisd__main { flex: 1 1 620px; min-width: 0; }',
  '.aisd__side { flex: 0 0 320px; max-width: 100%; }',
  '.aisd__tabs { display: flex; gap: 6px; padding: 10px 12px 0; flex-wrap: wrap; }',
  '.aisd__tab { border: 1px solid var(--pta-violet-line); border-bottom: none; border-radius: 10px 10px 0 0; background: var(--pta-card-2); color: var(--pta-violet-text); padding: 7px 16px; font-size: 12.5px; cursor: pointer; transition: background .15s ease, color .15s ease, box-shadow .15s ease; }',
  '.aisd__tab:hover { background: var(--pta-violet-soft); }',
  '.aisd__tab--on { background: var(--pta-card); color: var(--pta-violet-text); font-weight: bold; box-shadow: inset 0 -2px 0 var(--pta-violet); }',
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
  '.aisd__ev { background: #1e2227; color: #e6e6e6; border-radius: 10px; padding: 10px 12px; font: 11.5px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; scrollbar-width: thin; animation: ptaFadeIn .2s ease; }',
  '.aisd__meta { color: var(--pta-ink-faint); font-size: 11.5px; }',
  '.aisd__mtable { width: 100%; border-collapse: collapse; font-size: 11.5px; }',
  '.aisd__mtable td, .aisd__mtable th { padding: 3px 6px; border-bottom: 1px solid var(--pta-line-soft); text-align: left; }',
  '.aisd__case { border: 1px solid var(--pta-violet-line); border-radius: 10px; padding: 8px 10px; margin: 6px 0; font-size: 12px; transition: background .15s ease, border-color .15s ease; animation: ptaFadeUp .24s var(--pta-ease) backwards; }',
  '.aisd__case:hover { background: var(--pta-violet-soft); }',
  '.aisd__case pre { margin: 4px 0 0; background: var(--pta-card-2); border-radius: 6px; padding: 6px 8px; font-size: 11.5px; white-space: pre-wrap; }',
  '.pta-dark .aisd__case pre { background: #1e2227; }',
].join('\n');

const STAGES = [
  ['generate', 'Generate'],
  ['precheck', 'Prepare'],
  ['build', 'Run reference'],
  ['crosscheck', 'Cross-check'],
  ['testdata', 'Upload testdata'],
  ['judge', 'Judge verify'],
  ['calibrate', 'Calibrate limits'],
  ['report', 'Teacher report'],
];

/** Objective drafts skip the sandbox entirely: validate -> assemble -> report. */
const OBJ_STAGES = [
  ['generate', 'Generate'],
  ['precheck', 'Validate'],
  ['materialize', 'Assemble quiz'],
  ['report', 'Teacher report'],
];
const isObjDraft = (d) => ((d?.brief?.kind) === 'objective');
const stageListFor = (d) => (isObjDraft(d) ? OBJ_STAGES : STAGES);
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
  d?.brief?.kind || 'programming',
]);
let langsMap = {}; // judge languages from the server (scratchpad-identical set)
let activePane = null; // which tab survives re-renders
let pollTimer = null;
let lastSideFp = ''; // sidebar re-renders only when this changes
const sideFp = () => {
  const p = state?.pipeline || {};
  return JSON.stringify([p.status, p.stage, p.message, (p.evidence || '').length,
    (state?.log || []).length, state?.measured?.time, state?.published]);
};
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
        ${p.evidence ? `<div class="ais__label">🔍 ${esc(i18n('Judge evidence'))}</div><div class="aisd__ev">${esc(p.evidence)}</div>` : ''}
        ${p.status === 'failed' && p.stage === 'crosscheck' ? `<div class="aisd__meta" style="margin-top:6px;">💡 ${esc(i18n('If the statement is ambiguous for this input (e.g. negative values), clarify it in the Statement tab and verify again — or edit either solution directly.'))}</div>
        <button class="ais__btn ais__btn--sm aisd__skipcc" style="margin-top:8px;">✋ ${esc(i18n('Trust the reference — re-verify without cross-check'))}</button>` : ''}
        ${measured}
        ${d.docId ? `<div class="aisd__meta" style="margin-top:10px;">${esc(i18n('Draft problem'))}: <a href="${domainPrefix()}/p/${d.docId}" target="_blank" rel="noopener">#${d.docId}</a>${d.published ? ` · <b>${esc(i18n('Published'))}</b>` : ` (${esc(i18n('hidden'))})`}</div>` : ''}
        ${logs ? `<div class="ais__label">📜 ${esc(i18n('Recent activity'))}</div>${logs}` : ''}
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

function render($root) {
  const d = state;
  lastFp = artifactFp(d);
  lastSideFp = sideFp();
  const s = d.artifacts.statement || { title: '', body: '' };
  const sol = d.artifacts.solution || { language: d.brief.language, code: '' };
  const alt = d.artifacts.alt || { language: d.brief.language, code: '' };
  const busy = d.pipeline.status === 'running';
  const langSel = (cls, cur) => `<select class="${cls}" style="max-width:240px;">${langOptionsHtml(langsMap, cur)}</select>`;
  const isObj = isObjDraft(d);
  const progTabs = isObj ? '' : [
    '<button class="aisd__tab" data-pane="sol">✅ ' + esc(i18n('Reference solution')) + '</button>',
    '<button class="aisd__tab" data-pane="alt">🔁 ' + esc(i18n('Cross-check solution')) + '</button>',
    '<button class="aisd__tab" data-pane="tests">🧾 ' + esc(i18n('Tests')) + ' (' + (d.artifacts.tests || []).length + ')</button>',
  ].join('\n          ');
  const ansTab = isObj
    ? '<button class="aisd__tab" data-pane="ans">🔑 ' + esc(i18n('Answers')) + ' (' + answersCount(d.artifacts.answers && d.artifacts.answers.yaml) + ')</button>'
    : '';
  const stmtRefine = isObj ? '' : '<button class="ais__btn ais__btn--ghost ais__btn--sm aisd__refine" data-t="statement" ' + (busy ? 'disabled' : '') + '>💬 ' + esc(i18n('AI refine…')) + '</button>';
  $root.html(`
  <div class="ais__banner">← <a href="${domainPrefix()}/ai-studio">${esc(i18n('All drafts'))}</a>
    <span style="margin-left:6px;">${esc(d.brief.topic)}</span>
    <span class="ais__chip" style="margin-left:auto;">${isObj ? `📝 ${esc(i18n('Objective'))}` : `💻 ${esc(d.brief.language)}`} · ${esc(i18n(d.brief.difficulty))} · 📚 ${(d.brief.files || []).length}</span></div>
  <div class="aisd">
    <div class="aisd__main">
      <div class="ais">
        <div class="ais__head">✨ <span class="ais__title">${esc(s.title || i18n('Untitled draft'))}</span>
          <span class="ais__hint">${esc(i18n('Every artifact is editable — your edits go through the same verification.'))}</span></div>
        <div class="aisd__tabs">
          <button class="aisd__tab" data-pane="stmt">📝 ${esc(i18n('Statement'))}</button>
          ${ansTab}
          ${progTabs}
          <button class="aisd__tab" data-pane="report">📊 ${esc(i18n('Teacher report'))}</button>
          <button class="aisd__tab" data-pane="ctx">📚 ${esc(i18n('Context'))} (${(d.brief.files || []).length})</button>
        </div>
        <div class="ais__body">
          <div class="aisd__bar">
            ${busy ? `<button class="ais__btn ais__btn--danger aisd__stop">⏹ ${esc(i18n('Stop'))}</button>` : ''}
            <button class="ais__btn aisd__genall" ${busy ? 'disabled' : ''}>✨ ${esc(i18n('Generate & verify'))}</button>
            <button class="ais__btn aisd__verify" ${busy ? 'disabled' : ''}>🧪 ${esc(i18n('Run verification'))}</button>
            <button class="ais__btn aisd__publish" ${d.pipeline.status === 'passed' && !d.published ? '' : 'disabled'}>🚀 ${esc(i18n('Publish'))}</button>
            <button class="ais__btn ais__btn--danger aisd__discard" ${busy || d.published ? 'disabled' : ''}>🗑 ${esc(i18n('Discard'))}</button>
          </div>

          <div class="aisd__pane" data-pane="ctx">
            <div class="ais__label">🧠 ${esc(i18n('Task requirement'))}</div>
            <textarea class="aisd__topic" rows="3" spellcheck="false">${esc(d.brief.topic || '')}</textarea>
            <div class="ais__row" style="margin-top:8px;align-items:center;gap:10px;display:flex;flex-wrap:wrap;">
              <div><div class="ais__label" style="margin-top:0;">${esc(i18n('Difficulty'))}</div>
                <select class="aisd__difficulty" style="max-width:180px;">
                  ${['intro', 'medium', 'challenge'].map((x) => `<option value="${x}" ${d.brief.difficulty === x ? 'selected' : ''}>${esc(i18n(x))}</option>`).join('')}
                </select></div>
              ${isObj
    ? '<div><div class="ais__label" style="margin-top:0;">' + esc(i18n('Question types')) + '</div><div class="aisd__meta" style="margin-top:6px;">' + esc(((d.brief.qtypes || []).map((q) => i18n(QT_LABEL[q] || q)).join(' · ')) || i18n('AI decides')) + '</div></div>'
    : '<div style="min-width:230px;"><div class="ais__label" style="margin-top:0;">' + esc(i18n('Allowed languages for students')) + '</div>' + renderAllowLangsDd(langEntries(langsMap), d.brief.allowLangs || [], false) + '<div class="aisd__meta">' + esc(i18n('Empty = every judge language. Saved instantly.')) + '</div></div>'}
              <button class="ais__btn ais__btn--sm aisd__brief-save" style="align-self:flex-end;">💾 ${esc(i18n('Save requirement'))}</button>
            </div>
            <div class="aisd__meta" style="margin:6px 0 14px;">${esc(i18n('After changing the requirement, click Generate & verify to synthesize the task against it.'))}</div>
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
            </div>
          </div>

          <div class="aisd__pane" data-pane="stmt">
            <div class="ais__label">${esc(i18n('Title'))}</div>
            <input type="text" class="aisd__title" value="${esc(s.title)}">
            <div class="ais__label">${isObj
    ? esc(i18n('Statement (markdown with {{ input/select/multiselect/dropdown }} question markers)'))
    : esc(i18n('Statement (markdown, no samples — samples are computed by the judge)'))}</div>
            <textarea class="aisd__body-md" rows="14">${esc(s.body)}</textarea>
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__regen" data-t="statement" ${busy ? 'disabled' : ''}>✨ ${esc(i18n(isObj ? 'Regenerate quiz + key' : 'Regenerate'))}</button>
              ${stmtRefine}
              <button class="ais__btn ais__btn--sm aisd__save" data-t="statement">💾 ${esc(i18n('Save'))}</button>
            </div>
          </div>

          <div class="aisd__pane" data-pane="ans" ${isObj ? '' : 'hidden'}>
            <div class="aisd__meta" style="margin-bottom:8px;">${esc(i18n('The answer key the judge grades with. YAML: one line per question — id: [answer, score].'))}</div>
            <div class="ais__label">🔑 ${esc(i18n('Answer key (YAML)'))}</div>
            <textarea class="aisd__answers" rows="10" spellcheck="false">${esc((d.artifacts.answers && d.artifacts.answers.yaml) || '')}</textarea>
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__regen" data-t="statement" ${busy ? 'disabled' : ''}>✨ ${esc(i18n('Regenerate quiz + key'))}</button>
              <button class="ais__btn ais__btn--sm aisd__save" data-t="answers">💾 ${esc(i18n('Validate & save'))}</button>
            </div>
            <div class="ais__label">👁 ${esc(i18n('Preview'))}</div>
            ${answersPreview(d)}
          </div>

          <div class="aisd__pane" data-pane="sol" ${isObj ? 'hidden' : ''}>
            <div class="ais__label">${esc(i18n('Language'))}</div>${langSel('aisd__sol-lang', sol.language)}
            <div class="ais__label">${esc(i18n('Reference solution (must read stdin, write stdout only)'))}</div>
            <textarea class="aisd__sol-code" rows="18" spellcheck="false">${esc(sol.code)}</textarea>
            <div class="aisd__bar" style="margin-top:10px;">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__regen" data-t="solution" ${busy ? 'disabled' : ''}>✨ ${esc(i18n('Regenerate'))}</button>
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__refine" data-t="solution" ${busy ? 'disabled' : ''}>💬 ${esc(i18n('AI refine…'))}</button>
              <button class="ais__btn ais__btn--sm aisd__save" data-t="solution">💾 ${esc(i18n('Save'))}</button>
            </div>
          </div>

          <div class="aisd__pane" data-pane="alt" ${isObj ? 'hidden' : ''}>
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

          <div class="aisd__pane" data-pane="tests" ${isObj ? 'hidden' : ''}>
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

          <div class="aisd__pane" data-pane="report">
            <div class="aisd__meta" style="margin-bottom:8px;">${esc(i18n('A briefing for you, not for students: the key idea, the knowledge points the task tests, how the cases probe them, and likely pitfalls.'))}</div>
            ${reportPane(d)}
            <div class="aisd__bar" style="margin-top:12px;">
              <button class="ais__btn ais__btn--ghost ais__btn--sm aisd__regen" data-t="report" ${busy ? 'disabled' : ''}>✨ ${esc(i18n('Regenerate'))}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="aisd__side">${sideHtml(d)}</div>
  </div>`);
  wire($root);
  const pane = activePane || (d.artifacts.statement ? 'stmt' : 'ctx');
  $root.find('.aisd__tab').removeClass('aisd__tab--on').filter(`[data-pane="${pane}"]`).addClass('aisd__tab--on');
  $root.find('.aisd__pane').removeClass('aisd__pane--on').filter(`[data-pane="${pane}"]`).addClass('aisd__pane--on');
  mountStatementEditor($root);
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
  const busy = state.pipeline.status === 'running';
  $root.find('.aisd__genall, .aisd__verify, .aisd__regen, .aisd__refine, .aisd__brief-save').prop('disabled', busy);
  $root.find('.aisd__publish').prop('disabled', !(state.pipeline.status === 'passed' && !state.published));
  $root.find('.aisd__discard').prop('disabled', busy || !!state.published);
}

async function mountStatementEditor($root) {
  try {
    const { default: Editor } = await import('vj/components/editor');
    const $ta = $root.find('.aisd__body-md');
    // The editor appends to the textarea's PARENT — the pane div hosts it
    // right under the label, and mirrors keystrokes back into the textarea.
    statementEditor = Editor.getOrConstruct($ta, { language: 'markdown' });
  } catch (e) { /* plain textarea fallback */ }
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
  const raw = String($root.find('.aisd__tests').val() || '[]');
  const cases = JSON.parse(raw); // throws -> caught by caller with a friendly message
  return { cases };
}

function startPolling($root) {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const data = await request.get(base());
      const hadStmt = !!state?.artifacts?.statement;
      state = data.draft;
      if (!hadStmt && state?.artifacts?.statement && (!activePane || activePane === 'ctx')) activePane = 'stmt';
      if (artifactFp(state) !== lastFp) render($root); // new artifact — show it live
      else renderSide($root);
      if (state.pipeline.status !== 'running') {
        clearInterval(pollTimer);
        pollTimer = null;
        if (state.pipeline.status === 'passed') Notification.success(i18n('Verification passed.'));
        else if (state.pipeline.status === 'failed') Notification.error(`${i18n('Verification failed at')} ${state.pipeline.stage}: ${state.pipeline.message}`);
        render($root); // full refresh: repaired artifacts / samples / limits
      }
    } catch (e) { /* transient poll error; keep polling */ }
  }, 2000);
}

function wire($root) {
  $root.find('.aisd__tab').on('click', function onTab() {
    $root.find('.aisd__tab').removeClass('aisd__tab--on');
    $(this).addClass('aisd__tab--on');
    const pane = $(this).data('pane');
    activePane = pane;
    $root.find('.aisd__pane').removeClass('aisd__pane--on');
    $root.find(`.aisd__pane[data-pane="${pane}"]`).addClass('aisd__pane--on');
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

  $root.find('.aisd__brief-save').on('click', function onBrief() {
    act($(this), async () => {
      const res = await request.post(base(), {
        operation: 'save',
        target: 'brief',
        payload: JSON.stringify({
          topic: String($root.find('.aisd__topic').val() || ''),
          difficulty: $root.find('.aisd__difficulty').val(),
        }),
      });
      state = res.draft;
      render($root);
      Notification.success(i18n('Requirement saved — run Generate & verify to synthesize against it.'));
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

  wireAllowLangsDd($root, async (langs) => {
    try {
      const res = await request.post(base(), { operation: 'save', target: 'allowLangs', payload: JSON.stringify({ langs }) });
      state = res.draft;
      Notification.success(i18n('Allowed languages saved.'));
    } catch (e) {
      Notification.error(e.message);
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

  $root.find('.aisd__genall').on('click', function onGen() {
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'generate', target: 'all', verify: true });
      state = res.draft;
      render($root);
      Notification.success(i18n('Generation started — the task will appear here as each part is drafted.'));
      startPolling($root);
    });
  });
  $root.find('.aisd__regen').on('click', function onRegen() {
    const t = $(this).data('t');
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'generate', target: t });
      state = res.draft;
      render($root);
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
  $root.find('.aisd__publish').on('click', function onPub() {
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'publish' });
      Notification.success(`${i18n('Published as')} ${res.pid}`);
      state.published = true;
      renderSide($root);
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
  request.get(base()).then((data) => {
    state = data.draft;
    langsMap = data.langs || {};
    render($root);
    if (state.pipeline.status === 'running') startPolling($root);
  }).catch((e) => $root.html(`<div class="ais"><div class="ais__body"><div class="ais__empty">⚠ ${esc(e.message)}</div></div></div>`));
});
