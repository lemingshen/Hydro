import $ from 'jquery';
import Editor from 'vj/components/editor';
import Notification from 'vj/components/notification';
import {
  build, countBlanks, letterOf, MAX_ANSWERS_PER_BLANK, MAX_BLANKS, MAX_OPTIONS, parse, TASK_SCORE, answersYaml,
} from 'vj/components/problem/objectiveBuilder';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

/**
 * PTA fork — OBJECTIVE QUESTION BUILDER on the problem create / edit form.
 *
 * While the Objective type is selected (pid prefix `O`, see
 * problem_type_select.page.js) a form appears above the Markdown editor:
 * question type, the question text, the options / blanks and the correct
 * answer. Every change regenerates the task's Markdown into the editor
 * (markers + option list — the grammar the teacher no longer has to know)
 * and the answer key into a hidden `objectiveConfig` field, which the
 * server writes to config.yaml on save (handler/problem.ts). Opening an
 * existing objective task parses it back into the form; a task whose
 * content the builder cannot represent falls back to the plain editor.
 *
 * Logic lives in components/problem/objectiveBuilder.js; this file is DOM.
 */

const KINDS = [
  { key: 'blank', icon: '✎', name: 'Fill in the blank', desc: 'Students type the answer; exact match.' },
  { key: 'single', icon: '◉', name: 'Single choice', desc: 'One correct option.' },
  { key: 'multiple', icon: '☑', name: 'Multiple choice', desc: 'One or more correct options; partial credit for a subset.' },
  { key: 'tf', icon: '✓✗', name: 'True / False', desc: 'A statement to judge.' },
];

