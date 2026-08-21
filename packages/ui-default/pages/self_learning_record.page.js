import $ from 'jquery';
import MarkdownIt from 'markdown-it';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, request, tpl } from 'vj/utils';
import {
  ensureSparkStyle, openSparkPopover, showBadgeToasts, sparkChipText,
} from 'vj/pages/self_learning_solve.page';

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
  @keyframes slrFabDotPing { 0% { box-shadow: 0 0 0 0 rgba(255,207,64,.75); } 100% { box-shadow: 0 0 0 9px rgba(255,207,64,0); } }
  @keyframes slrPanelIn { from { opacity: 0; transform: translateY(14px) scale(.97); } to { opacity: 1; transform: none; } }
  @keyframes slrTypingShine { to { background-position: -200% center; } }
  .sl-fab { position: fixed; right: 24px; top: 50%; transform: translateY(-50%); z-index: 900; width: ${FAB_SIZE}px; height: ${FAB_SIZE}px; border-radius: 50%; border: none; background: radial-gradient(circle at 30% 28%, #e35d6a, #9e2335 72%); color: #fff; font-size: 26px; line-height: ${FAB_SIZE}px; text-align: center; padding: 0; cursor: grab; box-shadow: 0 10px 26px -8px rgba(158,35,53,.65), 0 0 0 4px rgba(158,35,53,.12); touch-action: none; user-select: none; -webkit-user-select: none; transition: transform .16s ease, box-shadow .16s ease, filter .16s ease; }
  .sl-fab:hover { transform: translateY(-50%) scale(1.07); filter: brightness(1.06); }
  .sl-fab:active { cursor: grabbing; transform: translateY(-50%) scale(.96); }
  .sl-fab__dot { position: absolute; top: 3px; right: 3px; width: 12px; height: 12px; border-radius: 50%; background: #ffcf40; border: 2px solid #fff; animation: slrFabDotPing 1.6s ease-out infinite; }
  .slr-float { position: fixed; z-index: 950; background: #fff; border: 1px solid #eadfe3; border-radius: 16px; box-shadow: 0 24px 60px -16px rgba(15,23,42,.45); display: flex; flex-direction: column; overflow: hidden; animation: slrPanelIn .24s cubic-bezier(.2,.8,.3,1); }
  .slr-header { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; background: linear-gradient(120deg, #9e2335, #c2255c); box-shadow: 0 2px 8px rgba(158,35,53,.35); flex: 0 0 auto; }
  .slr-title { font-weight: bold; font-size: 14px; letter-spacing: .01em; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.18); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slr-spark-chip { margin-left: auto; margin-right: 6px; flex: 0 0 auto; background: rgba(255,255,255,.18); color: #fff; border: 1px solid rgba(255,255,255,.35); border-radius: 999px; font-size: 11px; font-weight: bold; padding: 2px 10px; cursor: pointer; transition: background-color .15s ease, transform .15s ease; }
  .slr-spark-chip:hover { background: rgba(255,255,255,.3); transform: translateY(-1px); }
  .pta-dark .slr-spark-chip { background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.28); }
  .sl-hbtn { border: none; background: transparent; cursor: pointer; font-size: 15px; color: rgba(255,255,255,.88); width: 26px; height: 26px; padding: 0; border-radius: 50%; line-height: 1; transition: background .15s ease, color .15s ease; }
  .sl-hbtn:hover { background: rgba(255,255,255,.2); color: #fff; }
  .slr-body { flex: 1 1 auto; display: flex; min-height: 0; }
  .slr-statement { flex: 0 0 44%; max-width: 44%; overflow-y: auto; border-right: 1px solid #eceff5; padding: 14px 18px; background: #fbfcfe; font-size: 14px; scrollbar-width: thin; }
  .slr-statement h1, .slr-statement h2, .slr-statement h3 { font-size: 16px; margin: 10px 0 6px; color: #2b3a55; }
  .slr-statement pre { background: #f4f6fa; border: 1px solid #e8ecf3; padding: 8px 10px; border-radius: 8px; overflow-x: auto; }
  .slr-chatcol { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  .slr-chat { flex: 1 1 auto; overflow-y: auto; padding: 10px 12px; background: #f7f8fb; scrollbar-width: thin; }
  .sl-msg { display: flex; margin: 8px 0; }
  .sl-msg.user { justify-content: flex-end; }
  .sl-bubble { max-width: 85%; padding: 8px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.5; word-break: break-word; }
  .sl-msg.user .sl-bubble { background: linear-gradient(135deg, #fbe3e9, #f6d2dc); border: 1px solid #f0c8d3; border-bottom-right-radius: 4px; }
  .sl-msg.assistant .sl-bubble { background: #fff; border: 1px solid #e8e9ef; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(15,23,42,.06); }
  .sl-bubble pre { background: #f6f7f9; border: 1px solid #e6e8ee; padding: 6px 8px; border-radius: 8px; overflow-x: auto; margin: 6px 0; }
  .sl-bubble code { background: #f3eef0; padding: 0 4px; border-radius: 4px; font-size: 12.5px; color: #b02452; }
  .sl-bubble pre code { background: none; padding: 0; color: inherit; }
  .sl-bubble p { margin: 0 0 6px; }
  .sl-bubble p:last-child { margin-bottom: 0; }
  .sl-bubble ul, .sl-bubble ol { margin: 4px 0 6px 18px; padding: 0; }
  .sl-bubble li { margin: 2px 0; }
  .sl-bubble h1, .sl-bubble h2, .sl-bubble h3, .sl-bubble h4 { font-size: 14px; margin: 8px 0 4px; }
  .sl-bubble table { border-collapse: collapse; margin: 6px 0; }
  .sl-bubble th, .sl-bubble td { border: 1px solid #ddd; padding: 2px 6px; font-size: 12.5px; }
  .sl-bubble blockquote { border-left: 3px solid #e0b3bf; margin: 6px 0; padding: 2px 8px; color: #666; background: #fdf7f9; border-radius: 0 6px 6px 0; }
  .sl-divider { display: flex; align-items: center; gap: 10px; margin: 12px 0; color: #98a2ac; font-size: 12px; }
  .sl-divider::before, .sl-divider::after { content: ''; flex: 1 1 auto; height: 1px; background: linear-gradient(90deg, transparent, #dfe3eb, transparent); }
  .sl-divider span { background: #eef0f5; border: 1px solid #e2e6ee; border-radius: 999px; padding: 2px 12px; white-space: nowrap; }
  .sl-divider.accepted span { background: linear-gradient(135deg, #e3f7e7, #cff0d6); border-color: #a9dfb5; color: #237032; font-weight: bold; }
  .slr-typing { font-size: 13px; margin: 0; padding: 5px 12px; display: none; flex: 0 0 auto; background-image: linear-gradient(90deg, #b02452 25%, #e58a97 50%, #b02452 75%); background-size: 200% auto; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: #b02452; animation: slrTypingShine 1.4s linear infinite; }
  .slr-input-row { display: flex; margin: 0; padding: 8px; border-top: 1px solid #f0e6e9; flex: 0 0 auto; background: #fff; }
  .slr-input-row textarea { flex: 1; resize: none; height: 56px; border-radius: 10px; }
  .slr-input-row textarea:focus { border-color: #c2255c !important; box-shadow: 0 0 0 3px rgba(194,37,92,.13) !important; }
  .slr-input-row button { margin-left: 8px; align-self: flex-end; }
  .slr-input-row .button.primary { background: linear-gradient(135deg, #c2255c, #9e2335); border-color: transparent; box-shadow: 0 6px 14px -6px rgba(158,35,53,.6); }
  .slr-input-row .button.primary:hover { background: linear-gradient(135deg, #c2255c, #9e2335); filter: brightness(1.08); }
  .sl-empty { color: #98a2ac; text-align: center; padding: 30px 16px; font-size: 13px; border: 1px dashed #dfe4ec; border-radius: 12px; margin: 14px; background: #fbfcfe; }
  .slr-h { font-size: 17px; margin: 2px 0 10px; color: #2b3a55; }
  .slr-h3 { font-size: 15px; margin: 12px 0 8px; color: #33415c; }
  .slr-sep { border: none; border-top: 1px solid #e9edf5; margin: 16px 0 12px; }
  .slr-attempt { margin: 9px 0; border: 1px solid #e9edf5; border-radius: 12px; background: #fff; overflow: hidden; box-shadow: 0 1px 3px rgba(15,23,42,.05); transition: box-shadow .15s ease; }
  .slr-attempt:hover { box-shadow: 0 6px 16px -6px rgba(15,23,42,.14); }
  .slr-attempt summary { cursor: pointer; padding: 8px 12px; font-size: 12.5px; color: #444; user-select: none; }
  .slr-attempt[open] summary { border-bottom: 1px solid #eef1f6; background: linear-gradient(180deg, #fbfcfe, #f6f8fc); }
  .slr-attempt pre { margin: 0; border-radius: 0; background: #f7f9fc; padding: 10px; }
  .slr-badge { display: inline-block; border-radius: 999px; padding: 1px 10px; font-size: 11.5px; font-weight: 500; margin-right: 6px; background: #ffe6e3; color: #c0392b; }
  .slr-badge.pass { background: linear-gradient(135deg, #d9f5dd, #c2ecc9); color: #237032; }
  .pta-dark .slr-typing { background-image: linear-gradient(90deg, #ff8a99 25%, #ffc9d1 50%, #ff8a99 75%); color: #ff8a99; }
  .pta-dark .slr-float { background: #23272c; border-color: #333a41; box-shadow: 0 24px 60px -16px rgba(0,0,0,.7); }
  .pta-dark .slr-statement { background: #1e2227; border-right-color: #2e3338; color: #cfd6dd; }
  .pta-dark .slr-statement h1, .pta-dark .slr-statement h2, .pta-dark .slr-statement h3 { color: #dbe2ea; }
  .pta-dark .slr-statement pre { background: #1b1f24; border-color: #30363d; color: #d4d4d4; }
  .pta-dark .slr-chat { background: #1c2025; }
  .pta-dark .sl-msg.assistant .sl-bubble { background: #2a3036; border-color: #3a424b; color: #d5dade; box-shadow: none; }
  .pta-dark .sl-msg.user .sl-bubble { background: linear-gradient(135deg, #4a2630, #3c1f27); border-color: #5c3a41; color: #f2d9de; }
  .pta-dark .sl-bubble pre { background: #1b1f24; border-color: #30363d; color: #d4d4d4; }
  .pta-dark .sl-bubble code { background: #32282c; color: #e6bfc5; }
  .pta-dark .sl-bubble pre code { background: none; color: inherit; }
  .pta-dark .sl-bubble th, .pta-dark .sl-bubble td { border-color: #3a424b; }
  .pta-dark .sl-bubble blockquote { border-left-color: #6e4a54; color: #c3aab1; background: #2b2226; }
  .pta-dark .sl-divider::before, .pta-dark .sl-divider::after { background: linear-gradient(90deg, transparent, #3a424b, transparent); }
  .pta-dark .sl-divider span { background: #2a3036; border-color: #3a424b; color: #aab4be; }
  .pta-dark .sl-divider.accepted span { background: #1e3524; border-color: #2f5e3a; color: #69db7c; }
  .pta-dark .slr-input-row { background: #23272c; border-top-color: #3a2c30; }
  .pta-dark .slr-input-row textarea { background: #1e2227; border-color: #3a424b; color: #d5dade; }
  .pta-dark .sl-empty { color: #98a2ac; border-color: #3a424b; background: #1e2227; }
  .pta-dark .slr-h, .pta-dark .slr-h3 { color: #dbe2ea; }
  .pta-dark .slr-sep { border-top-color: #2e3338; }
  .pta-dark .slr-attempt { background: #23272c; border-color: #333a41; box-shadow: none; }
  .pta-dark .slr-attempt summary { color: #cfd6dd; }
  .pta-dark .slr-attempt[open] summary { border-bottom-color: #333a41; background: linear-gradient(180deg, #262b31, #23272c); }
  .pta-dark .slr-attempt pre { background: #1b1f24; color: #d4d4d4; }
  .pta-dark .slr-badge { background: #3a2225; color: #ff8787; }
  .pta-dark .slr-badge.pass { background: #1e3524; color: #69db7c; }
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
  let sparkState = null;
  let sparkCatalog = [];

  function absorbSpark(res) {
    if (!res) return;
    if (res.badgeCatalog) sparkCatalog = res.badgeCatalog;
    if (res.spark) {
      sparkState = res.spark;
      ensureSparkStyle();
      $('#slr-spark-chip').text(sparkChipText(sparkState)).show();
    }
    if (res.newBadges && res.newBadges.length) showBadgeToasts(res.newBadges);
  }
  $(document).on('click', '#slr-spark-chip', function onSparkChip() {
    openSparkPopover(sparkState, sparkCatalog, this);
  });
  try {
    const res = await request.get(tutorUrl);
    priorMessages = res.messages || [];
    absorbSpark(res);
  } catch (e) {
    return;
  }

  /* ------------------------------- DOM ------------------------------------ */

  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
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
        <button id="slr-spark-chip" class="slr-spark-chip" type="button" title="${i18n('My progress')}" style="display:none"></button>
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
      absorbSpark(res);
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
