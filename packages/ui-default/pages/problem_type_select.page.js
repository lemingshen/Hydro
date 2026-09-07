import $ from 'jquery';
import Notification from 'vj/components/notification';
import { objectiveTitleOf } from 'vj/components/problem/objectiveTitle';
import { NamedPage } from 'vj/misc/Page';
import { getAvailableLangs, getTheme, i18n } from 'vj/utils';

/**
 * Problem-type selector on the create/edit pages. The teacher picks the type
 * FIRST — Programming / Function / Objective / Subjective — via four cards
 * above the form; the pid is kept prefixed with 'P' / 'F' / 'O' / 'S'
 * accordingly (the prefix is the site-wide authority for how a problem is
 * treated). Submission is blocked on a mismatch.
 *
 * FUNCTION TASKS (PTA 函数题) additionally need a judge program and a stub.
 * While 'F' is selected a panel below the type cards takes both; they are
 * posted as `functionConfig` and land in config.yaml as `template` / `stub`
 * (handler/problem.ts applyFunctionConfig) — the same shape the AI Studio
 * writes, so a hand-made task is judged and displayed identically.
 */

const TYPES = [
  {
    key: 'P', color: '#1c7ed6', tint: '#e8f2fd', darkTint: '#152a40', name: 'Programming',
    desc: 'Judged by the OJ: students code in the online IDE and submit for automatic testing.',
  },
  {
    key: 'F', color: '#f08c00', tint: '#fff4e0', darkTint: '#3a2a10', name: 'Function',
    desc: 'Students write only one function; it is spliced into your judge program and tested like a programming task.',
  },
  {
    key: 'O', color: '#0ca678', tint: '#e6f7f1', darkTint: '#0f2f26', name: 'Objective',
    desc: 'True/false, multiple choice, fill-in-the-blank — auto-graded from the objective config.',
  },
  {
    key: 'S', color: '#845ef7', tint: '#f3edff', darkTint: '#251d3d', name: 'Subjective',
    desc: 'Project-level task: students submit files and a Markdown report; graded by the teacher, no OJ judging.',
  },
];