export default new NamedPage(['problem_create', 'problem_edit'], () => {
  const $pid = $('input[name="pid"]');
  const $field = $('textarea[name="content"]');
  const $form = $pid.closest('form');
  if (!$pid.length || !$field.length || !$form.length) return;
  const esc = (t) => $('<i>').text(String(t ?? '')).html();
  const tfLabels = () => [i18n('True'), i18n('False')];

  /* ------------------------------------------------------------------ */
  /*  content <-> editor plumbing                                         */
  /* ------------------------------------------------------------------ */
  const activeLang = () => $('[data-lang].tab--active').attr('data-lang') || $('[data-lang]').first().attr('data-lang') || 'en';
  /** The statement of the active language, whatever the storage shape. */
  const readContent = () => {
    const raw = String($field.val() || $field.text() || '');
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && !Array.isArray(j)) return String(j[activeLang()] ?? Object.values(j)[0] ?? '');
    } catch (e) { /* plain markdown */ }
    return raw;
  };
  /** Write the statement for the active language and mirror it into the editor. */
  const writeContent = (md) => {
    const raw = String($field.val() || $field.text() || '');
    let out = md;
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        j[activeLang()] = md;
        out = JSON.stringify(j);
      }
    } catch (e) { /* plain markdown */ }
    $field.val(out);
    $field.text(out);
    const ed = Editor.get($('textarea[data-editor]'));
    if (ed && ed.isValid) {
      try { if (ed.value() !== md) ed.value(md); } catch (e) { /* editor still booting */ }
    }
  };

  /* ------------------------------------------------------------------ */
  /*  state                                                               */
  /* ------------------------------------------------------------------ */
  const initial = window.UiContext && window.UiContext.objectiveAnswers;
  const initialMatching = window.UiContext && window.UiContext.objectiveMatching;
  let state = {
    type: 'single', stem: '', options: [{ text: '', correct: true }, { text: '', correct: false }], blankAnswers: [], matching: {}, tf: '', tfLabels: tfLabels(),
  };
  /** blankAnswers[k] is the list of accepted answers of blank k (never empty while editing). */
  const answersOf = (k) => {
    if (!Array.isArray(state.blankAnswers[k])) state.blankAnswers[k] = [];
    if (!state.blankAnswers[k].length) state.blankAnswers[k].push('');
    return state.blankAnswers[k];
  };
  let open = false; // the builder is driving the content
  let objectiveMode = false; // the Objective type is selected
  let unsupported = false; // existing content the builder cannot represent

  const $config = $('<input type="hidden" name="objectiveConfig">').appendTo($form);
  const $panel = $('<div class="oqb" id="oqb" hidden></div>');
  $('[data-lang]').first().closest('.section__tab-container').before($panel);
  const $langsRow = $('#pe-allowlangs-input').closest('.row');

  const render = () => {
    const kind = KINDS.find((k) => k.key === state.type) || KINDS[1];
    let h = '<div class="oqb__head">'
      + `<div class="oqb__title">🧩 ${esc(i18n('Question builder'))} <small>${esc(i18n('One task = one question, worth {0} points').replace('{0}', TASK_SCORE))}</small></div>`
      + `<button type="button" class="oqb__toggle" data-act="close">${esc(i18n('Write the Markdown by hand'))} ▸</button>`
      + '</div>';
    h += '<div class="oqb__types">';
    for (const k of KINDS) {
      h += `<label class="oqb__type${k.key === state.type ? ' is-on' : ''}"><input type="radio" name="oqb-kind" value="${k.key}"${k.key === state.type ? ' checked' : ''}>`
        + `<span class="oqb__type-icon">${k.icon}</span><span class="oqb__type-name">${esc(i18n(k.name))}</span></label>`;
    }
    h += '</div>';
    h += `<p class="oqb__desc">${esc(i18n(kind.desc))}</p>`;
    const stemLabel = state.type === 'tf' ? i18n('Statement') : i18n('Question');
    const stemHint = state.type === 'blank'
      ? i18n('Markdown is allowed. Type ____ where students should answer, or click "Insert blank".')
      : i18n('Markdown is allowed — code blocks, formulas and images work here too.');
    h += `<label class="oqb__label">${esc(stemLabel)} <small>${esc(stemHint)}</small></label>`;
    if (state.type === 'blank') {
      h += `<div class="oqb__tools"><button type="button" class="oqb__btn" data-act="insert-blank">＋ ${esc(i18n('Insert blank'))}</button>`
        + `<span class="oqb__muted">${esc(i18n('{0} blank(s)').replace('{0}', countBlanks(state.stem)))}</span></div>`;
    }
    h += `<textarea class="textbox oqb__stem" rows="4" placeholder="${esc(i18n('e.g. In C++, a `do-while` loop is guaranteed to execute its body at least once.'))}">${esc(state.stem)}</textarea>`;
    if (state.type === 'blank') {
      const n = countBlanks(state.stem);
      h += `<div class="oqb__sub">${esc(i18n('Accepted answers'))} <small>${esc(i18n('A blank is correct when the student\'s answer matches ANY of its accepted answers; the {0} points are split evenly over the blanks.').replace('{0}', TASK_SCORE))}</small></div>`;
      if (!n) h += `<p class="oqb__muted">${esc(i18n('No blank yet — click "Insert blank" or type ____ in the question.'))}</p>`;
      for (let k = 0; k < n; k++) {
        const list = answersOf(k);
        h += `<div class="oqb__blank"><div class="oqb__blank-head"><span class="oqb__letter">${k + 1}</span><span class="oqb__blank-title">${esc(i18n('Blank {0}').replace('{0}', k + 1))}</span>`
          + `<button type="button" class="oqb__btn oqb__btn--sm" data-act="add-ans" data-blank="${k}"${list.length >= MAX_ANSWERS_PER_BLANK ? ' disabled' : ''}>＋ ${esc(i18n('Add an accepted answer'))}</button></div>`;
        h += list.map((a, j) => `<div class="oqb__row oqb__row--ans">${j ? `<span class="oqb__or">${esc(i18n('or'))}</span>` : '<span class="oqb__or oqb__or--first">=</span>'}`
          + `<input class="textbox oqb__answer" data-blank="${k}" data-idx="${j}" placeholder="${esc(j ? i18n('Another accepted answer, e.g. <iostream>') : i18n('Expected answer for blank {0}').replace('{0}', k + 1))}" value="${esc(a)}">`
          + `<button type="button" class="oqb__del" data-act="del-ans" data-blank="${k}" data-idx="${j}" title="${esc(i18n('Remove'))}"${list.length <= 1 ? ' disabled' : ''}>×</button></div>`).join('');
        h += '</div>';
      }
      if (n) {
        h += `<div class="oqb__sub">${esc(i18n('Matching'))} <small>${esc(i18n('How the student\'s answer is compared with the accepted answers.'))}</small></div><div class="oqb__match">`
          + `<label class="oqb__flag${state.matching.ignoreCase ? ' is-on' : ''}"><input type="checkbox" name="oqb-match" value="ignoreCase"${state.matching.ignoreCase ? ' checked' : ''}> ${esc(i18n('Ignore case'))} <small>Iostream = iostream</small></label>`
          + `<label class="oqb__flag${state.matching.ignoreSpaces ? ' is-on' : ''}"><input type="checkbox" name="oqb-match" value="ignoreSpaces"${state.matching.ignoreSpaces ? ' checked' : ''}> ${esc(i18n('Ignore spaces'))} <small>x = 1 = x=1</small></label>`
          + '</div>';
      }
    } else if (state.type === 'tf') {
      const [t, f] = state.tfLabels;
      h += `<div class="oqb__sub">${esc(i18n('Correct answer'))}</div><div class="oqb__tf">`
        + `<label class="oqb__tfopt${state.tf === 'A' ? ' is-on' : ''}"><input type="radio" name="oqb-tf" value="A"${state.tf === 'A' ? ' checked' : ''}> ✓ ${esc(t)}</label>`
        + `<label class="oqb__tfopt${state.tf === 'B' ? ' is-on' : ''}"><input type="radio" name="oqb-tf" value="B"${state.tf === 'B' ? ' checked' : ''}> ✗ ${esc(f)}</label>`
        + '</div>';
    } else {
      const multi = state.type === 'multiple';
      h += `<div class="oqb__sub">${esc(i18n('Options'))} <small>${esc(multi ? i18n('Tick every correct option.') : i18n('Tick the correct option.'))} ${esc(i18n('Options are shown exactly as typed; wrap an option in backticks for code formatting.'))}</small></div>`;
      state.options.forEach((o, i) => {
        h += `<div class="oqb__row${o.correct ? ' is-correct' : ''}">`
          + `<label class="oqb__pick" title="${esc(i18n('Correct'))}"><input type="${multi ? 'checkbox' : 'radio'}" name="oqb-correct" value="${i}"${o.correct ? ' checked' : ''}></label>`
          + `<span class="oqb__letter">${letterOf(i)}</span>`
          + `<input class="textbox oqb__opt" data-opt="${i}" placeholder="${esc(i18n('Option {0}').replace('{0}', letterOf(i)))}" value="${esc(o.text)}">`
          + `<button type="button" class="oqb__del" data-act="del-opt" data-opt="${i}" title="${esc(i18n('Remove'))}"${state.options.length <= 2 ? ' disabled' : ''}>×</button>`
          + '</div>';
      });
      h += `<div class="oqb__tools"><button type="button" class="oqb__btn" data-act="add-opt"${state.options.length >= MAX_OPTIONS ? ' disabled' : ''}>＋ ${esc(i18n('Add option'))}</button></div>`;
    }
    const r = build(state);
    h += '<div class="oqb__foot">';
    if (r.issues.length) h += `<span class="oqb__status oqb__status--todo">○ ${esc(i18n(r.issues[0]))}</span>`;
    else h += `<span class="oqb__status oqb__status--ok">✓ ${esc(i18n('Ready — the Markdown and the answer key below are generated from this form.'))}</span>`;
    h += '</div>';
    $panel.html(h);
  };

  /** Push the generated Markdown + answer key out (editor, hidden fields). */
  const sync = () => {
    if (!open) return;
    const r = build(state);
    $config.val(r.issues.length ? '' : answersYaml(r.answers, r.matching));
    if (state.stem.trim() || (state.type !== 'blank' && state.type !== 'tf' && state.options.some((o) => o.text.trim()))) {
      if (readContent() !== r.markdown) writeContent(r.markdown);
    }
  };

  const $reopen = $(`<div class="oqb-reopen" hidden><button type="button" class="oqb__btn" data-act="reopen">🧩 ${esc(i18n('Open the question builder'))}</button>`
    + `<span class="oqb__muted"></span></div>`).insertAfter($panel);
  const $editorNote = $(`<p class="oqb-editor-note" hidden>✦ ${esc(i18n('Generated from the builder above — edits made directly in the editor are replaced while the builder is open.'))}</p>`);
  $('textarea[data-editor]').parent().before($editorNote);

  const setOpen = (v) => {
    open = v;
    $panel.attr('hidden', v ? null : 'hidden');
    $panel.toggleClass('is-open', v);
    $editorNote.attr('hidden', v ? null : 'hidden');
    $reopen.attr('hidden', (!v && objectiveMode) ? null : 'hidden');
    if (!v) $config.val('');
    else {
      render();
      sync();
    }
  };

  /** Load the current content into the form (when possible). */
  const loadFromContent = () => {
    const parsed = parse(readContent(), initial, initialMatching);
    unsupported = !parsed && /\{\{\s*(?:input|select|multiselect|textarea|dropdown)\(/.test(readContent());
    if (parsed) {
      state = { ...state, ...parsed };
      if (parsed.type === 'tf' && parsed.tfLabels) state.tfLabels = parsed.tfLabels;
      if ((parsed.type === 'single' || parsed.type === 'multiple') && !state.options.length) state.options = [{ text: '', correct: true }, { text: '', correct: false }];
      return true;
    }
    return false;
  };

  const enterObjective = () => {
    objectiveMode = true;
    $langsRow.attr('hidden', 'hidden');
    const ok = loadFromContent();
    $reopen.find('.oqb__muted').text(unsupported ? i18n('This task uses a format the builder cannot edit (free text or dropdown); edit the Markdown directly.') : '');
    setOpen(ok || !unsupported);
    if (!ok && !unsupported) {
      // A fresh task: the programming template is not a question — replace
      // it as soon as the teacher writes anything in the builder.
      state.stem = '';
    }
  };
  const leaveObjective = () => {
    objectiveMode = false;
    $langsRow.attr('hidden', null);
    $reopen.attr('hidden', 'hidden');
    setOpen(false);
  };

  const currentKey = () => {
    const c = String($pid.val() || '').charAt(0).toUpperCase();
    return ['P', 'O', 'S'].includes(c) ? c : 'P';
  };
  const applyKey = (k) => {
    if (k === 'O' && !objectiveMode) enterObjective();
    else if (k !== 'O' && objectiveMode) leaveObjective();
  };

  /* ------------------------------------------------------------------ */
  /*  events                                                              */
  /* ------------------------------------------------------------------ */
  $panel.on('change', 'input[name="oqb-kind"]', function onKind() {
    const t = String($(this).val());
    if (t === state.type) return;
    state.type = t;
    if (t === 'tf') {
      state.tfLabels = tfLabels();
      if (!state.tf) state.tf = 'A';
    }
    if ((t === 'single' || t === 'multiple') && state.options.length < 2) state.options = [{ text: '', correct: true }, { text: '', correct: false }];
    if (t === 'single') { // keep at most one tick
      let seen = false;
      state.options = state.options.map((o) => {
        const c = o.correct && !seen;
        if (o.correct) seen = true;
        return { ...o, correct: c };
      });
      if (!state.options.some((o) => o.correct)) state.options[0].correct = true;
    }
    render(); sync();
  });
  $panel.on('input', '.oqb__stem', function onStem() {
    const before = countBlanks(state.stem);
    state.stem = String($(this).val());
    sync();
    if (state.type === 'blank' && countBlanks(state.stem) !== before) {
      const pos = this.selectionStart;
      render();
      const el = $panel.find('.oqb__stem')[0];
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    }
  });
  $panel.on('input', '.oqb__opt', function onOpt() {
    state.options[+$(this).data('opt')].text = String($(this).val());
    sync();
    $panel.find('.oqb__status').replaceWith($(render.status()));
  });
  $panel.on('input', '.oqb__answer', function onAns() {
    answersOf(+$(this).data('blank'))[+$(this).data('idx')] = String($(this).val());
    sync();
    $panel.find('.oqb__status').replaceWith($(render.status()));
  });
  $panel.on('change', 'input[name="oqb-match"]', function onMatch() {
    state.matching[String($(this).val())] = this.checked;
    render();
    sync();
  });
  $panel.on('change', 'input[name="oqb-correct"]', function onCorrect() {
    const i = +$(this).val();
    if (state.type === 'single') state.options.forEach((o, k) => { o.correct = k === i; });
    else state.options[i].correct = this.checked;
    render(); sync();
  });
  $panel.on('change', 'input[name="oqb-tf"]', function onTf() {
    state.tf = String($(this).val());
    render(); sync();
  });
  $panel.on('click', '[data-act]', function onAct(ev) {
    ev.preventDefault();
    const act = $(this).data('act');
    if (act === 'add-opt') {
      if (state.options.length >= MAX_OPTIONS) return;
      state.options.push({ text: '', correct: false });
      render(); sync();
      $panel.find('.oqb__opt').last().trigger('focus');
    } else if (act === 'del-opt') {
      if (state.options.length <= 2) return;
      state.options.splice(+$(this).data('opt'), 1);
      if (state.type === 'single' && !state.options.some((o) => o.correct)) state.options[0].correct = true;
      render(); sync();
    } else if (act === 'add-ans') {
      const k = +$(this).data('blank');
      if (answersOf(k).length >= MAX_ANSWERS_PER_BLANK) return;
      answersOf(k).push('');
      render();
      sync();
      $panel.find(`.oqb__answer[data-blank="${k}"]`).last().trigger('focus');
    } else if (act === 'del-ans') {
      const k = +$(this).data('blank');
      if (answersOf(k).length <= 1) return;
      answersOf(k).splice(+$(this).data('idx'), 1);
      render();
      sync();
    } else if (act === 'insert-blank') {
      if (countBlanks(state.stem) >= MAX_BLANKS) {
        Notification.warn(i18n('At most {0} blanks per task.').replace('{0}', MAX_BLANKS));
        return;
      }
      const el = $panel.find('.oqb__stem')[0];
      const s = el ? el.selectionStart : state.stem.length;
      const e = el ? el.selectionEnd : state.stem.length;
      // Pad the blank with spaces only where the text has none.
      const before = state.stem.slice(0, s);
      const after = state.stem.slice(e);
      const token = `${before && !/\s$/.test(before) ? ' ' : ''}____${after && !/^\s/.test(after) ? ' ' : ''}`;
      state.stem = before + token + after;
      render(); sync();
      const el2 = $panel.find('.oqb__stem')[0];
      if (el2) {
        el2.focus();
        el2.setSelectionRange(s + token.length, s + token.length);
      }
    } else if (act === 'close') {
      setOpen(false);
    }
  });
  $reopen.on('click', '[data-act="reopen"]', (ev) => {
    ev.preventDefault();
    loadFromContent();
    setOpen(true);
  });
  // Only the status line changes while typing an option / answer.
  render.status = () => {
    const r = build(state);
    return r.issues.length
      ? `<span class="oqb__status oqb__status--todo">○ ${esc(i18n(r.issues[0]))}</span>`
      : `<span class="oqb__status oqb__status--ok">✓ ${esc(i18n('Ready — the Markdown and the answer key below are generated from this form.'))}</span>`;
  };

  // Type selection: the cards (problem_type_select.page.js) and the pid box.
  $(document).on('change', 'input[name="pts-type"]', function onType() { applyKey(String($(this).val())); });
  $pid.on('input blur', () => applyKey(currentKey()));
  setTimeout(() => applyKey(currentKey()), 0);

  // Save: an open builder must be complete, and its output must be current.
  $form.on('submit', (ev) => {
    if (!objectiveMode || !open) return;
    const r = build(state);
    if (r.issues.length) {
      ev.preventDefault();
      Notification.error(`${i18n('The question is not complete yet')}: ${i18n(r.issues[0])}`);
      $panel[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    writeContent(r.markdown);
    $config.val(answersYaml(r.answers, r.matching));
  });
});
