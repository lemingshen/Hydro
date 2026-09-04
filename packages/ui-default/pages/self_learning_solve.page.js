import $ from 'jquery';
import MarkdownIt from 'markdown-it';
import { mountComposer } from 'vj/components/chat-composer';
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
    // ⏹ The session is over but stays usable: submissions and tutoring are
    // still available as PRACTICE — none of it changes the recorded score.
    Notification.info(i18n('This session has ended. You can keep practising here — submissions and tutor answers no longer count towards your score.'));
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
    // Session tasks only. A bonus chip carries a data-pid too (its own
    // problem), but the gate never lists it — without this filter it fell
    // to `locked`: a dashed grey chip with a 🚫 cursor that still opened
    // on click, because its href was already real.
    const $chips = $('#sl-rail .sl-rail__chip[data-pid]:not([data-bonus])');
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
  /** Still being built server-side: diagnosing → drafting → building. */
  const isBusy = (b) => !!b && (b.status === 'diagnosing' || b.status === 'drafting' || b.status === 'building');
  /*
   * Animation state. The whole build is a BACKGROUND JOB: the create
   * request returns at once with a `diagnosing` entry and the page only
   * polls it — so a refresh at any moment lands back on the same panel.
   * `bonusDesigning` covers only the instant before that first response.
   * The diagnosis is the one long silent stretch with no progress signal
   * (one LLM call reading every attempt and tutor exchange), so its stage
   * text advances on a timer, keyed to the job so a reload resumes at a
   * plausible point; drafting and building mirror the pipeline's own
   * messages instead.
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
  /** The stage text the diagnosis has plausibly reached, from its start time. */
  function designStageAt(startedAt) {
    const t = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;
    return Math.min(DESIGN_STAGES.length - 1, Math.max(0, Math.floor(t / 4000)));
  }
  function startBonusStages($box, from = 0) {
    clearInterval(bonusStageTimer);
    let k = from;
    bonusStageTimer = setInterval(() => {
      k = Math.min(k + 1, DESIGN_STAGES.length - 1);
      const $st = $box.find('.sl-bjob__stage');
      if (!$st.length) { clearInterval(bonusStageTimer); return; }
      $st.addClass('is-swap');
      setTimeout(() => $st.text(DESIGN_STAGES[k]).removeClass('is-swap'), 180);
      if (k === DESIGN_STAGES.length - 1) clearInterval(bonusStageTimer);
    }, 4000);
  }

  function bonusChipHtml(b, i, extra = '') {
    const designing = b.status === 'diagnosing' || b.status === 'drafting';
    const cls = ` bonus${designing ? ' bonus-drafting' : b.status === 'building' ? ' bonus-building' : b.status === 'failed' ? ' bonus-failed' : ''}${b.docId && String(b.docId) === String(UiContext.slPid) ? ' current' : ''}${extra}`;
    const href = b.docId && b.status !== 'failed' ? `${sessionBase}/p/${b.docId}` : 'javascript:;';
    const label = designing ? '…' : b.status === 'failed' ? '⚠' : `🎁${i + 1}`;
    const title = designing ? i18n('Designing your bonus task…')
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
      ? [...bonuses, { id: '__designing', status: 'diagnosing', title: '', weakPoints: [], docId: null }]
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

  /**
   * The BUILD CARD: one animated view of the background job, whatever
   * phase it is in. A three-step track (diagnose → write → prepare the
   * judge) with the live step glowing, a sweeping progress bar, a stage
   * line that either rotates on a timer (diagnosis: no real signal) or
   * mirrors the pipeline's message, and the weak points as chips once the
   * diagnosis has named them. Re-rendered on every poll; the track and bar
   * transition between phases instead of snapping.
   */
  const JOB_STEPS = [
    ['🧠', i18n('Diagnose your weak points')],
    ['✍️', i18n('Write the statement')],
    ['🛠️', i18n('Prepare the judge')],
  ];
  function renderJobCard($box, b) {
    const phase = b.status === 'diagnosing' ? 0 : b.status === 'drafting' ? 1 : 2;
    const title = phase === 0 ? i18n('Designing your bonus task')
      : phase === 1 ? i18n('Writing your bonus task')
        : (b.title || i18n('Bonus task'));
    const stageIdx = phase === 0 ? designStageAt(b.startedAt || b.createdAt) : -1;
    const stage = phase === 0 ? DESIGN_STAGES[stageIdx]
      : ((b.message || '').replace(/\.\.\.$/, '…') || BUILD_HINT[b.status] || '');
    // Determinate-looking progress with an indeterminate sweep: the bar
    // fills a little past each finished step so it never sits still.
    const pct = [22, 55, 84][phase];
    const steps = JOB_STEPS.map(([icon, label], i) => {
      const st = i < phase ? 'is-done' : i === phase ? 'is-active' : '';
      const mark = i < phase ? '✓' : i === phase ? '<span class="sl-bjob__spin"></span>' : String(i + 1);
      return `<li class="${st}"><span class="sl-bjob__mark">${mark}</span><span class="sl-bjob__ico">${icon}</span><span>${escapeHtml(label)}</span></li>`;
    }).join('');
    const kps = (b.weakPoints || []).length
      ? `<div class="sl-bjob__kps"><span class="sl-bjob__kps-ico">🎯</span>${b.weakPoints.map((w) => `<span class="sl-bjob__kp">${escapeHtml(w)}</span>`).join('')}</div>`
      : '';
    const note = phase === 2
      ? `<div class="sl-bjob__note">${escapeHtml(i18n('Open it from the chip above and start reading — submissions open when the judge is ready.'))}</div>`
      : '';
    const $prev = $box.children('.sl-bjob');
    const html = `<div class="sl-bjob sl-bjob--p${phase}">
        <div class="sl-bjob__head">
          <span class="sl-bjob__orb"><span class="sl-bjob__orb-ico">${JOB_STEPS[phase][0]}</span></span>
          <div class="sl-bjob__titles"><b>${escapeHtml(title)}</b><span class="sl-bjob__stage">${escapeHtml(stage)}</span></div>
        </div>
        <ol class="sl-bjob__steps">${steps}</ol>
        <div class="sl-bjob__track"><i style="width:${pct}%"></i></div>
        ${kps}${note}
      </div>`;
    if ($prev.length && $prev.hasClass(`sl-bjob--p${phase}`)) {
      // Same phase: patch the live bits in place so the animations keep
      // their rhythm instead of restarting on every poll.
      $prev.find('.sl-bjob__stage').text(stage);
      $prev.find('.sl-bjob__titles b').text(title);
      if (kps && !$prev.find('.sl-bjob__kps').length) $prev.find('.sl-bjob__track').after(kps);
      return;
    }
    $box.html(html);
    if (phase === 0) startBonusStages($box, stageIdx);
    else clearInterval(bonusStageTimer);
  }

  function renderBonusBox() {
    const $box = $('#sl-bonus');
    if (!$box.length || !bonusInfo) return;
    const busy = bonuses.find(isBusy);
    const failed = bonuses.find((b) => b.status === 'failed');
    if (!bonusInfo.available) {
      $box.html('');
      return;
    }
    /*
     * 🎁 The teacher's Bonus tickbox is off for this session. Nothing is
     * offered — no button, no "finish every task first" teaser, because
     * finishing them would not unlock anything. A student who already owns
     * a task from before the box was unticked keeps it, so the panel still
     * falls through to the state view below when `bonuses` is non-empty.
     */
    if (bonusInfo.allowed === false && !bonuses.length) {
      $box.html('');
      return;
    }
    if (bonusDesigning) {
      // The create request is in flight (a moment: it returns as soon as
      // the job is recorded). Same card, diagnosis phase, clock at zero.
      renderJobCard($box, { status: 'diagnosing', startedAt: Date.now(), weakPoints: [] });
      return;
    }
    if (busy) {
      renderJobCard($box, busy);
      return;
    }
    clearInterval(bonusStageTimer);
    // Exactly one bonus task per session: once it exists, only its state
    // (and a retry after a failed build) is shown — never a second button.
    // Checked BEFORE eligibility on purpose: eligibility can flip false
    // after a task was granted (the teacher adds a task to the session, or
    // unticks Bonus), and an owned task must not then read as "locked".
    if (bonuses.length) {
      $box.html(failed
        ? `<div class="sl-bonus__note">⚠ ${escapeHtml(failed.message || i18n('The bonus task could not be prepared.'))} <a href="javascript:;" class="sl-bonus__retry" data-id="${escapeHtml(failed.id)}">${escapeHtml(i18n('Retry'))}</a></div>`
        : `<div class="sl-bonus__note">🎁 ${escapeHtml(i18n('Your bonus task is ready in the list above — this session offers exactly one.'))}</div>`);
    } else if (!bonusInfo.eligible) {
      $box.html(`<div class="sl-bonus__note">🎁 ${escapeHtml(i18n('Attempt every task of the session to unlock a bonus task made for your weak points.'))}</div>`);
      return;
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
      if (!bonuses.some(isBusy)) {
        clearInterval(bonusPoll);
        bonusPoll = null;
        return;
      }
      try {
        const res = await request.get(`${bonusUrl}?_fmt=json`);
        const before = new Map(bonuses.map((b) => [b.id, b.status]));
        bonuses = res.bonuses || bonuses;
        if (typeof res.allowed === 'boolean') bonusInfo.allowed = res.allowed;
        bonusInfo.eligible = !!res.eligible;
        bonusInfo.inProgress = !!res.inProgress;
        let popped = null;
        for (const b of bonuses) {
          const prev = before.get(b.id);
          if ((prev === 'diagnosing' || prev === 'drafting') && b.status !== prev) {
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
        if (bonuses.some(isBusy)) startBonusPoll();
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

  /** Scrolls the editor to the open question's anchored lines (assigned by initScratchpad). */
  let panelRevealQuestion = () => {};
  /**
   * One-line-by-default input that grows with its content, so neither the
   * placeholder nor a long answer ever scrolls inside a fixed box — the
   * scrollbar appears only past the stylesheet's max-height. Declared up
   * here because refreshPanelInput (inside initScratchpad) calls it.
   */

  /* ------- floating layout: body portal, drag, viewport-adaptive geometry ------- */

  // Saved as viewport FRACTIONS so both the launcher position and the window size
  // adapt naturally to any page size, window resize, or zoom level.
  const FAB_POS_KEY = 'hydro:sl-fab-pos';
  const PANEL_SIZE_KEY = 'hydro:sl-panel-size';
  const PANEL_POS_KEY = 'hydro:sl-panel-pos';
  const FAB_SIZE = 56;
  const EDGE = 12;
  let fabDragMoved = false;
  let fabFrac = null; // {fx, fy} in [0,1]; null = untouched default (center right)
  let sizeFrac = null; // {fw, fh} as fractions of the viewport; null = default size
  let panelFrac = null; // {fx, fy} of the window's top-left; null = hug the launcher
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
   * The window's top-left as fractions of its MOVABLE RANGE (viewport minus
   * window minus margins), like the launcher's — so a saved position can
   * never resolve off-screen, whatever the next viewport or window size is.
   */
  function panelPosFromPixels(left, top, w, h) {
    const minY = topBound();
    const rangeX = Math.max(1, window.innerWidth - w - EDGE * 2);
    const rangeY = Math.max(1, window.innerHeight - h - minY - EDGE);
    return {
      fx: Math.min(1, Math.max(0, (left - EDGE) / rangeX)),
      fy: Math.min(1, Math.max(0, (top - minY) / rangeY)),
    };
  }

  /**
   * Single source of truth for the open window's geometry. The size scales with
   * the viewport and everything stays on screen below the navbar. Until the
   * window has been dragged, it hugs the launcher; after a drag (see
   * initPanelDrag) the stored top-left rules, re-clamped to the viewport.
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
    // Expanded: a large reading pane — up to 760px wide, full available height.
    const size = isExpanded
      ? {
        w: Math.min(760, Math.max(300, window.innerWidth - EDGE * 2)),
        h: Math.max(360, window.innerHeight - topBound() - EDGE),
      }
      : panelSizePixels();
    let left;
    let top;
    if (panelFrac) {
      const minY = topBound();
      left = EDGE + panelFrac.fx * Math.max(0, window.innerWidth - size.w - EDGE * 2);
      top = minY + panelFrac.fy * Math.max(0, window.innerHeight - size.h - minY - EDGE);
    } else {
      const fp = fabPixelPos();
      left = Math.min(Math.max(EDGE, fp.x + FAB_SIZE - size.w), window.innerWidth - size.w - EDGE);
      top = Math.min(Math.max(topBound(), fp.y + FAB_SIZE - size.h), window.innerHeight - size.h - EDGE);
    }
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
      // Corner-resizing moves the top-left; a dragged window must keep the
      // position it just resized to instead of snapping back on relayout.
      if (panelFrac) {
        panelFrac = panelPosFromPixels(r.left, r.top, r.width, r.height);
        try {
          localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelFrac));
        } catch (e) { /* persistence is best-effort */ }
      }
      applyPanelLayout();
    };
    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
  }

  /**
   * Requested UX: the window is draggable by its upper frame. Pointer-drag
   * any empty header area — the action buttons, the question chip and the
   * resize corner keep their own gestures, and the narrow-viewport sheet
   * layout is not draggable. The dropped position is stored as fractions of
   * the movable range (PANEL_POS_KEY) so it survives reloads and viewport
   * changes without ever resolving off-screen; double-clicking the same
   * empty header area toggles the expanded reading pane.
   */
  function initPanelDrag() {
    const header = $tutor.find('.sl-float__header')[0];
    if (!header) return;
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
      if (saved && Number.isFinite(saved.fx) && Number.isFinite(saved.fy)) {
        panelFrac = { fx: Math.min(1, Math.max(0, saved.fx)), fy: Math.min(1, Math.max(0, saved.fy)) };
      }
    } catch (e) { /* keep hugging the launcher */ }
    const ownGesture = (ev) => !!(ev.target.closest && ev.target.closest('.sl-hbtn, .sl-float__qtag, .sl-float__resize'));
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origL = 0;
    let origT = 0;
    let boxW = 0;
    let boxH = 0;
    header.addEventListener('pointerdown', (ev) => {
      if (isNarrowViewport()) return;
      if (ev.button !== undefined && ev.button !== 0) return;
      if (ownGesture(ev)) return;
      const r = $tutor[0].getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      origL = r.left;
      origT = r.top;
      boxW = r.width;
      boxH = r.height;
      dragging = true;
      moved = false;
      header.setPointerCapture?.(ev.pointerId);
    });
    header.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return; // still a click
      moved = true;
      ev.preventDefault();
      const minY = topBound();
      const left = Math.min(Math.max(EDGE, origL + dx), Math.max(EDGE, window.innerWidth - boxW - EDGE));
      const top = Math.min(Math.max(minY, origT + dy), Math.max(minY, window.innerHeight - boxH - EDGE));
      $tutor.css({
        left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto',
      });
    });
    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      header.releasePointerCapture?.(ev.pointerId);
      if (!moved) return;
      const r = $tutor[0].getBoundingClientRect();
      panelFrac = panelPosFromPixels(r.left, r.top, r.width, r.height);
      try {
        localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelFrac));
      } catch (e) { /* persistence is best-effort */ }
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
    header.addEventListener('dblclick', (ev) => {
      if (ownGesture(ev)) return;
      ev.preventDefault();
      setExpanded(!isExpanded);
    });
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

  /** 🎓 The five level meanings, indexable by level (titles for chips). */
  const LEVEL_DESCS = [
    'no answer or evasion',
    'restates the code in words',
    'correct mechanical account — what and how',
    'correct plus why it is necessary',
    'correct plus a generalization (tradeoff, alternative, complexity)',
  ];
  /** 🧩 The five failure-phase REASONING levels (thinking vs guessing). */
  const REASONING_DESCS = [
    'no substantive answer, off-topic, or restates the question',
    'a guess with no reasoning',
    'relevant reasoning, but vague or partly wrong',
    'correct, specific reasoning about their own code',
    'correct reasoning plus predicts a consequence or generalizes',
  ];
  /**
   * Per-answer grade chip — immediate student feedback on a graded answer.
   * kind picks the rubric wording: post-acceptance 'ownership' (🎓) vs
   * failure-phase 'reasoning' (🧩).
   */
  function levelChipHtml(level, kind = 'ownership') {
    const n = Math.min(4, Math.max(0, Math.round(level)));
    const descs = kind === 'reasoning' ? REASONING_DESCS : LEVEL_DESCS;
    const icon = kind === 'reasoning' ? '🧩' : '🎓';
    const title = `${i18n('Level {0} of {1}').replace('{0}', n).replace('{1}', 4)} — ${i18n(descs[n])}`;
    return `<span class="sl-lvl sl-lvl--l${n}" title="${escapeHtml(title)}">${icon} L${n}/4</span>`;
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
    if (meta && typeof meta.level === 'number') $bubble.append(levelChipHtml(meta.level, meta.levelKind || 'ownership'));
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
          line: m.line,
          endLine: m.endLine,
          resolved: m.resolved,
          accepted: underAccepted,
          level: typeof m.level === 'number' ? m.level : m.rlevel,
          levelKind: typeof m.level === 'number' ? 'ownership' : 'reasoning',
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
    /*
     * 🔒 Why the scratchpad editor is read-only right now. Two independent
     * reasons can hold it:
     *   'thinking' — the LLM is working (overlay / in-card spinner);
     *   'question' — a tutor question from a FAILED submission is OPEN.
     *                Requirement: no code editing for as long as the
     *                tutor keeps asking — across every follow-up of the
     *                mini-dialogue — until the tutor deems the question
     *                resolved, or the student moves on to the next issue.
     * A Set rather than a flag, because the two overlap constantly — a
     * question card appears the instant thinking ends — and releasing one
     * must never unlock an editor the other still holds.
     */
    const editorLocks = new Set();
    let editorLocked = ''; // the reason Monaco was last told ('' = editable), diffed on apply

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

    /** The positioned wrapper around Monaco (.ScratchpadMonacoEditor), for overlays. */
    function editorHost() {
      const ed = findScratchpadEditor();
      const dom = ed && ed.getDomNode && ed.getDomNode();
      return (dom && dom.closest && dom.closest('.ScratchpadMonacoEditor')) || null;
    }

    /**
     * Push the lock set into Monaco. Idempotent: the editor is only told
     * about a change of state, and the tooltip Monaco shows on a keypress
     * in a read-only editor names the CURRENT reason, so a student who
     * tries to type learns what to do instead of seeing the stock
     * "cannot edit in read-only editor".
     */
    function applyEditorLock() {
      const ed = findScratchpadEditor();
      if (!ed) return;
      // Diffed on the REASON, not just on locked/unlocked, so the tooltip
      // follows a hand-over between the two locks. A held lock is always
      // re-asserted (cheap): the scratchpad may hand us a fresh Monaco
      // instance that never heard the first one.
      const state = editorLocks.size === 0 ? '' : (editorLocks.has('thinking') ? 'thinking' : 'question');
      if (state || state !== editorLocked) {
        ed.updateOptions({
          readOnly: !!state,
          readOnlyMessage: state ? {
            value: state === 'thinking'
              ? i18n('The tutor is thinking...')
              : i18n('Editing unlocks once the tutor is satisfied with your answer — or when you move on with “Next issue”.'),
          } : undefined,
        });
        editorLocked = state;
      }
      // The pill is for the question lock only: the thinking lock already
      // has its overlay or in-card spinner.
      const host = editorHost();
      const showPill = editorLocks.has('question') && !editorLocks.has('thinking');
      let pill = document.getElementById('sl-editlock');
      if (showPill && host) {
        if (!pill) {
          ensureTutorUiStyle();
          pill = document.createElement('div');
          pill.id = 'sl-editlock';
          pill.className = 'sl-editlock';
          pill.innerHTML = `🔒 ${escapeHtml(i18n('Editing is paused while the tutor has a question for you.'))}`;
        }
        if (pill.parentNode !== host) host.appendChild(pill);
      } else if (pill) pill.remove();
    }

    function lockEditor(reason = 'thinking') {
      editorLocks.add(reason);
      applyEditorLock();
    }

    function unlockEditor(reason = 'thinking') {
      editorLocks.delete(reason);
      applyEditorLock();
    }

    /**
     * The panel is a READ-ONLY history: answering happens only in the
     * pop-up card at the code line. This keeps just the header 📍 chip
     * mirroring where the open question is anchored (click jumps there).
     */
    function refreshPanelInput() {
      const open = !!(lastQuestion && !lastQuestion.resolved);
      const $tag = $('#sl-tutor-qtag');
      if (open && lastQuestion.line) {
        const loc = lastQuestion.endLine && lastQuestion.endLine !== lastQuestion.line
          ? `L${lastQuestion.line}–${lastQuestion.endLine}` : `L${lastQuestion.line}`;
        $tag.text(`📍 ${loc}`).attr('title', i18n('Jump to the anchored lines')).show();
      } else $tag.hide();
    }
    panelRevealQuestion = () => {
      const ed = findScratchpadEditor();
      if (ed && lastQuestion && lastQuestion.line) {
        try { ed.revealLineInCenter(lastQuestion.line); } catch (e) { /* the editor may be gone */ }
      }
    };

    function clearAnnotations() {
      annoSession += 1;
      for (const a of annoState) {
        disposeZoneListeners(a);
        try {
          a.editor.changeViewZones((acc) => acc.removeZone(a.zoneId));
          if (a.decoIds && a.decoIds.length) a.editor.deltaDecorations(a.decoIds, []);
        } catch (e) { /* the editor may already be gone */ }
      }
      annoState = [];
      cardState = null;
      lastQuestion = null;
      refreshPanelInput();
      unlockEditor('question'); // no card, no question to hold the editor for
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

    /*
     * 📐 The card's WIDTH follows the editor, not a fixed cap. A Monaco view
     * zone lives inside the lines layer, which is as wide as the LONGEST
     * LINE and starts at the text column — so a fixed-width card, sized
     * for a wide desktop pane, ran off the visible area the moment the IDE
     * pane was narrower (a split view, a smaller window, the minimap on)
     * and lost its send button behind the minimap.
     *
     * The budget comes from Monaco's own layout: the visible text area,
     * from the text column to the minimap (or the vertical scrollbar when
     * the minimap is off). The card takes that, less its margins, capped
     * at a readable maximum — and is re-fitted whenever the editor lays
     * out again (pane drag, window resize, minimap toggle). Horizontal
     * scrolling moves the lines layer under it, so the card slides along
     * by the scroll offset and stays where the eye left it.
     */
    const CARD_MAX_PX = 720;
    const CARD_MIN_PX = 240;
    const CARD_GUTTER_PX = 12; // left margin, matching .sl-anno's design

    function zoneAvailWidth(ed) {
      try {
        const li = ed.getLayoutInfo();
        const mm = li.minimap;
        const rightEdge = (mm && mm.minimapWidth > 0 && mm.minimapLeft > li.contentLeft)
          ? mm.minimapLeft
          : li.width - (li.verticalScrollbarWidth || 0);
        return Math.max(0, rightEdge - li.contentLeft);
      } catch (e) {
        return 0;
      }
    }

    function fitZoneWidth(entry) {
      if (!entry || !entry.zone || !entry.zone.domNode) return;
      const dom = entry.zone.domNode;
      const avail = zoneAvailWidth(entry.editor);
      if (!avail) return;
      const width = Math.max(CARD_MIN_PX, Math.min(avail - CARD_GUTTER_PX * 2, CARD_MAX_PX));
      const changed = dom.style.width !== `${width}px`;
      dom.style.width = `${width}px`;
      dom.style.maxWidth = 'none';
      let scrollLeft = 0;
      try { scrollLeft = entry.editor.getScrollLeft() || 0; } catch (e) { /* keep 0 */ }
      dom.style.marginLeft = `${CARD_GUTTER_PX + scrollLeft}px`;
      // A new width re-wraps the text; re-fit the height the card last
      // asked for (fitZone remembers its budget on the entry).
      if (changed && entry.fit) fitZone(entry, entry.fit.min, entry.fit.max);
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
        zoneId, zone, decoIds, editor: ed, disposables: [],
      };
      fitZoneWidth(entry);
      try {
        entry.disposables.push(
          ed.onDidLayoutChange(() => fitZoneWidth(entry)),
          ed.onDidScrollChange((e) => { if (e.scrollLeftChanged) fitZoneWidth(entry); }),
        );
      } catch (e) { /* an editor without these events keeps the initial fit */ }
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
      entry.fit = { min, max }; // so a width change can re-fit with the same budget
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

    function disposeZoneListeners(entry) {
      for (const d of entry.disposables || []) {
        try { d.dispose(); } catch (e) { /* already gone */ }
      }
      entry.disposables = [];
    }

    function removeZoneEntry(entry) {
      disposeZoneListeners(entry);
      try {
        entry.editor.changeViewZones((acc) => acc.removeZone(entry.zoneId));
        if (entry.decoIds && entry.decoIds.length) entry.editor.deltaDecorations(entry.decoIds, []);
      } catch (e) { /* ignore */ }
      annoState = annoState.filter((x) => x !== entry);
    }

    /**
     * The COMPLETE tutor-card stylesheet, injected from the bundle: the card
     * is a popup hugging the code line — sized to the editor's visible text
     * area by fitZoneWidth, never a fixed width that can run off a narrow
     * pane — and never at the mercy of template freshness.
     */
    const TUTOR_UI_STYLE = `
      @keyframes slGhostPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
      @keyframes slResolvePulse { 0% { box-shadow: 0 8px 24px -10px rgba(47, 158, 68, .4), 0 0 0 0 rgba(47, 158, 68, .35); } 100% { box-shadow: 0 8px 24px -10px rgba(47, 158, 68, .4), 0 0 0 12px rgba(47, 158, 68, 0); } }
      .sl-anno { display: flex; flex-wrap: nowrap; align-items: flex-start; gap: 8px; box-sizing: border-box; max-width: 720px; min-width: 240px; background: var(--pta-card); border: 1px solid var(--pta-crimson-line); border-left: 4px solid var(--pta-crimson); border-radius: 14px; padding: 9px 12px; margin: 0 0 0 12px; font-size: 13px; line-height: 1.45; box-shadow: 0 12px 30px -12px rgba(158, 35, 53, .38), 0 2px 6px rgba(15, 23, 42, .07); color: var(--pta-ink); user-select: text; overflow: hidden; animation: ptaScaleIn .28s var(--pta-ease) both; }
      .sl-anno--chat { flex-direction: column; align-items: stretch; gap: 7px; padding: 8px 12px 10px; }
      .sl-anno__head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: bold; font-size: 12.5px; letter-spacing: .01em; color: var(--pta-crimson-text); flex: 0 0 auto; min-height: 22px; }
      .sl-anno__title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sl-anno__lockchip { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; letter-spacing: .01em; padding: 2px 8px; border-radius: 999px; background: var(--pta-warn-soft); border: 1px solid var(--pta-warn-line); color: var(--pta-warn-text); white-space: nowrap; cursor: help; animation: ptaScaleIn .24s var(--pta-ease) both; }
      .sl-anno__log { max-height: var(--sl-log-max, 148px); overflow-y: auto; overflow-x: hidden; background: var(--pta-card-2); border: 1px solid var(--pta-crimson-line); border-radius: 12px; padding: 6px 8px; scrollbar-width: thin; }
      .sl-anno__msg { margin: 4px 0; padding: 6px 11px; border-radius: 12px; font-size: 12.5px; line-height: 1.5; width: fit-content; max-width: 92%; box-sizing: border-box; color: var(--pta-ink); word-break: break-word; animation: ptaFadeUp .22s var(--pta-ease) both; }
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
      /* The composer: one rounded block — the answer box on its own line,
         the actions beneath. The block, not the textarea, carries the
         border and the focus ring. */
      .sl-anno__input { display: flex; flex-direction: column; gap: 4px; flex: 0 0 auto; padding: 7px 9px 7px 12px; border: 1px solid var(--pta-crimson-line); border-radius: 14px; background: var(--pta-card); transition: border-color .15s ease, box-shadow .15s ease; }
      .sl-anno__input:focus-within { border-color: var(--pta-crimson); box-shadow: var(--pta-ring-crimson); }
      .sl-anno__input textarea { display: block; width: 100%; resize: none; height: 26px; min-height: 26px; max-height: 120px; overflow-y: hidden; border: none !important; border-radius: 0; padding: 3px 0 !important; margin: 0; font-size: 13px; font-family: inherit; line-height: 1.5; color: var(--pta-ink); background: transparent !important; box-shadow: none !important; }
      .sl-anno__input textarea:focus { outline: none; }
      .sl-anno__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 8px; }
      .sl-anno__actions-left, .sl-anno__actions-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .sl-anno__actions-right { margin-left: auto; }
      .sl-anno__input .sl-anno__send { width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; border: none; background: var(--pta-grad-crimson); color: #fff; box-shadow: 0 4px 10px -4px rgba(158, 35, 53, .6); transition: filter .12s ease, transform .12s var(--pta-ease); flex: 0 0 auto; }
      .sl-anno__input .sl-anno__send:hover { filter: brightness(1.1); transform: translateY(-1px); background: var(--pta-grad-crimson); }
      .sl-anno__input button:disabled { opacity: .5; cursor: default; transform: none; }
      .sl-anno__input .sl-anno__skip { background: transparent; color: var(--pta-crimson-text); border: 1px solid var(--pta-crimson-line); border-radius: 999px; padding: 4px 12px; font-size: 12px; white-space: nowrap; flex: 0 0 auto; transition: background .15s ease, color .15s ease, border-color .15s ease; }
      .sl-anno__input .sl-anno__skip:hover { background: var(--pta-crimson-soft); border-color: var(--pta-crimson); }
      .sl-anno__input .sl-anno__skip:disabled { opacity: .5; cursor: default; background: transparent; }
      .sl-anno__input .sl-anno__idk { background: transparent; color: var(--pta-warn-text); border: 1px solid var(--pta-warn-line); border-radius: 999px; padding: 4px 11px; font-size: 12px; white-space: nowrap; flex: 0 0 auto; transition: background .15s ease, border-color .15s ease; }
      .sl-anno__input .sl-anno__idk:hover { background: var(--pta-warn-soft); border-color: var(--pta-warn); }
      .sl-anno__input .sl-anno__idk:disabled { opacity: .5; cursor: default; background: transparent; }
      .sl-anno__qcount { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; opacity: .8; margin-right: 8px; align-self: center; }
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
      /* 🔒 the pill floating over the read-only editor. Centered with auto
         margins, not a transform: the fade-up keyframes end on
         "transform: none", which used to cancel a translateX(-50%) and
         leave the pill hanging off the right edge. */
      @keyframes slLockIn { from { opacity: 0; margin-top: -6px; } to { opacity: 1; margin-top: 0; } }
      .sl-editlock { position: absolute; top: 8px; left: 0; right: 0; width: max-content; max-width: calc(100% - 24px); margin: 0 auto; z-index: 20; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; padding: 5px 14px; border-radius: 999px; background: var(--pta-warn-soft); border: 1px solid var(--pta-warn-line); color: var(--pta-warn-text); font-size: 12px; font-weight: 600; box-shadow: 0 8px 22px -10px rgba(232, 89, 12, .55), 0 2px 6px rgba(15, 23, 42, .08); animation: slLockIn .24s var(--pta-ease) both; }
      .pta-dark .sl-editlock { box-shadow: 0 10px 26px -10px rgba(0, 0, 0, .6); }
      @media (prefers-reduced-motion: reduce) { .sl-editlock, .sl-anno__lockchip { animation: none !important; } }
      .pta-dark .sl-anno, .pta-dark .sl-anno-ghost { border-left-color: #e35d6a; box-shadow: 0 12px 30px -12px rgba(0, 0, 0, .65); }
      .pta-dark .sl-anno--resolved { border-left-color: #69b34c; }
      .pta-dark .sl-anno--info { border-left-color: #4dabf7; }
      /* 🎓 ownership-evaluation theatre: shows the grading PROCESS as staged
         steps while the LLM works. Stages only — the resulting level is
         embargoed server-side and never rendered anywhere in the client. */
      .sl-own-eval { margin: 8px 2px 4px; padding: 10px 12px; background: linear-gradient(135deg, var(--pta-violet-soft), var(--pta-card)); border: 1px solid var(--pta-violet-line); border-radius: 12px; animation: ptaFadeIn .25s ease both; }
      .sl-own-eval__title { font-size: 12px; font-weight: 700; color: var(--pta-violet-text); margin-bottom: 7px; }
      .sl-own-eval__bar { height: 3px; border-radius: 999px; background: var(--pta-violet-soft); overflow: hidden; margin-bottom: 8px; position: relative; }
      .sl-own-eval__bar i { position: absolute; top: 0; bottom: 0; left: 0; width: 40%; border-radius: 999px; background: linear-gradient(90deg, transparent, var(--pta-violet, #7048e8), transparent); animation: slOwnScan 1.3s ease-in-out infinite; }
      @keyframes slOwnScan { 0% { transform: translateX(-100%); } 100% { transform: translateX(260%); } }
      .sl-own-eval__stage { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--pta-ink-faint); padding: 3px 0; opacity: .55; transition: color .25s ease, opacity .25s ease; }
      .sl-own-eval__stage.is-active { color: var(--pta-ink); opacity: 1; }
      .sl-own-eval__stage.is-done { color: var(--pta-ok-text); opacity: .9; }
      .sl-own-eval__mark { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: var(--pta-ok-text); flex: 0 0 auto; }
      .sl-own-eval__stage:not(.is-active) .sl-own-eval__mark .sl-spin--sm { visibility: hidden; }
      .sl-own-eval__icon { flex: 0 0 auto; }
      .sl-own-eval--done .sl-own-eval__bar i { animation: none; transform: none; width: 100%; background: var(--pta-ok-line); }
      .sl-own-eval--panel { margin: 0; }
      @media (prefers-reduced-motion: reduce) { .sl-own-eval, .sl-own-eval__bar i { animation: none !important; } }
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

    /**
     * Requested UX: the full-page overlay is only for the moment right after a
     * submission, before any card exists; once the pop-up card is on screen,
     * the thinking animation lives INSIDE it.
     */
    let thinkingRow = null;
    /** The active 🎓 evaluation theatre, so hideThinking can stop its timer. */
    let ownEval = null;

    /**
     * 🎓 Ownership-evaluation theatre: while the LLM grades a
     * post-acceptance explanation, demonstrate the PROCESS as three staged
     * steps — read → cross-check → assess — with a scanning bar. The
     * progression is purely time-driven (there is no real progress signal),
     * and it deliberately never shows the resulting level, which is
     * embargoed server-side.
     */
    function buildOwnershipEval() {
      ensureTutorUiStyle();
      const stages = [
        ['📖', i18n('Reading your explanation')],
        ['🔎', i18n('Cross-checking it against your code')],
        ['🎓', i18n('Assessing depth of understanding')],
      ];
      const el = document.createElement('div');
      el.className = 'sl-own-eval';
      el.innerHTML = `<div class="sl-own-eval__title">🎓 ${escapeHtml(i18n('The tutor is evaluating your explanation…'))}</div>`
        + '<div class="sl-own-eval__bar"><i></i></div>'
        + stages.map(([icon, label]) => '<div class="sl-own-eval__stage">'
          + '<span class="sl-own-eval__mark"><span class="sl-spin--sm"></span></span>'
          + `<span class="sl-own-eval__icon">${icon}</span><span>${escapeHtml(label)}</span>`
          + '</div>').join('');
      const rows = [].slice.call(el.querySelectorAll('.sl-own-eval__stage'));
      let i = -1;
      const advance = () => {
        if (i >= 0 && rows[i]) {
          rows[i].classList.remove('is-active');
          rows[i].classList.add('is-done');
          rows[i].querySelector('.sl-own-eval__mark').textContent = '✓';
        }
        i += 1;
        if (rows[i]) rows[i].classList.add('is-active');
      };
      advance(); // stage 1 starts immediately
      const timer = setInterval(() => { if (i < rows.length - 1) advance(); }, 1500);
      return {
        el,
        /** Flip everything to done; resolves after a short beat so the completion is visible. */
        async complete() {
          clearInterval(timer);
          while (i < rows.length) advance();
          el.classList.add('sl-own-eval--done');
          await new Promise((resolve) => { setTimeout(resolve, 380); });
        },
        cancel() { clearInterval(timer); },
      };
    }

    function showThinking(mode) {
      ensureTutorUiStyle();
      lockEditor();
      if (mode === 'ghost') return; // the flying ghost carries its own spinner
      if (cardState) {
        const $log = $(cardState.dom).find('.sl-anno__log');
        if (!thinkingRow) {
          if (mode === 'ownership') {
            // 🎓 Grading an accepted-code explanation: the staged evaluation
            // theatre replaces the plain "thinking" row (same lifecycle, so
            // every hideThinking path — including errors — cleans it up).
            ownEval = buildOwnershipEval();
            thinkingRow = ownEval.el;
          } else {
            thinkingRow = $('<div class="sl-anno__thinking"><span class="sl-spin--sm"></span>'
              + `<span>${escapeHtml(i18n('The tutor is thinking...'))}</span></div>`)[0];
          }
        }
        $log.append(thinkingRow);
        $log.scrollTop($log[0].scrollHeight);
        $(cardState.dom).find('.sl-anno__input textarea, .sl-anno__input button, .sl-anno__idk').prop('disabled', true);
        fitZone(cardState.entry, 60, cardMaxPx());
        return;
      }
      showOverlay();
    }

    function hideThinking() {
      if (ownEval) {
        ownEval.cancel();
        ownEval = null;
      }
      if (thinkingRow && thinkingRow.parentNode) thinkingRow.parentNode.removeChild(thinkingRow);
      thinkingRow = null;
      hideOverlay(); // no-op when only the in-card spinner was shown; also unlocks
      if (cardState) {
        if (!$(cardState.dom).hasClass('sl-anno--resolved')) {
          $(cardState.dom).find('.sl-anno__input textarea, .sl-anno__input button, .sl-anno__idk').prop('disabled', false);
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
      /*
       * Card anatomy — head / dialogue / composer:
       *   head      the title, then (right) the 🔒 chip while the editor is
       *             locked and the walkthrough counter;
       *   log       the bubbles;
       *   composer  a Claude-style block: the answer box on its own full-
       *             width line, and an action row beneath it — the concede
       *             shortcut on the left (locked cards only), "Next issue"
       *             and Send on the right. Nothing shares a line with the
       *             text any more, so the box is never squeezed and its
       *             placeholder never clips.
       * The composer keeps the .sl-anno__input class: the thinking/idle
       * toggles and the answer path address the box and its buttons
       * through it.
       */
      dom.innerHTML = '<div class="sl-anno__head">'
        + `<span class="sl-anno__title">🤖 ${escapeHtml(i18n('AI Socratic Tutor'))}</span>`
        + `<span class="sl-anno__btns">${(opts.ownership && opts.ownership.max)
          ? `<span class="sl-anno__qcount" title="${escapeHtml(i18n('Walkthrough question {0} of up to {1}').replace('{0}', opts.ownership.asked).replace('{1}', opts.ownership.max))}">Q${opts.ownership.asked}/${opts.ownership.max}</span>`
          : ''}</span>`
        + '</div>'
        + '<div class="sl-anno__log"></div>'
        + '<div class="sl-anno__input">'
        + '<textarea rows="1" maxlength="1000" placeholder="'
        + `${escapeHtml(accepted ? i18n('Type your answer… (Enter to send)') : i18n('Type your answer — a guess is fine (Enter to send)'))}"></textarea>`
        + '<div class="sl-anno__actions">'
        + '<div class="sl-anno__actions-left"></div>'
        + '<div class="sl-anno__actions-right">'
        /*
         * "Next issue" stays available throughout, as it always was: it is
         * both the "already fixed it" advance and the stuck student's way
         * out that the tutor itself points to after repeated "I don't
         * know"s. Taking it does not unlock anything by itself — the next
         * question re-takes the lock. The accepted walkthrough has no skip.
         */
        + (accepted
          ? ''
          : `<button type="button" class="sl-anno__skip" title="${escapeHtml(i18n('Already fixed it? Jump straight to the next issue.'))}">${escapeHtml(i18n('Next issue'))} ➜</button>`)
        + `<button type="button" class="sl-anno__send" title="${escapeHtml(i18n('Send'))} · ${escapeHtml(i18n('Enter to send · Shift+Enter for a new line'))}">➤</button>`
        + '</div></div>'
        + '</div>';
      const entry = addZone(ed, endLine, 120, dom, { line, endLine });
      cardState = {
        entry, dom, rid, line, endLine, question: ann.question, history: [], accepted,
      };
      lastQuestion = cardState;
      refreshPanelInput();
      // 🎓 Ownership walkthrough: the 🎉 celebration leads on the FIRST
      // post-acceptance card only — follow-up questions go straight in.
      // (The Q-counter above shows counts only; the LLM's per-answer grades
      // never reach the client.)
      if (accepted && !opts.restored && (!opts.ownership || opts.ownership.asked <= 1)) appendCardNote(i18n('Accepted! Great job!'), '🎉');
      appendCardMsg('tutor', ann.question);
      /*
       * 🔒 Requirement: after a NOT-accepted submission, no code editing for
       * as long as the tutor keeps asking. The lock is taken the moment the
       * card exists and is held across every follow-up of the dialogue —
       * an answer the tutor is not satisfied with does NOT release it (see
       * submitCardAnswer). A persistent bar between the dialogue and the
       * answer box says so and carries the "I don't know" shortcut, which
       * is a real answer: the tutor's STUCK-STUDENT rule makes the question
       * smaller rather than revealing the fix, and the lock stays on.
       */
      if (!accepted) {
        lockEditor('question');
        // The state lives in the head as a compact chip (the full sentence
        // is its tooltip); the concede shortcut sits in the action row.
        $('<span class="sl-anno__lockchip"></span>')
          .attr('title', i18n('Editing is paused until the tutor is satisfied with your answer — or until you move on with Next issue.'))
          .text(`🔒 ${i18n('Editing paused')}`)
          .prependTo($(dom).find('.sl-anno__btns'));
        $('<button type="button" class="sl-anno__idk"></button>')
          .attr('title', i18n('Say so — the tutor makes the question smaller.'))
          .text(`🤷 ${i18n('I don’t know')}`)
          .appendTo($(dom).find('.sl-anno__actions-left'));
      }
      // Mirror into the launcher panel: the red button replays this dialogue.
      appendBubble('assistant', ann.question, { line, endLine });
      fitZone(entry, 60, cardMaxPx());
      requestAnimationFrame(() => fitZone(entry, 60, cardMaxPx()));
      setTimeout(() => fitZone(entry, 60, cardMaxPx()), 150);
      $(dom).find('.sl-anno__skip').on('click', () => {
        const cs = cardState;
        if (!cs || cs.dom !== dom) return;
        // Guided flow only (the accepted walkthrough has no skip): the
        // student fixed the flaw in the editor and advances — the next
        // question is generated against the CURRENT code.
        if (!askedQuestions.includes(cs.question)) askedQuestions.push(cs.question);
        requestNextQuestion(cs.rid, cs.endLine, cs.accepted);
      });
      $(dom).find('.sl-anno__idk').on('click', () => {
        const cs = cardState;
        if (!cs || cs.dom !== dom || cs.resolved) return;
        submitCardAnswer(i18n('I don’t know.'));
      });
      const input = dom.querySelector('.sl-anno__input textarea');
      // The answer box is a chat composer: proportional font (the card sits
      // inside Monaco, whose font it would otherwise inherit) and live
      // Markdown, so `code` and **emphasis** read as such while typing.
      mountComposer(input, { i18n });
      // The composer's live preview appears and disappears with the text;
      // the Monaco zone must follow its height.
      dom.addEventListener('pta-composer-resize', () => fitZone(entry, 60, cardMaxPx()));
      // The answer box GROWS with the student's text (one line → up to
      // five), and the Monaco view-zone grows with it — long answers are
      // welcome. Enter sends; Shift+Enter makes a new line.
      const growField = () => {
        input.style.height = 'auto';
        const want = input.scrollHeight + 2;
        input.style.height = `${Math.min(Math.max(want, 26), 120)}px`;
        input.style.overflowY = want > 120 ? 'auto' : 'hidden';
        fitZone(entry, 60, cardMaxPx());
      };
      input.addEventListener('input', growField);
      const send = () => {
        const text = (input.value || '').trim();
        if (text) submitCardAnswer(text);
      };
      dom.querySelector('.sl-anno__send').addEventListener('click', send);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
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
      // 🎓 The ownership walkthrough chains accepted questions with the same
      // ghost flight the failure walkthrough uses.
      const useGhost = !!prevCard;
      let ghost = null;
      if (useGhost) {
        // The resolved card lifts off as a fixed ghost carrying a thinking
        // strip; once the next question arrives it FLIES to the new anchor.
        const rect = prevCard.dom.getBoundingClientRect();
        ghost = document.createElement('div');
        ghost.className = 'sl-anno-ghost';
        ghost.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
        ghost.innerHTML = '<div class="sl-anno-ghost__chip"><span class="sl-spin--sm"></span>'
          + `<span>${escapeHtml(i18n(accepted ? 'Preparing the next question...' : 'Finding the next issue...'))}</span></div>`;
        document.body.appendChild(ghost);
        removeZoneEntry(prevCard.entry);
        if (cardState === prevCard) cardState = null;
        unlockEditor('question'); // the card that held it is gone; the next one re-takes it
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
          unlockEditor('question');
        }
        if (res.annotation) {
          if (ghost) {
            const g = ghost;
            ghost = null;
            await flyGhostToNewCard(g, () => showQuestionCard(rid, res.annotation, accepted, { hiddenEnter: true, ownership: res.ownership }));
          } else {
            showQuestionCard(rid, res.annotation, accepted, { ownership: res.ownership });
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

    /**
     * 🔓 The tutor is SATISFIED — the card's question is resolved — so the
     * editing lock is released and the lock bar goes. This is the only
     * in-dialogue release: sending an answer, or conceding, is not one.
     * Idempotent, and a no-op on accepted cards, which never held the lock.
     */
    function releaseCardLock(cs) {
      if (!cs) return;
      $(cs.dom).find('.sl-anno__lockchip, .sl-anno__idk').remove();
      unlockEditor('question');
      fitZone(cs.entry, 60, cardMaxPx());
    }

    async function submitCardAnswer(text) {
      if (!cardState) return;
      const session = annoSession;
      const cs = cardState;
      const priorHistory = cs.history.slice();
      appendCardMsg('student', text);
      const $field = $(cs.dom).find('.sl-anno__input textarea');
      $field.val('').css({ height: '', 'overflow-y': 'hidden' });
      fitZone(cs.entry, 60, cardMaxPx());
      // 🎓 Accepted card: the answer is being GRADED for the ownership
      // rubric — show the staged evaluation theatre instead of the plain
      // spinner. (The editor stays locked either way.)
      showThinking(cs.accepted ? 'ownership' : undefined);
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
        // Let the theatre reach its all-done beat before the reply lands.
        if (cs.accepted && ownEval) await ownEval.complete();
        hideThinking();
        absorbGate(res);
        // 🎓 Immediate feedback: the LLM's grade for THIS answer lands as
        // a chip on the student's message (card + the panel mirror below).
        if (typeof res.level === 'number') {
          const $ans = $(cs.dom).find('.sl-anno__msg.student').last();
          if ($ans.length) $ans.append(` ${levelChipHtml(res.level, res.levelKind)}`);
        }
        appendCardMsg('tutor', res.reply);
        // Mirror the exchange into the launcher panel history.
        appendBubble('user', text, {
          line: cs.line, endLine: cs.endLine, level: res.level, levelKind: res.levelKind,
        });
        appendBubble('assistant', res.reply, {
          line: cs.line, endLine: cs.endLine, resolved: res.resolved, accepted: cs.accepted,
        });
        if (res.resolved) {
          askedQuestions.push(cs.question);
          cs.resolved = true;
          refreshPanelInput();
          $(cs.dom).addClass('sl-anno--resolved');
          $(cs.dom).find('.sl-anno__input textarea, .sl-anno__send').prop('disabled', true);
          if (cs.accepted) {
            // 🎓 Ownership walkthrough: a resolved answer chains straight
            // into the next question. The server closes the sequence (and
            // finishes the task) once the budget is spent or no distinct
            // aspect remains — that final call shows the 🎉 mastery card.
            appendCardNote(i18n('Nice — on to the next question.'), '👏');
            fitZone(cs.entry, 60, cardMaxPx());
            setTimeout(() => {
              if (session === annoSession && cardState === cs) requestNextQuestion(cs.rid, cs.endLine, true);
            }, 650);
          } else {
            // Guided session: the tutor is satisfied, so the editing lock
            // comes off HERE — the student FIXES this spot in the editor,
            // then clicks Next-issue — the next question is generated
            // against the CURRENT code, so fixed flaws are skipped and
            // anchors match the editor. One submission at the very end
            // verifies the whole walkthrough.
            releaseCardLock(cs);
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
        // 🎓 Ownership walkthrough: ONE combined pop-up on success — the
        // first card opens with the 🎉 celebration row, then the tutor's
        // questions about the student's OWN code chain one at a time
        // (2–3 normally; 5–6 when accepted on the very first attempt).
        askedQuestions = [];
        // Keep a way back in if a card was closed unanswered — the server
        // resumes the same unfinished sequence, never a fresh one.
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

    // ⏯ RESUME AFTER RELOAD: the server sends the thread's still-open
    // question (deadline-gated). The panel is read-only, so continuation
    // means REBUILDING THE POP-UP CARD at its code line once the editor
    // mounts — the same card, the same endpoint, mid-dialogue. The panel
    // history is seeded by the card itself (it mirrors its question), then
    // topped up with the earlier turns; the round button's dot glows.
    const oq = UiContext.slOpenQuestion;
    if (oq && oq.question && oq.rid) {
      const restoreSession = annoSession;
      let tries = 0;
      const tryRestore = () => {
        if (annoSession !== restoreSession || cardState) return; // a live flow took over
        const ed = findScratchpadEditor();
        if (!ed) {
          tries += 1;
          if (tries < 40) setTimeout(tryRestore, 250);
          return;
        }
        // The asked-question memory rides the server too: reseeding it
        // keeps the guided flow from ever repeating a question after a
        // reload, and the walkthrough card gets its Qn/m counter back.
        askedQuestions = (oq.asked || []).slice(-12);
        showQuestionCard(
          oq.rid,
          { question: oq.question, line: oq.line, endLine: oq.endLine },
          !!oq.accepted,
          { restored: true, ownership: oq.ownership || undefined },
        );
        const cs = cardState;
        if (cs) {
          for (const t of (oq.history || []).slice(-10)) {
            const role = t.role === 'student' ? 'student' : 'tutor';
            cs.history.push({ role, content: t.content });
            appendCardMsg(role, t.content);
            appendBubble(role === 'student' ? 'user' : 'assistant', t.content, {});
          }
          // 🔒 A reload is not an exit. The server only hands back a
          // question the tutor has NOT resolved (openTutorQuestionOf), so
          // the lock showQuestionCard took above simply stands — however
          // many answers the replayed history already holds.
          fitZone(cs.entry, 60, cardMaxPx());
        }
        $fabDot.show();
      };
      setTimeout(tryRestore, 300);
    }
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
  // The header chip mirrors the open question's anchor; clicking (or Enter /
  // Space — it is a focusable role=button span) recenters the editor on it.
  const revealFromTag = (ev) => {
    if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    panelRevealQuestion();
  };
  $('#sl-tutor-qtag').on('click', revealFromTag).on('keydown', revealFromTag);
  $(document).on('keydown', (ev) => {
    if (ev.key === 'Escape' && panelOpen && isExpanded) setExpanded(false);
  });
  initPanelResize();
  initPanelDrag();
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