const STYLE = [
  '.pts { margin: 0 0 18px; }',
  '.pts__title { font-weight: bold; font-size: 14px; margin-bottom: 8px; color: var(--pta-ink); }',
  '.pts__title small { font-weight: normal; color: var(--pta-ink-faint); margin-left: 8px; }',
  '.pts__grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }',
  '@media (max-width: 1100px) { .pts__grid { grid-template-columns: repeat(2, 1fr); } }',
  '@media (max-width: 640px) { .pts__grid { grid-template-columns: 1fr; } }',
  '.ptsc { display: block; cursor: pointer; margin: 0; animation: ptaFadeUp .28s var(--pta-ease) backwards; }',
  '.ptsc:nth-of-type(2) { animation-delay: .06s; }',
  '.ptsc:nth-of-type(3) { animation-delay: .12s; }',
  '.ptsc:nth-of-type(4) { animation-delay: .18s; }',
  '.ptsc input { position: absolute; opacity: 0; pointer-events: none; }',
  '.ptsc__body { display: block; position: relative; border: 1.5px solid var(--pta-line); border-radius: 12px; background: var(--pta-card); padding: 13px 15px 12px; height: 100%; box-sizing: border-box; transition: border-color .15s, box-shadow .15s, background .15s, transform .15s var(--pta-ease); }',
  '.ptsc:hover .ptsc__body { border-color: var(--pta-blue-line); box-shadow: var(--pta-shadow-hover); transform: translateY(-2px); }',
  '.ptsc input:focus-visible + .ptsc__body { outline: 2px solid #4c6ef5; outline-offset: 2px; }',
  '.ptsc__row { display: flex; align-items: center; gap: 9px; margin-bottom: 6px; }',

  '.ptsc__name { font-weight: bold; font-size: 13.5px; color: var(--pta-ink); }',
  '.ptsc__key { font: bold 11px/1 var(--font-family); font-variant-numeric: tabular-nums; color: #fff; border-radius: 6px; padding: 3px 7px; letter-spacing: .04em; }',
  '.ptsc__check { position: absolute; top: 9px; right: 11px; width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 12px; line-height: 18px; text-align: center; opacity: 0; transform: scale(.6); transition: opacity .15s, transform .18s var(--pta-ease); }',
  '.ptsc__desc { display: block; color: var(--pta-ink-soft); font-size: 12px; line-height: 1.5; }',
  '.ptsc input:checked + .ptsc__body { box-shadow: 0 3px 14px rgba(52,64,90,.10); }',
  '.ptsc input:checked + .ptsc__body .ptsc__check { opacity: 1; transform: scale(1); }',
  // Selection is pure CSS per type and per theme — no inline styles, so the
  // cards follow whichever theme the page is in. (Values mirror TYPES above;
  // keep the two in sync if a type color ever changes.)
  '.ptsc input[value="P"]:checked + .ptsc__body { border-color: #1c7ed6; background: #e8f2fd; }',
  '.ptsc input[value="O"]:checked + .ptsc__body { border-color: #0ca678; background: #e6f7f1; }',
  '.ptsc input[value="S"]:checked + .ptsc__body { border-color: #845ef7; background: #f3edff; }',
  '.ptsc input[value="F"]:checked + .ptsc__body { border-color: #f08c00; background: #fff4e0; }',
  '.pta-dark .ptsc input[value="P"]:checked + .ptsc__body { background: #152a40; }',
  '.pta-dark .ptsc input[value="O"]:checked + .ptsc__body { background: #0f2f26; }',
  '.pta-dark .ptsc input[value="S"]:checked + .ptsc__body { background: #251d3d; }',
  '.pta-dark .ptsc input[value="F"]:checked + .ptsc__body { background: #3a2a10; }',
  // Function task: the judge program + stub panel.
  '.ptsf { margin: 0 0 18px; padding: 12px 14px; border: 1.5px solid #f08c00; border-radius: 12px; background: var(--pta-card); }',
  '.ptsf__title { font-weight: bold; font-size: 13.5px; color: var(--pta-ink); margin-bottom: 4px; }',
  '.ptsf__hint { font-size: 12px; line-height: 1.5; color: var(--pta-ink-soft); margin: 0 0 8px; }',
  '.ptsf__row { display: grid; grid-template-columns: 200px 1fr; gap: 12px; align-items: end; margin-bottom: 8px; }',
  '@media (max-width: 780px) { .ptsf__row { grid-template-columns: 1fr; } }',
  '.ptsf label { display: block; font-size: 12px; color: var(--pta-ink-soft); margin-bottom: 3px; }',
  '.ptsf textarea { width: 100%; font-family: var(--code-font-family, monospace); font-size: 12.5px; line-height: 1.45; resize: vertical; }',
  '.ptsf__marker { font-family: var(--code-font-family, monospace); font-size: 11.5px; color: #e67700; }',
  // Objective: the title box is filled from the question text (read-only).
  '.textbox.pts-derived { background: var(--pta-card-2); color: var(--pta-ink-soft); cursor: default; }',
  '.pts-derived-note { display: flex; align-items: flex-start; gap: 6px; margin: 4px 0 0; font-size: 12px; line-height: 1.45; color: var(--pta-ink-faint); }',
  '.pts-derived-note b { color: var(--pta-violet-text); font-weight: 600; }',
].join('\n');

/** The title form's max length (framework Types.Title); the server keeps the full rule. */
const FORM_TITLE_MAX = 64;

