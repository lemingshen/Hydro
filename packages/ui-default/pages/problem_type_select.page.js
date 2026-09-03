import $ from 'jquery';
import Notification from 'vj/components/notification';
import { objectiveTitleOf } from 'vj/components/problem/objectiveTitle';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n } from 'vj/utils';

/**
 * Problem-type selector on the create/edit pages. The teacher picks the type
 * FIRST — Programming / Objective / Subjective — via three full-width cards
 * above the form; the pid is kept prefixed with 'P' / 'O' / 'S' accordingly
 * (the prefix is the site-wide authority for how a problem is treated).
 * Submission is blocked on a mismatch.
 */

const TYPES = [
  {
    key: 'P', color: '#1c7ed6', tint: '#e8f2fd', darkTint: '#152a40', name: 'Programming',
    desc: 'Judged by the OJ: students code in the online IDE and submit for automatic testing.',
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
  '.pts__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }',
  '@media (max-width: 780px) { .pts__grid { grid-template-columns: 1fr; } }',
  '.ptsc { display: block; cursor: pointer; margin: 0; animation: ptaFadeUp .28s var(--pta-ease) backwards; }',
  '.ptsc:nth-of-type(2) { animation-delay: .06s; }',
  '.ptsc:nth-of-type(3) { animation-delay: .12s; }',
  '.ptsc input { position: absolute; opacity: 0; pointer-events: none; }',
  '.ptsc__body { display: block; position: relative; border: 1.5px solid var(--pta-line); border-radius: 12px; background: var(--pta-card); padding: 13px 15px 12px; height: 100%; box-sizing: border-box; transition: border-color .15s, box-shadow .15s, background .15s, transform .15s var(--pta-ease); }',
  '.ptsc:hover .ptsc__body { border-color: var(--pta-blue-line); box-shadow: var(--pta-shadow-hover); transform: translateY(-2px); }',
  '.ptsc input:focus-visible + .ptsc__body { outline: 2px solid #4c6ef5; outline-offset: 2px; }',
  '.ptsc__row { display: flex; align-items: center; gap: 9px; margin-bottom: 6px; }',

  '.ptsc__name { font-weight: bold; font-size: 13.5px; color: var(--pta-ink); }',
  '.ptsc__key { font: bold 11px/1 ui-monospace, Consolas, monospace; color: #fff; border-radius: 6px; padding: 3px 7px; letter-spacing: .04em; }',
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
  '.pta-dark .ptsc input[value="P"]:checked + .ptsc__body { background: #152a40; }',
  '.pta-dark .ptsc input[value="O"]:checked + .ptsc__body { background: #0f2f26; }',
  '.pta-dark .ptsc input[value="S"]:checked + .ptsc__body { background: #251d3d; }',
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
    return ['P', 'O', 'S'].includes(c) ? c : null;
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

  const applyPrefix = (key) => {
    const v = String($pid.val() || '');
    if (!v) {
      $pid.val(key);
      return;
    }
    const first = v.charAt(0).toUpperCase();
    if (['P', 'O', 'S'].includes(first)) {
      if (first !== key) $pid.val(key + v.slice(1));
    } else $pid.val(key + v);
  };

  $sel.find('input[name="pts-type"]').on('change', function onPick() {
    applyPrefix(String($(this).val()));
  });

  $pid.on('input blur', () => {
    const k = currentKey();
    if (k) $sel.find(`input[value="${k}"]`).prop('checked', true);
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
    if (derivedMode) {
      syncTitle();
      if (!String($title.val() || '').trim()) {
        ev.preventDefault();
        Notification.error(i18n('Write the question in the content first — the title of an objective task is derived from it.'));
      }
    }
  });
});
