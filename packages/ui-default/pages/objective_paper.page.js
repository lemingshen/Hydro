/*
 * Combined objective paper (contest_paper / homework_paper /
 * training_paper / self_learning_paper).
 *
 * Each .paper-q section holds ONE task's rendered statement. This script
 * replays the single-problem objective renderer per section — markers
 * become inputs, option ULs become radio/checkbox groups — but everything
 * is namespaced by the section's docId, because after the one-question-
 * per-task split every task's marker is (1) and bare names/anchors would
 * collide across sections.
 *
 * Test/Homework papers do NOT submit. They are answer sheets with memory:
 * every change is written to localStorage under a per-user, per-container
 * key, and restored on the next visit — close the tab, come back tomorrow,
 * the sheet is as you left it. (Programming code enjoys the same durability
 * natively via the scratchpad's editor reducer.) The SELF-LEARNING paper
 * additionally submits per question and polls the verdict inline (legacy
 * sessions only — new sessions are programming-only). No paper mounts an
 * AI tutor: the tutor is a programming-only feature.
 */
import $ from 'jquery';
import * as yaml from 'js-yaml';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
// This fork exposes the utilities through the vj/utils barrel — per-file
// paths like vj/utils/request do not exist here.
import { i18n, request, tpl } from 'vj/utils';
// The fixed-left problems rail is auto_scratchpad's component; the handler
// ships UiContext.paperRail and this export mounts it.
import { injectRailForPage } from 'vj/pages/auto_scratchpad.page';

const MARKER_G = /\{\{ (input|select|multiselect|textarea|dropdown)\((\d+(?:-\d+)?)\)(?:\[([^\]]*)\])? \}\}/g;

function renderSection($sec, ans) {
  const docId = $sec.data('docid');
  $sec.find('.paper-q__content').children().each((i, e) => {
    if (e.tagName === 'PRE' && !e.children[0]?.className.includes('#input')) return;
    const found = [];
    let m;
    MARKER_G.lastIndex = 0;
    while (m = MARKER_G.exec(e.textContent)) found.push([...m]); // eslint-disable-line no-cond-assign
    for (const [info, type, qid, options] of found) {
      const name = `${docId}:${qid}`;
      if (type === 'input') {
        $(e).html($(e).html().replace(info, tpl`<span class="paper-blank"><input type="text" name="${name}" data-doc="${docId}" data-q="${qid}" class="textbox objective-input"></span>`));
      } else if (type === 'textarea') {
        $(e).html($(e).html().replace(info, tpl`<div class="paper-area"><textarea name="${name}" data-doc="${docId}" data-q="${qid}" class="textbox objective-input"></textarea></div>`));
      } else if (type === 'dropdown') {
        const opts = (options || '').split(',').map((s) => s.trim()).filter(Boolean);
        $(e).html($(e).html().replace(info, tpl`<span class="select-container paper-dd"><select name="${name}" data-doc="${docId}" data-q="${qid}" class="objective-input select"><option value=""></option>${{ templateRaw: true, html: opts.map((o) => tpl`<option value="${o}">${o}</option>`).join('') }}</select></span>`));
      } else {
        const $ul = $(e).next('ul');
        if (!$ul.length) continue;
        $(e).html($(e).html().replace(info, ''));
        $ul.children().each((j, ele) => {
          const letter = String.fromCharCode(65 + j);
          $(ele).after(tpl`<label class="radiobox paper-opt"><input type="${type === 'select' ? 'radio' : 'checkbox'}" name="${name}" data-doc="${docId}" data-q="${qid}" class="objective-input" value="${letter}"> ${letter}. ${{ templateRaw: true, html: ele.innerHTML }}</label>`);
          $(ele).remove();
        });
      }
    }
  });
  ans[docId] = ans[docId] || {};
}