export default new NamedPage(['problem_create', 'problem_edit'], () => {
  const $pid = $('input[name="pid"]');
  if (!$pid.length) return;
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
  if (!document.getElementById('pts-style')) {
    $('<style>').attr('id', 'pts-style').text(STYLE).appendTo(document.head);
  }
  const esc = (t) => $('<i>').text(String(t ?? '')).html();

  const currentKey = () => {
    const c = String($pid.val() || '').charAt(0).toUpperCase();
    return ['P', 'F', 'O', 'S'].includes(c) ? c : null;
  };

  let html = `<div class="pts"><div class="pts__title">${esc(i18n('Problem Type'))}`
    + `<small>${esc(i18n('The problem ID is prefixed automatically.'))}</small></div><div class="pts__grid">`;
  for (const t of TYPES) {
    html += `<label class="ptsc"><input type="radio" name="pts-type" value="${t.key}">`
      + '<span class="ptsc__body">'
      + `<span class="ptsc__check" style="background:${t.color}">✓</span>`
      + '<span class="ptsc__row">'
      + `<span class="ptsc__name">${esc(i18n(t.name))}</span>`
      + `<span class="ptsc__key" style="background:${t.color}">${t.key}…</span></span>`
      + `<span class="ptsc__desc">${esc(i18n(t.desc))}</span>`
      + '</span></label>';
  }
  html += '</div></div>';
  const $sel = $(html);
  // Full width, above the whole pid/title row (the narrow pid column made
  // the old placement wrap terribly).
  const $row = $pid.closest('.row');
  if ($row.length) $row.before($sel);
  else $pid.parent().before($sel);

  const init = currentKey() || 'P';
  $sel.find(`input[value="${init}"]`).prop('checked', true);

  /* ---------------- function task: judge program + stub ---------------- */
  const langs = getAvailableLangs();
  const prefill = (window.UiContext && window.UiContext.functionConfig) || null;
  // Prefill from config.yaml: the first family that has a harness; pick a
  // concrete language id of that family for the dropdown.
  const family = prefill ? Object.keys(prefill.template || {})[0] : null;
  const langIds = Object.keys(langs);
  const preLang = family ? (langIds.find((l) => l === family) || langIds.find((l) => l.split('.')[0] === family) || '') : '';
  const defaultLang = preLang || langIds.find((l) => l.split('.')[0] === 'cc') || langIds.find((l) => l.split('.')[0] === 'c') || langIds[0] || '';
  const langOpts = langIds.map((l) => `<option value="${esc(l)}"${l === defaultLang ? ' selected' : ''}>${esc(langs[l].display || l)}</option>`).join('');
  const $fn = $(`<div class="ptsf" hidden>
      <div class="ptsf__title">🧩 ${esc(i18n('Judge program'))}</div>
      <p class="ptsf__hint">${esc(i18n('The complete program the student’s function is spliced into. Put the line'))} <span class="ptsf__marker">/* Your function will be put here */</span> ${esc(i18n('where the function goes (without it, the function is appended at the end). Implement every helper fully — this is what actually runs.'))}</p>
      <div class="ptsf__row">
        <div><label>${esc(i18n('Language of the judge program'))}</label><select class="textbox ptsf__lang">${langOpts}</select></div>
        <div class="ptsf__hint" style="margin:0;">${esc(i18n('One judge program per language family; students may submit in any variant of that family.'))}</div>
      </div>
      <label>${esc(i18n('Judge program'))}</label>
      <textarea class="textbox ptsf__harness" rows="14" spellcheck="false">${esc(family ? prefill.template[family] : '')}</textarea>
      <label style="margin-top:8px;">${esc(i18n('Stub the student starts from (the empty function)'))}</label>
      <textarea class="textbox ptsf__stub" rows="5" spellcheck="false">${esc(family && prefill.stub ? (prefill.stub[family] || '') : '')}</textarea>
    </div>`);
  $sel.after($fn);
  const $fnInput = $('<input type="hidden" name="functionConfig" value="">').appendTo($pid.closest('form'));
  const syncFn = () => {
    if (String($sel.find('input[name="pts-type"]:checked').val()) !== 'F') { $fnInput.val(''); return; }
    $fnInput.val(JSON.stringify({
      language: String($fn.find('.ptsf__lang').val() || ''),
      harness: String($fn.find('.ptsf__harness').val() || ''),
      stub: String($fn.find('.ptsf__stub').val() || ''),
    }));
  };
  const applyFnPanel = (key) => { $fn.prop('hidden', key !== 'F'); syncFn(); };
  applyFnPanel(init);
  $fn.on('input change', syncFn);

  const applyPrefix = (key) => {
    const v = String($pid.val() || '');
    if (!v) {
      $pid.val(key);
      return;
    }
    const first = v.charAt(0).toUpperCase();
    if (['P', 'F', 'O', 'S'].includes(first)) {
      if (first !== key) $pid.val(key + v.slice(1));
    } else $pid.val(key + v);
  };

  $sel.find('input[name="pts-type"]').on('change', function onPick() {
    applyPrefix(String($(this).val()));
    applyFnPanel(String($(this).val()));
  });

  $pid.on('input blur', () => {
    const k = currentKey();
    if (k) {
      $sel.find(`input[value="${k}"]`).prop('checked', true);
      applyFnPanel(k);
    }
  });

  /*
   * OBJECTIVE TITLES ARE THE QUESTION. While the Objective type is selected
   * the title box is read-only and mirrors the question text of the content
   * (options and answer markers excluded — components/problem/objectiveTitle,
   * the client copy of lib/objective_title.ts). The editor writes to the
   * hidden `content` textarea without firing events, so the mirror polls it
   * lightly and refreshes right before submit; the server applies the same
   * rule when saving, so what is shown here is what will be stored.
   */
  const $title = $('input[name="title"]');
  const $content = $('textarea[name="content"]');
  const $note = $(`<p class="pts-derived-note">✦ <span>${esc(i18n('Objective tasks are titled by their question text — this box is filled automatically from the content (options and answer markers excluded).'))}</span></p>`);
  let derivedMode = false;
  let lastManualTitle = null;
  const readContent = () => String($content.val() || $content.text() || '');
  const syncTitle = () => {
    if (!derivedMode) return;
    const t = objectiveTitleOf(readContent(), '');
    const shown = t.length > FORM_TITLE_MAX ? `${t.slice(0, FORM_TITLE_MAX - 1)}…` : t;
    if ($title.val() !== shown) $title.val(shown);
  };
  const applyMode = (key) => {
    const on = key === 'O';
    if (on === derivedMode) {
      if (on) syncTitle();
      return;
    }
    derivedMode = on;
    if (on) {
      lastManualTitle = String($title.val() || '');
      $title.addClass('pts-derived').attr('readonly', 'readonly').attr('title', i18n('Filled automatically from the question text'));
      $title.closest('label').append($note);
      syncTitle();
    } else {
      $title.removeClass('pts-derived').removeAttr('readonly').removeAttr('title');
      $note.detach();
      if (lastManualTitle !== null && !$title.val()) $title.val(lastManualTitle);
    }
  };
  applyMode(init);
  $sel.find('input[name="pts-type"]').on('change', function onPickTitle() {
    applyMode(String($(this).val()));
  });
  $pid.on('input blur', () => {
    const k = currentKey();
    if (k) applyMode(k);
  });
  $('textarea[data-editor]').on('input keyup', () => syncTitle());
  const timer = setInterval(syncTitle, 700);
  $(window).on('unload', () => clearInterval(timer));
  // The form's own submit guard runs on the button click; refresh first.
  document.addEventListener('click', (ev) => {
    if (ev.target && ev.target.closest && ev.target.closest('[type="submit"]')) syncTitle();
  }, true);

  $pid.closest('form').on('submit', (ev) => {
    const picked = String($sel.find('input[name="pts-type"]:checked').val() || 'P');
    const k = currentKey();
    if (k !== picked) {
      ev.preventDefault();
      Notification.error(i18n('The problem ID must start with {0} for this problem type.').replace('{0}', `'${picked}'`));
      return;
    }
    if (picked === 'F') {
      syncFn();
      if (!String($fn.find('.ptsf__harness').val() || '').trim()) {
        ev.preventDefault();
        Notification.error(i18n('A function task needs its judge program — paste the complete program the student’s function is inserted into.'));
        return;
      }
    }
    if (derivedMode) {
      syncTitle();
      if (!String($title.val() || '').trim()) {
        ev.preventDefault();
        Notification.error(i18n('Write the question in the content first — the title of an objective task is derived from it.'));
      }
    }
  });
});
