import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

/**
 * PTA fork: the session page's score board (teacher view) can be expanded
 * to a full-screen overlay so a wide class × task table is comfortable to
 * read; the board itself already scrolls both ways with a sticky header.
 *
 * While expanded, the section is MOVED to <body>: a fixed-position element
 * stays trapped inside any ancestor that has a transform, filter or
 * stacking context (theme animations do), which is how an overlay can end
 * up beneath its own backdrop. A placeholder marks where to put it back.
 * Esc, the button, or the backdrop close it.
 *
 * "Evaluate all students now" gets a staged progress theatre: the plain
 * form POST used to reload the page with zero feedback. The stages are
 * HONEST about what the evaluation does — it aggregates submissions and
 * the ALREADY-RECORDED explanation grades (the LLM grades each answer
 * live, on the student's page, at the moment they answer a walkthrough
 * question — the button never calls the LLM).
 */
const EVAL_STYLE = `
.sld-evalcard { animation: sldEvalIn .25s ease both; }
@keyframes sldEvalIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.sld-eval__title { font-size: 13px; font-weight: 700; color: var(--pta-violet-text, #5f3dc4); margin-bottom: 9px; }
.sld-eval__bar { height: 4px; border-radius: 999px; background: var(--pta-violet-soft, #f3f0ff); overflow: hidden; margin-bottom: 9px; position: relative; }
.sld-eval__bar i { position: absolute; top: 0; bottom: 0; left: 0; width: 40%; border-radius: 999px; background: linear-gradient(90deg, transparent, var(--pta-violet, #7048e8), transparent); animation: sldEvalScan 1.2s ease-in-out infinite; }
@keyframes sldEvalScan { 0% { transform: translateX(-100%); } 100% { transform: translateX(260%); } }
.sld-eval__stage { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--pta-ink-faint, #8a8a97); padding: 4px 0; opacity: .55; transition: color .25s ease, opacity .25s ease; }
.sld-eval__stage.is-active { color: var(--pta-ink, #222); opacity: 1; }
.sld-eval__stage.is-done { color: var(--pta-ok-text, #2b8a3e); opacity: .9; }
.sld-eval__mark { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: var(--pta-ok-text, #2b8a3e); flex: 0 0 auto; }
.sld-eval__spin { width: 11px; height: 11px; border: 2px solid var(--pta-violet-line, #d0bfff); border-top-color: var(--pta-violet, #7048e8); border-radius: 50%; animation: sldEvalSpin .7s linear infinite; }
@keyframes sldEvalSpin { to { transform: rotate(360deg); } }
.sld-eval__stage:not(.is-active) .sld-eval__spin { visibility: hidden; }
.sld-eval__head { display: flex; align-items: flex-start; gap: 8px; }
.sld-eval__head .sld-eval__title { flex: 1 1 auto; margin-bottom: 9px; }
.sld-eval__close { display: none; flex: 0 0 auto; width: 22px; height: 22px; border: none; border-radius: 6px; background: transparent; color: var(--pta-ink-faint, #8a8a97); font-size: 14px; line-height: 1; cursor: pointer; }
.sld-eval__close:hover { background: var(--pta-violet-soft, #f3f0ff); color: var(--pta-violet-text, #5f3dc4); }
.sld-eval--settled .sld-eval__close { display: inline-flex; align-items: center; justify-content: center; }
.sld-eval__now { display: none; font-size: 12px; font-weight: 600; color: var(--pta-violet-text, #5f3dc4); margin-top: 8px; line-height: 1.45; }
.sld-eval__now.is-on { display: block; }
.sld-eval--done .sld-eval__now { color: var(--pta-ok-text, #2b8a3e); }
.sld-eval__hint { font-size: 11px; color: var(--pta-ink-faint, #8a8a97); margin-top: 9px; line-height: 1.5; }
.sld-eval--done .sld-eval__bar i { animation: none; transform: none; width: 100%; background: var(--pta-ok-line, #b2f2bb); }
.sld-eval--failed .sld-eval__bar i { animation: none; transform: none; width: 100%; background: #ffa8a8; }
.sld-eval--failed .sld-eval__title { color: #c92a2a; }
.sld-eval--out { opacity: 0 !important; transition: opacity .25s ease !important; }
@media (prefers-reduced-motion: reduce) { .sld-evalcard, .sld-eval__bar i, .sld-eval__spin { animation: none !important; } }
`;