export default new NamedPage(['contest_paper', 'homework_paper', 'self_learning_paper'], () => {
  const key = window.UiContext.paperKey || window.UiContext.paperTid;
  const ans = {}; // ans[docId] = { qid: value }
  const storeKey = `paper/${window.UserContext._id}/${key}`;
  // Durable memory: localStorage survives closing the tab and the browser.
  // Earlier builds kept drafts in sessionStorage; migrate one silently so
  // nobody loses an in-flight sheet on the day this ships.
  try {
    if (!localStorage.getItem(storeKey) && sessionStorage.getItem(storeKey)) {
      localStorage.setItem(storeKey, sessionStorage.getItem(storeKey));
    }
  } catch (e) { /* private mode */ }

  $('.paper-q').each((i, sec) => renderSection($(sec), ans));

  // pid lookup for rail interactions (chips are keyed by pid, sections by docId)
  const pidOf = {};
  for (const t of (window.UiContext.paperTasks || [])) pidOf[t.docId] = String(t.pid);
  injectRailForPage();

  // restore drafts typed earlier in this browser
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || '{}');
    for (const [doc, m] of Object.entries(saved)) {
      for (const [qid, val] of Object.entries(m)) {
        const $inp = $(`[data-doc="${doc}"][data-q="${qid}"]`);
        if (!$inp.length) continue;
        if (Array.isArray(val)) val.forEach((v) => $inp.filter(`[value="${v}"]`).prop('checked', true));
        else if ($inp.is(':radio')) $inp.filter(`[value="${val}"]`).prop('checked', true);
        else $inp.val(val);
        (ans[doc] = ans[doc] || {})[qid] = val;
      }
    }
  } catch (e) { /* fresh start */ }

  let savedFlash;
  const persist = () => {
    try { localStorage.setItem(storeKey, JSON.stringify(ans)); } catch (e) { return; }
    const $s = $('.paper-top__saved');
    if (!$s.length) return;
    $s.text(`✓ ${i18n('Saved')}`).addClass('paper-top__saved--on');
    clearTimeout(savedFlash);
    savedFlash = setTimeout(() => $s.removeClass('paper-top__saved--on'), 1200);
  };
  const markState = () => { /* the rail carries status; answered-dots retired with the old sidebar */ };
  Object.keys(ans).forEach(markState);

  $(document).on('input change', '.objective-input', function onAnswer() {
    const doc = $(this).data('doc');
    const qid = String($(this).data('q'));
    const map = (ans[doc] = ans[doc] || {});
    if ($(this).is(':checkbox')) {
      map[qid] = $(`.objective-input[data-doc="${doc}"][data-q="${qid}"]:checked`).map(function v() { return $(this).val(); }).get().sort();
      if (!map[qid].length) delete map[qid];
    } else {
      const v = String($(this).val() || '');
      if (v) map[qid] = v; else delete map[qid];
    }
    persist();
    markState(doc);
  });

  // sidebar highlights the section in view
  const spy = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const pid = pidOf[$(en.target).data('docid')];
      if (!pid) continue;
      $('#sl-rail .sl-rail__chip.current').removeClass('current');
      $(`#sl-rail .sl-rail__chip[data-pid="${pid}"]`).addClass('current');
    }
  }, { rootMargin: '-45px 0px -70% 0px' });
  $('.paper-q').each((i, el) => spy.observe(el));

  /*
   * Test/Homework papers stay pure answer sheets: their judging story lives
   * with the assessment. The SELF-LEARNING paper is different — it is the
   * primary answering surface for a (legacy) session's objective tasks
   * (the solve route redirects here), so below it gains per-question
   * submission and verdict polling, wired to the per-task solve/record
   * endpoints the handler ships. There is no tutor here: the AI tutor is
   * programming-only.
   */
  if (window.UiContext.paperCanSubmit) initSelfLearningAnswering();

  function initSelfLearningAnswering() {
    const tasks = window.UiContext.paperTasks || [];
    const taskByDoc = {};
    for (const t of tasks) taskByDoc[t.docId] = t;
    /* ------------------- per-question submit + verdict ------------------- */

    const POLL_INTERVAL = 1500;
    const MAX_POLLS = 60;
    const setStatus = (docId, cls, text) => {
      $(`.paper-q__status[data-status-for="${docId}"]`).attr('class', `paper-q__status on ${cls}`).text(text);
    };
    const setHint = (docId, text) => $(`[data-hint-for="${docId}"]`).text(text || '');
    // Objective judging keys each question's case as `${subtaskId}` or
    // `${subtaskId}-${id}` — the same id space as the inputs' data-q.
    const caseKeyOf = (c) => {
      if (c.subtaskId === undefined || c.subtaskId === null) return null;
      return (c.id === undefined || c.id === null) ? `${c.subtaskId}` : `${c.subtaskId}-${c.id}`;
    };

    // Questions handed in before this page load: while the verdict is
    // withheld the card says so instead of looking untouched.
    if (window.UiContext.paperWithheld) {
      for (const t of tasks) if (t.submitted) setStatus(t.docId, 'pending', i18n('Submitted — scored after the deadline'));
    }

    function markQuestions(docId, data) {
      const $sec = $(`#q-${docId}`);
      $sec.find('.paper-mk--pass, .paper-mk--fail, .paper-mk--partial')
        .removeClass('paper-mk--pass paper-mk--fail paper-mk--partial');
      if (!data || !data.cases) return;
      for (const c of data.cases) {
        const qkey = caseKeyOf(c);
        if (!qkey) continue;
        const cls = c.status === 1 ? 'paper-mk--pass' : (/partial/i.test(c.message || '') ? 'paper-mk--partial' : 'paper-mk--fail');
        $sec.find(`.objective-input[data-q="${qkey}"]`).each(function markOne() {
          const $wrap = $(this).closest('.paper-opt, .paper-blank, .paper-dd, .paper-area');
          ($wrap.length ? $wrap : $(this)).addClass(cls);
        });
      }
    }

    async function pollRecord(task, rid, latePct) {
      for (let i = 0; i < MAX_POLLS; i++) {
        let data;
        try {
          data = await request.get(`${task.recordUrl}?rid=${rid}`);
        } catch (e) {
          Notification.error(e.message);
          return null;
        }
        const score = (data.judged && data.score !== undefined && data.score !== null) ? ` · ${data.score}` : '';
        // During the late window the chip is honest about the reduced value.
        // Per-submission truth from the solve POST beats the page-load
        // snapshot: the deadline may have passed while this tab sat open.
        const pct = (latePct !== undefined) ? latePct : (window.UiContext.paperPenalty || 0);
        const eff = (pct && data.judged && data.score !== undefined && data.score !== null)
          ? ` → ${Math.round((data.score * (100 - pct)) / 100)}` : '';
        const lateTag = (data.judged && pct) ? ` · −${pct}% ${i18n('late')}${eff}` : '';
        setStatus(task.docId, data.judged ? (data.accepted ? 'pass' : 'fail') : 'pending', `${data.statusText || ''}${score}${lateTag}`);
        if (data.judged) return data;
        await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL); });
      }
      Notification.warn(i18n('Judging is taking longer than expected. Please check the record list.'));
      return null;
    }

    const answeredKeys = (docId) => Object.keys(ans[docId] || {}).filter((k) => {
      const v = ans[docId][k];
      return Array.isArray(v) ? v.length : (v !== undefined && v !== null && String(v).trim());
    });

    /**
     * Test / Homework: "Save All" hands in every answered task in one go.
     * Each task is still its own submission (the record the evaluation grades
     * after the deadline); verdicts stay withheld, so the cards only confirm.
     */
    const $saveAll = $('#paper-save-all');
    const saveText = (t) => $('#paper-savebar-text').text(t);
    const refreshSaveBar = () => {
      if (!$saveAll.length) return;
      const answered = tasks.filter((t) => answeredKeys(t.docId).length).length;
      saveText(`${answered} / ${tasks.length} ${i18n('answered')} — ${i18n('save to hand them in; scored after the deadline.')}`);
    };
    refreshSaveBar();
    $(document).on('change input', '.objective-input', () => setTimeout(refreshSaveBar, 0));
    if ($saveAll.length) {
      $saveAll.on('click', async () => {
      const todo = tasks.filter((t) => t.submitUrl && answeredKeys(t.docId).length);
      if (!todo.length) {
        Notification.warn(i18n('Please answer at least one question before submitting.'));
        return;
      }
      $saveAll.prop('disabled', true).addClass('is-busy');
      let ok = 0;
      const failed = [];
      for (const task of todo) {
        setHint(task.docId, i18n('Submitting...'));
        setStatus(task.docId, 'pending', i18n('Waiting'));
        try {
          await request.post(task.submitUrl, { lang: '_', code: yaml.dump(ans[task.docId]) }); // eslint-disable-line no-await-in-loop
          ok += 1;
          setHint(task.docId, '');
          markQuestions(task.docId, null);
          setStatus(task.docId, 'pending', i18n('Submitted — scored after the deadline'));
          if (window.__ptaRailMark) window.__ptaRailMark(String(task.pid), false, true);
        } catch (e) {
          failed.push(task);
          setHint(task.docId, e.message || i18n('Failed'));
          setStatus(task.docId, 'fail', i18n('Not saved'));
        }
      }
      $saveAll.prop('disabled', false).removeClass('is-busy');
      const unanswered = tasks.length - todo.length;
      if (failed.length) Notification.error(`${i18n('Saved {0} answer(s); {1} could not be saved — try again.').replace('{0}', ok).replace('{1}', failed.length)}`);
      else Notification.success(`${i18n('Saved {0} answer(s).').replace('{0}', ok)}${unanswered ? ` ${i18n('{0} question(s) still unanswered.').replace('{0}', unanswered)}` : ''}`);
      saveText(`${i18n('Last saved')} ${new Date().toLocaleTimeString()} — ${ok} / ${tasks.length} ${i18n('handed in')}`);
      });
    }

    if (window.UiContext.paperCanSubmit) $(document).on('click', '.paper-submit', async function onPaperSubmit() {
      const docId = $(this).data('doc');
      const task = taskByDoc[docId];
      // Test / Homework papers carry no record URL: their verdicts are
      // withheld until the deadline, so the answer is posted and confirmed
      // without polling. Only the self-learning paper polls its record.
      if (!task || !task.submitUrl) return;
      const m = ans[docId] || {};
      const filled = Object.keys(m).filter((k) => {
        const v = m[k];
        return Array.isArray(v) ? v.length : (v !== undefined && v !== null && String(v).trim());
      });
      if (!filled.length) {
        Notification.warn(i18n('Please answer at least one question before submitting.'));
        return;
      }
      const $btn = $(this).prop('disabled', true);
      setHint(docId, i18n('Submitting...'));
      setStatus(docId, 'pending', i18n('Waiting'));
      try {
        const res = await request.post(task.submitUrl, { lang: '_', code: yaml.dump(m) });
        setHint(docId, '');
        markQuestions(docId, null);
        if (!task.recordUrl) {
          setStatus(docId, 'pending', i18n('Submitted — scored after the deadline'));
          if (window.__ptaRailMark) window.__ptaRailMark(String(task.pid), false, true);
          Notification.success(i18n('Answer submitted.'));
          return;
        }
        const data = await pollRecord(task, res.rid, res.late ? (res.penalty || 0) : 0);
        if (!data) return;
        markQuestions(docId, data);
        if (window.__ptaRailMark) window.__ptaRailMark(String(task.pid), !!data.accepted);
        if (data.accepted) Notification.success(i18n('Accepted! Great job!'));
      } catch (e) {
        Notification.error(e.message);
        setHint(docId, '');
      } finally {
        $btn.prop('disabled', false);
      }
    });
  }
});
