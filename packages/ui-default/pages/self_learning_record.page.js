import $ from 'jquery';
import MarkdownIt from 'markdown-it';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request, tpl } from 'vj/utils';

/**
 * Self-learning tutor on the standard record page.
 *
 * After a programming submission inside a self-learning session, the solve page
 * redirects to /record/:rid?slssid=...&slpid=... — the normal record layout.
 * This module detects those parameters, waits for the verdict, then opens a
 * large two-pane window: the problem statement on the left, the AI Socratic
 * tutor chat on the right. Failed submissions get the debugging protocol;
 * accepted ones get the post-acceptance extension coaching.
 */

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const POLL_INTERVAL = 1500;
const MAX_POLLS = 200; // ~5 minutes
const FAB_SIZE = 56;
const EDGE = 12;
const FAB_POS_KEY = 'hydro:sl-fab-pos'; // shared with the solve page

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STYLE = `
  .sl-fab { position: fixed; right: 24px; top: 50%; transform: translateY(-50%); z-index: 900; width: ${FAB_SIZE}px; height: ${FAB_SIZE}px; border-radius: 50%; border: none; background: #9e2335; color: #fff; font-size: 26px; line-height: ${FAB_SIZE}px; text-align: center; padding: 0; cursor: grab; box-shadow: 0 4px 14px rgba(0,0,0,.25); touch-action: none; user-select: none; -webkit-user-select: none; }
  .sl-fab:hover { background: #7f1b2a; }
  .sl-fab:active { cursor: grabbing; }
  .sl-fab__dot { position: absolute; top: 3px; right: 3px; width: 12px; height: 12px; border-radius: 50%; background: #ffcf40; border: 2px solid #fff; }
  .slr-float { position: fixed; z-index: 950; background: #fff; border: 1px solid #d5d5d5; border-radius: 10px; box-shadow: 0 10px 36px rgba(0,0,0,.22); display: flex; flex-direction: column; overflow: hidden; }
  .slr-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #9e2335; border-bottom: 1px solid #8a1e2e; flex: 0 0 auto; }
  .slr-title { font-weight: bold; font-size: 14px; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sl-hbtn { border: none; background: transparent; cursor: pointer; font-size: 15px; color: rgba(255,255,255,.85); padding: 2px 6px; border-radius: 4px; }
  .sl-hbtn:hover { background: rgba(255,255,255,.18); color: #fff; }
  .slr-body { flex: 1 1 auto; display: flex; min-height: 0; }
  .slr-statement { flex: 0 0 44%; max-width: 44%; overflow-y: auto; border-right: 1px solid #e5e5e5; padding: 12px 16px; background: #fff; font-size: 14px; }
  .slr-statement h1, .slr-statement h2, .slr-statement h3 { font-size: 16px; margin: 10px 0 6px; }
  .slr-statement pre { background: #f4f4f4; padding: 8px; border-radius: 4px; overflow-x: auto; }
  .slr-chatcol { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  .slr-chat { flex: 1 1 auto; overflow-y: auto; padding: 10px 12px; background: #fafafa; }
  .sl-msg { display: flex; margin: 6px 0; }
  .sl-msg.user { justify-content: flex-end; }
  .sl-bubble { max-width: 85%; padding: 8px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.5; word-break: break-word; }
  .sl-msg.user .sl-bubble { background: #f6dde2; border-bottom-right-radius: 3px; }
  .sl-msg.assistant .sl-bubble { background: #fff; border: 1px solid #e4e4e4; border-bottom-left-radius: 3px; }
  .sl-bubble pre { background: #f4f4f4; padding: 8px; border-radius: 4px; overflow-x: auto; }
  .sl-bubble code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 12.5px; }
  .sl-bubble pre code { background: none; padding: 0; }
  .sl-bubble p { margin: 0 0 6px; }
  .sl-bubble p:last-child { margin-bottom: 0; }
  .sl-bubble ul, .sl-bubble ol { margin: 4px 0 6px 18px; padding: 0; }
  .sl-bubble li { margin: 2px 0; }
  .sl-bubble h1, .sl-bubble h2, .sl-bubble h3, .sl-bubble h4 { font-size: 14px; margin: 8px 0 4px; }
  .sl-bubble table { border-collapse: collapse; margin: 6px 0; }
  .sl-bubble th, .sl-bubble td { border: 1px solid #ddd; padding: 2px 6px; font-size: 12.5px; }
  .sl-bubble blockquote { border-left: 3px solid #ccc; margin: 6px 0; padding: 2px 8px; color: #666; }
  .sl-divider { text-align: center; margin: 10px 0; color: #999; font-size: 12px; }
  .sl-divider span { background: #ececec; border-radius: 10px; padding: 2px 10px; }
  .sl-divider.accepted span { background: #d3f1d3; color: #25ad40; }
  .slr-typing { color: #888; font-style: italic; font-size: 13px; margin: 0; padding: 4px 12px; display: none; flex: 0 0 auto; }
  .slr-input-row { display: flex; margin: 0; padding: 8px; border-top: 1px solid #e6e6e6; flex: 0 0 auto; background: #fff; }
  .slr-input-row textarea { flex: 1; resize: none; height: 56px; }
  .slr-input-row button { margin-left: 8px; align-self: flex-end; }
  .slr-input-row .button.primary { background: #9e2335; border-color: #9e2335; }
  .slr-input-row .button.primary:hover { background: #7f1b2a; border-color: #7f1b2a; }
  .sl-empty { color: #888; text-align: center; padding: 30px 16px; font-size: 13px; }
  .slr-h { font-size: 17px; margin: 2px 0 10px; }
  .slr-h3 { font-size: 15px; margin: 12px 0 8px; }
  .slr-sep { border: none; border-top: 1px solid #e3e3e3; margin: 16px 0 12px; }
  .slr-attempt { margin: 8px 0; border: 1px solid #e6e6e6; border-radius: 6px; background: #fbfbfb; }
  .slr-attempt summary { cursor: pointer; padding: 6px 10px; font-size: 12.5px; color: #444; user-select: none; }
  .slr-attempt[open] summary { border-bottom: 1px solid #eee; }
  .slr-attempt pre { margin: 0; border-radius: 0 0 6px 6px; }
  .slr-badge { display: inline-block; border-radius: 8px; padding: 0 8px; font-size: 11.5px; margin-right: 4px; background: #fbdedb; color: #c0392b; }
  .slr-badge.pass { background: #d3f1d3; color: #25ad40; }
  @media (max-width: 900px) { .slr-statement { display: none; } }
  @media (max-width: 600px) {
    .slr-float { right: 8px !important; left: 8px !important; bottom: 8px !important; top: auto !important; width: auto !important; height: min(560px, calc(100vh - 60px)) !important; }
    .sl-fab { right: 12px; }
  }
`;