export default new NamedPage('self_learning_detail', () => {
  const $section = $('.sld-results');
  const $btn = $section.find('.sld-results__expand');
  if ($section.length && $btn.length) {
    let $backdrop = null;
    let $placeholder = null;
    const setExpanded = (on) => {
      if (on === $section.hasClass('sld-results--full')) return;
      if (on) {
        $placeholder = $('<div class="sld-results__placeholder" hidden></div>');
        $section.before($placeholder);
        $backdrop = $('<div class="sld-results__backdrop"></div>').appendTo(document.body).on('click', () => setExpanded(false));
        $section.appendTo(document.body).addClass('sld-results--full');
        $('body').css('overflow', 'hidden');
      } else {
        $section.removeClass('sld-results--full');
        if ($placeholder) {
          $placeholder.replaceWith($section);
          $placeholder = null;
        }
        if ($backdrop) $backdrop.remove();
        $backdrop = null;
        $('body').css('overflow', '');
      }
      $btn.find('span').text(on ? i18n('Close') : i18n('Expand'));
      $btn.attr('title', on ? i18n('Back to the normal view') : i18n('Expand the score board'));
      $btn.contents().first().replaceWith(document.createTextNode(on ? '✕ ' : '⛶ '));
    };
    $btn.on('click', () => setExpanded(!$section.hasClass('sld-results--full')));
    $(document).on('keydown', (ev) => {
      if (ev.key === 'Escape' && $section.hasClass('sld-results--full')) setExpanded(false);
    });
  }

  /* ---------------- 📊 evaluation: background job + sidebar progress card ---------------- */
  const $evalBtn = $('button[name="operation"][value="recompute"]');
  if (!$evalBtn.length) return; // students and read-only viewers have no button
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  /**
   * Refresh the results IN PLACE: re-fetch this page as HTML and swap the
   * section's body (note + table + legend). The section HEADER — the
   * Expand button and the Evaluate form — is deliberately left alone so
   * their event handlers survive; a full page reload remains the fallback.
   */
  const refreshResults = async () => {
    const res = await fetch(window.location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const fresh = doc.querySelector('.sld-results .section__body');
    const cur = document.querySelector('.sld-results .section__body');
    if (!fresh || !cur) throw new Error('results fragment not found');
    cur.replaceWith(document.importNode(fresh, true));
  };

  /**
   * Requested UX, twice over: (1) the progress card lives in the page's
   * RIGHT PANEL — no modal, no backdrop, the page stays fully usable; and
   * (2) the evaluation itself is a SERVER-SIDE BACKGROUND JOB
   * (postRecompute returns immediately; sdoc.evalJob holds the state), so
   * refreshing the page or re-logging in never cancels it — the load-time
   * check at the bottom simply re-attaches this card to the running job.
   */
  let card = null;
  const showEvalCard = () => {
    if (card) return card;
    if (!document.getElementById('sld-eval-style')) {
      $('<style>').attr('id', 'sld-eval-style').text(EVAL_STYLE).appendTo(document.head);
    }
    const stages = [
      ['📥', i18n('Collecting judged submissions')],
      ['📐', i18n('Summing the task scores')],
      ['🧾', i18n('Writing the results table')],
    ];
    const $el = $(`<div class="section side sld-evalcard" role="status">
      <div class="section__body">
        <div class="sld-eval__head">
          <div class="sld-eval__title">📊 ${escapeHtml(i18n('Evaluating all students…'))}</div>
          <button type="button" class="sld-eval__close" title="${escapeHtml(i18n('Dismiss'))}">×</button>
        </div>
        <div class="sld-eval__bar"><i></i></div>
        ${stages.map(([icon, label]) => '<div class="sld-eval__stage">'
    + '<span class="sld-eval__mark"><span class="sld-eval__spin"></span></span>'
    + `<span>${icon}</span><span>${escapeHtml(label)}</span></div>`).join('')}
        <div class="sld-eval__now"></div>
        <div class="sld-eval__hint">☁️ ${escapeHtml(i18n('Running in the background — refreshing or leaving this page will not cancel it.'))}</div>
      </div>
    </div>`);
    const $side = $('.medium-3.columns').first();
    if ($side.length) $side.prepend($el);
    else $el.insertBefore($('.sld-results')); // layout fallback: above the table
    const rows = $el.find('.sld-eval__stage').toArray();
    let i = -1;
    const advance = () => {
      if (i >= 0 && rows[i]) {
        rows[i].classList.remove('is-active');
        rows[i].classList.add('is-done');
        rows[i].querySelector('.sld-eval__mark').textContent = '✓';
      }
      i += 1;
      if (rows[i]) rows[i].classList.add('is-active');
    };
    advance();
    const t0 = Date.now();
    const timer = setInterval(() => { if (i < rows.length - 1) advance(); }, 1100);
    const destroy = () => {
      clearInterval(timer);
      $el.remove();
      if (card && card.$el === $el) card = null;
    };
    $el.find('.sld-eval__close').on('click', destroy);
    // The finished card STAYS on screen (requested UX) as the run's
    // summary; the × that appears with it is the only way it leaves.
    const settleUi = () => $el.addClass('sld-eval--settled');
    card = {
      $el,
      destroy,
      /** Live line: who the LLM is judging right now ("3/7 · name · P5"). */
      setProgress(p) {
        const $now = $el.find('.sld-eval__now');
        if (!p || !p.total) {
          $now.removeClass('is-on');
          return;
        }
        const who = [p.uname, p.pid].filter(Boolean).join(' · ');
        $now.addClass('is-on').text(`🎓 ${i18n('Now grading')} ${p.done || 0}/${p.total}${who ? ` · ${who}` : ''}`);
      },
      async finishDone(summary) {
        clearInterval(timer);
        while (i < rows.length) {
          advance();
          if (i < rows.length) await sleep(480);
        }
        const elapsed = Date.now() - t0;
        if (elapsed < 2200) await sleep(2200 - elapsed);
        $el.addClass('sld-eval--done');
        $el.find('.sld-eval__title').text(`✅ ${i18n('Evaluation complete — the table below is up to date.')}`);
        const $now = $el.find('.sld-eval__now').addClass('is-on');
        void summary; // the rollback evaluation has no grading counts
        $now.text(`✓ ${i18n('Scores computed — the total is the sum of the per-task scores.')}`);
        settleUi();
      },
      async finishFailed(msg) {
        clearInterval(timer);
        $el.addClass('sld-eval--failed');
        $el.find('.sld-eval__title').text(`⚠️ ${i18n('Evaluation failed')}${msg ? `: ${msg}` : ''}`);
        settleUi();
      },
    };
    return card;
  };

  /* -------- 🎓 Ownership hover breakdown (per answer, per task) -------- */
  const LEVEL_DESCS = [
    'no answer or evasion',
    'restates the code in words',
    'correct mechanical account — what and how',
    'correct plus why it is necessary',
    'correct plus a generalization (tradeoff, alternative, complexity)',
  ];
  const lvlChip = (n0) => {
    const n = Math.min(4, Math.max(0, Math.round(n0)));
    const title = `${i18n('Level {0} of {1}').replace('{0}', n).replace('{1}', 4)} — ${i18n(LEVEL_DESCS[n])}`;
    return `<span class="sl-lvl sl-lvl--l${n}" title="${escapeHtml(title)}">L${n}</span>`;
  };
  const ownCache = new Map(); // uid -> detail payload
  let $tip = null;
  let tipUid = null;
  let hideTimer = null;
  const hideTip = () => {
    if ($tip) $tip.remove();
    $tip = null;
    tipUid = null;
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideTip, 220);
  };
  const renderTip = (cell, uname, data) => {
    if ($tip) $tip.remove();
    let body = '';
    if (!data) {
      body = `<em>${escapeHtml(i18n('Loading…'))}</em>`;
    } else if (!data.tasks || !data.tasks.length) {
      body = `<em>${escapeHtml(i18n('No post-acceptance explanations recorded yet.'))}</em>`;
    } else {
      body = data.tasks.map((t) => {
        const qs = (t.questions || []).map((q, k) => {
          const chips = (q.levels || []).length
            ? q.levels.map(lvlChip).join('')
            : `<em>${escapeHtml(i18n('no answer yet — counts as level 0'))}</em>`;
          return `<div class="sld-owntip__q" title="${escapeHtml(q.question)}">Q${k + 1}. ${escapeHtml(q.question.slice(0, 64))}${q.question.length > 64 ? '…' : ''} ${chips}</div>`;
        }).join('');
        const mean = t.mean === null ? '—' : t.mean;
        let rub = '';
        if (t.rubric) {
          if (!t.rubric.attempted) {
            rub = `<div class="sld-owntip__q"><em>${escapeHtml(i18n('not attempted — counts as 0 in the session mean'))}</em></div>`;
          } else {
            const EMO = {
              achievement: '🏆', ownership: '🎓', fixConv: '🔧', trajectory: '📈', transfer: '🧠', reasoning: '🧩', initiative: '💡',
            };
            const partsStr = (t.rubric.parts || []).map((p) => `${EMO[p.key] || ''}${p.pending ? '…' : p.value}`).join(' ');
            rub = `<div class="sld-owntip__q">${t.rubric.firstAttempt ? '⭐ ' : ''}<b>${escapeHtml(i18n('task score'))} ${t.rubric.score}/100</b>${t.rubric.basis && t.rubric.basis !== 100 ? ` <em title="${escapeHtml(i18n('renormalized — the transfer slot is untestable for this student'))}">×100/${t.rubric.basis}</em>` : ''} <small title="${escapeHtml(i18n('… = part pending (not graded yet, counts 0 for now)'))}">${partsStr}</small></div>`;
          }
        }
        let init = '';
        if (t.initiative && typeof t.initiative.level === 'number') {
          const il = Math.min(4, Math.max(0, t.initiative.level));
          init = `<div class="sld-owntip__q">💡 ${escapeHtml(i18n('initiative'))} <span class="sl-lvl sl-lvl--l${il}">L${il}</span></div>`;
        }
        let rq = '';
        if (t.reasoning && t.reasoning.levels && t.reasoning.levels.length) {
          const chips = t.reasoning.levels.map((l) => `<span class="sl-lvl sl-lvl--l${Math.min(4, Math.max(0, l))}">L${l}</span>`).join('');
          rq = `<div class="sld-owntip__q">🧩 ${escapeHtml(i18n('reasoning'))} ${chips}</div>`;
        }
        let fix = '';
        if (t.fix && t.fix.transitions && t.fix.transitions.length) {
          const chips = t.fix.transitions.map((x) => {
            const title = i18n('Trial {0} · level {1} · penalty ×{2}')
              .replace('{0}', x.trial).replace('{1}', x.level).replace('{2}', x.penalty);
            return `<span class="sl-lvl sl-lvl--l${Math.min(4, Math.max(0, x.level))}" title="${escapeHtml(title)}">T${x.trial}:L${x.level}</span>`;
          }).join('');
          fix = `<div class="sld-owntip__q">🔧 ${escapeHtml(i18n('fix conversion'))} ${chips} <em>· ${t.fix.mean === null ? '—' : t.fix.mean}/${data.levelMax || 4}</em></div>`;
        }
        return `<div class="sld-owntip__task">${escapeHtml(t.pid)} <small title="${escapeHtml(t.title)}">· ${escapeHtml(i18n('task mean'))} ${mean}/${data.levelMax || 4}</small></div>${rub}${qs}${init}${rq}${fix}`;
      }).join('');
      {
        const assessed = data.transferInfo || [];
        const pending = data.transferPending || [];
        const untested = data.transferUntested || [];
        if (assessed.length || pending.length || untested.length) {
          const cut = (s) => `${escapeHtml(String(s).slice(0, 44))}${String(s).length > 44 ? '…' : ''}`;
          body += `<div class="sld-owntip__task">🧠 ${escapeHtml(i18n('concept transfer'))}</div>`
            + assessed.map((a) => `<div class="sld-owntip__q" title="${escapeHtml(a.concept)}">${cut(a.concept)}`
              + ` <em>${escapeHtml(String(a.fromPid))} → ${escapeHtml(String(a.toPid))}</em>`
              + ` <span class="sl-lvl sl-lvl--l${Math.min(4, Math.max(0, a.level))}">L${a.level}</span></div>`).join('')
            + pending.map((a) => `<div class="sld-owntip__q" title="${escapeHtml(a.concept)}">${cut(a.concept)}`
              + ` <em>${escapeHtml(String(a.fromPid))} → ${escapeHtml(String(a.toPid))} · ⏳ ${escapeHtml(i18n('grading pending — evaluate again'))}</em></div>`).join('')
            + untested.map((a) => `<div class="sld-owntip__q" title="${escapeHtml(a.concept)}">${cut(a.concept)}`
              + ` <em>${escapeHtml(i18n('learned on {0} — no later task shares this knowledge point').replace('{0}', a.fromPid))}</em></div>`).join('');
        } else if (data.transfer === null || data.transfer === undefined) {
          // The "—" explains itself: nothing ever surfaced to transfer-test.
          body += `<div class="sld-owntip__task">🧠 ${escapeHtml(i18n('concept transfer'))}</div>`
            + `<div class="sld-owntip__q"><em>${escapeHtml(i18n('no misconception surfaced in failure tutoring — nothing to transfer-test (a flawless run leaves no lesson to carry)'))}</em></div>`;
        }
      }
      if (data.trajectoryInfo && data.trajectoryInfo.points && data.trajectoryInfo.points.length) {
        const ti = data.trajectoryInfo;
        const pts = ti.points.map((q) => `${escapeHtml(String(q.pid))}:${q.pct}`).join(' → ');
        const detail = i18n('level {0} · improvement {1}').replace('{0}', ti.level).replace('{1}', ti.improvement);
        body += `<div class="sld-owntip__task">📈 ${escapeHtml(i18n('independence trajectory'))} <small>· ${escapeHtml(detail)}</small></div>`
          + `<div class="sld-owntip__q" title="${escapeHtml(i18n('class percentile of tutor help at first engagement, in the order tasks were started (low = little help)'))}">${pts}</div>`;
      }
      const naAll = data.stdTasks === 0 && (data.faTasks || 0) > 0;
      const naOr = (v, dflt) => (naAll ? i18n('n/a') : (v === null || v === undefined ? '—' : v));
      body += `<div class="sld-owntip__sum">🎓 ${escapeHtml(i18n('Ownership'))} ${data.ownership === null ? '—' : data.ownership} / ${data.ownershipMax || 10}`
        + `  ·  🔧 ${escapeHtml(i18n('Fix Conversion'))} ${naOr(data.fixConv)} / ${data.fixConvMax || 15}`
        + `  ·  📈 ${escapeHtml(i18n('Trajectory'))} ${naOr(data.trajectory)} / ${data.trajectoryMax || 10}`
        + `  ·  🧠 ${escapeHtml(i18n('Transfer'))} ${naAll ? i18n('n/a') : (data.transferState === 'untestable' ? i18n('n/t') : naOr(data.transfer))} / ${data.transferMax || 15}`
        + `  ·  🧩 ${escapeHtml(i18n('Reasoning'))} ${naOr(data.reasoning)} / ${data.reasoningMax || 25}`
        + `  ·  💡 ${escapeHtml(i18n('Initiative'))} ${naOr(data.initiative)} / ${data.initiativeMax || 5} ·  <b>Σ ${data.total === null || data.total === undefined ? '—' : data.total} / ${data.totalMax || 100}</b></div>`;
    }
    $tip = $(`<div class="sld-owntip"><div class="sld-owntip__title">🎓 ${escapeHtml(i18n('Ownership & fix-conversion details'))}${uname ? ` · ${escapeHtml(uname)}` : ''}</div>${body}</div>`)
      .appendTo(document.body)
      .on('mouseenter', () => clearTimeout(hideTimer))
      .on('mouseleave', scheduleHide);
    const r = cell.getBoundingClientRect();
    const w = $tip.outerWidth();
    const h = $tip.outerHeight();
    let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    $tip.css({ left: `${left}px`, top: `${top}px` });
  };
  $(document).on('mouseenter', '.sld-results__own--cell', function onOwnHover() {
    const cell = this;
    const uid = +cell.getAttribute('data-uid');
    if (!uid) return;
    clearTimeout(hideTimer);
    const uname = $(cell).closest('tr').find('td a').first().text().trim();
    tipUid = uid;
    renderTip(cell, uname, ownCache.get(uid) || null);
    if (ownCache.has(uid)) return;
    request.post(window.location.pathname, { operation: 'ownershipDetail', uid })
      .then((res) => {
        ownCache.set(uid, res);
        if (tipUid === uid && $tip) renderTip(cell, uname, res);
      })
      .catch(() => { /* leave the loading tip; it hides on leave */ });
  });
  $(document).on('mouseleave', '.sld-results__own--cell', scheduleHide);

  /* -------- status polling against the server-side job -------- */
  let pollTimer = null;
  let settling = false;
  let missCount = 0;
  const stopPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  const settle = async (job) => {
    if (settling) return;
    settling = true;
    stopPoll();
    const c = showEvalCard();
    try {
      if (job && job.state === 'done') {
        let swapped = true;
        try {
          await refreshResults();
        } catch (err) {
          swapped = false;
        }
        if (!swapped) {
          window.location.reload(); // fallback: fragment swap failed
          return;
        }
        // The hover pop-up caches per-student payloads; trajectory in them
        // comes from the STORED results row, which this evaluation just
        // rewrote — drop the cache so the next hover fetches fresh data.
        ownCache.clear();
        hideTip();
        await c.finishDone(job.progress);
        Notification.success(i18n('Evaluation complete.'));
      } else {
        const msg = !job
          ? i18n('The evaluation state was lost — please try again.')
          : (job.stale ? i18n('The evaluation appears to have stalled — please try again.') : (job.error || ''));
        await c.finishFailed(msg);
        if (msg) Notification.error(msg);
      }
    } finally {
      settling = false;
      $evalBtn.prop('disabled', false);
    }
  };
  const poll = async () => {
    if (settling) return;
    try {
      const res = await request.post(window.location.pathname, { operation: 'evalStatus' });
      const job = res.job;
      if (!job) {
        // A race right after start, or state cleared: tolerate a few misses.
        missCount += 1;
        if (missCount >= 4) await settle(null);
        return;
      }
      missCount = 0;
      if (job.state === 'running' && !job.stale) {
        showEvalCard().setProgress(job.progress); // who is being judged now
        return;
      }
      await settle(job);
    } catch (e) { /* transient poll errors: keep polling */ }
  };
  const startPoll = () => {
    if (pollTimer) return;
    missCount = 0;
    pollTimer = setInterval(poll, 1500);
    setTimeout(poll, 700); // quick first check: small classes finish fast
  };

  $evalBtn.closest('form').on('submit', async (ev) => {
    ev.preventDefault();
    if ($evalBtn.prop('disabled')) return;
    $evalBtn.prop('disabled', true);
    if (card) card.destroy(); // a finished card from the previous run
    ownCache.clear(); // results are about to be rewritten
    try {
      await request.post(window.location.pathname, { operation: 'recompute' });
      showEvalCard();
      startPoll();
    } catch (e) {
      $evalBtn.prop('disabled', false);
      Notification.error(e.message || String(e));
    }
  });

  // RE-ATTACH: a refreshed — or freshly re-logged-in — page asks whether a
  // background evaluation is still running and, if so, resumes the card
  // and the polling exactly as if the page had never gone away.
  (async () => {
    try {
      const res = await request.post(window.location.pathname, { operation: 'evalStatus' });
      if (res.job && res.job.state === 'running' && !res.job.stale) {
        $evalBtn.prop('disabled', true);
        showEvalCard();
        startPoll();
      }
    } catch (e) { /* no job info — nothing to re-attach */ }
  })();
});
