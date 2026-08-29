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
import * as yaml from 'js-yaml';
import MarkdownIt from 'markdown-it';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
// This fork exposes the utilities through the vj/utils barrel — per-file
// paths like vj/utils/request do not exist here.
import { i18n, request, tpl } from 'vj/utils';
// Spark celebration kit + achievements popover, shared with the solve and
// record pages (same import precedent as self_learning_record.page.js).
import {
  confettiBurst, ensureSparkStyle, openSparkPopover, showBadgeToasts, sparkChipText,
} from 'vj/pages/self_learning_solve.page';
// The fixed-left problems rail is auto_scratchpad's component; the handler
// ships UiContext.paperRail and this export mounts it.
import { injectRailForPage } from 'vj/pages/auto_scratchpad.page';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

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
   * primary answering surface for the session's objective tasks (the solve
   * route redirects here), so below it gains per-question submission,
   * verdicts, and the floating Socratic tutor with Spark + Boss Challenge,
   * wired to the per-task solve/record/tutor endpoints the handler ships.
   */
  // Tutoring stays available for review even after the session's submission
  // window closes — only the submit wiring is gated on paperCanSubmit.
  if (window.UiContext.paperCanSubmit || window.UiContext.slTutor) initSelfLearningAnswering();

  function initSelfLearningAnswering() {
    const tasks = window.UiContext.paperTasks || [];
    const taskByDoc = {};
    for (const t of tasks) taskByDoc[t.docId] = t;
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

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

    if (window.UiContext.paperCanSubmit) $(document).on('click', '.paper-submit', async function onPaperSubmit() {
      const docId = $(this).data('doc');
      const task = taskByDoc[docId];
      if (!task || !task.recordUrl) return;
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
        const data = await pollRecord(task, res.rid, res.late ? (res.penalty || 0) : 0);
        if (!data) return;
        markQuestions(docId, data);
        if (window.__ptaRailMark) window.__ptaRailMark(String(task.pid), !!data.accepted);
        if (data.accepted) {
          Notification.success(i18n('Accepted! Great job!'));
          await tutor.onAccepted(task, res.rid);
        } else {
          // A failed submission launches the Socratic tutor for THIS question.
          await tutor.onFailed(task, res.rid);
        }
      } catch (e) {
        Notification.error(e.message);
        setHint(docId, '');
      } finally {
        $btn.prop('disabled', false);
      }
    });

    /* --------------- floating Socratic tutor (per-question) --------------- */

    const tutor = buildPaperTutor();

    function buildPaperTutor() {
      if (!window.UiContext.slTutor || !tasks.some((t) => t.tutorUrl)) {
        return { onAccepted: async () => {}, onFailed: async () => {} };
      }
      ensureSparkStyle();
      const PLACEHOLDER0 = i18n('Explain your thinking, answer the tutor, or ask for guidance... (Enter to send)');
      const $fab = $(`<button class="sl-fab" id="paper-fab" type="button" title="${esc(i18n('AI Socratic Tutor'))}">🤖<span class="sl-fab__dot" style="display:none"></span></button>`)
        .appendTo(document.body);
      const $fabDot = $fab.find('.sl-fab__dot');
      const $panel = $(`<div class="sl-float" id="paper-tutor" style="display:none">
        <div class="sl-float__header">
          <span class="sl-float__title">🤖 ${esc(i18n('AI Socratic Tutor'))}</span>
          <span class="sl-float__qtag" id="paper-qtag" style="display:none"></span>
          <button id="sl-spark-chip" class="sl-spark-chip" type="button" title="${esc(i18n('My progress'))}" style="display:none"></button>
          <span class="sl-float__actions"><button type="button" class="sl-hbtn" id="paper-tutor-close" title="×">×</button></span>
        </div>
        <div class="sl-chat" id="paper-chat"></div>
        <div class="sl-typing" id="paper-typing" style="display:none">${esc(i18n('The tutor is thinking...'))}</div>
        <div class="sl-input-row">
          <textarea id="paper-tutor-input" class="textbox" placeholder="${esc(PLACEHOLDER0)}"></textarea>
          <button id="paper-tutor-send" class="rounded primary button" type="button">${esc(i18n('Send'))}</button>
        </div>
      </div>`).appendTo(document.body);
      const $chat = $panel.find('#paper-chat');
      const $typing = $panel.find('#paper-typing');
      const $input = $panel.find('#paper-tutor-input');
      const $qtag = $panel.find('#paper-qtag');

      let panelOpen = false;
      let waiting = false;
      let active = null;
      let sparkState = null;
      let sparkCatalog = [];
      const ctxByDoc = {};
      const ctxOf = (t) => ctxByDoc[t.docId] || (ctxByDoc[t.docId] = {
        started: false, chMode: false, chHistory: [], challengeInfo: null,
      });

      const scrollChat = () => { $chat.scrollTop($chat[0].scrollHeight); };
      const emptyText = () => {
        $chat.empty().append(`<div class="sl-empty">${esc(i18n('Submit your solution first — the tutor starts from a judged attempt.'))}</div>`);
      };
      const setTyping = (on) => {
        waiting = on;
        $typing.toggle(on);
        $panel.find('#paper-tutor-send').prop('disabled', on);
      };
      const appendDivider = (text, ok = false) => {
        $chat.find('.sl-empty').remove();
        $chat.append(`<div class="sl-divider${ok ? ' accepted' : ''}"><span>${esc(text)}</span></div>`);
        scrollChat();
      };
      const appendBubble = (role, content) => {
        $chat.find('.sl-empty').remove();
        const $m = $(`<div class="sl-msg ${role === 'user' ? 'user' : 'assistant'}"><div class="sl-bubble"></div></div>`);
        const $b = $m.find('.sl-bubble');
        if (role === 'user') $b.html(esc(content).replace(/\n/g, '<br>'));
        else {
          $b.html(md.render(String(content || '')));
          import('vj/components/highlighter/prismjs')
            .then(({ default: prism }) => prism.highlightBlocks($m))
            .catch(() => { /* highlighting is optional */ });
          if (!panelOpen) $fabDot.show();
        }
        $chat.append($m);
        scrollChat();
      };
      const renderMessages = (messages) => {
        $chat.empty();
        if (!messages || !messages.length) { emptyText(); return; }
        for (const m of messages) {
          if (m.kind === 'attempt') appendDivider(m.content);
          else if (m.kind === 'accepted') appendDivider(m.content, true);
          else appendBubble(m.role, m.content);
        }
      };
      const absorbSpark = (res, c) => {
        if (!res) return;
        if (res.badgeCatalog) sparkCatalog = res.badgeCatalog;
        if (res.spark) {
          sparkState = res.spark;
          $('#sl-spark-chip').text(sparkChipText(sparkState)).show();
        }
        if (res.newBadges && res.newBadges.length) showBadgeToasts(res.newBadges);
        if (res.challenge && c) c.challengeInfo = res.challenge;
      };
      $(document).on('click', '#sl-spark-chip', function onSparkChip() {
        openSparkPopover(sparkState, sparkCatalog, this);
      });

      const exitChallengeUi = () => {
        $('#paper-chexit').remove();
        $input.attr('placeholder', PLACEHOLDER0);
      };
      const enterChallengeUi = () => {
        if ($('#paper-chexit').length) return;
        const $bar = $(`<div class="sl-chbar" id="paper-chexit">🔥 ${esc(i18n('Boss Challenge mode'))} <a href="javascript:;">${esc(i18n('Exit challenge'))}</a></div>`);
        $bar.find('a').on('click', () => {
          if (active) ctxOf(active).chMode = false;
          exitChallengeUi();
        });
        $typing.before($bar);
        $input.attr('placeholder', i18n('Type your challenge answer... (Enter to send)'));
      };

      async function setActive(task, { load = true } = {}) {
        active = task;
        const c = ctxOf(task);
        $qtag.text(`Q${task.index}`).show();
        exitChallengeUi();
        if (!load) { $chat.empty(); return c; }
        setTyping(true);
        try {
          const res = await request.get(task.tutorUrl);
          absorbSpark(res, c);
          renderMessages(res.messages);
          if (res.messages && res.messages.length) c.started = true;
          if (c.chMode) enterChallengeUi();
          else if (c.challengeInfo && c.challengeInfo.state === 'active') offerChallenge(task, null);
        } catch (e) {
          renderMessages([]);
        } finally {
          setTyping(false);
        }
        return c;
      }

      const openPanel = () => {
        panelOpen = true;
        $panel.show();
        $fab.hide();
        $fabDot.hide();
        scrollChat();
        $input.trigger('focus');
      };
      const closePanel = () => {
        panelOpen = false;
        $panel.hide();
        $fab.show();
      };
      $fab.on('click', async () => {
        if (!active) {
          const first = tasks.find((t) => t.tutorUrl);
          if (first) await setActive(first);
          else return;
        }
        openPanel();
      });
      $panel.find('#paper-tutor-close').on('click', closePanel);

      function offerChallenge(task, ch) {
        const c = ctxOf(task);
        if (ch) c.challengeInfo = ch;
        const info = c.challengeInfo;
        if (!info || !info.available) return;
        $chat.find('.sl-choffer').remove();
        const resume = info.state === 'active';
        const $row = $(`<div class="sl-choffer">🔥 <b>${esc(i18n('Boss Challenge'))}</b> — ${esc(i18n(resume ? 'You have an unfinished Boss Challenge.' : 'Feeling brave? Beat one extra twist of this problem.'))}
          <span class="sl-choffer__btns"><button type="button" class="sl-chaccept">${esc(i18n(resume ? 'Resume the challenge' : 'Accept the challenge'))} 🔥</button>${resume ? '' : `<button type="button" class="sl-chlater">${esc(i18n('Maybe later'))}</button>`}</span></div>`);
        $chat.append($row);
        scrollChat();
        if (!panelOpen) $fabDot.show();
        $row.find('.sl-chaccept').on('click', () => startChallenge(task, $row));
        $row.find('.sl-chlater').on('click', async () => {
          c.challengeInfo = { state: 'declined' };
          $row.remove();
          try { await request.post(task.tutorUrl, { operation: 'challengeDecline' }); } catch (e) { /* best-effort */ }
        });
      }

      async function startChallenge(task, $row) {
        if (waiting) return;
        const c = ctxOf(task);
        setTyping(true);
        try {
          const res = await request.post(task.tutorUrl, { operation: 'challenge' });
          if ($row) $row.remove();
          c.chMode = true;
          c.chHistory = [];
          appendDivider(`🔥 ${res.title || i18n('Boss Challenge')}`);
          if (res.hook) appendBubble('assistant', `💡 ${res.hook}`);
          appendBubble('assistant', `🔥 ${res.question}`);
          enterChallengeUi();
          openPanel();
        } catch (e) {
          Notification.error(e.message);
        } finally {
          setTyping(false);
          $input.trigger('focus');
        }
      }

      async function sendMessage() {
        if (waiting || !active) return;
        const text = String($input.val() || '').trim();
        if (!text) return;
        const c = ctxOf(active);
        if (c.chMode) {
          $input.val('');
          appendBubble('user', text);
          setTyping(true);
          try {
            const res = await request.post(active.tutorUrl, {
              operation: 'challengeReply', text, history: JSON.stringify(c.chHistory.slice(-10)),
            });
            c.chHistory.push({ role: 'student', content: text });
            c.chHistory.push({ role: 'tutor', content: res.reply });
            absorbSpark(res, c);
            appendBubble('assistant', res.reply);
            if (res.cleared) {
              appendDivider(`🏆 ${i18n('Challenge cleared! Legendary work!')}`, true);
              confettiBurst();
              c.challengeInfo = { state: 'cleared' };
              c.chMode = false;
              exitChallengeUi();
            }
          } catch (e) {
            appendBubble('assistant', `⚠️ ${e.message}`);
          } finally {
            setTyping(false);
            $input.trigger('focus');
          }
          return;
        }
        if (!c.started) {
          Notification.warn(i18n('Submit your solution first — the tutor starts from a judged attempt.'));
          return;
        }
        $input.val('');
        appendBubble('user', text);
        setTyping(true);
        try {
          const res = await request.post(active.tutorUrl, { operation: 'message', text });
          absorbSpark(res, c);
          appendBubble('assistant', res.reply);
        } catch (e) {
          appendBubble('assistant', `⚠️ ${e.message}`);
        } finally {
          setTyping(false);
          $input.trigger('focus');
        }
      }
      $panel.find('#paper-tutor-send').on('click', sendMessage);
      $input.on('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      return {
        async onFailed(task, rid) {
          const c = (active && active.docId === task.docId) ? ctxOf(task) : await setActive(task, { load: false });
          setTyping(true);
          try {
            const res = await request.post(task.tutorUrl, { operation: 'start', rid });
            absorbSpark(res, c);
            renderMessages(res.messages);
            c.started = true;
            openPanel();
          } catch (e) {
            Notification.error(e.message);
          } finally {
            setTyping(false);
          }
        },
        async onAccepted(task, rid) {
          const c = (active && active.docId === task.docId) ? ctxOf(task) : await setActive(task);
          setTyping(true);
          try {
            const res = await request.post(task.tutorUrl, { operation: 'accepted', rid });
            absorbSpark(res, c);
            if (res.marker) appendDivider(res.marker, true);
            if (res.reply) {
              appendBubble('assistant', res.reply);
              c.started = true;
            }
            offerChallenge(task, res.challenge);
            if (!panelOpen) $fabDot.show();
          } catch (e) { /* celebration is non-fatal */ } finally {
            setTyping(false);
          }
        },
      };
    }
  }
});