export default new NamedPage('record_detail', async () => {
  const params = new URLSearchParams(window.location.search);
  const ssid = params.get('slssid');
  const pid = params.get('slpid');
  if (!ssid || !pid) return; // a normal record page — do nothing
  const m = window.location.pathname.match(/^(.*)\/record\/([0-9a-f]{24})/i);
  if (!m) return;
  const prefix = m[1];
  const rid = m[2];
  const base = `${prefix}/self-learning/${encodeURIComponent(ssid)}/p/${encodeURIComponent(pid)}`;
  const tutorUrl = `${base}/tutor`;
  const recordUrl = `${base}/record`;

  // Probe the tutor first: for admins, misconfigured sites, or foreign records
  // this throws — then this page behaves like any normal record page.
  let priorMessages = [];
  try {
    const res = await request.get(tutorUrl);
    priorMessages = res.messages || [];
  } catch (e) {
    return;
  }

  /* ------------------------------- DOM ------------------------------------ */

  $('<style>').attr('id', 'slr-style').text(STYLE).appendTo(document.head);
  const $fab = $(tpl`
    <button id="slr-fab" class="sl-fab" type="button" title="${i18n('AI Socratic Tutor')}">
      <span>🤖</span><span class="sl-fab__dot" id="slr-fab-dot" style="display:none"></span>
    </button>
  `).appendTo(document.body);
  const $tutor = $(tpl`
    <div id="slr-float" class="slr-float" style="display:none" role="dialog" aria-label="${i18n('AI Socratic Tutor')}">
      <div class="slr-header">
        <span class="slr-title">🤖 ${i18n('AI Socratic Tutor')}</span>
        <span class="slr-actions">
          <button id="slr-expand" type="button" class="sl-hbtn" title="${i18n('Expand')}">⤢</button>
          <button id="slr-reset" type="button" class="sl-hbtn" title="${i18n('Reset conversation')}">↺</button>
          <button id="slr-close" type="button" class="sl-hbtn" title="${i18n('Minimize')}">–</button>
        </span>
      </div>
      <div class="slr-body">
        <div class="slr-statement typo" id="slr-statement">
          <div class="sl-empty">${i18n('Loading problem statement...')}</div>
        </div>
        <div class="slr-chatcol">
          <div class="slr-chat" id="slr-chat"></div>
          <div class="slr-typing" id="slr-typing">${i18n('The tutor is thinking...')}</div>
          <div class="slr-input-row">
            <textarea id="slr-input" class="textbox" placeholder="${i18n('Explain your thinking, answer the tutor, or ask for guidance... (Enter to send)')}"></textarea>
            <button id="slr-send" class="rounded primary button" type="button">${i18n('Send')}</button>
          </div>
        </div>
      </div>
    </div>
  `).appendTo(document.body);
  const $chat = $('#slr-chat');
  const $typing = $('#slr-typing');
  const $input = $('#slr-input');
  const $fabDot = $('#slr-fab-dot');
  let panelOpen = false;
  let isExpanded = false;
  let waiting = false;
  let tutorStarted = false;
  let judged = false;

  /* ------------------------- launcher: drag + layout ----------------------- */

  let fabFrac = null;
  let fabDragMoved = false;

  function isNarrowViewport() {
    return window.matchMedia('(max-width: 600px)').matches;
  }

  function topBound() {
    const nav = document.querySelector('.nav');
    const h = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
    return Math.max(EDGE, h + EDGE);
  }

  function fabPixelPos() {
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    if (!fabFrac) return { x: iw - FAB_SIZE - 24, y: (ih - FAB_SIZE) / 2 };
    const minY = topBound();
    const rangeX = Math.max(0, iw - FAB_SIZE - EDGE * 2);
    const rangeY = Math.max(0, ih - FAB_SIZE - minY - EDGE);
    return { x: EDGE + fabFrac.fx * rangeX, y: minY + fabFrac.fy * rangeY };
  }

  function syncFab() {
    if (!fabFrac) return;
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
    } catch (e) { /* default center-right */ }
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
      if (!fabDragMoved && Math.hypot(dx, dy) < 5) return;
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
        } catch (e) { /* best-effort */ }
      }
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
  }

  /** Two-pane window geometry: large by default, wider when expanded. */
  function applyLayout() {
    if (!panelOpen) return;
    if (isNarrowViewport()) {
      $tutor.css({
        left: '', top: '', right: '', bottom: '', width: '', height: '',
      });
      return;
    }
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    const w = Math.min(isExpanded ? 1500 : 1100, iw - EDGE * 2);
    const h = ih - topBound() - EDGE;
    const fp = fabPixelPos();
    const left = Math.min(Math.max(EDGE, fp.x + FAB_SIZE - w), iw - w - EDGE);
    const top = Math.min(Math.max(topBound(), fp.y + FAB_SIZE - h), ih - h - EDGE);
    $tutor.css({
      width: `${w}px`, height: `${h}px`, left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto',
    });
  }

  function openPanel() {
    panelOpen = true;
    $tutor.show();
    applyLayout();
    $fab.hide();
    $fabDot.hide();
    if (!$chat.children().length) {
      $chat.append(`<div class="sl-empty">${escapeHtml(i18n(judged ? 'The tutor is thinking...' : 'Waiting for the judge...'))}</div>`);
    }
    scrollChat();
    $input.trigger('focus');
  }

  function closePanel() {
    panelOpen = false;
    $tutor.hide();
    $fab.show();
  }

  /* -------------------------------- chat ----------------------------------- */

  function scrollChat() {
    if ($chat.length) $chat.scrollTop($chat[0].scrollHeight);
  }

  function highlight($dom) {
    import('vj/components/highlighter/prismjs')
      .then(({ default: prism }) => prism.highlightBlocks($dom))
      .catch(() => { /* optional */ });
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
      $msg.find('.sl-bubble').html(escapeHtml(String(content || '')).replace(/\n/g, '<br>'));
    } else {
      $msg.find('.sl-bubble').html(md.render(String(content || '')));
      highlight($msg);
      if (!panelOpen) $fabDot.show();
    }
    $chat.append($msg);
    scrollChat();
  }

  function renderMessages(messages) {
    $chat.empty();
    for (const msg of messages || []) {
      if (msg.kind === 'attempt') appendDivider(msg.content);
      else if (msg.kind === 'accepted') appendDivider(msg.content, true);
      else appendBubble(msg.role, msg.content);
    }
  }

  function setTyping(on) {
    waiting = on;
    $typing.toggle(on);
    $('#slr-send').prop('disabled', on);
  }

  async function startTutor() {
    setTyping(true);
    try {
      const res = await request.post(tutorUrl, { operation: 'start', rid });
      renderMessages(res.messages);
      tutorStarted = true;
    } catch (e) {
      appendBubble('assistant', `⚠️ ${e.message}`);
    } finally {
      setTyping(false);
    }
  }

  async function sendMessage() {
    if (waiting) return;
    const text = ($input.val() || '').trim();
    if (!text) return;
    if (!tutorStarted) {
      Notification.warn(i18n('Waiting for the judge...'));
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

  /* ------------------------- statement + verdict --------------------------- */

  const PRISM_LANG = {
    py: 'python', cc: 'cpp', c: 'c', pas: 'pascal', java: 'java', kt: 'kotlin', js: 'javascript', ts: 'typescript', go: 'go', rs: 'rust', rb: 'ruby', cs: 'csharp', php: 'php', bash: 'bash',
  };
  const prismLang = (lang) => PRISM_LANG[String(lang || '').split('.')[0]] || 'none';

  function renderLeftPane(problem, attempts) {
    const $st = $('#slr-statement');
    if (!problem) {
      $st.html(`<div class="sl-empty">${escapeHtml(i18n('Loading problem statement...'))}</div>`);
      return;
    }
    // Problem title + description, rendered as markdown.
    let html = `<h2 class="slr-h">${escapeHtml(String(problem.pid))}. ${escapeHtml(String(problem.title))}</h2>`;
    html += md.render(String(problem.statementRaw || ''));
    // The student's submission trajectory: every attempt with its verdict and code.
    if (attempts && attempts.length) {
      html += `<hr class="slr-sep"><h3 class="slr-h3">${escapeHtml(i18n('Submitted code'))}</h3>`;
      attempts.forEach((a, idx) => {
        const open = idx === attempts.length - 1 ? ' open' : '';
        const when = a.at ? new Date(a.at).toLocaleString() : '';
        html += `<details class="slr-attempt"${open}>`
          + `<summary><span class="slr-badge${a.accepted ? ' pass' : ''}">${escapeHtml(a.statusText || '')}</span>`
          + `${escapeHtml(i18n('Attempt'))} #${idx + 1} · ${escapeHtml(String(a.score ?? 0))} · ${escapeHtml(a.lang || '')}${when ? ` · ${escapeHtml(when)}` : ''}</summary>`
          + `<pre><code class="language-${prismLang(a.lang)}">${escapeHtml(a.code || '')}</code></pre>`
          + '</details>';
      });
    }
    $st.html(html);
    highlight($st);
  }

  async function fetchRecord(full) {
    return request.get(`${recordUrl}?rid=${rid}${full ? '&full=true' : ''}`);
  }

  /* -------------------------------- wiring --------------------------------- */

  initFabDrag();
  $fab.on('click', () => {
    if (fabDragMoved) {
      fabDragMoved = false;
      return;
    }
    openPanel();
  });
  $('#slr-close').on('click', closePanel);
  $('#slr-expand').on('click', () => {
    isExpanded = !isExpanded;
    $('#slr-expand').text(isExpanded ? '⤡' : '⤢').attr('title', i18n(isExpanded ? 'Collapse' : 'Expand'));
    applyLayout();
    scrollChat();
  });
  $(document).on('keydown', (ev) => {
    if (ev.key === 'Escape' && panelOpen && isExpanded) {
      isExpanded = false;
      $('#slr-expand').text('⤢').attr('title', i18n('Expand'));
      applyLayout();
    }
  });
  $('#slr-send').on('click', sendMessage);
  $input.on('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage();
    }
  });
  $('#slr-reset').on('click', () => {
    new ConfirmDialog({
      $body: tpl.typoMsg(i18n('Reset this tutoring conversation? The tutor will forget everything discussed so far.')),
    }).open().then(async (action) => {
      if (action !== 'yes') return;
      try {
        await request.post(tutorUrl, { operation: 'reset' });
        $chat.empty();
        tutorStarted = false;
        await startTutor();
      } catch (e) {
        Notification.error(e.message);
      }
    });
  });
  $(window).on('resize', () => {
    syncFab();
    applyLayout();
  });

  /* --------------------------------- boot ---------------------------------- */

  if (priorMessages.length) renderMessages(priorMessages);

  let data = null;
  try {
    data = await fetchRecord(true);
    renderLeftPane(data.problem, data.attempts);
  } catch (e) {
    return; // record not visible to this user
  }
  for (let i = 0; i < MAX_POLLS && !data.judged; i++) {
    await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL); }); // eslint-disable-line no-await-in-loop
    try {
      data = await fetchRecord(false); // eslint-disable-line no-await-in-loop
    } catch (e) { break; }
  }
  if (!data?.judged) {
    $fabDot.show();
    return;
  }
  judged = true;
  // Refresh the trajectory so the just-judged attempt shows its final verdict.
  try {
    const fresh = await fetchRecord(true);
    renderLeftPane(fresh.problem, fresh.attempts);
  } catch (e) { /* keep the earlier render */ }
  // Judged: open the window and start the tutor — Socratic debugging on failure,
  // the post-acceptance extension coaching (explain-a-line, idiomatic upgrades,
  // complexity probes, stretch goals) on success.
  openPanel();
  await startTutor();
});
