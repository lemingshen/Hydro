import $ from 'jquery';
import MarkdownIt from 'markdown-it';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, loadReactRedux, request, tpl } from 'vj/utils';
// Direct import: pulls the rail module into the bundle through the dependency
// graph, so the session rail never depends on the page-loader picking up a
// newly added file.
import { injectRailForPage, injectRailWhenReady } from './auto_scratchpad.page';

/* ---------------------------- celebration helper ---------------------------- */
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
  /*
   * PTA fork: the AI tutor is a PROGRAMMING-only feature. Objective quizzes
   * are answered on the session paper (no tutor there any more) and the
   * server refuses tutor calls for anything but judged programs, so this
   * page only knows two shapes: the Scratchpad IDE with its line-anchored
   * question cards (programming), and a plain answer form with an inline
   * verdict (answer-submission tasks) — no chat-mode tutor, no quiz form.
   */
  const tutorUrl = `${window.location.pathname}/tutor`;
  const recordUrl = `${window.location.pathname}/record`;
  const $chat = $('#sl-chat');
  const $tutor = $('#sl-tutor');
  const $verdict = $('#sl-verdict');
  const $fab = $('#sl-fab');
  const $fabDot = $('#sl-fab-dot');
  let panelOpen = false;

    /* ------------------ one task at a time (students) ------------------ */
  /*
   * UiContext.slGate (students only) is the session progression: which
   * task is current, which are finished / skipped, what is unlocked. Every
   * tutor / verdict response may carry a fresh `gate`; the rail's
   * progression block and the chips follow it live.
   */
  let gate = (window.UiContext && UiContext.slGate) || null;
  const sessionBase = window.location.pathname.replace(/\/p\/\d+.*$/, '');
  /** Set by the IDE flow after an Accepted verdict: re-opens the tutor's reflection question. */
  let reaskReflection = null;

  function applyGateToRail(g) {
    if (!g) return;
    const $chips = $('#sl-rail .sl-rail__chip[data-pid]');
    $chips.each(function markChip(i) {
      const pid = Number($(this).attr('data-pid'));
      if (!Number.isFinite(pid)) return;
      const st = g.done.includes(pid) ? 'done' : g.skipped.includes(pid) ? 'skipped' : g.current === pid ? 'current' : g.unlocked.includes(pid) ? 'open' : 'locked';
      $(this).toggleClass('locked', st === 'locked').toggleClass('skipped', st === 'skipped').toggleClass('gate-now', st === 'current');
      if (st !== 'locked') {
        if ($(this).attr('href') === 'javascript:;') $(this).attr('href', `${sessionBase}/p/${pid}`);
        if ($(this).text() === '🔒') $(this).text(String(i + 1));
      }
    });
  }

  function renderGate() {
    const $box = $('#sl-gate');
    if (!$box.length || !gate) return;
    const here = Number(UiContext.slPid);
    const nextPid = gate.current && gate.current !== here ? gate.current : null;
    const nextHref = nextPid ? `${sessionBase}/p/${nextPid}` : sessionBase;
    const nextBtn = `<a class="sl-gate__next" href="${nextHref}">${escapeHtml(nextPid ? `${i18n('Next task')} →` : `${i18n('Back to the session')} →`)}</a>`;
    let head;
    let hint;
    let btns = '';
    if (gate.isBonus) {
      const bt = bonuses.find((b) => String(b.docId) === String(UiContext.slPid)) || (window.UiContext && UiContext.slBonusTask) || null;
      head = `🎁 ${i18n('Bonus task')}`;
      hint = bt && bt.status === 'building'
        ? i18n('Made for your weak points. Read and code now — the judge is still being prepared, submissions open in a moment. No tutor here: submit, see the verdict, retry.')
        : bt && bt.status === 'failed'
          ? i18n('This bonus task could not be prepared.')
          : i18n('Made for your weak points. No tutor here — submit, see the verdict, retry as often as you like.');
      btns = `<a class="sl-gate__next" href="${sessionBase}">${escapeHtml(`${i18n('Back to the session')} →`)}</a>`;
      $box.html(`<b>${escapeHtml(head)}</b><div class="sl-gate__hint">${escapeHtml(hint)}${bt && bt.weakPoints?.length ? `<br>🎯 ${escapeHtml(bt.weakPoints.join(' · '))}` : ''}</div><div class="sl-gate__btns">${btns}</div>`);
      return;
    }
    if (gate.isDone) {
      head = `🏁 ${i18n('Task finished')}`;
      hint = !nextPid
        ? i18n('You have worked through every task. Retry any of them whenever you like.')
        : i18n('The next task is open. You can keep retrying this one any time.');
      btns = nextBtn;
    } else if (gate.isSkipped) {
      head = `⏭ ${i18n('Skipped task')}`;
      hint = i18n('Retry whenever you are ready — the next task is already open.');
      btns = nextBtn;
    } else if (gate.isCurrent) {
      head = i18n('Task {0} of {1}').replace('{0}', gate.index).replace('{1}', gate.total);
      hint = gate.engaged
        ? i18n('Get accepted and answer the tutor\u2019s question to finish — or skip for now and come back later.')
        : i18n('Get accepted and answer the tutor\u2019s question to unlock the next task. Skipping becomes possible after your first attempt.');
      btns = `${reaskReflection ? `<button type="button" class="sl-gate__reask" title="${escapeHtml(i18n('Answer the tutor\u2019s reflection question to finish this task'))}">💬 ${escapeHtml(i18n('Answer the tutor'))}</button>` : ''}`
        + `<button type="button" class="sl-gate__skip" ${gate.engaged ? '' : 'disabled'} title="${escapeHtml(gate.engaged ? i18n('Set this task aside and move on') : i18n('Submit at least one attempt first'))}">⏭ ${escapeHtml(i18n('Skip this task'))}</button>`;
    } else {
      head = i18n('Earlier task');
      hint = i18n('Open for retries; your current task is highlighted in the list.');
      btns = nextBtn.replace(i18n('Next task'), i18n('Go to current task'));
    }
    $box.html(`<b>${escapeHtml(head)}</b><div class="sl-gate__hint">${escapeHtml(hint)}</div><div class="sl-gate__btns">${btns}</div>`);
    $box.find('.sl-gate__reask').on('click', () => { if (reaskReflection) reaskReflection(); });
    $box.find('.sl-gate__skip').on('click', async function onSkip() {
      const action = await new ConfirmDialog({
        $body: tpl.typoMsg(i18n('Skip this task for now? It stays open — you can come back and retry it any time. The next task unlocks right away.')),
      }).open();
      if (action !== 'yes') return;
      $(this).prop('disabled', true);
      try {
        const res = await request.post(`${window.location.pathname}/skip`, {});
        gate = res.gate || gate;
        applyGateToRail(gate);
        Notification.success(i18n('Task skipped — opening the next one.'));
        setTimeout(() => { window.location.href = res.nextUrl || sessionBase; }, 600);
      } catch (e) {
        Notification.error(e.message);
        $(this).prop('disabled', false);
      }
    });
  }

  /* ------------------------- bonus task (students) ------------------------- */
  /*
   * Once every session task has been attempted, the rail offers a Bonus
   * Task. Clicking it asks the server to diagnose the student's weak points
   * and start an AI Studio build; the rail shows a shimmering placeholder
   * chip while the statement is drafted, which pops into a real chip the
   * student can open at once, and keeps pulsing while the judge is
   * prepared in the background. No tutor on bonus tasks.
   */
  const bonusInfo = (window.UiContext && UiContext.slBonus) || null;
  let bonuses = (window.UiContext && UiContext.slBonuses) || [];
  const bonusUrl = `${sessionBase}/bonus`;
  let bonusPoll = null;
  /*
   * Animation state. `bonusDesigning` covers the diagnosis call (the
   * longest silent stretch: the AI reads every attempt and tutor exchange
   * before any draft exists); the stage text advances on a timer since the
   * request is one round trip. While the draft is being built, the panel
   * mirrors the pipeline's own messages instead.
   */
  let bonusDesigning = false;
  let bonusStageTimer = null;
  const DESIGN_STAGES = [
    i18n('Reading your attempts…'),
    i18n('Reviewing your exchanges with the tutor…'),
    i18n('Finding your weak points…'),
    i18n('Designing a task that targets them…'),
    i18n('Almost there…'),
  ];
  const BUILD_HINT = {
    drafting: i18n('Writing the statement — you will be able to open it in a moment…'),
    building: i18n('Preparing the judge: reference solution, cross-check, tests, sandbox verification…'),
  };
  function startBonusStages($box) {
    clearInterval(bonusStageTimer);
    let k = 0;
    bonusStageTimer = setInterval(() => {
      k = Math.min(k + 1, DESIGN_STAGES.length - 1);
      const $st = $box.find('.sl-bonus__stage');
      if (!$st.length) { clearInterval(bonusStageTimer); return; }
      $st.addClass('is-swap');
      setTimeout(() => $st.text(DESIGN_STAGES[k]).removeClass('is-swap'), 180);
      if (k === DESIGN_STAGES.length - 1) clearInterval(bonusStageTimer);
    }, 4000);
  }

  function bonusChipHtml(b, i, extra = '') {
    const cls = ` bonus${b.status === 'drafting' ? ' bonus-drafting' : b.status === 'building' ? ' bonus-building' : b.status === 'failed' ? ' bonus-failed' : ''}${b.docId && String(b.docId) === String(UiContext.slPid) ? ' current' : ''}${extra}`;
    const href = b.docId && b.status !== 'failed' ? `${sessionBase}/p/${b.docId}` : 'javascript:;';
    const label = b.status === 'drafting' ? '…' : b.status === 'failed' ? '⚠' : `🎁${i + 1}`;
    const title = b.status === 'drafting' ? i18n('Designing your bonus task…')
      : b.status === 'building' ? `${b.title || i18n('Bonus task')} — ${i18n('read and code now; the judge is being prepared')}`
        : b.status === 'failed' ? `${i18n('Bonus task failed')}: ${b.message || ''}`
          : `${b.title || i18n('Bonus task')} — ${(b.weakPoints || []).join(', ')} · ${i18n('now in the Problem Set too')}`;
    return `<a class="sl-rail__chip${cls}"${b.docId ? ` data-pid="${escapeHtml(String(b.docId))}"` : ''} data-bonus="${escapeHtml(b.id)}" data-bonus-status="${escapeHtml(b.status)}" href="${href}" title="${escapeHtml(title)}">${escapeHtml(label)}</a>`;
  }

  /** Repaint the rail's bonus group from `bonuses` (creating it on first use). */
  function renderBonusChips(newId) {
    const $body = $('#sl-rail .sl-rail__body');
    if (!$body.length) return;
    let $cat = $body.find('.sl-rail__cat--bonus');
    let $grid = $body.find('.sl-rail__grid--bonus');
    const list = bonusDesigning
      ? [...bonuses, { id: '__designing', status: 'drafting', title: '', weakPoints: [], docId: null }]
      : bonuses;
    if (!list.length) {
      $cat.remove();
      $grid.remove();
      return;
    }
    if (!$grid.length) {
      // The server-rendered group (if any) has no marker classes: adopt it by header text, else append.
      const $hdr = $body.find('.sl-rail__cat').filter(function isBonus() { return $(this).text().trim() === i18n('Bonus'); }).first();
      if ($hdr.length) {
        $cat = $hdr.addClass('sl-rail__cat--bonus');
        $grid = $hdr.next('.sl-rail__grid').addClass('sl-rail__grid--bonus');
      } else {
        $cat = $(`<div class="sl-rail__cat sl-rail__cat--bonus">${escapeHtml(i18n('Bonus'))}</div>`).appendTo($body);
        $grid = $('<div class="sl-rail__grid sl-rail__grid--bonus"></div>').appendTo($body);
      }
    }
    $grid.html(list.map((b, i) => bonusChipHtml(b, i, b.id === newId ? ' bonus-new' : '')).join(''));
  }

  function renderBonusBox() {
    const $box = $('#sl-bonus');
    if (!$box.length || !bonusInfo) return;
    const inProgress = bonuses.some((b) => b.status === 'drafting' || b.status === 'building');
    const failed = bonuses.find((b) => b.status === 'failed');
    if (!bonusInfo.available) {
      $box.html('');
      return;
    }
    if (bonusDesigning) {
      // The diagnosis is running: a pulsing brain, a shimmering bar and
      // staged status text, so the wait never looks stalled.
      $box.html(`<div class="sl-bonus__design">
          <div class="sl-bonus__design-head"><span class="sl-bonus__brain">🧠</span><b>${escapeHtml(i18n('Designing your bonus task'))}</b></div>
          <div class="sl-bonus__bar"><i></i></div>
          <div class="sl-bonus__stage">${escapeHtml(DESIGN_STAGES[0])}</div>
        </div>`);
      startBonusStages($box);
      return;
    }
    if (inProgress) {
      const b = bonuses.find((x) => x.status === 'drafting' || x.status === 'building');
      const detail = (b.message || '').replace(/\.\.\.$/, '…');
      $box.html(`<div class="sl-bonus__design sl-bonus__design--${escapeHtml(b.status)}">
          <div class="sl-bonus__design-head"><span class="sl-bonus__brain">${b.status === 'drafting' ? '✍️' : '🛠️'}</span><b>${escapeHtml(b.status === 'drafting' ? i18n('Writing your bonus task') : (b.title || i18n('Bonus task')))}</b></div>
          <div class="sl-bonus__bar"><i></i></div>
          <div class="sl-bonus__stage">${escapeHtml(detail || BUILD_HINT[b.status] || '')}</div>
          ${b.status === 'building' ? `<div class="sl-bonus__note">${escapeHtml(i18n('Open it from the chip above and start reading — submissions open when the judge is ready.'))}</div>` : ''}
          ${(b.weakPoints || []).length ? `<div class="sl-bonus__kps">🎯 ${b.weakPoints.map((w) => `<span class="sl-bonus__kp">${escapeHtml(w)}</span>`).join('')}</div>` : ''}
        </div>`);
      return;
    }
    if (!bonusInfo.eligible) {
      $box.html(`<div class="sl-bonus__note">🎁 ${escapeHtml(i18n('Attempt every task of the session to unlock a bonus task made for your weak points.'))}</div>`);
      return;
    }
    // Exactly one bonus task per session: once it exists, only its state
    // (and a retry after a failed build) is shown — never a second button.
    if (bonuses.length) {
      $box.html(failed
        ? `<div class="sl-bonus__note">⚠ ${escapeHtml(failed.message || i18n('The bonus task could not be prepared.'))} <a href="javascript:;" class="sl-bonus__retry" data-id="${escapeHtml(failed.id)}">${escapeHtml(i18n('Retry'))}</a></div>`
        : `<div class="sl-bonus__note">🎁 ${escapeHtml(i18n('Your bonus task is ready in the list above — this session offers exactly one.'))}</div>`);
    } else {
      $box.html(`<button type="button" class="sl-bonus__btn" id="sl-bonus-btn">🎁 ${escapeHtml(i18n('Bonus Task'))}</button>
      <div class="sl-bonus__note">${escapeHtml(i18n('One new, harder task built from your attempts and tutor exchanges — aimed at your weak points. Each session offers exactly one.'))}</div>`);
    }
    $box.find('#sl-bonus-btn').on('click', createBonus);
    $box.find('.sl-bonus__retry').on('click', async function onRetry() {
      try {
        await request.post(bonusUrl, { operation: 'retry', id: $(this).attr('data-id') });
        bonuses = bonuses.map((b) => (b.id === $(this).attr('data-id') ? { ...b, status: b.docId ? 'building' : 'drafting', message: '' } : b));
        renderBonusChips();
        renderBonusBox();
        startBonusPoll();
      } catch (e) {
        Notification.error(e.message);
      }
    });
  }

  async function createBonus() {
    if (bonusDesigning) return;
    bonusDesigning = true;
    renderBonusChips('__designing'); // a shimmering placeholder chip appears at once
    renderBonusBox();
    try {
      const res = await request.post(bonusUrl, { operation: 'create' });
      bonusDesigning = false;
      clearInterval(bonusStageTimer);
      bonuses = [...bonuses, res.bonus];
      bonusInfo.inProgress = true;
      renderBonusChips(res.bonus.id);
      renderBonusBox();
      startBonusPoll();
    } catch (e) {
      bonusDesigning = false;
      clearInterval(bonusStageTimer);
      renderBonusChips();
      renderBonusBox();
      Notification.error(e.message);
    }
  }

  function startBonusPoll() {
    if (bonusPoll) return;
    bonusPoll = setInterval(async () => {
      if (!bonuses.some((b) => b.status === 'drafting' || b.status === 'building')) {
        clearInterval(bonusPoll);
        bonusPoll = null;
        return;
      }
      try {
        const res = await request.get(`${bonusUrl}?_fmt=json`);
        const before = new Map(bonuses.map((b) => [b.id, b.status]));
        bonuses = res.bonuses || bonuses;
        bonusInfo.eligible = !!res.eligible;
        bonusInfo.inProgress = !!res.inProgress;
        let popped = null;
        for (const b of bonuses) {
          const prev = before.get(b.id);
          if (prev === 'drafting' && b.status !== 'drafting') {
            popped = b.id;
            if (b.status === 'building') Notification.success(i18n('Your bonus task \u201c{0}\u201d is ready to read — open it from the side panel. Submissions open once the judge is prepared.').replace('{0}', b.title || ''));
          }
          if (prev && prev !== 'ready' && b.status === 'ready') {
            Notification.success(i18n('The judge for \u201c{0}\u201d is ready — you can submit now.').replace('{0}', b.title || ''));
            popped = b.id; // re-pop the chip as it turns solid
            try { confettiBurst(); } catch (err) { /* decorative */ }
            if (String(b.docId) === String(UiContext.slPid)) renderGate();
          }
          if (prev && prev !== 'failed' && b.status === 'failed') Notification.error(`${i18n('Bonus task failed')}: ${b.message || ''}`);
        }
        renderBonusChips(popped);
        renderBonusBox();
      } catch (e) { /* keep polling */ }
    }, 3000);
  }

  // The rail attaches asynchronously; paint the bonus slot once it exists.
  if (bonusInfo) {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if ($('#sl-bonus').length) {
        clearInterval(t);
        renderBonusChips();
        renderBonusBox();
        if (bonuses.some((b) => b.status === 'drafting' || b.status === 'building')) startBonusPoll();
      } else if (tries > 80) clearInterval(t);
    }, 150);
  }

  /** Take a fresh gate from any response and repaint. */
  function absorbGate(res) {
    if (!res || !res.gate) return;
    const wasDone = gate && gate.isDone;
    gate = res.gate;
    applyGateToRail(gate);
    renderGate();
    if (gate.isDone && !wasDone) {
      Notification.success(gate.current
        ? i18n('Task finished — the next task is unlocked!')
        : i18n('Task finished — that was the last one. Well done!'));
    }
  }
  // The rail is attached asynchronously (scratchpad mode); fill the block once it exists.
  if (gate) {
    let tries = 0;
    const gateTimer = setInterval(() => {
      tries += 1;
      if ($('#sl-gate').length) {
        clearInterval(gateTimer);
        renderGate();
        applyGateToRail(gate);
      } else if (tries > 80) clearInterval(gateTimer);
    }, 150);
  }

  let lastRid = null;
  /** Assigned by initScratchpad so page-level code can clear open cards. */
  let clearScratchpadAnnotations = () => {};
  /*
   * Panel chat: the launcher panel can continue the tutor's OPEN question —
   * the card the student may have closed by mistake. initScratchpad assigns
   * these: whether there is an open question, and how to answer it (the
   * same endpoint and bookkeeping as the card itself).
   */
  let panelHasQuestion = () => false;
  let panelAnswer = async () => {};

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
      }
      // Any other kind is a legacy button-chat turn: retired — the pop-up
      // cards near the code are the only interaction channel.
    }
  }

  function panelEmptyText() {
    return i18n('No tutoring history yet. Submit your code — the tutor will pop questions right at your lines.');
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
  }

  function closePanel() {
    panelOpen = false;
    $tutor.hide();
    $fab.show(); // the red launcher returns so the chat history stays one click away
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
        + ` <span class="text-gray">(${i18n('Score')}: ${data.score}, ${data.time}ms, ${data.memory}KiB)</span>`;
      if (data.cases && data.cases.length) {
        html += '<div class="sl-cases">';
        for (const c of data.cases) {
          const key = caseKey(c) ?? '?';
          const cls2 = c.status === 1 ? 'pass' : (/partial/i.test(c.message || '') ? 'partial' : 'fail');
          html += `<span class="${cls2}">#${escapeHtml(key)} ${escapeHtml(c.statusText)}</span>`;
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

  /**
   * The plain answer form (answer-submission tasks, which have no IDE and no
   * tutor): submit, then poll the verdict inline. Programming tasks never
   * reach this — they submit from the Scratchpad toolbar.
   */
  async function handleSubmit(ev) {
    if (ev) ev.preventDefault();
    const lang = $('[name="lang"]').val() || '_';
    const code = $('[name="code"]').val();
    if (!code || !code.trim()) {
      Notification.warn(i18n('Please write your code first.'));
      return;
    }
    const $btn = $('#sl-submit');
    $btn.prop('disabled', true);
    $('#sl-submit-hint').text(i18n('Submitting...'));
    try {
      const res = await request.post(window.location.pathname, { lang, code });
      lastRid = res.rid;
      $('#sl-submit-hint').text('');
      renderVerdict({ judged: false, statusText: i18n('Waiting') });
      const data = await pollRecord(res.rid);
      if (data && data.accepted) Notification.success(i18n('Accepted! Great job!'));
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
    // The last question asked, kept after its card is closed so the panel
    // can still answer it (cleared on a new submission — the code changed).
    let lastQuestion = null;
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

    /** Panel input: enabled only while the tutor has an unanswered question. */
    function refreshPanelInput() {
      const open = !!(lastQuestion && !lastQuestion.resolved);
      $('#sl-panel-input').prop('disabled', !open).attr('placeholder', open
        ? i18n('Answer the tutor\u2019s open question here… (Enter to send)')
        : i18n('No open question right now — submit your code to get the next one.'));
      $('#sl-panel-send').prop('disabled', !open);
    }
    panelHasQuestion = () => !!(lastQuestion && !lastQuestion.resolved);

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
      lastQuestion = null;
      refreshPanelInput();
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
      .sl-anno__giveup { background: var(--pta-card); color: var(--pta-warn-text); border: 1px solid var(--pta-warn-line); border-radius: 999px; padding: 1px 10px; font-size: 10.5px; cursor: pointer; margin-right: 2px; }
      .sl-anno__giveup:hover { background: var(--pta-warn-soft); }
      .pta-dark .sl-anno, .pta-dark .sl-anno-ghost { border-left-color: #e35d6a; box-shadow: 0 12px 30px -12px rgba(0, 0, 0, .65); }
      .pta-dark .sl-anno--resolved { border-left-color: #69b34c; }
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
        + `<input type="text" maxlength="1000" placeholder="${escapeHtml(i18n('Type your answer \u2014 it\u2019s fine to say you don\u2019t know (Enter to send)'))}">`
        + `<button type="button" class="sl-anno__send" title="${escapeHtml(i18n('Send'))}">➤</button>`
        + (accepted ? '' : `<button type="button" class="sl-anno__skip" title="${escapeHtml(i18n('Already fixed it? Jump straight to the next issue.'))}">${escapeHtml(i18n('Next issue'))} ➜</button>`)
        + '</div>';
      const entry = addZone(ed, endLine, 120, dom, { line, endLine });
      cardState = {
        entry, dom, rid, line, endLine, question: ann.question, history: [], accepted,
      };
      lastQuestion = cardState;
      refreshPanelInput();
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
        absorbGate(res);
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
          // Accepted with nothing left to reflect on: the server finishes
          // the task here, so the card says so in the same words as a
          // resolved reflection would.
          if (accepted) showInfoCard(`🎉 ${i18n('Accepted — nothing left to ask: you have truly mastered this problem!')}`, afterLine || 0);
          else showInfoCard(i18n('All issues covered — apply your fixes and submit once to verify!'), afterLine || 0);
        }
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
        absorbGate(res);
        appendCardMsg('tutor', res.reply);
        // Mirror the exchange into the launcher panel history.
        appendBubble('user', text, { line: cs.line, endLine: cs.endLine });
        appendBubble('assistant', res.reply, {
          line: cs.line, endLine: cs.endLine, resolved: res.resolved, accepted: cs.accepted,
        });
        if (res.resolved) {
          askedQuestions.push(cs.question);
          cs.resolved = true;
          refreshPanelInput();
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

    /**
     * Answer the open question from the launcher panel. If its card is still
     * on screen the card's own flow runs (and mirrors into the panel); if the
     * student closed the card, the same endpoint is called here and the
     * exchange lives in the panel alone.
     */
    panelAnswer = async (text) => {
      const q = lastQuestion;
      if (!q || q.resolved) return;
      if (cardState === q && q.dom && document.body.contains(q.dom)) {
        await submitCardAnswer(text);
        return;
      }
      const session = annoSession;
      const priorHistory = q.history.slice();
      appendBubble('user', text, { line: q.line, endLine: q.endLine });
      const $wait = $(`<div class="sl-msg assistant"><div class="sl-bubble"><em>${escapeHtml(i18n('The tutor is thinking...'))}</em></div></div>`).appendTo($chat);
      scrollChat();
      $('#sl-panel-input, #sl-panel-send').prop('disabled', true);
      try {
        const res = await request.post(tutorUrl, {
          operation: 'annotateReply',
          rid: q.rid,
          line: q.line,
          endLine: q.endLine,
          question: q.question,
          history: JSON.stringify(priorHistory.slice(-10)),
          text,
          code: currentEditorCode(),
        });
        $wait.remove();
        if (session !== annoSession) return;
        q.history.push({ role: 'student', content: text });
        q.history.push({ role: 'tutor', content: res.reply });
        absorbGate(res);
        appendBubble('assistant', res.reply, {
          line: q.line, endLine: q.endLine, resolved: res.resolved, accepted: q.accepted,
        });
        if (res.resolved) {
          askedQuestions.push(q.question);
          q.resolved = true;
          appendDivider(q.accepted
            ? i18n('Great reflection — you have truly mastered this problem!')
            : i18n('Great — now FIX this line in the editor.'), q.accepted);
        }
      } catch (e) {
        $wait.remove();
        appendBubble('assistant', `⚠️ ${e.message}`);
      } finally {
        refreshPanelInput();
        scrollChat();
      }
    };

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
            absorbGate(data); // tutor-less sessions: an accepted verdict finishes the task
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
        // Progression: answering that question finishes the task; keep a
        // way to re-open it if the card was closed unanswered.
        reaskReflection = async () => {
          askedQuestions = [];
          await requestNextQuestion(rid, lastLine, true);
        };
        renderGate();
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

  // Answer-submission tasks render the plain form (its textarea is upgraded
  // to Monaco by the site-wide code_editor.page.js autoload); programming
  // tasks go straight into the IDE. Objective tasks never render this page
  // — the solve route sends them to the session paper.
  $('#sl-submit-form').on('submit', handleSubmit);
  initScratchpad();

  // Answer-submission problems have no IDE, but keep the same session
  // problem rail, attached below the navbar in page mode, so learners can
  // navigate among the session's problems from here too.
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
  // Panel chat: continue the tutor's open question (the card may be closed).
  const sendPanel = async () => {
    const $in = $('#sl-panel-input');
    const text = String($in.val() || '').trim();
    if (!text) return;
    if (!panelHasQuestion()) {
      Notification.info(i18n('No open question right now — submit your code to get the next one.'));
      return;
    }
    $in.val('');
    await panelAnswer(text);
  };
  $('#sl-panel-send').on('click', sendPanel);
  $('#sl-panel-input').on('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendPanel();
    }
  });
  // Until a question exists the row is disabled with an explanation.
  $('#sl-panel-input').prop('disabled', true).attr('placeholder', i18n('No open question right now — submit your code to get the next one.'));
  $('#sl-panel-send').prop('disabled', true);
  $(document).on('keydown', (ev) => {
    if (ev.key === 'Escape' && panelOpen && isExpanded) setExpanded(false);
  });
  initPanelResize();
  $(window).on('resize', () => {
    syncFab();
    applyPanelLayout();
  });

  // Replay the previous tutoring history on page load (programming only —
  // UiContext.slTutor is false for every other task kind).
  if (UiContext.slTutor && $tutor.length) {
    request.get(tutorUrl).then((res) => {
      if (res.messages && res.messages.length) {
        renderMessages(res.messages, true);
        // Legacy chat turns are filtered out; only light the dot when the
        // read-only history actually has something to show.
        if ($chat.children().length) $fabDot.show();
      }
    }).catch(() => { /* tutor unavailable; the fab still opens an empty panel */ });
  }
});
