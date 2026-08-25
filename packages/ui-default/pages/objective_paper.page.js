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
 * The paper does NOT submit. It is an answer sheet with memory: every
 * change is written to localStorage under a per-user, per-container key,
 * and restored on the next visit — close the tab, come back tomorrow,
 * the sheet is as you left it. (Programming code enjoys the same durability
 * natively via the scratchpad's editor reducer; standalone objective pages
 * via their IndexedDB answer cache.)
 */
import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
// This fork exposes the utilities through the vj/utils barrel — per-file
// paths like vj/utils/request do not exist here.
import { i18n, tpl } from 'vj/utils';
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
   * No submission from the paper: it is an answer sheet with memory.
   * Judging flows (per-problem pages, or whatever end-of-assessment
   * collection the course adopts) live elsewhere; nothing here posts.
   */
});
