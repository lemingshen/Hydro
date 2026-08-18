import $ from 'jquery';
import * as yaml from 'js-yaml';
import MarkdownIt from 'markdown-it';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, loadReactRedux, request, tpl } from 'vj/utils';
// Direct import: pulls the rail module into the bundle through the dependency
// graph, so the session rail never depends on the page-loader picking up a
// newly added file.
import { injectRailWhenReady, removeRail as removeScratchpadRail } from './auto_scratchpad.page';
import { openDB } from 'vj/utils/db';

const POLL_INTERVAL = 1500;
const MAX_POLLS = 120; // ~3 minutes

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Full markdown rendering for tutor messages. html:false keeps raw HTML escaped. */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** The student's own bubbles stay as typed: escaped text with line breaks. */
function renderUserText(text) {
  return escapeHtml(String(text || '')).replace(/\n/g, '<br>');
}

/** Question key as the judge reports it: subtaskId or subtaskId-id. */
function caseKey(c) {
  if (c.subtaskId === undefined || c.subtaskId === null) return null;
  return (c.id === undefined || c.id === null) ? `${c.subtaskId}` : `${c.subtaskId}-${c.id}`;
}

export default new NamedPage('self_learning_solve', async () => {
  const tutorUrl = `${window.location.pathname}/tutor`;
  const recordUrl = `${window.location.pathname}/record`;
  const isObjective = UiContext.slType === 'objective';
  const $chat = $('#sl-chat');
  const $tutor = $('#sl-tutor');
  const $typing = $('#sl-typing');
  const $input = $('#sl-input');
  const $verdict = $('#sl-verdict');
  const $fab = $('#sl-fab');
  const $fabDot = $('#sl-fab-dot');
  let panelOpen = false;
  let tutorStarted = false;
  let waiting = false;
  let lastRid = null;

  /* --------------------- objective (quiz) answer form ---------------------- */

  const ans = {};
  const cacheKey = `sl/${UserContext._id}/${UiContext.slSsid}/${UiContext.slPid}#objective`;
  let db = null;

  function buildObjectiveForm() {
    const $container = $('[data-fragment-id="problem-description"]');
    if (!$container.length) return 0;
    const reg = /\{\{ (input|select|multiselect|textarea|dropdown)\(\d+(-\d+)?\)(?:\[([^\]]*)\])? \}\}/g;
    let cnt = 0;
    $container.children().each((i, e) => {
      if (e.tagName === 'PRE' && !(e.children[0]?.className || '').includes('#input')) return;
      const questions = [];
      let q;
      while (q = reg.exec(e.textContent)) questions.push(q); // eslint-disable-line no-cond-assign
      for (const [info, type, , options] of questions) {
        cnt++;
        const id = info.replace(/\{\{ (input|select|multiselect|textarea|dropdown)\((\d+(-\d+)?)\)(?:\[([^\]]*)\])? \}\}/, '$2');
        if (type === 'input') {
          $(e).html($(e).html().replace(info, tpl`
            <div class="objective_${id} medium-3" id="p${id}" style="display: inline-block;">
              <input type="text" name="${id}" class="textbox objective-input">
            </div>
          `));
        } else if (type === 'textarea') {
          $(e).html($(e).html().replace(info, tpl`
            <div class="objective_${id} medium-6" id="p${id}">
              <textarea name="${id}" class="textbox objective-input"></textarea>
            </div>
          `));
        } else if (type === 'dropdown') {
          const opts = (options || '').split(',').map((s) => s.trim()).filter(Boolean);
          $(e).html($(e).html().replace(info, tpl`
            <div class="objective_${id} medium-3 select-container" id="p${id}" style="display: inline-block;">
              <select name="${id}" class="objective-input select">
                <option value=""></option>
                ${{ templateRaw: true, html: opts.map((o) => tpl`<option value="${o}">${o}</option>`).join('') }}
              </select>
            </div>
          `));
        } else {
          if ($(e).next()[0]?.tagName !== 'UL') {
            cnt--;
            return;
          }
          $(e).html($(e).html().replace(info, ''));
          $(e).next('ul').children().each((j, ele) => {
            $(ele).after(tpl`
              <label class="objective_${id} radiobox" id="p${id}">
                <input type="${type === 'select' ? 'radio' : 'checkbox'}" name="${id}" class="objective-input" value="${String.fromCharCode(65 + j)}">
                ${String.fromCharCode(65 + j)}. ${{ templateRaw: true, html: ele.innerHTML }}
              </label>
            `);
            $(ele).remove();
          });
        }
      }
    });
    return cnt;
  }

  async function saveAns() {
    try {
      await db?.put('solutions', { id: cacheKey, value: JSON.stringify(ans) });
    } catch (e) { /* persistence is best-effort */ }
  }

  async function loadAns() {
    let saved = null;
    try {
      saved = await db?.get('solutions', cacheKey);
    } catch (e) { /* ignore */ }
    if (typeof saved?.value !== 'string') return;
    const isValidOption = (v) => v.length === 1 && v.charCodeAt(0) >= 65 && v.charCodeAt(0) <= 90;
    try {
      Object.assign(ans, JSON.parse(saved.value));
    } catch (e) { return; }
    for (const [id, val] of Object.entries(ans)) {
      if (Array.isArray(val)) {
        for (const v of val) {
          if (isValidOption(v)) $(`.objective_${id} input[value="${v}"]`).prop('checked', true);
        }
      } else if (val) {
        $(`.objective_${id} input[type=text], .objective_${id} textarea, .objective_${id} select`).val(val.toString());
        if (isValidOption(val)) $(`.objective_${id}.radiobox [value="${val}"]`).prop('checked', true);
      }
    }
  }

  function wireObjectiveInputs() {
    $('.objective-input[type!=checkbox]').on('input change', (e) => {
      ans[e.target.name] = e.target.value;
      saveAns();
    });
    $('input.objective-input[type=checkbox]').on('input', (e) => {
      if (e.target.checked) {
        ans[e.target.name] ||= [];
        ans[e.target.name].push(e.target.value);
        ans[e.target.name] = [...new Set(ans[e.target.name])].sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0));
      } else {
        ans[e.target.name] = (ans[e.target.name] || []).filter((v) => v !== e.target.value);
      }
      saveAns();
    });
  }

  function clearQuestionMarks() {
    $('.sl-q-pass, .sl-q-fail, .sl-q-partial').removeClass('sl-q-pass sl-q-fail sl-q-partial');
  }

  function markQuestions(data) {
    if (!isObjective || !data.cases) return;
    clearQuestionMarks();
    for (const c of data.cases) {
      const key = caseKey(c);
      if (!key) continue;
      const cls = c.status === 1 ? 'sl-q-pass' : (/partial/i.test(c.message || '') ? 'sl-q-partial' : 'sl-q-fail');
      $(`.objective_${key}`).addClass(cls);
    }
  }

  /* ------- floating layout: body portal, drag, viewport-adaptive geometry ------- */

  // Saved as viewport FRACTIONS so both the launcher position and the window size
  // adapt naturally to any page size, window resize, or zoom level.
  const FAB_POS_KEY = 'hydro:sl-fab-pos';
  const PANEL_SIZE_KEY = 'hydro:sl-panel-size';
  const FAB_SIZE = 56;
  const EDGE = 12;
  let fabDragMoved = false;
  let fabFrac = null; // {fx, fy} in [0,1]; null = untouched default (center right)
  let sizeFrac = null; // {fw, fh} as fractions of the viewport; null = default size
  let isExpanded = false;

  // position:fixed silently degrades to absolute positioning inside any transformed
  // ancestor — and Hydro animates .section entrances with translateY. That detaches
  // the window from the viewport and can even create page scrollbars. Re-homing both
  // nodes directly under <body> makes them true viewport overlays.
  if ($fab.length) $fab.appendTo(document.body);
  if ($tutor.length) $tutor.appendTo(document.body);

  function isNarrowViewport() {
    return window.matchMedia('(max-width: 600px)').matches;
  }

  /** Keep the launcher and the window below the fixed navbar. */
  function topBound() {
    const nav = document.querySelector('.nav');
    const h = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
    return Math.max(EDGE, h + EDGE);
  }

  /** Where the launcher is (or would be, while hidden) in the current viewport. */
  function fabPixelPos() {
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    if (!fabFrac) return { x: iw - FAB_SIZE - 24, y: (ih - FAB_SIZE) / 2 }; // CSS default: center right
    const minY = topBound();
    const rangeX = Math.max(0, iw - FAB_SIZE - EDGE * 2);
    const rangeY = Math.max(0, ih - FAB_SIZE - minY - EDGE);
    return { x: EDGE + fabFrac.fx * rangeX, y: minY + fabFrac.fy * rangeY };
  }

  /** Re-apply the launcher position for the current viewport size. */
  function syncFab() {
    if (!fabFrac || !$fab.length) return;
    const pos = fabPixelPos();
    $fab.css({
      left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto', transform: 'none',
    });
  }

  function setFabFromPixels(x, y) {
    const minY = topBound();
    const rangeX = Math.max(1, window.innerWidth - FAB_SIZE - EDGE * 2);
    const rangeY = Math.max(1, window.innerHeight - FAB_SIZE - minY - EDGE);
    fabFrac = {
      fx: Math.min(1, Math.max(0, (x - EDGE) / rangeX)),
      fy: Math.min(1, Math.max(0, (y - minY) / rangeY)),
    };
    syncFab();
  }

  function initFabDrag() {
    const el = $fab[0];
    try {
      const saved = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
      if (saved && Number.isFinite(saved.fx) && Number.isFinite(saved.fy)) {
        fabFrac = { fx: Math.min(1, Math.max(0, saved.fx)), fy: Math.min(1, Math.max(0, saved.fy)) };
        syncFab();
      }
    } catch (e) { /* keep the default center-right position */ }
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      const r = el.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      origX = r.left;
      origY = r.top;
      dragging = true;
      fabDragMoved = false;
      el.setPointerCapture?.(ev.pointerId);
    });
    el.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!fabDragMoved && Math.hypot(dx, dy) < 5) return; // still a click
      fabDragMoved = true;
      ev.preventDefault();
      setFabFromPixels(origX + dx, origY + dy);
    });
    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture?.(ev.pointerId);
      if (fabDragMoved && fabFrac) {
        try {
          localStorage.setItem(FAB_POS_KEY, JSON.stringify(fabFrac));
        } catch (e) { /* persistence is best-effort */ }
      }
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
  }

  /** The window size for the current viewport: saved fraction (or default), clamped. */
  function panelSizePixels() {
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    const maxW = Math.max(300, iw - EDGE * 2);
    const maxH = Math.max(360, ih - topBound() - EDGE);
    const w = sizeFrac ? sizeFrac.fw * iw : 400;
    const h = sizeFrac ? sizeFrac.fh * ih : 620;
    return {
      w: Math.min(Math.max(300, w), maxW),
      h: Math.min(Math.max(360, h), maxH),
    };
  }

  /**
   * Single source of truth for the open window's geometry. The size scales with
   * the viewport, the window hugs the launcher, and everything stays on screen
   * below the navbar. Called on open, on every resize, and when toggling expand.
   */
  function applyPanelLayout() {
    if (!$tutor.length || !panelOpen) return;
    if (isNarrowViewport()) {
      // Let the mobile stylesheet lay the window out edge-to-edge.
      $tutor.css({
        left: '', top: '', right: '', bottom: '', width: '', height: '', maxWidth: '',
      });
      return;
    }
    // Expanded: a large reading pane — up to 760px wide, full available height —
    // that is still a floating window anchored to the launcher.
    const size = isExpanded
      ? {
        w: Math.min(760, Math.max(300, window.innerWidth - EDGE * 2)),
        h: Math.max(360, window.innerHeight - topBound() - EDGE),
      }
      : panelSizePixels();
    const fp = fabPixelPos();
    const left = Math.min(Math.max(EDGE, fp.x + FAB_SIZE - size.w), window.innerWidth - size.w - EDGE);
    const top = Math.min(Math.max(topBound(), fp.y + FAB_SIZE - size.h), window.innerHeight - size.h - EDGE);
    $tutor.css({
      width: `${size.w}px`, height: `${size.h}px`, left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', maxWidth: 'none',
    });
  }

  function setExpanded(on) {
    isExpanded = on;
    $tutor.toggleClass('sl-float--expanded', on);
    $('#sl-tutor-expand').text(on ? '⤡' : '⤢').attr('title', i18n(on ? 'Collapse' : 'Expand'));
    applyPanelLayout();
    scrollChat();
  }

  function initPanelResize() {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) || 'null');
      if (saved && Number.isFinite(saved.fw) && Number.isFinite(saved.fh)) sizeFrac = saved;
    } catch (e) { /* keep the default size */ }
    const handle = document.getElementById('sl-tutor-resize');
    if (!handle) return;
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let fixedRight = 0;
    let fixedBottom = 0;
    handle.addEventListener('pointerdown', (ev) => {
      if (isExpanded || isNarrowViewport()) return;
      if (ev.button !== undefined && ev.button !== 0) return;
      const r = $tutor[0].getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      startW = r.width;
      startH = r.height;
      fixedRight = r.right;
      fixedBottom = r.bottom;
      resizing = true;
      handle.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
    });
    handle.addEventListener('pointermove', (ev) => {
      if (!resizing) return;
      ev.preventDefault();
      // Dragging the top-left corner: the bottom-right corner stays pinned.
      const maxW = Math.max(300, window.innerWidth - EDGE * 2);
      const maxH = Math.max(360, window.innerHeight - topBound() - EDGE);
      const w = Math.min(Math.max(300, startW + (startX - ev.clientX)), maxW);
      const h = Math.min(Math.max(360, startH + (startY - ev.clientY)), maxH);
      $tutor.css({
        width: `${w}px`,
        height: `${h}px`,
        left: `${Math.max(EDGE, fixedRight - w)}px`,
        top: `${Math.max(topBound(), fixedBottom - h)}px`,
        right: 'auto',
        bottom: 'auto',
        maxWidth: 'none',
      });
    });
    const endResize = (ev) => {
      if (!resizing) return;
      resizing = false;
      handle.releasePointerCapture?.(ev.pointerId);
      const r = $tutor[0].getBoundingClientRect();
      sizeFrac = { fw: r.width / window.innerWidth, fh: r.height / window.innerHeight };
      try {
        localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(sizeFrac));
      } catch (e) { /* persistence is best-effort */ }
      applyPanelLayout();
    };
    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
  }

  /* ------------------------------ tutor chat ------------------------------- */

  function scrollChat() {
    if ($chat.length) $chat.scrollTop($chat[0].scrollHeight);
  }

  function appendDivider(text, accepted = false) {
    $chat.find('.sl-empty').remove();
    $chat.append($(`<div class="sl-divider${accepted ? ' accepted' : ''}"><span>${escapeHtml(text)}</span></div>`));
    scrollChat();
  }

  function appendBubble(role, content) {
    $chat.find('.sl-empty').remove();
    const $msg = $(`<div class="sl-msg ${role === 'user' ? 'user' : 'assistant'}"><div class="sl-bubble"></div></div>`);
    if (role === 'user') {
      $msg.find('.sl-bubble').html(renderUserText(content));
    } else {
      $msg.find('.sl-bubble').html(md.render(String(content || '')));
      import('vj/components/highlighter/prismjs')
        .then(({ default: prism }) => prism.highlightBlocks($msg))
        .catch(() => { /* highlighting is optional */ });
      if (!panelOpen) $fabDot.show();
    }
    $chat.append($msg);
    scrollChat();
  }

  function renderMessages(messages, replace = true) {
    if (replace) $chat.empty();
    for (const m of messages || []) {
      if (m.kind === 'attempt') appendDivider(m.content);
      else if (m.kind === 'accepted') appendDivider(m.content, true);
      else appendBubble(m.role, m.content);
    }
  }

  function setTyping(on) {
    waiting = on;
    $typing.toggle(on);
    $('#sl-send').prop('disabled', on);
  }

  function openPanel() {
    if (!$tutor.length) return;
    panelOpen = true;
    $tutor.show();
    applyPanelLayout();
    $fab.hide();
    $fabDot.hide();
    if (!$chat.children().length) {
      $chat.append(`<div class="sl-empty">${escapeHtml(i18n('Submit your solution first — the tutor starts from a judged attempt.'))}</div>`);
    }
    scrollChat();
    $input.trigger('focus');
  }

  function closePanel() {
    panelOpen = false;
    $tutor.hide();
  }

  async function startTutor(rid, open = true) {
    if (!UiContext.slTutor || !$tutor.length) return;
    if (open) openPanel();
    setTyping(true);
    try {
      const res = await request.post(tutorUrl, { operation: 'start', rid });
      renderMessages(res.messages, true);
      tutorStarted = true;
    } catch (e) {
      appendBubble('assistant', `⚠️ ${e.message}`);
    } finally {
      setTyping(false);
      if (open) $input.trigger('focus');
    }
  }

  async function notifyAccepted(rid) {
    if (!tutorStarted || !UiContext.slTutor) return;
    setTyping(true);
    try {
      const res = await request.post(tutorUrl, { operation: 'accepted', rid });
      if (res.reply) {
        appendDivider(i18n('Accepted!'), true);
        appendBubble('assistant', res.reply);
      }
    } catch (e) { /* non-fatal */ } finally {
      setTyping(false);
    }
  }

  async function sendMessage() {
    if (waiting) return;
    const text = ($input.val() || '').trim();
    if (!text) return;
    if (!tutorStarted) {
      Notification.warn(i18n('Submit your solution first — the tutor starts from a judged attempt.'));
      return;
    }
    $input.val('');
    appendBubble('user', text);
    setTyping(true);
    try {
      const res = await request.post(tutorUrl, { operation: 'message', text });
      appendBubble('assistant', res.reply);
    } catch (e) {
      appendBubble('assistant', `⚠️ ${e.message}`);
    } finally {
      setTyping(false);
      $input.trigger('focus');
    }
  }

  /* ------------------------- submission & polling ------------------------- */

  function renderVerdict(data) {
    let cls = 'pending';
    if (data.judged) cls = data.accepted ? 'pass' : 'fail';
    $verdict.attr('class', `sl-verdict ${cls}`).show();
    let html = '';
    if (!data.judged) {
      html = `<b>⏳ ${escapeHtml(data.statusText)}...</b>`;
    } else {
      const icon = data.accepted ? '✅' : '❌';
      html = `<b>${icon} ${escapeHtml(data.statusText)}</b>`
        + (isObjective
          ? ` <span class="text-gray">(${i18n('Score')}: ${data.score})</span>`
          : ` <span class="text-gray">(${i18n('Score')}: ${data.score}, ${data.time}ms, ${data.memory}KiB)</span>`);
      if (data.cases && data.cases.length) {
        html += '<div class="sl-cases">';
        for (const c of data.cases) {
          const key = caseKey(c) ?? '?';
          const cls2 = c.status === 1 ? 'pass' : (/partial/i.test(c.message || '') ? 'partial' : 'fail');
          const label = isObjective ? (c.message || c.statusText) : c.statusText;
          html += `<span class="${cls2}">#${escapeHtml(key)} ${escapeHtml(label)}</span>`;
        }
        html += '</div>';
      }
      if (data.compilerTexts) {
        html += `<details style="margin-top:6px"><summary>${i18n('Compiler output')}</summary><pre style="white-space:pre-wrap">${escapeHtml(data.compilerTexts)}</pre></details>`;
      }
      if (data.judgeTexts) {
        html += `<details style="margin-top:6px"><summary>${i18n('Judge messages')}</summary><pre style="white-space:pre-wrap">${escapeHtml(data.judgeTexts)}</pre></details>`;
      }
    }
    $verdict.html(html);
  }

  async function pollRecord(rid) {
    for (let i = 0; i < MAX_POLLS; i++) {
      let data;
      try {
        data = await request.get(`${recordUrl}?rid=${rid}`);
      } catch (e) {
        Notification.error(e.message);
        return null;
      }
      renderVerdict(data);
      if (data.judged) return data;
      await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL); });
    }
    Notification.warn(i18n('Judging is taking longer than expected. Please check the record list.'));
    return null;
  }

  async function handleSubmit(ev) {
    if (ev) ev.preventDefault();
    let payload;
    if (isObjective) {
      const filled = Object.keys(ans).filter((k) => {
        const v = ans[k];
        return Array.isArray(v) ? v.length : (v !== undefined && v !== null && String(v).trim());
      });
      if (!filled.length) {
        Notification.warn(i18n('Please answer at least one question before submitting.'));
        return;
      }
      payload = { lang: '_', code: yaml.dump(ans) };
    } else {
      const lang = $('[name="lang"]').val() || '_';
      const code = $('[name="code"]').val();
      if (!code || !code.trim()) {
        Notification.warn(i18n('Please write your code first.'));
        return;
      }
      payload = { lang, code };
    }
    const $btn = $('#sl-submit');
    $btn.prop('disabled', true);
    $('#sl-submit-hint').text(i18n('Submitting...'));
    try {
      const res = await request.post(window.location.pathname, payload);
      if (!isObjective) {
        // Programming tasks hand off to the standard record page, where the
        // tutor window (with the problem statement alongside) takes over.
        const prefix = window.location.pathname.split('/self-learning/')[0];
        window.location.assign(`${prefix}/record/${res.rid}?slssid=${UiContext.slSsid}&slpid=${UiContext.slPid}`);
        return;
      }
      lastRid = res.rid;
      $('#sl-submit-hint').text('');
      clearQuestionMarks();
      renderVerdict({ judged: false, statusText: i18n('Waiting') });
      const data = await pollRecord(res.rid);
      if (!data) return;
      markQuestions(data);
      if (data.accepted) {
        Notification.success(i18n('Accepted! Great job!'));
        await notifyAccepted(res.rid);
      } else {
        // Requirement: a failed submission by a student launches the Socratic tutor chat.
        await startTutor(res.rid);
      }
    } catch (e) {
      Notification.error(e.message);
      $('#sl-submit-hint').text('');
    } finally {
      $btn.prop('disabled', false);
    }
  }

  /* --------------------- Scratchpad (full-screen IDE) ---------------------- */

  function initScratchpad() {
    if (UiContext.slType !== 'programming') return;
    const $scratchpadContainer = $('.scratchpad-container');
    if (!$scratchpadContainer.length) return;
    let reactLoaded = false;
    let renderReact = null;
    let unmountReact = null;
    let extended = false;
    let busy = false;
    let lastTrackedRid = null;
    let annoState = []; // active zones: { zoneId, decoIds, editor }
    let annoSession = 0; // bumped on clear; stale async work checks it
    let askedQuestions = [];
    let cardState = null; // the single active question card
    let editorLocked = false;

    function findScratchpadEditor() {
      const m = window.monaco;
      if (!m || !m.editor || !m.editor.getEditors) return null;
      const editors = m.editor.getEditors();
      return editors.find((e) => {
        const dom = e.getDomNode && e.getDomNode();
        return dom && $('#scratchpad').has(dom).length && $(dom).is(':visible');
      }) || editors[0] || null;
    }

    function lockEditor() {
      const ed = findScratchpadEditor();
      if (ed && !editorLocked) {
        ed.updateOptions({ readOnly: true });
        editorLocked = true;
      }
    }

    function unlockEditor() {
      const ed = findScratchpadEditor();
      if (ed && editorLocked) ed.updateOptions({ readOnly: false });
      editorLocked = false;
    }

    function clearAnnotations() {
      annoSession += 1;
      for (const a of annoState) {
        try {
          a.editor.changeViewZones((acc) => acc.removeZone(a.zoneId));
          if (a.decoIds && a.decoIds.length) a.editor.deltaDecorations(a.decoIds, []);
        } catch (e) { /* the editor may already be gone */ }
      }
      annoState = [];
      cardState = null;
      hideOverlay();
    }

    /** Keep clicks and keystrokes inside our zone DOM away from Monaco. */
    function shieldZoneDom(dom) {
      dom.style.pointerEvents = 'auto';
      // Monaco paints .view-lines above the view-zones layer and it swallows
      // mouse events over the card; lifting the zone restores interactivity.
      dom.style.zIndex = '100';
      for (const evt of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'keypress', 'wheel']) {
        dom.addEventListener(evt, (e) => e.stopPropagation());
      }
    }

    function addZone(ed, afterLine, heightInPx, dom, decorate) {
      ensureTutorUiStyle();
      shieldZoneDom(dom);
      const zone = { afterLineNumber: afterLine, heightInPx, domNode: dom };
      let zoneId = null;
      ed.changeViewZones((acc) => {
        zoneId = acc.addZone(zone);
      });
      let decoIds = [];
      if (decorate) {
        decoIds = ed.deltaDecorations([], [{
          range: new window.monaco.Range(decorate.line, 1, decorate.endLine, ed.getModel().getLineMaxColumn(decorate.endLine)),
          options: { isWholeLine: true, className: 'sl-anno-line' },
        }]);
      }
      const entry = {
        zoneId, zone, decoIds, editor: ed,
      };
      annoState.push(entry);
      return entry;
    }

    /**
     * Size the zone to the card's real content. Monaco pins the DOM to the
     * zone's heightInPx, so a fixed guess leaves blank slabs or overflow;
     * measuring keeps the card exactly as tall as its content, and lets it
     * grow as the mini-dialogue accumulates messages.
     */
    function fitZone(entry, min = 44, max = 300) {
      if (!entry) return;
      try {
        const dom = entry.zone.domNode;
        const prev = dom.style.height;
        dom.style.height = 'auto';
        const h = Math.min(Math.max(min, Math.ceil(dom.offsetHeight)), max);
        dom.style.height = prev; // Monaco re-applies the zone height on layout
        entry.zone.heightInPx = h;
        entry.editor.changeViewZones((acc) => acc.layoutZone(entry.zoneId));
      } catch (e) { /* sizing is cosmetic */ }
    }

    function removeZoneEntry(entry) {
      try {
        entry.editor.changeViewZones((acc) => acc.removeZone(entry.zoneId));
        if (entry.decoIds && entry.decoIds.length) entry.editor.deltaDecorations(entry.decoIds, []);
      } catch (e) { /* ignore */ }
      annoState = annoState.filter((x) => x !== entry);
    }

    /**
     * The COMPLETE tutor-card stylesheet, injected from the bundle: the card
     * is a compact popup (max 640px) hugging the code line, never a
     * full-width banner, and never at the mercy of template freshness.
     */
    const TUTOR_UI_STYLE = [
      '.sl-anno { display: flex; align-items: flex-start; gap: 8px; box-sizing: border-box; max-width: 440px; min-width: 260px; background: #fdf3f4; border: 1px solid #e7bcc3; border-left: 4px solid #9e2335; border-radius: 6px; padding: 8px 10px; margin: 0 0 0 12px; font-size: 13px; line-height: 1.45; box-shadow: 0 3px 12px rgba(0,0,0,.28); color: #333; user-select: text; overflow: hidden; }',
      '.sl-anno--chat { flex-direction: column; align-items: stretch; gap: 4px; padding: 6px 10px; }',
      '.sl-anno__head { display: flex; justify-content: space-between; align-items: center; font-weight: bold; font-size: 12.5px; color: #9e2335; flex: 0 0 auto; }',
      '.sl-anno__log { max-height: 148px; overflow-y: auto; overflow-x: hidden; background: #fff; border: 1px solid #f0dadd; border-radius: 4px; padding: 4px 6px; }',
      '.sl-anno__msg { margin: 3px 0; padding: 3px 8px; border-radius: 8px; font-size: 12.5px; line-height: 1.4; width: fit-content; max-width: 95%; box-sizing: border-box; color: #333; word-break: break-word; }',
      '.sl-anno__msg.tutor { background: #fdf3f4; border: 1px solid #eccdd2; }',
      '.sl-anno__msg.student { background: #ececec; margin-left: auto; }',
      '.sl-anno__msg p { margin: 0 0 4px; }',
      '.sl-anno__msg p:last-child { margin-bottom: 0; }',
      '.sl-anno__msg code { background: #f0e3e6; padding: 0 4px; border-radius: 3px; font-size: 12px; }',
      '.sl-anno__msg pre { background: #f4f4f4; padding: 6px; border-radius: 4px; overflow-x: auto; margin: 4px 0; }',
      '.sl-anno__msg pre code { background: none; padding: 0; }',
      '.sl-anno__msg ul, .sl-anno__msg ol { margin: 2px 0 4px 16px; padding: 0; }',
      '.sl-anno__note { margin: 4px 0 2px; padding: 3px 8px; border-radius: 8px; background: #e9f7ec; border: 1px solid #bfe6c8; color: #2f9e44; font-size: 12.5px; width: fit-content; font-weight: bold; }',
      '.sl-anno__q { flex: 1 1 auto; color: #333; overflow: hidden; }',
      '.sl-anno__btns { display: flex; gap: 2px; flex: 0 0 auto; }',
      '.sl-anno button { border: none; background: transparent; cursor: pointer; font-size: 14px; padding: 0 5px; border-radius: 4px; color: #9e2335; line-height: 1.4; }',
      '.sl-anno button:hover { background: rgba(158,35,53,.12); }',
      '.sl-anno__input { display: flex; gap: 6px; flex: 0 0 auto; }',
      '.sl-anno__input input { flex: 1 1 auto; border: 1px solid #d8d8d8; border-radius: 4px; padding: 3px 8px; font-size: 12.5px; color: #333; background: #fff; }',
      '.sl-anno__input input:focus { outline: none; border-color: #9e2335; }',
      '.sl-anno__input button { border: 1px solid #9e2335; background: #9e2335; color: #fff; }',
      '.sl-anno__input button:hover { background: #7f1b2a; }',
      '.sl-anno__input button:disabled { opacity: .5; cursor: default; }',
      '.sl-anno--resolved { border-left-color: #2f9e44; }',
      '.sl-anno--resolved .sl-anno__head { color: #2f9e44; }',
      '.sl-anno--info { align-items: center; min-height: 40px; }',
      '.sl-anno-line { background: rgba(158,35,53,.10); }',
      '.sl-anno__thinking { display: flex; align-items: center; gap: 6px; margin: 3px 0; padding: 3px 8px; border-radius: 8px; background: #fff; border: 1px dashed #eccdd2; color: #9e2335; font-size: 12.5px; width: fit-content; }',
      '.sl-anno__thinking .sl-spin--sm { width: 14px; height: 14px; border: 2px solid #eccdd2; border-top-color: #9e2335; border-radius: 50%; flex: 0 0 auto; animation: sl-overlay-rot .8s linear infinite; }',
      '.sl-overlay { position: fixed; inset: 0; z-index: 3000; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }',
      '.sl-overlay__box { background: #2b2b2b; border-radius: 14px; padding: 30px 38px; display: flex; flex-direction: column; align-items: center; gap: 16px; color: #eee; font-size: 14px; box-shadow: 0 10px 36px rgba(0,0,0,.45); }',
      '.sl-overlay .sl-spin { width: 46px; height: 46px; border: 5px solid rgba(255,255,255,.25); border-top-color: #fff; border-radius: 50%; animation: sl-overlay-rot .8s linear infinite; }',
      '@keyframes sl-overlay-rot { to { transform: rotate(360deg); } }',
    ].join('\n');

    function ensureTutorUiStyle() {
      if (!document.getElementById('sl-tutor-ui-style')) {
        $('<style>').attr('id', 'sl-tutor-ui-style').text(TUTOR_UI_STYLE).appendTo(document.head);
      }
    }

    function showOverlay() {
      lockEditor();
      ensureTutorUiStyle();
      if (document.getElementById('sl-anno-overlay')) return;
      const dom = document.createElement('div');
      dom.id = 'sl-anno-overlay';
      dom.className = 'sl-overlay';
      dom.innerHTML = '<div class="sl-overlay__box">'
        + '<span class="sl-spin"></span>'
        + `<div>${escapeHtml(i18n('The tutor is thinking...'))}</div>`
        + '</div>';
      document.body.appendChild(dom);
    }

    function hideOverlay() {
      const el = document.getElementById('sl-anno-overlay');
      if (el) el.remove();
      unlockEditor();
    }

    let thinkingRow = null;

    /**
     * Requested UX: the full-page overlay is only for the moment right after a
     * submission, before any card exists; once the pop-up card is on screen,
     * the thinking animation lives INSIDE it.
     */
    function showThinking() {
      ensureTutorUiStyle();
      lockEditor();
      if (cardState) {
        const $log = $(cardState.dom).find('.sl-anno__log');
        if (!thinkingRow) {
          thinkingRow = $('<div class="sl-anno__thinking"><span class="sl-spin--sm"></span>'
            + `<span>${escapeHtml(i18n('The tutor is thinking...'))}</span></div>`)[0];
        }
        $log.append(thinkingRow);
        $log.scrollTop($log[0].scrollHeight);
        $(cardState.dom).find('.sl-anno__input input, .sl-anno__input button').prop('disabled', true);
        fitZone(cardState.entry, 60, 300);
        return;
      }
      showOverlay();
    }

    function hideThinking() {
      if (thinkingRow && thinkingRow.parentNode) thinkingRow.parentNode.removeChild(thinkingRow);
      thinkingRow = null;
      hideOverlay(); // no-op when only the in-card spinner was shown; also unlocks
      if (cardState) {
        if (!$(cardState.dom).hasClass('sl-anno--resolved')) {
          $(cardState.dom).find('.sl-anno__input input, .sl-anno__input button').prop('disabled', false);
        }
        fitZone(cardState.entry, 60, 300);
      }
    }

    function showInfoCard(text, afterLine) {
      const ed = findScratchpadEditor();
      if (!ed) return;
      const dom = document.createElement('div');
      dom.className = 'sl-anno sl-anno--info';
      dom.innerHTML = `<span class="sl-anno__icon">🤖</span>`
        + `<span class="sl-anno__q">${escapeHtml(text)}</span>`
        + `<span class="sl-anno__btns"><button type="button" class="sl-anno__close" title="${escapeHtml(i18n('Dismiss'))}">×</button></span>`;
      const entry = addZone(ed, afterLine, 44, dom, null);
      fitZone(entry, 40, 160);
      dom.querySelector('.sl-anno__close').addEventListener('click', () => removeZoneEntry(entry));
    }

    /** A distinct green instruction row (not a chat bubble). */
    function appendCardNote(text) {
      if (!cardState) return;
      const $log = $(cardState.dom).find('.sl-anno__log');
      $log.append(`<div class="sl-anno__note">✏️ ${escapeHtml(text)}</div>`);
      $log.scrollTop($log[0].scrollHeight);
      fitZone(cardState.entry, 60, 300);
    }

    function appendCardMsg(role, content) {
      if (!cardState) return;
      const $log = $(cardState.dom).find('.sl-anno__log');
      const $msg = $(`<div class="sl-anno__msg ${role === 'student' ? 'student' : 'tutor'}"></div>`);
      if (role === 'student') {
        $msg.html(escapeHtml(String(content || '')).replace(/\n/g, '<br>'));
      } else {
        // The same markdown renderer as the chat windows (html stays escaped).
        $msg.html(md.render(String(content || '')));
      }
      $log.append($msg);
      $log.scrollTop($log[0].scrollHeight);
      fitZone(cardState.entry, 60, 300);
    }

    /** The single interactive question card: a mini chatbox anchored at the line. */
    function showQuestionCard(rid, ann) {
      const ed = findScratchpadEditor();
      if (!ed || !ed.getModel()) return;
      const max = ed.getModel().getLineCount();
      const line = Math.min(Math.max(1, Math.floor(ann.line) || 1), max);
      const endLine = Math.min(Math.max(line, Math.floor(ann.endLine) || line), max);
      const dom = document.createElement('div');
      dom.className = 'sl-anno sl-anno--chat';
      dom.innerHTML = '<div class="sl-anno__head">'
        + `<span>🤖 ${escapeHtml(i18n('AI Socratic Tutor'))}</span>`
        + `<span class="sl-anno__btns"><button type="button" class="sl-anno__close" title="${escapeHtml(i18n('Dismiss'))}">×</button></span>`
        + '</div>'
        + '<div class="sl-anno__log"></div>'
        + '<div class="sl-anno__input">'
        + `<input type="text" maxlength="1000" placeholder="${escapeHtml(i18n('Type your answer... (Enter to send)'))}">`
        + `<button type="button" title="${escapeHtml(i18n('Send'))}">➤</button>`
        + '</div>';
      const entry = addZone(ed, endLine, 120, dom, { line, endLine });
      cardState = {
        entry, dom, rid, line, endLine, question: ann.question, history: [],
      };
      appendCardMsg('tutor', ann.question);
      fitZone(entry, 60, 300);
      requestAnimationFrame(() => fitZone(entry, 60, 300));
      dom.querySelector('.sl-anno__close').addEventListener('click', () => {
        // Dismissing ends the guided sequence for this attempt.
        removeZoneEntry(entry);
        cardState = null;
      });
      const input = dom.querySelector('.sl-anno__input input');
      const send = () => {
        const text = (input.value || '').trim();
        if (text) submitCardAnswer(text);
      };
      dom.querySelector('.sl-anno__input button').addEventListener('click', send);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          send();
        }
      });
      setTimeout(() => input.focus(), 50);
    }

    /** Requirement flow: ONE question at a time; the editor locks while the LLM works. */
    async function requestNextQuestion(rid, afterLine) {
      const session = annoSession;
      const prevCard = cardState; // when a card exists, the spinner shows inside it
      showThinking();
      try {
        const res = await request.post(tutorUrl, {
          operation: 'annotate', rid, asked: JSON.stringify(askedQuestions.slice(-8)),
        });
        if (session !== annoSession || !extended) return;
        hideThinking();
        if (prevCard) {
          removeZoneEntry(prevCard.entry);
          if (cardState === prevCard) cardState = null;
        }
        if (res.annotation) showQuestionCard(rid, res.annotation);
        else showInfoCard(i18n('No further questions — revise your code and resubmit!'), afterLine || 0);
      } catch (e) {
        if (session !== annoSession) return;
        hideThinking();
        console.warn('[self-learning] tutor annotations unavailable:', e.message);
        if (prevCard && cardState === prevCard) appendCardMsg('tutor', `⚠️ ${e.message}`);
        else showInfoCard(`⚠️ ${e.message}`, afterLine || 0);
      }
    }

    async function submitCardAnswer(text) {
      if (!cardState) return;
      const session = annoSession;
      const cs = cardState;
      const priorHistory = cs.history.slice();
      appendCardMsg('student', text);
      $(cs.dom).find('.sl-anno__input input').val('');
      showThinking(); // in-card spinner; the editor stays locked while the LLM evaluates
      try {
        const res = await request.post(tutorUrl, {
          operation: 'annotateReply',
          rid: cs.rid,
          line: cs.line,
          endLine: cs.endLine,
          question: cs.question,
          history: JSON.stringify(priorHistory.slice(-10)),
          text,
        });
        if (session !== annoSession) return;
        cs.history.push({ role: 'student', content: text });
        cs.history.push({ role: 'tutor', content: res.reply });
        hideThinking();
        appendCardMsg('tutor', res.reply);
        if (res.resolved) {
          askedQuestions.push(cs.question);
          $(cs.dom).addClass('sl-anno--resolved');
          $(cs.dom).find('.sl-anno__input input, .sl-anno__input button').prop('disabled', true);
          // Resolution is terminal: no further questions are generated now.
          // The green card sends the student back to the CODE — the next
          // submission restarts the guidance loop from the new verdict.
          appendCardNote(i18n('Now modify your code accordingly and resubmit!'));
          fitZone(cs.entry, 60, 300);
        }
      } catch (e) {
        if (session !== annoSession) return;
        hideThinking();
        appendCardMsg('tutor', `⚠️ ${e.message}`);
      }
    }

    async function trackScratchpadSubmission(rid) {
      if (rid === lastTrackedRid) return; // both hook paths may fire for one submission
      lastTrackedRid = rid;
      console.debug('[self-learning] tracking scratchpad submission', rid);
      lastRid = rid;
      clearAnnotations();
      let judged = false;
      for (let i = 0; i < 120 && extended; i++) {
        try {
          const data = await request.get(`${recordUrl}?rid=${rid}`); // eslint-disable-line no-await-in-loop
          if (data.judged) {
            judged = true;
            break;
          }
        } catch (e) {
          return;
        }
        await new Promise((resolve) => { setTimeout(resolve, 1500); }); // eslint-disable-line no-await-in-loop
      }
      if (!judged || !extended) return;
      // In-editor guidance: ONE Socratic question card at a time, anchored at
      // the relevant lines. The student answers inside the card; once the
      // tutor deems the question resolved, the next one is generated. While
      // the LLM works, a spinner shows and the editor is locked. The chat
      // thread still advances silently so the record page stays coherent.
      askedQuestions = [];
      requestNextQuestion(rid, 0);
      await startTutor(rid, false);
    }

    async function loadReact() {
      if (reactLoaded) return;
      $('.loader-container').show();
      const [
        { default: React },
        { createRoot },
        { default: SockJs },
        { default: ScratchpadApp },
        { default: ScratchpadReducer },
      ] = await Promise.all([
        import('react'),
        import('react-dom/client'),
        import('vj/components/socket'),
        import('vj/components/scratchpad'),
        import('vj/components/scratchpad/reducers'),
      ]);
      const { Provider, store } = await loadReactRedux(ScratchpadReducer);
      window.store = store;
      // The IDE dispatches SCRATCHPAD_POST_SUBMIT with the submit request
      // promise as its payload. The *_FULFILLED action is emitted deep inside
      // the middleware chain and never crosses store.dispatch, so the reliable
      // hook is the original action: attach to its promise directly. Pretest
      // runs dispatch a different action and are deliberately ignored.
      const rawDispatch = store.dispatch.bind(store);
      store.dispatch = (action) => {
        try {
          if (action && action.type === 'SCRATCHPAD_POST_SUBMIT' && action.payload && typeof action.payload.then === 'function') {
            action.payload.then((res) => {
              if (res && res.rid) trackScratchpadSubmission(res.rid);
            }).catch(() => { /* submit failures already surface in the IDE */ });
          } else if (action && action.type === 'SCRATCHPAD_POST_SUBMIT_FULFILLED' && action.payload && action.payload.rid) {
            trackScratchpadSubmission(action.payload.rid); // fallback, in case the middleware ever routes it here
          }
        } catch (e) { /* the tutor hook is best-effort */ }
        return rawDispatch(action);
      };
      const sock = new SockJs(UiContext.ws_prefix + UiContext.pretestConnUrl);
      sock.onmessage = (message) => {
        const msg = JSON.parse(message.data);
        store.dispatch({ type: 'SCRATCHPAD_RECORDS_PUSH', payload: msg });
      };
      renderReact = () => {
        const root = createRoot($('#scratchpad').get(0));
        root.render(React.createElement(Provider, { store }, React.createElement(ScratchpadApp)));
        unmountReact = () => root.unmount();
      };
      reactLoaded = true;
      $('.loader-container').hide();
    }

    async function enterScratchpad() {
      if (busy || extended) return;
      busy = true;
      $('body').addClass('header--collapsed mode--scratchpad');
      $scratchpadContainer.css({
        left: 0, top: 0, width: '100%', height: '100%',
      }).show();
      $('.main > .row').hide();
      $('.footer').hide();
      $(window).scrollTop(0);
      document.body.style.overflow = 'hidden';
      await loadReact();
      renderReact();
      $('#scratchpad').css('opacity', 1);
      injectRailWhenReady(); // PTA-style problem rail on the left
      extended = true;
      busy = false;
    }

    function leaveScratchpad() {
      if (busy || !extended) return;
      busy = true;
      // The tutor lives inside the IDE on this page: tidy it away on exit.
      removeScratchpadRail();
      clearAnnotations();
      panelOpen = false;
      $tutor.hide();
      $('#scratchpad').css('opacity', 0);
      // Hand the statement DOM back to the page before unmounting the IDE.
      $('.problem-content-container').append($('.problem-content'));
      if (unmountReact) unmountReact();
      $scratchpadContainer.hide();
      $('body').removeClass('header--collapsed mode--scratchpad');
      $('.main > .row').show();
      $('.footer').show();
      document.body.style.overflow = 'scroll';
      extended = false;
      busy = false;
    }

    $(window).on('resize', () => {
      if (cardState) fitZone(cardState.entry, 60, 300);
    });
    $(document).on('click', '#sl-open-scratchpad', (ev) => {
      ev.preventDefault();
      enterScratchpad();
    });
    // The quit button is rendered by the scratchpad's own toolbar.
    $(document).on('click', '[name="problem-sidebar__quit-scratchpad"]', (ev) => {
      ev.preventDefault();
      leaveScratchpad();
    });
    // Site-wide policy: programming problems open directly in the IDE. Going
    // through the button lets the shared rail module attach the problem rail;
    // the deferral guarantees its delegated hook is bound first.
    setTimeout(() => $('#sl-open-scratchpad').trigger('click'), 0);
  }

  /* ------------------------------ wiring ---------------------------------- */

  if (isObjective) {
    try {
      db = await openDB;
    } catch (e) { db = null; }
    const cnt = buildObjectiveForm();
    if (cnt) {
      await loadAns();
      wireObjectiveInputs();
    }
    $('#sl-submit').on('click', handleSubmit);
    $('#sl-clear-answers').on('click', async () => {
      const action = await new ConfirmDialog({
        $body: tpl.typoMsg(i18n('All changes will be lost. Are you sure to clear all answers?')),
      }).open();
      if (action !== 'yes') return;
      for (const k of Object.keys(ans)) delete ans[k];
      try {
        await db?.delete('solutions', cacheKey);
      } catch (e) { /* ignore */ }
      window.location.reload();
    });
  } else {
    // The code textarea is upgraded to Monaco by the site-wide
    // code_editor.page.js autoload.
    $('#sl-submit-form').on('submit', handleSubmit);
    initScratchpad();
  }

  if ($fab.length) initFabDrag();
  $fab.on('click', () => {
    if (fabDragMoved) {
      fabDragMoved = false; // this click was the tail end of a drag
      return;
    }
    openPanel();
  });
  $('#sl-tutor-close').on('click', closePanel);
  $('#sl-tutor-expand').on('click', () => setExpanded(!isExpanded));
  $(document).on('keydown', (ev) => {
    if (ev.key === 'Escape' && panelOpen && isExpanded) setExpanded(false);
  });
  initPanelResize();
  $(window).on('resize', () => {
    syncFab();
    applyPanelLayout();
  });
  $('#sl-send').on('click', sendMessage);
  $input.on('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage();
    }
  });
  $('#sl-tutor-reset').on('click', () => {
    new ConfirmDialog({
      $body: tpl.typoMsg(i18n('Reset this tutoring conversation? The tutor will forget everything discussed so far.')),
    }).open().then(async (action) => {
      if (action !== 'yes') return;
      try {
        await request.post(tutorUrl, { operation: 'reset' });
        $chat.empty();
        tutorStarted = false;
        if (lastRid) await startTutor(lastRid);
      } catch (e) {
        Notification.error(e.message);
      }
    });
  });

  // Resume a previous tutoring conversation on page load.
  if (UiContext.slTutor && $tutor.length) {
    request.get(tutorUrl).then((res) => {
      if (res.messages && res.messages.length) {
        renderMessages(res.messages, true);
        tutorStarted = true;
        $fabDot.show();
      }
    }).catch(() => { /* tutor unavailable; the fab still opens an empty panel */ });
  }
});
