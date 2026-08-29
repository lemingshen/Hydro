import $ from 'jquery';
import * as yaml from 'js-yaml';
import MarkdownIt from 'markdown-it';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, loadReactRedux, request, tpl } from 'vj/utils';
// Direct import: pulls the rail module into the bundle through the dependency
// graph, so the session rail never depends on the page-loader picking up a
// newly added file.
import { injectRailForPage, injectRailWhenReady } from './auto_scratchpad.page';
import { openDB } from 'vj/utils/db';

/* ------------------------- Tutor Spark (motivation) ------------------------- */
/*
 * The tutor's motivation layer: momentum chip, badge toasts + confetti, an
 * achievements popover, and the Boss Challenge flows. Exported so the record
 * page reuses the exact same look.
 */

const SPARK_STYLE = `
  @keyframes slSparkIn { from { opacity: 0; transform: translateX(26px) scale(.96); } to { opacity: 1; transform: none; } }
  @keyframes slSparkOut { to { opacity: 0; transform: translateX(26px) scale(.96); } }
  @keyframes slSparkIcon { 0% { transform: scale(.4) rotate(-14deg); } 60% { transform: scale(1.18) rotate(5deg); } 100% { transform: none; } }
  .sl-spark-toastwrap { position: fixed; top: 60px; right: 16px; z-index: 4000; display: flex; flex-direction: column; gap: 10px; pointer-events: none; }
  .sl-spark-toast { pointer-events: auto; display: flex; gap: 11px; align-items: center; width: 300px; max-width: calc(100vw - 32px); background: linear-gradient(var(--pta-card), var(--pta-card)) padding-box, linear-gradient(120deg, #ffd43b, #9775fa) border-box; border: 2px solid transparent; border-radius: 14px; padding: 10px 13px; box-shadow: 0 14px 34px -12px rgba(95, 61, 196, .45); cursor: pointer; animation: slSparkIn .3s var(--pta-ease); }
  .sl-spark-toast--out { animation: slSparkOut .25s ease forwards; }
  .sl-spark-toast__icon { font-size: 27px; line-height: 1; flex: 0 0 auto; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .15)); animation: slSparkIcon .5s var(--pta-ease) both; }
  .sl-spark-toast__k { font-size: 10.5px; font-weight: bold; letter-spacing: .08em; text-transform: uppercase; color: #b08d00; }
  .sl-spark-toast__t { font-size: 13.5px; font-weight: bold; color: var(--pta-ink); margin: 1px 0; }
  .sl-spark-toast__d { font-size: 11.5px; color: var(--pta-ink-soft); line-height: 1.4; }
  .pta-dark .sl-spark-toast__k { color: #e6c34c; }
  .sl-spark-pop { position: fixed; z-index: 3990; width: 320px; max-width: calc(100vw - 24px); max-height: min(480px, calc(100vh - 100px)); overflow-y: auto; background: var(--pta-card); border: 1px solid var(--pta-line); border-radius: 14px; box-shadow: var(--pta-shadow-pop); padding: 12px 14px; scrollbar-width: thin; animation: ptaScaleIn .22s var(--pta-ease); }
  .sl-spark-pop__head { display: flex; align-items: center; justify-content: space-between; font-weight: bold; font-size: 13.5px; color: var(--pta-ink); margin-bottom: 8px; }
  .sl-spark-pop__stats { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .sl-spark-pop__stat { font-size: 11.5px; background: var(--pta-card-3); border: 1px solid var(--pta-line); border-radius: 999px; padding: 2px 10px; color: var(--pta-ink-soft); }
  .sl-spark-badge { display: flex; gap: 10px; align-items: center; padding: 7px 8px; border-radius: 10px; transition: background .15s ease, transform .15s var(--pta-ease); }
  .sl-spark-badge:hover { background: var(--pta-card-2); transform: translateX(2px); }
  .sl-spark-badge__icon { font-size: 22px; width: 30px; text-align: center; flex: 0 0 auto; }
  .sl-spark-badge--locked { opacity: .55; }
  .sl-spark-badge--locked .sl-spark-badge__icon { filter: grayscale(1); }
  .sl-spark-badge__t { font-size: 12.5px; font-weight: bold; color: var(--pta-ink); }
  .sl-spark-badge__d { font-size: 11px; color: var(--pta-ink-faint); line-height: 1.35; }
  .sl-spark-badge__lock { margin-left: auto; font-size: 10px; color: var(--pta-ink-faint); border: 1px solid var(--pta-line); border-radius: 999px; padding: 0 8px; flex: 0 0 auto; }
  .sl-choffer { margin: 10px 0; padding: 10px 12px; border: 1px solid var(--pta-warn-line); border-left: 4px solid var(--pta-warn); border-radius: 12px; background: var(--pta-warn-soft); font-size: 13px; color: var(--pta-ink); box-shadow: 0 4px 14px -8px rgba(232, 89, 12, .5); animation: ptaFadeUp .26s var(--pta-ease) both; }
  .sl-choffer__btns { display: flex; gap: 8px; margin-top: 8px; }
  .sl-choffer__btns button { border: none; border-radius: 999px; padding: 5px 15px; font-size: 12.5px; cursor: pointer; transition: filter .12s ease, transform .12s var(--pta-ease); }
  .sl-chaccept { background: var(--pta-grad-warn); color: #fff; box-shadow: 0 5px 12px -5px rgba(232, 89, 12, .7); font-weight: bold; }
  .sl-chaccept:hover { filter: brightness(1.08); transform: translateY(-1px); }
  .sl-chlater { background: var(--pta-card); color: var(--pta-warn-text); border: 1px solid var(--pta-warn-line) !important; }
  .sl-chlater:hover { background: var(--pta-warn-soft); }
  .sl-chbar { display: flex; align-items: center; gap: 8px; margin: 0; padding: 5px 12px; font-size: 12px; font-weight: bold; color: var(--pta-warn-text); background: var(--pta-warn-soft); border-top: 1px solid var(--pta-warn-line); flex: 0 0 auto; }
  .sl-chbar a { margin-left: auto; color: var(--pta-warn-text); font-weight: normal; }
`;

export function ensureSparkStyle() {
  if (!document.getElementById('sl-spark-style')) {
    $('<style>').attr('id', 'sl-spark-style').text(SPARK_STYLE).appendTo(document.head);
  }
}

/** Lightweight canvas confetti — celebration without a dependency. */
export function confettiBurst() {
  try {
    const cv = document.createElement('canvas');
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
    cv.style.cssText = 'position:fixed;inset:0;z-index:4100;pointer-events:none';
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');
    const COLORS = ['#ffd43b', '#ff922b', '#ff6b6b', '#9775fa', '#4dabf7', '#40c057', '#f783ac'];
    const parts = [];
    for (let i = 0; i < 140; i++) {
      const a = (Math.PI * (0.15 + 0.7 * Math.random())) + Math.PI; // upward fan
      const v = 7 + Math.random() * 9;
      parts.push({
        x: cv.width / 2 + (Math.random() - 0.5) * 160,
        y: cv.height * 0.62,
        vx: Math.cos(a) * v * (Math.random() < 0.5 ? 1 : -1),
        vy: Math.sin(a) * v,
        w: 5 + Math.random() * 6,
        h: 3 + Math.random() * 5,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        color: COLORS[i % COLORS.length],
        life: 80 + Math.random() * 40,
      });
    }
    let frame = 0;
    const tick = () => {
      frame += 1;
      ctx.clearRect(0, 0, cv.width, cv.height);
      let alive = 0;
      for (const p of parts) {
        if (frame > p.life) continue;
        alive += 1;
        p.vy += 0.22; p.vx *= 0.992; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - frame / p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive && frame < 150) requestAnimationFrame(tick);
      else cv.remove();
    };
    requestAnimationFrame(tick);
  } catch (e) { /* celebration is optional */ }
}

/** Stacked achievement toasts (top right) + one confetti burst per batch. */
export function showBadgeToasts(newBadges) {
  if (!newBadges || !newBadges.length) return;
  ensureSparkStyle();
  let $wrap = $('.sl-spark-toastwrap');
  if (!$wrap.length) $wrap = $('<div class="sl-spark-toastwrap"></div>').appendTo(document.body);
  for (const b of newBadges) {
    const $t = $(`<div class="sl-spark-toast" role="status">
      <span class="sl-spark-toast__icon">${escapeHtml(b.icon || '🏅')}</span>
      <span><div class="sl-spark-toast__k">${escapeHtml(i18n('New badge unlocked!'))}</div>
      <div class="sl-spark-toast__t">${escapeHtml(b.title || '')}</div>
      <div class="sl-spark-toast__d">${escapeHtml(b.desc || '')}</div></span>
    </div>`);
    const out = () => { $t.addClass('sl-spark-toast--out'); setTimeout(() => $t.remove(), 260); };
    $t.on('click', out);
    setTimeout(out, 7000);
    $wrap.append($t);
  }
  confettiBurst();
}

export function sparkChipText(spark) {
  if (!spark) return '';
  return `🔥 ${spark.streak || 0} · ⭐ ${spark.accepted || 0} · 🏆 ${(spark.badges || []).length}`;
}

/** Achievements popover anchored to a chip element. */
export function openSparkPopover(spark, catalog, anchorEl) {
  ensureSparkStyle();
  const existing = document.getElementById('sl-spark-pop');
  if (existing) { existing.remove(); return; }
  const owned = new Set((spark && spark.badges) || []);
  const s = spark || {};
  const rows = (catalog || []).map((b) => {
    const has = owned.has(b.id);
    return `<div class="sl-spark-badge${has ? '' : ' sl-spark-badge--locked'}">
      <span class="sl-spark-badge__icon">${escapeHtml(b.icon)}</span>
      <span><div class="sl-spark-badge__t">${escapeHtml(b.title)}</div>
      <div class="sl-spark-badge__d">${escapeHtml(b.desc)}</div></span>
      ${has ? '' : `<span class="sl-spark-badge__lock">${escapeHtml(i18n('Locked'))}</span>`}
    </div>`;
  }).join('');
  const $pop = $(`<div class="sl-spark-pop" id="sl-spark-pop">
    <div class="sl-spark-pop__head"><span>🏆 ${escapeHtml(i18n('Achievements'))}</span></div>
    <div class="sl-spark-pop__stats">
      <span class="sl-spark-pop__stat">🔥 ${s.streak || 0} ${escapeHtml(i18n('day streak'))}</span>
      <span class="sl-spark-pop__stat">⭐ ${s.accepted || 0} ${escapeHtml(i18n('solved'))}</span>
      <span class="sl-spark-pop__stat">🐛 ${s.cardAnswers || 0}</span>
      <span class="sl-spark-pop__stat">⚔️ ${s.challengesCleared || 0}</span>
    </div>${rows}</div>`).appendTo(document.body);
  const r = anchorEl.getBoundingClientRect();
  const w = $pop.outerWidth();
  $pop.css({
    top: `${Math.min(r.bottom + 8, window.innerHeight - $pop.outerHeight() - 12)}px`,
    left: `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`,
  });
  setTimeout(() => {
    $(document).one('pointerdown.slSparkPop', (ev) => {
      if (!$pop[0].contains(ev.target)) $pop.remove();
      else $(document).one('pointerdown.slSparkPop', () => $pop.remove());
    });
  }, 0);
}

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
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark'); // panel styles are template-side
  // Homework-style schedule cues (students only; the server enforces).
  const slSched = UiContext.slSchedule;
  if (slSched && slSched.phase === 'extension') {
    Notification.warn(`⚠️ ${i18n('Late window')} — ${i18n('submissions until')} ${new Date(slSched.hardEndAt).toLocaleString()} ${i18n('count at')} −${slSched.penalty}%`);
  } else if (slSched && slSched.phase === 'ended') {
    Notification.info(i18n('This session has ended — review and tutoring stay open; submissions are closed.'));
  }
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
  let sparkState = null;
  let sparkCatalog = [];
  let challengeInfo = null;
  let chMode = false;
  let chHistory = [];
  let inputPlaceholder0 = null;

  /** Fold any tutor response's spark payload into the UI (chip, toasts). */
  function absorbSpark(res) {
    if (!res) return;
    if (res.badgeCatalog) sparkCatalog = res.badgeCatalog;
    if (res.spark) {
      sparkState = res.spark;
      ensureSparkStyle();
      $('#sl-spark-chip').text(sparkChipText(sparkState)).show();
    }
    if (res.newBadges && res.newBadges.length) showBadgeToasts(res.newBadges);
    if (res.challenge) challengeInfo = res.challenge;
  }
  $(document).on('click', '#sl-spark-chip', function onSparkChip() {
    openSparkPopover(sparkState, sparkCatalog, this);
  });
  let waiting = false;
  let lastRid = null;
  /** Assigned by initScratchpad so the reset handler can clear open cards. */
  let clearScratchpadAnnotations = () => {};

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
    if (!fabFrac) return { x: iw - FAB_SIZE - 24, y: ih - FAB_SIZE - 24 }; // CSS default: bottom right
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

  function appendBubble(role, content, meta = null) {
    $chat.find('.sl-empty').remove();
    const $msg = $(`<div class="sl-msg ${role === 'user' ? 'user' : 'assistant'}"><div class="sl-bubble"></div></div>`);
    const $bubble = $msg.find('.sl-bubble');
    if (role === 'user') {
      $bubble.html(renderUserText(content));
    } else {
      $bubble.html(md.render(String(content || '')));
      import('vj/components/highlighter/prismjs')
        .then(({ default: prism }) => prism.highlightBlocks($msg))
        .catch(() => { /* highlighting is optional */ });
      if (!panelOpen) $fabDot.show();
    }
    if (meta && meta.line) {
      const loc = meta.endLine && meta.endLine !== meta.line ? `L${meta.line}–${meta.endLine}` : `L${meta.line}`;
      $bubble.prepend(`<div class="sl-loc">📍 ${escapeHtml(loc)}</div>`);
    }
    $chat.append($msg);
    if (meta && meta.resolved) {
      const note = meta.accepted
        ? i18n('Great reflection — you have truly mastered this problem!')
        : i18n('Great — now FIX this line in the editor.');
      $chat.append(`<div class="sl-msg assistant"><div class="sl-bubble sl-bubble--note">✏️ ${escapeHtml(note)}</div></div>`);
    }
    scrollChat();
  }

  function renderMessages(messages, replace = true) {
    if (replace) $chat.empty();
    // Card turns inherit their attempt's verdict from the preceding divider,
    // so replayed resolution notes celebrate after acceptance instead of
    // asking for a resubmission.
    let underAccepted = false;
    for (const m of messages || []) {
      if (m.kind === 'attempt') { underAccepted = false; appendDivider(m.content); } // eslint-disable-line brace-style
      else if (m.kind === 'accepted') { underAccepted = true; appendDivider(m.content, true); } // eslint-disable-line brace-style
      else if (m.kind === 'anno') {
        appendBubble(m.role, m.content, {
          line: m.line, endLine: m.endLine, resolved: m.resolved, accepted: underAccepted,
        });
      } else if (UiContext.slType === 'programming') {
        // Legacy button-chat turns are retired for programming problems: the
        // pop-up cards near the code are the only interaction channel there.
        continue; // eslint-disable-line no-continue
      } else appendBubble(m.role, m.content);
    }
  }

  function setTyping(on) {
    waiting = on;
    $typing.toggle(on);
    $('#sl-send').prop('disabled', on);
  }

  function panelEmptyText() {
    return UiContext.slType === 'programming'
      ? i18n('No tutoring history yet. Submit your code — the tutor will pop questions right at your lines.')
      : i18n('Submit your solution first — the tutor starts from a judged attempt.');
  }

  function openPanel() {
    if (!$tutor.length) return;
    panelOpen = true;
    $tutor.show();
    applyPanelLayout();
    $fab.hide();
    $fabDot.hide();
    if (!$chat.children().length) {
      $chat.append(`<div class="sl-empty">${escapeHtml(panelEmptyText())}</div>`);
    }
    scrollChat();
    $input.trigger('focus');
  }

  function closePanel() {
    panelOpen = false;
    $tutor.hide();
    $fab.show(); // the red launcher returns so the chat history stays one click away
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
    if (!UiContext.slTutor) return;
    setTyping(true);
    try {
      const res = await request.post(tutorUrl, { operation: 'accepted', rid });
      absorbSpark(res);
      if (res.marker) appendDivider(res.marker, true);
      if (res.reply) {
        appendBubble('assistant', res.reply);
        tutorStarted = true;
      }
      maybeOfferChallengeChat(res.challenge, rid);
      if (!panelOpen) $fabDot.show();
    } catch (e) { /* non-fatal */ } finally {
      setTyping(false);
    }
  }

  /* ------------------------ Boss Challenge (chat mode) ------------------------ */

  function maybeOfferChallengeChat(ch, rid) {
    if (!ch || !ch.available) return;
    $('.sl-choffer').remove();
    const resume = ch.state === 'active';
    const $row = $(`<div class="sl-choffer">🔥 <b>${escapeHtml(i18n('Boss Challenge'))}</b> — ${escapeHtml(i18n(resume ? 'You have an unfinished Boss Challenge.' : 'Feeling brave? Beat one extra twist of this problem.'))}
      <span class="sl-choffer__btns"><button type="button" class="sl-chaccept">${escapeHtml(i18n(resume ? 'Resume the challenge' : 'Accept the challenge'))} 🔥</button>${resume ? '' : `<button type="button" class="sl-chlater">${escapeHtml(i18n('Maybe later'))}</button>`}</span></div>`);
    $chat.find('.sl-empty').remove();
    $chat.append($row);
    scrollChat();
    if (!panelOpen) $fabDot.show();
    $row.find('.sl-chaccept').on('click', () => startChallengeChat(rid, $row));
    $row.find('.sl-chlater').on('click', async () => {
      try { await request.post(tutorUrl, { operation: 'challengeDecline' }); } catch (e) { /* best-effort */ }
      challengeInfo = { state: 'declined' };
      $row.remove();
    });
  }

  async function startChallengeChat(rid, $row) {
    if (waiting) return;
    setTyping(true);
    try {
      const res = await request.post(tutorUrl, { operation: 'challenge', rid });
      if ($row) $row.remove();
      chMode = true;
      chHistory = [];
      appendDivider(`🔥 ${res.title || i18n('Boss Challenge')}`);
      if (res.hook) appendBubble('assistant', `💡 ${res.hook}`);
      appendBubble('assistant', `🔥 ${res.question}`);
      if (inputPlaceholder0 === null) inputPlaceholder0 = $input.attr('placeholder') || '';
      $input.attr('placeholder', i18n('Type your challenge answer... (Enter to send)'));
      if (!$('#sl-chexit').length) {
        const $bar = $(`<div class="sl-chbar" id="sl-chexit">🔥 ${escapeHtml(i18n('Boss Challenge mode'))} <a href="javascript:;">${escapeHtml(i18n('Exit challenge'))}</a></div>`);
        $bar.find('a').on('click', exitChallengeChat);
        $typing.before($bar);
      }
      openPanel();
    } catch (e) {
      Notification.error(e.message);
    } finally {
      setTyping(false);
      $input.trigger('focus');
    }
  }

  function exitChallengeChat() {
    chMode = false;
    $('#sl-chexit').remove();
    if (inputPlaceholder0 !== null) $input.attr('placeholder', inputPlaceholder0);
  }

  async function sendChallengeReply(text) {
    appendBubble('user', text);
    setTyping(true);
    try {
      const res = await request.post(tutorUrl, {
        operation: 'challengeReply', text, history: JSON.stringify(chHistory.slice(-10)),
      });
      chHistory.push({ role: 'student', content: text });
      chHistory.push({ role: 'tutor', content: res.reply });
      absorbSpark(res);
      appendBubble('assistant', res.reply);
      if (res.cleared) {
        appendDivider(`🏆 ${i18n('Challenge cleared! Legendary work!')}`, true);
        confettiBurst();
        challengeInfo = { state: 'cleared' };
        exitChallengeChat();
      }
    } catch (e) {
      appendBubble('assistant', `⚠️ ${e.message}`);
    } finally {
      setTyping(false);
      $input.trigger('focus');
    }
  }

  async function sendMessage() {
    if (waiting) return;
    const text = ($input.val() || '').trim();
    if (!text) return;
    if (chMode) {
      $input.val('');
      await sendChallengeReply(text);
      return;
    }
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
    if (data.judged && window.__ptaRailMark) {
      const railPid = (window.UiContext && (UiContext.slPid || (UiContext.pdoc && UiContext.pdoc.docId))) || '';
      if (railPid) window.__ptaRailMark(String(railPid), !!data.accepted);
    }
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

    /* --------- "Submitted code" panel at the bottom of the description --------- */

    const PRISM_LANG = {
      py: 'python', cc: 'cpp', c: 'c', pas: 'pascal', java: 'java', kt: 'kotlin', js: 'javascript', ts: 'typescript', go: 'go', rs: 'rust', rb: 'ruby', cs: 'csharp', php: 'php', bash: 'bash',
    };
    const prismLang = (lang) => PRISM_LANG[String(lang || '').split('.')[0]] || 'none';

    const ATTEMPTS_STYLE = `
/* Beautify pass: #sl-attempts / .sl-attempt now ship from
   pta_theme.page.styl together with their dark Prism palette. */
`;

    /**
     * Requirement: every submitted program of this student on this problem,
     * as collapsible cards at the bottom of the problem description. The
     * panel lives inside .problem-content, which the Scratchpad reuses as
     * its statement pane, so it shows both in and out of the IDE. Refreshed
     * after every judged submission; pretest runs are excluded server-side.
     */
    async function refreshAttemptsPanel() {
      let res;
      try {
        res = await request.get(recordUrl); // no rid -> the user's own trajectory
      } catch (e) {
        return; // the panel is best-effort
      }
      const attempts = res.attempts || [];
      if (!document.getElementById('sl-attempts-style')) {
        $('<style>').attr('id', 'sl-attempts-style').text(ATTEMPTS_STYLE).appendTo(document.head);
      }
      let $panel = $('#sl-attempts');
      if (!$panel.length) {
        const $content = $('.problem-content');
        if (!$content.length) return;
        $panel = $('<div id="sl-attempts" class="typo"></div>').appendTo($content);
      }
      const rowHtml = (a, num, open) => {
        const score = Math.max(0, Math.min(100, Number(a.score ?? 0)));
        const whenFull = a.at ? new Date(a.at).toLocaleString() : '';
        const when = a.at ? new Date(a.at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const tone = a.accepted ? ' pass' : (score > 0 ? ' part' : ' zero');
        const barTone = a.accepted ? ' pass' : (score > 0 ? ' part' : '');
        return `<details class="sl-attempt"${open ? ' open' : ''}>`
          + `<summary title="${escapeHtml(`${i18n('Attempt')} #${num} · ${score} · ${a.lang || ''}${whenFull ? ` · ${whenFull}` : ''}`)}">`
          + `<span class="sl-attempt__num">#${num}</span>`
          + `<span class="sl-badge${a.accepted ? ' pass' : ''}">${escapeHtml(a.statusText || '')}</span>`
          + `<span class="sl-attempt__meta">${escapeHtml(a.lang || '')}${when ? ` · ${escapeHtml(when)}` : ''}</span>`
          + `<span class="sl-attempt__score${tone}">${score}</span>`
          + (score > 0 ? `<i class="sl-attempt__bar${barTone}" style="transform:scaleX(${(score / 100).toFixed(3)})"></i>` : '')
          + '</summary>'
          + `<pre><code class="language-${prismLang(a.lang)}">${escapeHtml(a.code || '')}</code></pre>`
          + '</details>';
      };
      const best = attempts.reduce((m, a) => Math.max(m, Number(a.score ?? 0)), 0);
      const anyAc = attempts.some((x) => x.accepted);
      let html = `<div class="sl-attempts__head"><h3>${escapeHtml(i18n('Submitted code'))}</h3>`
        + (attempts.length ? `<span class="sl-attempts__count">${attempts.length}</span>` : '')
        + (attempts.length ? `<span class="sl-attempts__best${anyAc ? ' pass' : ''}">${escapeHtml(i18n('Best'))} ${best}</span>` : '')
        + '</div>';
      if (!attempts.length) {
        html += `<p class="text-gray">${escapeHtml(i18n('No submissions yet.'))}</p>`;
        $panel.html(html);
        return;
      }
      // Newest first: the row that matters sits on top and starts expanded;
      // chronological attempt numbers are preserved.
      const rows = attempts.map((a, idx) => ({ a, num: idx + 1 })).reverse();
      const VISIBLE = 5;
      const fold = rows.length > VISIBLE + 1;
      rows.forEach(({ a, num }, i) => {
        if (fold && i === VISIBLE) html += '<div class="sl-attempts__rest" hidden>';
        html += rowHtml(a, num, i === 0);
      });
      if (fold) {
        html += '</div>'
          + `<button type="button" class="sl-attempts__more">▾ ${escapeHtml(i18n('Earlier attempts'))} (${rows.length - VISIBLE})</button>`;
      }
      $panel.html(html);
      $panel.find('.sl-attempts__more').on('click', function onMore() {
        $panel.find('.sl-attempts__rest').removeAttr('hidden');
        $(this).remove();
      });
      import('vj/components/highlighter/prismjs')
        .then(({ default: prism }) => prism.highlightBlocks($panel))
        .catch(() => { /* highlighting is optional */ });
    }

    /* ---------------- PTA-style submit-result modal + judging pill ---------------- */

    const MODAL_STYLE = `
/* Beautify pass: the .slm result modal now ships from pta_theme.page.styl
   (shared with the site-wide copy — one source of truth, both themes). */
`;

    function ensureModalStyle() {
      if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
      if (!document.getElementById('sl-modal-style')) {
        $('<style>').attr('id', 'sl-modal-style').text(MODAL_STYLE).appendTo(document.head);
      }
    }

    function showJudging() {
      ensureModalStyle();
      if (!document.getElementById('sl-judging')) {
        $(`<div id="sl-judging">⏳ ${escapeHtml(i18n('Judging...'))}</div>`).appendTo(document.body);
      }
    }

    function hideJudging() {
      $('#sl-judging').remove();
    }

    /** The live editor content — the ground truth once fixes begin mid-session. */
    function currentEditorCode() {
      const ed = findScratchpadEditor();
      return (ed && ed.getModel()) ? String(ed.getModel().getValue()).slice(0, 8000) : '';
    }

    const STATUS_COLORS = {
      0: '#1c7ed6', 1: '#2f9e44', 2: '#e03131', 3: '#e8590c', 4: '#9c36b5',
      5: '#e8590c', 6: '#c2255c', 7: '#5f3dc4', 8: '#495057', 9: '#868e96',
      11: '#e03131', 20: '#1c7ed6', 21: '#1c7ed6',
    };
    const DARK_STATUS_OVERRIDES = { 8: '#9aa4ad', 9: '#9aa4ad' };
    const statusColor = (st, accepted) => {
      if (accepted) return STATUS_COLORS[1];
      if (getTheme() === 'dark' && DARK_STATUS_OVERRIDES[st]) return DARK_STATUS_OVERRIDES[st];
      return STATUS_COLORS[st] || '#d9480f';
    };

    const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');
    const langDisplay = (l) => (window.LANGS && window.LANGS[l] && window.LANGS[l].display) || l || '-';

    /**
     * Requirement: a PTA-style "Submit Result" modal replaces the in-IDE score
     * panel — summary grid, per-test-case detail (deliberately WITHOUT any
     * hint column), the submitted source with line numbers, and the compiler
     * output. The tutor flow waits until the modal is closed.
     */
    function showSubmitModal(data, onClose) {
      ensureModalStyle();
      const conf = (UiContext.pdoc && typeof UiContext.pdoc.config === 'object' && UiContext.pdoc.config) || {};
      const timeLimit = conf.timeMax || conf.time || null;
      const memLimitKB = conf.memoryMax ? conf.memoryMax * 1024 : null;
      const stColor = statusColor(data.status, data.accepted);
      const problemName = `${UiContext.pdoc?.pid ?? UiContext.slPid ?? ''}. ${UiContext.pdoc?.title || ''}`;
      const userName = (window.UserContext && (UserContext.uname || UserContext.displayName)) || `#${UserContext?._id ?? ''}`;
      const cell = (k, v, cls = '') => `<div><div class="slm__k">${escapeHtml(i18n(k))}</div><div class="slm__v ${cls}">${v}</div></div>`;
      let html = '<div class="slm__summary">';
      html += cell('Problem', escapeHtml(problemName));
      html += cell('User', escapeHtml(userName));
      html += cell('Submit At', escapeHtml(fmtTs(data.submitAt)));
      html += cell('Compiler', escapeHtml(langDisplay(data.lang)));
      html += cell('Memory Usage', escapeHtml(`${data.memory}${memLimitKB ? ` / ${memLimitKB}` : ''} KB`));
      html += cell('Time Usage', escapeHtml(`${data.time}${timeLimit ? ` / ${timeLimit}` : ''} ms`));
      html += `<div><div class="slm__k">${escapeHtml(i18n('Status'))}</div><div class="slm__v" style="color:${stColor};font-weight:bold">${escapeHtml(data.statusText || '')}</div></div>`;
      html += cell('Score', escapeHtml(String(data.score ?? 0)));
      html += cell('Judge At', escapeHtml(fmtTs(data.judgeAt)));
      html += '</div>';
      if (data.cases && data.cases.length) {
        html += `<div class="slm__sect"><div class="slm__secthead">${escapeHtml(i18n('Submission Detail'))}</div>`
          + `<table class="slm__table"><thead><tr><th>${escapeHtml(i18n('Test Case'))}</th><th>${escapeHtml(i18n('Memory(KB)'))}</th>`
          + `<th>${escapeHtml(i18n('Time(ms)'))}</th><th>${escapeHtml(i18n('Status'))}</th><th>${escapeHtml(i18n('Score'))}</th></tr></thead><tbody>`;
        for (const c of data.cases) {
          const key = caseKey(c) ?? '?';
          html += `<tr><td>${escapeHtml(String(key))}</td><td>${escapeHtml(String(c.memory ?? '-'))}</td>`
            + `<td>${escapeHtml(String(c.time ?? '-'))}</td>`
            + `<td class="slm__st" style="color:${statusColor(c.status)}">${escapeHtml(c.statusText || '')}`
            + (c.message ? `<div class="slm__msg">${escapeHtml(c.message)}</div>` : '')
            + `</td><td>${escapeHtml(String(c.score ?? '-'))}</td></tr>`;
        }
        html += '</tbody></table></div>';
      }
      html += `<div class="slm__sect"><div class="slm__secthead">${escapeHtml(i18n('Submission Code'))}`
        + `<span class="slm__langtag">[ ${escapeHtml(langDisplay(data.lang))} ]</span></div>`
        + `<div class="slm__codearea"><pre class="slm__code line-numbers"><code class="language-${prismLang(data.lang)}">${escapeHtml(data.code || '')}</code></pre></div></div>`;
      if (data.compilerTexts) {
        html += `<div class="slm__sect"><div class="slm__secthead">${escapeHtml(i18n('Compilation Output'))}</div>`
          + `<pre class="slm__compile">${escapeHtml(data.compilerTexts)}</pre></div>`;
      }
      const $mask = $('<div class="slm-mask"></div>').appendTo(document.body);
      const $modal = $(`<div class="slm" role="dialog" aria-label="${escapeHtml(i18n('Submit Result'))}">`
        + `<div class="slm__head"><span class="slm__title">${escapeHtml(i18n('Submit Result'))}</span>`
        + `<button type="button" class="slm__close" title="${escapeHtml(i18n('Close'))}">×</button></div>`
        + `<div class="slm__body">${html}</div>`
        + `<div class="slm__foot"><button type="button" class="rounded primary button slm__ok">${escapeHtml(i18n('OK'))}</button></div>`
        + '</div>').appendTo($mask);
      import('vj/components/highlighter/prismjs')
        .then(({ default: prism }) => prism.highlightBlocks($modal))
        .catch(() => { /* highlighting is optional */ });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        $(document).off('keydown.slmodal');
        // Smooth disappear: fade the mask, sink the dialog, then remove.
        $mask.addClass('slm-mask--closing');
        setTimeout(() => {
          $mask.remove();
          if (onClose) onClose();
        }, 190);
      };
      $modal.find('.slm__close, .slm__ok').on('click', close);
      $(document).on('keydown.slmodal', (ev) => {
        if (ev.key === 'Escape') close();
      });
    }

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
    clearScratchpadAnnotations = clearAnnotations;

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

    /** Viewport-responsive height budget for the tutor pop-up cards. */
    function cardMaxPx() {
      const vh = window.innerHeight || 800;
      return Math.max(200, Math.min(Math.round(vh * 0.5), 480));
    }

    function syncCardHeights() {
      if (!cardState) return;
      cardState.dom.style.setProperty('--sl-log-max', `${Math.max(110, cardMaxPx() - 118)}px`);
      fitZone(cardState.entry, 60, cardMaxPx());
    }
    $(window).on('resize.slcard', syncCardHeights);

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
    const TUTOR_UI_STYLE = `
      @keyframes slGhostPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
      @keyframes slResolvePulse { 0% { box-shadow: 0 8px 24px -10px rgba(47, 158, 68, .4), 0 0 0 0 rgba(47, 158, 68, .35); } 100% { box-shadow: 0 8px 24px -10px rgba(47, 158, 68, .4), 0 0 0 12px rgba(47, 158, 68, 0); } }
      .sl-anno { display: flex; flex-wrap: nowrap; align-items: flex-start; gap: 8px; box-sizing: border-box; max-width: 460px; min-width: 260px; background: var(--pta-card); border: 1px solid var(--pta-crimson-line); border-left: 4px solid var(--pta-crimson); border-radius: 12px; padding: 9px 11px; margin: 0 0 0 12px; font-size: 13px; line-height: 1.45; box-shadow: 0 10px 28px -12px rgba(158, 35, 53, .4), 0 2px 6px rgba(15, 23, 42, .08); color: var(--pta-ink); user-select: text; overflow: hidden; animation: ptaScaleIn .28s var(--pta-ease) both; }
      .sl-anno--chat { flex-direction: column; align-items: stretch; gap: 5px; padding: 7px 11px 8px; }
      .sl-anno__head { display: flex; justify-content: space-between; align-items: center; font-weight: bold; font-size: 12.5px; letter-spacing: .01em; color: var(--pta-crimson-text); flex: 0 0 auto; }
      .sl-anno__log { max-height: var(--sl-log-max, 148px); overflow-y: auto; overflow-x: hidden; background: var(--pta-card-2); border: 1px solid var(--pta-crimson-line); border-radius: 9px; padding: 5px 7px; scrollbar-width: thin; }
      .sl-anno__msg { margin: 4px 0; padding: 5px 10px; border-radius: 10px; font-size: 12.5px; line-height: 1.45; width: fit-content; max-width: 95%; box-sizing: border-box; color: var(--pta-ink); word-break: break-word; animation: ptaFadeUp .22s var(--pta-ease) both; }
      .sl-anno__msg.tutor { background: var(--pta-crimson-soft); border: 1px solid var(--pta-crimson-line); border-bottom-left-radius: 3px; }
      .sl-anno__msg.student { background: var(--pta-card-3); border: 1px solid var(--pta-line); border-bottom-right-radius: 3px; margin-left: auto; }
      .sl-anno__msg p { margin: 0 0 4px; }
      .sl-anno__msg p:last-child { margin-bottom: 0; }
      .sl-anno__msg code { background: var(--pta-crimson-soft); color: var(--pta-crimson-text); padding: 0 4px; border-radius: 4px; font-size: 12px; }
      .sl-anno__msg pre { background: var(--pta-card-2); padding: 6px 8px; border-radius: 6px; overflow-x: auto; margin: 4px 0; }
      .sl-anno__msg pre code { background: none; color: inherit; padding: 0; }
      .sl-anno__msg ul, .sl-anno__msg ol { margin: 2px 0 4px 16px; padding: 0; }
      .sl-anno--enter { animation: ptaScaleIn .3s var(--pta-ease); }
      .sl-anno-ghost { position: fixed; z-index: 3600; pointer-events: none; overflow: hidden; border-radius: 12px; background: var(--pta-card); border: 1px solid var(--pta-crimson-line); border-left: 4px solid var(--pta-crimson); box-shadow: 0 12px 32px -10px rgba(158, 35, 53, .5); display: flex; align-items: center; justify-content: center; }
      .sl-anno-ghost--fly { transition: left .38s var(--pta-ease), top .38s var(--pta-ease), width .38s var(--pta-ease), height .38s var(--pta-ease); }
      .sl-anno-ghost--out { transition: opacity .24s ease; opacity: 0; }
      .sl-anno-ghost__chip { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--pta-crimson-text); white-space: nowrap; padding: 0 12px; transition: opacity .2s ease; }
      .sl-anno-ghost--fly .sl-anno-ghost__chip { opacity: 0; }
      .sl-anno-ghost--pulse { animation: slGhostPulse 1.4s ease-in-out infinite; }
      .sl-anno__nextwrap { padding: 6px 4px 2px; text-align: right; }
      .sl-anno__next { background: var(--pta-grad-crimson); color: #fff; border: none; border-radius: 999px; padding: 5px 16px; font-size: 12.5px; cursor: pointer; box-shadow: 0 5px 14px -5px rgba(158, 35, 53, .6); transition: filter .12s ease, transform .12s var(--pta-ease); }
      .sl-anno__next:hover { filter: brightness(1.08); transform: translateY(-1px); }
      .sl-anno__note { margin: 5px 0 2px; padding: 4px 10px; border-radius: 999px; background: var(--pta-ok-soft); border: 1px solid var(--pta-ok-line); color: var(--pta-ok-text); font-size: 12.5px; width: fit-content; font-weight: bold; animation: ptaScaleIn .24s var(--pta-ease) both; }
      .sl-anno__q { flex: 1 1 auto; color: var(--pta-ink); overflow: hidden; }
      .sl-anno__btns { display: flex; gap: 2px; flex: 0 0 auto; }
      .sl-anno button { border: none; background: transparent; cursor: pointer; font-size: 14px; padding: 0 5px; border-radius: 6px; color: var(--pta-crimson-text); line-height: 1.5; transition: background .15s ease; }
      .sl-anno button:hover { background: rgba(194, 37, 92, .1); }
      .sl-anno__input { display: flex; gap: 6px; flex: 0 0 auto; align-items: center; }
      .sl-anno__input input { flex: 1 1 auto; border: 1px solid var(--pta-crimson-line); border-radius: 999px; padding: 5px 12px; font-size: 12.5px; color: var(--pta-ink); background: var(--pta-card); transition: border-color .15s ease, box-shadow .15s ease; }
      .sl-anno__input input:focus { outline: none; border-color: var(--pta-crimson); box-shadow: var(--pta-ring-crimson); }
      .sl-anno__input .sl-anno__send { width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; border: none; background: var(--pta-grad-crimson); color: #fff; box-shadow: 0 4px 10px -4px rgba(158, 35, 53, .6); transition: filter .12s ease, transform .12s var(--pta-ease); }
      .sl-anno__input .sl-anno__send:hover { filter: brightness(1.1); transform: translateY(-1px); background: var(--pta-grad-crimson); }
      .sl-anno__input button:disabled { opacity: .5; cursor: default; transform: none; }
      .sl-anno__input .sl-anno__skip { background: var(--pta-card); color: var(--pta-crimson-text); border: 1px solid var(--pta-crimson-line); border-radius: 999px; padding: 4px 12px; font-size: 12px; white-space: nowrap; flex: 0 0 auto; transition: background .15s ease, color .15s ease, border-color .15s ease; }
      .sl-anno__input .sl-anno__skip:hover { background: var(--pta-crimson-soft); border-color: var(--pta-crimson); }
      .sl-anno__input .sl-anno__skip:disabled { opacity: .5; cursor: default; background: var(--pta-card); }
      .sl-anno--resolved { border-left-color: var(--pta-success); animation: slResolvePulse .7s ease-out 1; }
      .sl-anno--resolved .sl-anno__head { color: var(--pta-ok-text); }
      .sl-anno--info { align-items: center; min-height: 40px; border-left-color: var(--pta-primary-2); box-shadow: 0 10px 28px -12px rgba(28, 126, 214, .4), 0 2px 6px rgba(15, 23, 42, .08); border-color: var(--pta-blue-line); }
      .sl-anno-line { background: linear-gradient(90deg, rgba(194, 37, 92, .13), rgba(194, 37, 92, .03)); box-shadow: inset 3px 0 0 rgba(194, 37, 92, .8); }
      .sl-anno__thinking { display: flex; align-items: center; gap: 7px; margin: 4px 0; padding: 4px 10px; border-radius: 999px; background: var(--pta-card); border: 1px dashed var(--pta-crimson-line); color: var(--pta-crimson-text); font-size: 12.5px; width: fit-content; }
      .sl-anno__thinking .sl-spin--sm { width: 14px; height: 14px; border: 2px solid var(--pta-crimson-line); border-top-color: var(--pta-crimson); border-radius: 50%; flex: 0 0 auto; animation: ptaSpin .8s linear infinite; }
      .sl-overlay { position: fixed; inset: 0; z-index: 3000; background: rgba(10, 14, 22, .5); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; animation: ptaFadeIn .2s ease-out; }
      .sl-overlay__box { background: rgba(23, 30, 41, .94); border: 1px solid rgba(255, 255, 255, .09); border-radius: 16px; padding: 30px 38px; display: flex; flex-direction: column; align-items: center; gap: 16px; color: #eee; font-size: 14px; box-shadow: 0 18px 50px rgba(0, 0, 0, .5); animation: ptaScaleIn .24s var(--pta-ease); }
      .sl-overlay .sl-spin { width: 46px; height: 46px; border: 5px solid rgba(255, 255, 255, .2); border-top-color: #ff8a99; border-right-color: #e35d6a; border-radius: 50%; animation: ptaSpin .8s linear infinite; }
      .sl-anno--offer { border-left-color: var(--pta-warn); background: var(--pta-warn-soft); }
      .sl-anno--offer .sl-anno__q b { color: var(--pta-warn-text); }
      .sl-offer__btns { display: inline-flex; gap: 6px; align-items: center; }
      .sl-offer__btns button { border: none; border-radius: 999px; padding: 3px 12px; font-size: 11.5px; cursor: pointer; transition: filter .12s ease; }
      .sl-offer__btns .sl-chaccept { background: var(--pta-grad-warn); color: #fff; font-weight: bold; box-shadow: 0 4px 10px -4px rgba(232, 89, 12, .7); }
      .sl-offer__btns .sl-chaccept:hover { filter: brightness(1.08); }
      .sl-offer__btns .sl-chlater { background: var(--pta-card); color: var(--pta-warn-text); border: 1px solid var(--pta-warn-line); }
      .sl-offer__btns .sl-chlater:hover { background: var(--pta-warn-soft); }
      .sl-anno--boss { border-left-color: var(--pta-warn); }
      .sl-anno--boss .sl-anno__head { color: var(--pta-warn-text); }
      .sl-anno--boss.sl-anno--resolved { border-left-color: var(--pta-success); }
      .sl-anno__giveup { background: var(--pta-card); color: var(--pta-warn-text); border: 1px solid var(--pta-warn-line); border-radius: 999px; padding: 1px 10px; font-size: 10.5px; cursor: pointer; margin-right: 2px; }
      .sl-anno__giveup:hover { background: var(--pta-warn-soft); }
      .pta-dark .sl-anno, .pta-dark .sl-anno-ghost { border-left-color: #e35d6a; box-shadow: 0 12px 30px -12px rgba(0, 0, 0, .65); }
      .pta-dark .sl-anno--resolved, .pta-dark .sl-anno--boss.sl-anno--resolved { border-left-color: #69b34c; }
      .pta-dark .sl-anno--info { border-left-color: #4dabf7; }
`;

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
    let chCard = null; // the live Boss Challenge card (programming problems)

    /**
     * Requested UX: the full-page overlay is only for the moment right after a
     * submission, before any card exists; once the pop-up card is on screen,
     * the thinking animation lives INSIDE it.
     */
    function showThinking(mode) {
      ensureTutorUiStyle();
      lockEditor();
      if (mode === 'ghost') return; // the flying ghost carries its own spinner
      if (cardState) {
        const $log = $(cardState.dom).find('.sl-anno__log');
        if (!thinkingRow) {
          thinkingRow = $('<div class="sl-anno__thinking"><span class="sl-spin--sm"></span>'
            + `<span>${escapeHtml(i18n('The tutor is thinking...'))}</span></div>`)[0];
        }
        $log.append(thinkingRow);
        $log.scrollTop($log[0].scrollHeight);
        $(cardState.dom).find('.sl-anno__input input, .sl-anno__input button').prop('disabled', true);
        fitZone(cardState.entry, 60, cardMaxPx());
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
        } else {
          $(cardState.dom).find('.sl-anno__skip').prop('disabled', false);
        }
        fitZone(cardState.entry, 60, cardMaxPx());
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
      // Monaco sizes the zone DOM asynchronously: measuring only once (before
      // layout settles) clips wrapped text. Re-fit after layout and once more
      // after fonts settle.
      fitZone(entry, 40, Math.min(260, cardMaxPx()));
      requestAnimationFrame(() => fitZone(entry, 40, Math.min(260, cardMaxPx())));
      setTimeout(() => fitZone(entry, 40, Math.min(260, cardMaxPx())), 150);
      dom.querySelector('.sl-anno__close').addEventListener('click', () => removeZoneEntry(entry));
    }

    /* ---------------------- Boss Challenge (in-editor) ---------------------- */

    /** Offer card with Accept / Maybe-later, anchored under the code. */
    function maybeOfferChallengeCard(rid, line) {
      if (!challengeInfo || !challengeInfo.available) return;
      if (chCard || document.querySelector('.sl-anno--offer')) return;
      const ed = findScratchpadEditor();
      if (!ed || !ed.getModel()) return;
      const resume = challengeInfo.state === 'active';
      const dom = document.createElement('div');
      dom.className = 'sl-anno sl-anno--offer';
      dom.innerHTML = '<span class="sl-anno__icon">🔥</span>'
        + `<span class="sl-anno__q"><b>${escapeHtml(i18n('Boss Challenge'))}</b> — ${escapeHtml(i18n(resume ? 'You have an unfinished Boss Challenge.' : 'Feeling brave? Beat one extra twist of this problem.'))}</span>`
        + '<span class="sl-anno__btns sl-offer__btns">'
        + `<button type="button" class="sl-chaccept">${escapeHtml(i18n(resume ? 'Resume the challenge' : 'Accept the challenge'))} 🔥</button>`
        + (resume ? '' : `<button type="button" class="sl-chlater">${escapeHtml(i18n('Maybe later'))}</button>`)
        + '</span>';
      const max = ed.getModel().getLineCount();
      const anchorLine = Math.min(Math.max(1, line || max), max);
      const entry = addZone(ed, anchorLine, 52, dom, null);
      fitZone(entry, 44, Math.min(220, cardMaxPx()));
      requestAnimationFrame(() => fitZone(entry, 44, Math.min(220, cardMaxPx())));
      setTimeout(() => fitZone(entry, 44, Math.min(220, cardMaxPx())), 150);
      dom.querySelector('.sl-chaccept').addEventListener('click', () => {
        removeZoneEntry(entry);
        startChallengeCard(rid, anchorLine);
      });
      const later = dom.querySelector('.sl-chlater');
      if (later) {
        later.addEventListener('click', async () => {
          removeZoneEntry(entry);
          challengeInfo = { state: 'declined' };
          try { await request.post(tutorUrl, { operation: 'challengeDecline' }); } catch (e) { /* best-effort */ }
        });
      }
    }

    async function startChallengeCard(rid, line) {
      showOverlay();
      try {
        const res = await request.post(tutorUrl, { operation: 'challenge', rid });
        hideOverlay();
        showBossCard(res, line);
        // Mirror into the launcher panel history.
        appendDivider(`🔥 ${res.title || i18n('Boss Challenge')}`);
        if (res.hook) appendBubble('assistant', `💡 ${res.hook}`);
        appendBubble('assistant', `🔥 ${res.question}`);
      } catch (e) {
        hideOverlay();
        Notification.error(e.message);
      }
    }

    /** The live Boss Challenge card: same chatbox anatomy, fire styling. The
     *  editor stays UNLOCKED — revising the code is part of the challenge. */
    function showBossCard(ch, line) {
      const ed = findScratchpadEditor();
      if (!ed || !ed.getModel()) return;
      const max = ed.getModel().getLineCount();
      const anchorLine = Math.min(Math.max(1, line || max), max);
      const dom = document.createElement('div');
      dom.className = 'sl-anno sl-anno--chat sl-anno--boss';
      dom.style.setProperty('--sl-log-max', `${Math.max(110, cardMaxPx() - 118)}px`);
      dom.innerHTML = '<div class="sl-anno__head">'
        + `<span>🔥 ${escapeHtml(ch.title || i18n('Boss Challenge'))}</span>`
        + '<span class="sl-anno__btns">'
        + `<button type="button" class="sl-anno__giveup">${escapeHtml(i18n('Give up'))}</button>`
        + `<button type="button" class="sl-anno__close" title="${escapeHtml(i18n('Dismiss'))}">×</button>`
        + '</span></div>'
        + '<div class="sl-anno__log"></div>'
        + '<div class="sl-anno__input">'
        + `<input type="text" maxlength="1500" placeholder="${escapeHtml(i18n('Type your challenge answer... (Enter to send)'))}">`
        + `<button type="button" class="sl-anno__send" title="${escapeHtml(i18n('Send'))}">➤</button>`
        + '</div>';
      const entry = addZone(ed, anchorLine, 140, dom, null);
      chCard = { entry, dom, history: [] };
      if (ch.hook) appendCardNote(ch.hook, '💡', chCard);
      appendCardMsg('tutor', ch.question, chCard);
      fitZone(entry, 60, cardMaxPx());
      requestAnimationFrame(() => fitZone(entry, 60, cardMaxPx()));
      setTimeout(() => fitZone(entry, 60, cardMaxPx()), 150);
      dom.querySelector('.sl-anno__close').addEventListener('click', () => {
        removeZoneEntry(entry);
        chCard = null;
      });
      dom.querySelector('.sl-anno__giveup').addEventListener('click', async () => {
        challengeInfo = { state: 'declined' };
        appendCardNote(i18n('You gave up this challenge. It will not be offered again for this problem.'), '✖', chCard);
        $(dom).find('.sl-anno__input input, .sl-anno__send, .sl-anno__giveup').prop('disabled', true);
        try { await request.post(tutorUrl, { operation: 'challengeDecline' }); } catch (e) { /* best-effort */ }
      });
      const input = dom.querySelector('.sl-anno__input input');
      const send = async () => {
        const text = (input.value || '').trim();
        if (!text || !chCard) return;
        const card = chCard;
        input.value = '';
        appendCardMsg('student', text, card);
        appendBubble('user', text);
        const $log = $(card.dom).find('.sl-anno__log');
        const row = $(`<div class="sl-anno__thinking"><span class="sl-spin--sm"></span><span>${escapeHtml(i18n('The tutor is thinking...'))}</span></div>`).appendTo($log)[0];
        $(card.dom).find('.sl-anno__input input, .sl-anno__input button, .sl-anno__giveup').prop('disabled', true);
        $log.scrollTop($log[0].scrollHeight);
        fitZone(card.entry, 60, cardMaxPx());
        try {
          const res = await request.post(tutorUrl, {
            operation: 'challengeReply',
            text,
            history: JSON.stringify(card.history.slice(-10)),
            code: currentEditorCode(),
          });
          card.history.push({ role: 'student', content: text });
          card.history.push({ role: 'tutor', content: res.reply });
          row.remove();
          absorbSpark(res);
          appendCardMsg('tutor', res.reply, card);
          appendBubble('assistant', res.reply, { resolved: res.cleared, accepted: true });
          if (res.cleared) {
            $(card.dom).addClass('sl-anno--resolved');
            appendCardNote(i18n('Challenge cleared! Legendary work!'), '🏆', card);
            appendDivider(`🏆 ${i18n('Challenge cleared! Legendary work!')}`, true);
            confettiBurst();
            challengeInfo = { state: 'cleared' };
            $(card.dom).find('.sl-anno__input input, .sl-anno__send, .sl-anno__giveup').prop('disabled', true);
          } else {
            $(card.dom).find('.sl-anno__input input, .sl-anno__input button, .sl-anno__giveup').prop('disabled', false);
            input.focus();
          }
        } catch (e) {
          row.remove();
          appendCardMsg('tutor', `⚠️ ${e.message}`, card);
          $(card.dom).find('.sl-anno__input input, .sl-anno__input button, .sl-anno__giveup').prop('disabled', false);
        }
        fitZone(card.entry, 60, cardMaxPx());
      };
      dom.querySelector('.sl-anno__send').addEventListener('click', send);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          send();
        }
      });
      setTimeout(() => input.focus(), 50);
    }

    /** A distinct green instruction row (not a chat bubble). */
    function appendCardNote(text, icon = '✏️', st = cardState) {
      if (!st) return;
      const $log = $(st.dom).find('.sl-anno__log');
      $log.append(`<div class="sl-anno__note">${icon} ${escapeHtml(text)}</div>`);
      $log.scrollTop($log[0].scrollHeight);
      fitZone(st.entry, 60, cardMaxPx());
    }

    function appendCardMsg(role, content, st = cardState) {
      if (!st) return;
      const $log = $(st.dom).find('.sl-anno__log');
      const $msg = $(`<div class="sl-anno__msg ${role === 'student' ? 'student' : 'tutor'}"></div>`);
      if (role === 'student') {
        $msg.html(escapeHtml(String(content || '')).replace(/\n/g, '<br>'));
      } else {
        // The same markdown renderer as the chat windows (html stays escaped).
        $msg.html(md.render(String(content || '')));
      }
      $log.append($msg);
      $log.scrollTop($log[0].scrollHeight);
      fitZone(st.entry, 60, cardMaxPx());
    }

    /** The single interactive question card: a mini chatbox anchored at the line. */
    function showQuestionCard(rid, ann, accepted = false, opts = {}) {
      const ed = findScratchpadEditor();
      if (!ed || !ed.getModel()) return;
      const max = ed.getModel().getLineCount();
      const line = Math.min(Math.max(1, Math.floor(ann.line) || 1), max);
      const endLine = Math.min(Math.max(line, Math.floor(ann.endLine) || line), max);
      const dom = document.createElement('div');
      dom.className = 'sl-anno sl-anno--chat';
      dom.style.setProperty('--sl-log-max', `${Math.max(110, cardMaxPx() - 118)}px`);
      if (opts.hiddenEnter) dom.style.visibility = 'hidden'; // the flight reveals it
      dom.innerHTML = '<div class="sl-anno__head">'
        + `<span>🤖 ${escapeHtml(i18n('AI Socratic Tutor'))}</span>`
        + `<span class="sl-anno__btns"><button type="button" class="sl-anno__close" title="${escapeHtml(i18n('Dismiss'))}">×</button></span>`
        + '</div>'
        + '<div class="sl-anno__log"></div>'
        + '<div class="sl-anno__input">'
        + `<input type="text" maxlength="1000" placeholder="${escapeHtml(i18n('Type your answer... (Enter to send)'))}">`
        + `<button type="button" class="sl-anno__send" title="${escapeHtml(i18n('Send'))}">➤</button>`
        + (accepted ? '' : `<button type="button" class="sl-anno__skip" title="${escapeHtml(i18n('Already fixed it? Jump straight to the next issue.'))}">${escapeHtml(i18n('Next issue'))} ➜</button>`)
        + '</div>';
      const entry = addZone(ed, endLine, 120, dom, { line, endLine });
      cardState = {
        entry, dom, rid, line, endLine, question: ann.question, history: [], accepted,
      };
      // Combined pop-up on success: the celebration leads, the reflection follows.
      if (accepted) appendCardNote(i18n('Accepted! Great job!'), '🎉');
      appendCardMsg('tutor', ann.question);
      // Mirror into the launcher panel: the red button replays this dialogue.
      appendBubble('assistant', ann.question, { line, endLine });
      fitZone(entry, 60, cardMaxPx());
      requestAnimationFrame(() => fitZone(entry, 60, cardMaxPx()));
      setTimeout(() => fitZone(entry, 60, cardMaxPx()), 150);
      dom.querySelector('.sl-anno__close').addEventListener('click', () => {
        // Dismissing ends the guided sequence for this attempt.
        removeZoneEntry(entry);
        cardState = null;
      });
      $(dom).find('.sl-anno__skip').on('click', () => {
        const cs = cardState;
        if (!cs || cs.dom !== dom) return;
        // Fast-student path: fixed without answering. Record the question as
        // asked and advance immediately with the current editor code.
        if (!askedQuestions.includes(cs.question)) askedQuestions.push(cs.question);
        requestNextQuestion(cs.rid, cs.endLine);
      });
      const input = dom.querySelector('.sl-anno__input input');
      const send = () => {
        const text = (input.value || '').trim();
        if (text) submitCardAnswer(text);
      };
      dom.querySelector('.sl-anno__send').addEventListener('click', send);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          send();
        }
      });
      setTimeout(() => input.focus(), 50);
    }

    function revealCurrentCard() {
      if (!cardState) return;
      cardState.dom.style.visibility = '';
      $(cardState.dom).addClass('sl-anno--enter');
      setTimeout(() => { if (cardState) $(cardState.dom).removeClass('sl-anno--enter'); }, 360);
    }

    /**
     * FLIP flight: mount the next card hidden, smooth-scroll it into view,
     * then animate the fixed ghost from the old rect to the new one and
     * cross-fade into the live card.
     */
    function flyGhostToNewCard(ghost, mountFn) {
      return new Promise((resolve) => {
        mountFn();
        const target = cardState && cardState.dom;
        if (!target) {
          ghost.remove();
          resolve();
          return;
        }
        const ed = findScratchpadEditor();
        if (ed && cardState) {
          try {
            ed.revealLineInCenterIfOutsideViewport(cardState.endLine, 0); // ScrollType.Smooth
          } catch (e) { /* best-effort */ }
        }
        const settle = () => {
          const r = target.getBoundingClientRect();
          if (!r.width && !r.height) {
            requestAnimationFrame(settle);
            return;
          }
          ghost.classList.remove('sl-anno-ghost--pulse');
          ghost.getBoundingClientRect(); // flush layout before enabling the transition
          ghost.classList.add('sl-anno-ghost--fly');
          ghost.style.left = `${r.left}px`;
          ghost.style.top = `${r.top}px`;
          ghost.style.width = `${r.width}px`;
          ghost.style.height = `${r.height}px`;
          setTimeout(() => {
            ghost.remove();
            revealCurrentCard();
            resolve();
          }, 430);
        };
        // let Monaco lay the new zone out and the smooth scroll progress
        requestAnimationFrame(() => setTimeout(settle, 260));
      });
    }

    /** Requirement flow: ONE question at a time; the editor locks while the LLM works. */
    async function requestNextQuestion(rid, afterLine, accepted = false) {
      const session = annoSession;
      const prevCard = cardState;
      const useGhost = !!prevCard && !accepted;
      let ghost = null;
      if (useGhost) {
        // The resolved card lifts off as a fixed ghost carrying a thinking
        // strip; once the next question arrives it FLIES to the new anchor.
        const rect = prevCard.dom.getBoundingClientRect();
        ghost = document.createElement('div');
        ghost.className = 'sl-anno-ghost';
        ghost.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
        ghost.innerHTML = '<div class="sl-anno-ghost__chip"><span class="sl-spin--sm"></span>'
          + `<span>${escapeHtml(i18n('Finding the next issue...'))}</span></div>`;
        document.body.appendChild(ghost);
        removeZoneEntry(prevCard.entry);
        if (cardState === prevCard) cardState = null;
        showThinking('ghost'); // lock only — the ghost shows the spinner
        // Instant feedback: the resolved card CONDENSES into a compact
        // thinking chip right away, pulsing while the LLM works, so the
        // wait never looks like a frozen full-size card.
        const g0 = ghost;
        requestAnimationFrame(() => {
          if (!g0.isConnected) return;
          g0.getBoundingClientRect(); // flush layout before transitioning
          g0.classList.add('sl-anno-ghost--fly');
          g0.style.width = '250px';
          g0.style.height = '44px';
          setTimeout(() => {
            if (g0.isConnected) {
              g0.classList.remove('sl-anno-ghost--fly');
              g0.classList.add('sl-anno-ghost--pulse');
            }
          }, 400);
        });
      } else {
        showThinking(); // in-card spinner or full overlay, as before
      }
      const dropGhost = (fade = true) => {
        if (!ghost) return;
        const g = ghost;
        ghost = null;
        if (fade) {
          g.classList.add('sl-anno-ghost--out');
          setTimeout(() => g.remove(), 260);
        } else g.remove();
      };
      try {
        const res = await request.post(tutorUrl, {
          operation: 'annotate', rid, asked: JSON.stringify(askedQuestions.slice(-12)), code: currentEditorCode(),
        });
        if (session !== annoSession || !extended) {
          dropGhost(false);
          return;
        }
        hideThinking();
        if (res.marker) appendDivider(res.marker, !!res.markerAccepted); // the panel history gains the divider
        absorbSpark(res);
        if (prevCard && cardState === prevCard) {
          removeZoneEntry(prevCard.entry); // non-ghost path only
          cardState = null;
        }
        if (res.annotation) {
          if (ghost) {
            const g = ghost;
            ghost = null;
            await flyGhostToNewCard(g, () => showQuestionCard(rid, res.annotation, accepted, { hiddenEnter: true }));
          } else {
            showQuestionCard(rid, res.annotation, accepted);
          }
        } else {
          dropGhost();
          if (accepted) showInfoCard(`🎉 ${i18n('Accepted! Great job!')}`, afterLine || 0);
          else showInfoCard(i18n('All issues covered — apply your fixes and submit once to verify!'), afterLine || 0);
        }
        // The optional Boss Challenge rides every accept: reflection card or
        // lone celebration, the fire card offers one extra twist below it.
        if (accepted) maybeOfferChallengeCard(rid, afterLine || 0);
      } catch (e) {
        dropGhost();
        if (session !== annoSession) return;
        hideThinking();
        console.warn('[self-learning] tutor annotations unavailable:', e.message);
        if (accepted) showInfoCard(`🎉 ${i18n('Accepted! Great job!')}`, afterLine || 0); // success needs no error noise
        else if (prevCard && cardState === prevCard) appendCardMsg('tutor', `⚠️ ${e.message}`);
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
          code: currentEditorCode(),
        });
        if (session !== annoSession) return;
        cs.history.push({ role: 'student', content: text });
        cs.history.push({ role: 'tutor', content: res.reply });
        hideThinking();
        absorbSpark(res);
        appendCardMsg('tutor', res.reply);
        // Mirror the exchange into the launcher panel history.
        appendBubble('user', text, { line: cs.line, endLine: cs.endLine });
        appendBubble('assistant', res.reply, {
          line: cs.line, endLine: cs.endLine, resolved: res.resolved, accepted: cs.accepted,
        });
        if (res.resolved) {
          askedQuestions.push(cs.question);
          $(cs.dom).addClass('sl-anno--resolved');
          $(cs.dom).find('.sl-anno__input input, .sl-anno__send').prop('disabled', true);
          if (cs.accepted) {
            // Post-success reflection stays terminal: close with praise.
            appendCardNote(i18n('Great reflection — you have truly mastered this problem!'), '🎉');
          } else {
            // Guided session: the student FIXES this spot in the editor, then
            // clicks the (always-visible) Next-issue button — the next
            // question is generated against the CURRENT code, so fixed flaws
            // are skipped and anchors match the editor. One submission at the
            // very end verifies the whole walkthrough.
            appendCardNote(i18n('Great — now FIX this line in the editor.'), '✏️');
          }
          fitZone(cs.entry, 60, cardMaxPx());
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
      showJudging();
      let judged = false;
      let verdict = null;
      for (let i = 0; i < 120 && extended; i++) {
        try {
          const data = await request.get(`${recordUrl}?rid=${rid}`); // eslint-disable-line no-await-in-loop
          if (data.judged) {
            judged = true;
            verdict = data;
            break;
          }
        } catch (e) {
          hideJudging();
          return;
        }
        await new Promise((resolve) => { setTimeout(resolve, 1500); }); // eslint-disable-line no-await-in-loop
      }
      hideJudging();
      if (!judged || !extended) return;
      refreshAttemptsPanel(); // the trajectory just gained a judged attempt
      // Requirement: the PTA-style result modal replaces the in-IDE score
      // panel. The tutor's cards start only after the student closes it.
      showSubmitModal(verdict, () => { afterVerdictModal(rid, verdict); });
    }

    /** The tutoring flow, resumed once the result modal is dismissed. */
    async function afterVerdictModal(rid, verdict) {
      if (!extended) return;
      if (!UiContext.slTutor) return; // teachers and unconfigured sites: no tutoring flows
      const ed = findScratchpadEditor();
      const lastLine = (ed && ed.getModel()) ? ed.getModel().getLineCount() : 0;
      if (verdict && verdict.accepted) {
        // Requirement: ONE combined pop-up on success — the reflection card
        // itself opens with the 🎉 celebration row, then the single
        // self-reflection question. If nothing is worth reflecting on, a
        // lone celebration card shows instead (never both).
        askedQuestions = [];
        await requestNextQuestion(rid, lastLine, true);
        return;
      }
      // In-editor guidance: ONE Socratic question card at a time, anchored at
      // the relevant lines. The student answers inside the card; once the
      // tutor deems the question resolved, the next one is generated. While
      // the LLM works, a spinner shows and the editor is locked. Every card
      // exchange is persisted server-side and mirrored into the launcher
      // panel, which is a read-only history viewer.
      askedQuestions = [];
      await requestNextQuestion(rid, lastLine);
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
      // hook is the original action: attach to its promise directly.
      // Rejections (e.g. submitting EMPTY code fails the server's `code`
      // validation) must be caught on BOTH promises — the raw request payload
      // and the promise the middleware returns from dispatch — otherwise they
      // surface as uncaught runtime errors. Translate them into a toast.
      const submitErrorToast = (e) => {
        const msg = String((e && e.message) || e || '');
        Notification.error(/Field code|\bcode\b.*validation|validation.*\bcode\b/i.test(msg)
          ? i18n('Please write some code before submitting.')
          : (msg || i18n('Submit failed.')));
      };
      const HOOKED_ACTIONS = ['SCRATCHPAD_POST_SUBMIT', 'SCRATCHPAD_POST_PRETEST'];
      const rawDispatch = store.dispatch.bind(store);
      store.dispatch = (action) => {
        const hooked = action && HOOKED_ACTIONS.includes(action.type)
          && action.payload && typeof action.payload.then === 'function';
        try {
          if (hooked) {
            action.payload.then((res) => {
              if (action.type === 'SCRATCHPAD_POST_SUBMIT' && res && res.rid) trackScratchpadSubmission(res.rid);
            }).catch(submitErrorToast);
          } else if (action && action.type === 'SCRATCHPAD_POST_SUBMIT_FULFILLED' && action.payload && action.payload.rid) {
            trackScratchpadSubmission(action.payload.rid); // fallback, in case the middleware ever routes it here
          }
        } catch (e) { /* the tutor hook is best-effort */ }
        const result = rawDispatch(action);
        // The toast already fired via the payload catch; this catch only
        // marks the middleware's returned promise as handled.
        if (hooked && result && typeof result.catch === 'function') result.catch(() => {});
        return result;
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
      clearAnnotations();
      panelOpen = false;
      $tutor.hide();
      $fab.show();
      $('#scratchpad').css('opacity', 0);
      // Hand the statement DOM back to the page before unmounting the IDE.
      $('.problem-content-container').append($('.problem-content'));
      if (unmountReact) unmountReact();
      $scratchpadContainer.hide();
      $('body').removeClass('header--collapsed mode--scratchpad');
      $('.main > .row').show();
      $('.footer').show();
      // Back on the normal page: keep the session rail, re-homed below the navbar.
      injectRailForPage();
      document.body.style.overflow = 'scroll';
      extended = false;
      busy = false;
    }

    $(window).on('resize', () => {
      if (cardState) fitZone(cardState.entry, 60, cardMaxPx());
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
    // The "Submitted code" panel renders from the start, IDE or not.
    refreshAttemptsPanel();
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

  // Requirement: quiz and answer-submission problems have no IDE, but keep
  // the same session problem rail, attached below the navbar in page mode,
  // so learners can navigate among the session's problems from here too.
  if (UiContext.slType !== 'programming') injectRailForPage();

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
        if (UiContext.slType === 'programming') {
          // The card channel restarts from the next submission; the panel
          // just returns to its empty read-only state.
          clearScratchpadAnnotations();
          $chat.append(`<div class="sl-empty">${escapeHtml(panelEmptyText())}</div>`);
        } else if (lastRid) await startTutor(lastRid);
      } catch (e) {
        Notification.error(e.message);
      }
    });
  });

  // Resume a previous tutoring conversation on page load.
  if (UiContext.slTutor && $tutor.length) {
    request.get(tutorUrl).then((res) => {
      absorbSpark(res);
      if (res.messages && res.messages.length) {
        renderMessages(res.messages, true);
        tutorStarted = true;
        // For programming, legacy chat turns are filtered out; only light the
        // dot when the read-only history actually has something to show.
        if ($chat.children().length) $fabDot.show();
      }
      // An unfinished Boss Challenge survives reloads: offer to resume it in
      // the chat panel (quiz problems only — programming re-offers in-editor).
      if (UiContext.slType === 'objective' && res.challenge && res.challenge.state === 'active') {
        maybeOfferChallengeChat(res.challenge, null);
      }
    }).catch(() => { /* tutor unavailable; the fab still opens an empty panel */ });
  }
});
