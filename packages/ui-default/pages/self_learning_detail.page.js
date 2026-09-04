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

  /* ---------------- ↕ sort the board by student ID or total ---------------- */
  /*
   * The board arrives ranked by total (the # column keeps that rank).
   * Clicking the Student header sorts by student ID (A→Z first, then
   * Z→A), clicking Total by score (highest first, then lowest first). The
   * choice is remembered per session page for the browser session and
   * re-applied after an in-place refresh of the results, whose fragment
   * swap rebuilds the table.
   */
  const SORT_KEY = `sld-sort:${window.location.pathname}`;
  let sortState = null; // { key: 'uname' | 'total', dir: 'asc' | 'desc' } | null = server order
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(SORT_KEY) || 'null');
    if (saved && ['uname', 'total'].includes(saved.key) && ['asc', 'desc'].includes(saved.dir)) sortState = saved;
  } catch (e) { sortState = null; }
  const rowKey = (tr, key) => (key === 'total' ? Number.parseFloat(tr.getAttribute('data-total')) : String(tr.getAttribute('data-uname') || ''));
  const applySort = () => {
    const $table = $('.sld-results__table');
    if (!$table.length) return;
    $table.find('th[data-sort]').removeAttr('data-dir');
    const $tbody = $table.find('tbody');
    const rows = $tbody.children('tr').get();
    if (!rows.length) return;
    if (!sortState) {
      rows.sort((a, b) => (+a.getAttribute('data-rank') || 0) - (+b.getAttribute('data-rank') || 0));
    } else {
      const { key, dir } = sortState;
      const sign = dir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        let c;
        if (key === 'total') {
          const x = rowKey(a, key);
          const y = rowKey(b, key);
          c = (Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y) ? y : -Infinity);
        } else {
          c = rowKey(a, key).localeCompare(rowKey(b, key), undefined, { numeric: true, sensitivity: 'base' });
        }
        // Stable: ties keep the server's rank order.
        return c !== 0 ? sign * c : (+a.getAttribute('data-rank') || 0) - (+b.getAttribute('data-rank') || 0);
      });
      $table.find(`th[data-sort="${key}"]`).attr('data-dir', dir);
    }
    $tbody.append(rows);
  };
  $(document).on('click', '.sld-results__table th[data-sort]', function onSortClick() {
    const key = this.getAttribute('data-sort');
    const first = key === 'total' ? 'desc' : 'asc';
    const dir = sortState && sortState.key === key ? (sortState.dir === 'asc' ? 'desc' : 'asc') : first;
    sortState = { key, dir };
    try { window.sessionStorage.setItem(SORT_KEY, JSON.stringify(sortState)); } catch (e) { /* private mode */ }
    applySort();
  });
  applySort();

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
    applySort(); // the swap rebuilt the table in server order
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
      ['🎓', i18n('Grading walkthrough answers')],
      ['🔧', i18n('Grading guided fixes')],
      ['🧩', i18n('Grading reasoning answers')],
      ['💡', i18n('Grading first-engagement initiative')],
      ['📈', i18n('Grading independence trajectories')],
      ['🧠', i18n('Grading concept transfer')],
      ['📐', i18n('Scoring each task and the blocks')],
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
    /*
     * The stage highlight is DRIVEN BY THE REAL PHASE reported by the
     * server (setProgress → syncStage), never by a wall clock — a long
     * re-evaluation keeps the 🎓 stage lit for as long as walkthrough
     * answers are actually being judged. Jumps are safe: a phase with
     * zero work never reports, and syncStage walks straight through it,
     * ticking it done. The ambient timer below only performs the initial
     * 📥 → 🎓 step while the first poll is still in flight; the two
     * closing stages (📐 scoring, 🧾 writing) animate in finishDone.
     */
    const PHASE_STAGE = { own: 1, fix: 2, rea: 3, ini: 4, trj: 5, trf: 6 };
    const syncStage = (target) => { while (i < target && i < rows.length - 1) advance(); };
    const timer = setInterval(() => { if (i < 1) advance(); }, 1100);
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
      /** ♻️ Label the run as the from-scratch re-evaluation the button starts. */
      markForce() {
        $el.find('.sld-eval__title').text(`♻️ ${i18n('Re-evaluating every student from scratch…')}`);
      },
      /** Live line: who the LLM is judging right now ("3/7 · name · P5"). */
      setProgress(p) {
        const $now = $el.find('.sld-eval__now');
        if (p && PHASE_STAGE[p.phase] !== undefined) syncStage(PHASE_STAGE[p.phase]);
        if (!p || !p.total) {
          $now.removeClass('is-on');
          return;
        }
        const who = [p.uname, p.pid].filter(Boolean).join(' · ');
        const tag = p.phase === 'fix' ? `🔧 ${i18n('Now grading fixes')}`
          : p.phase === 'rea' ? `🧩 ${i18n('Now grading reasoning')}`
            : p.phase === 'ini' ? `💡 ${i18n('Now grading initiative')}`
              : p.phase === 'trj' ? `📈 ${i18n('Now grading trajectories')}`
                : p.phase === 'trf' ? `🧠 ${i18n('Now grading concept transfer')}`
                  : `🎓 ${i18n('Now grading')}`;
        $now.addClass('is-on').text(`${tag} ${p.done || 0}/${p.total}${who ? ` · ${who}` : ''}`);
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
        if (summary && summary.total) {
          const failed = summary.failed ? ` · ${summary.failed} ${i18n('failed (retried next evaluation)')}` : '';
          const scored = i18n('Scores computed — Total = 🅰 Block A + 🅱 Block B per student.');
          const parts = [];
          if (summary.own && summary.own.total) parts.push(`🎓 ${summary.own.graded || 0}/${summary.own.total}`);
          if (summary.fix && summary.fix.total) parts.push(`🔧 ${summary.fix.graded || 0}/${summary.fix.total}`);
          if (summary.rea && summary.rea.total) parts.push(`🧩 ${summary.rea.graded || 0}/${summary.rea.total}`);
          if (summary.ini && summary.ini.total) parts.push(`💡 ${summary.ini.graded || 0}/${summary.ini.total}`);
          if (summary.trj && summary.trj.total) parts.push(`📈 ${summary.trj.graded || 0}/${summary.trj.total}`);
          if (summary.trf && summary.trf.total) parts.push(`🧠 ${summary.trf.graded || 0}/${summary.trf.total}`);
          const detail = parts.length ? parts.join(' · ') : `${summary.graded || 0}/${summary.total}`;
          $now.text(`✓ ${scored} ${detail} ${i18n('answers graded')}${failed}`);
        } else {
          $now.text(`✓ ${i18n('Scores computed — Total = 🅰 Block A + 🅱 Block B per student.')}`);
        }
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

  /* -------- 🔎 Score evidence pop-up: hover any score cell (click to pin) -------- */
  /*
   * Every score cell of the board carries data-ev (which number), data-uid
   * and, per task, data-pid. Hovering it opens a pop-up with THE PROOF
   * behind that number — the stored results row (the exact figures the
   * table shows) plus the raw evidence from the student's tutor threads
   * and submissions (operation scoreEvidence): the tutor's questions, the
   * student's own answers and their grades, the judged attempts, the
   * fix transitions, the trajectory / transfer judgments and any
   * manipulation flags. One request per student, cached until the next
   * evaluation. Clicking a cell PINS its pop-up (it stays while the
   * teacher walks the student through it); Esc, × or another click
   * unpins.
   */
  const LEVELS = {
    own: ['no answer or evasion', 'restates the code in words', 'correct mechanical account — what and how', 'correct plus why it is necessary', 'correct plus a generalization (tradeoff, alternative, complexity)'],
    fix: ['targeted region unchanged', 'thrashing', 'right area, incomplete', 'flaw correctly addressed', 'minimal targeted fix'],
    rea: ['no substantive answer, off-topic, or restates the question', 'a guess with no reasoning', 'relevant reasoning but vague or partly wrong', 'correct, specific reasoning about their own code', 'correct reasoning plus predicts a consequence or generalizes'],
    ini: ['no hypothesis, weak comprehension', 'no hypothesis, adequate comprehension', 'vague hypothesis, or strong comprehension alone', 'specific, plausible hypothesis pointing at the right area', 'specific hypothesis identifying the actual flaw'],
    trj: ['dependent throughout', 'marginal movement', 'uneven or middling', 'solid independence', 'strong independence'],
    trf: ['relapse, unrecognized', 'relapse, recognized on prompt', 'handled, but fragile', 'applied correctly, unprompted', 'plus positive evidence of command'],
  };
  const TITLES = {
    task: ['Σ', 'Task score'], ach: ['🏆', 'Achievement'], own: ['🎓', 'Code Ownership'], fix: ['🔧', 'Guidance-to-Fix Conversion'],
    rea: ['🧩', 'Reasoning Quality'], ini: ['💡', 'Self-Diagnostic Initiative'], blockA: ['🅰', 'Block A'], trj: ['📈', 'Independence Trajectory'],
    trf: ['🧠', 'Concept Transfer'], blockB: ['🅱', 'Block B'], total: ['Σ', 'Session total'],
  };
  const lvlChip = (n0, kind) => {
    if (n0 === null || n0 === undefined) return `<em class="sld-evpop__meta">${escapeHtml(i18n('not graded'))}</em>`;
    const n = Math.min(4, Math.max(0, Math.round(n0)));
    const desc = (LEVELS[kind] || LEVELS.own)[n];
    return `<span class="sl-lvl sl-lvl--l${n}" title="${escapeHtml(`${i18n('Level {0} of {1}').replace('{0}', n).replace('{1}', 4)} — ${i18n(desc)}`)}">L${n}</span> <span class="sld-evpop__meta">${escapeHtml(i18n(desc))}</span>`;
  };
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
  const num = (x, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? (Math.round(x * 10 ** d) / 10 ** d).toString() : '—');
  const answerBlock = (text, chip) => `<div class="sld-evpop__a">${escapeHtml(text || '')}${chip ? `<div>${chip}</div>` : ''}</div>`;
  const qLine = (label, text, line) => `<div class="sld-evpop__q">${escapeHtml(label)} ${escapeHtml(text || '')}${line ? `<span class="sld-evpop__line">(${escapeHtml(i18n('line {0}').replace('{0}', line))})</span>` : ''}</div>`;
  const flagBlock = (t, sub) => {
    const ig = t && t.integrity;
    if (!ig || !ig[sub]) return '';
    const hits = (ig.hits || []).filter((h) => h.sub === sub);
    return `<div class="sld-evpop__flag">🚫 ${escapeHtml(i18n('Manipulation detected in the student’s own text — this sub-rubric is scored 0 for this task.'))}${hits.length ? hits.map((h) => `<div class="sld-evpop__meta">“${escapeHtml(h.excerpt)}” · ${escapeHtml(fmtTime(h.at))}</div>`).join('') : ''}</div>`;
  };
  const scoreBox = (pts, max, formula, flagged) => `<div class="sld-evpop__score${flagged ? ' is-flag' : ''}"><b>${escapeHtml(pts)}</b> / ${escapeHtml(max)} ${escapeHtml(i18n('pts'))}${formula ? `<span class="sld-evpop__formula">= ${escapeHtml(formula)}</span>` : ''}</div>`;
  /**
   * ✎ The teacher's adjustment block for a task Σ or the session total:
   * what is adjusted now (computed → adjusted, reason, when) and a small
   * form — new score, reason — that posts overrideScore / clearOverride.
   * Pinned pop-ups keep it open while the form is filled in.
   */
  const adjustBlock = (kind, pid, d) => {
    const row = d.row;
    if (!row) return '';
    const cur = kind === 'task' ? (row.override && row.override.tasks ? row.override.tasks[String(pid)] : null) : (row.override ? row.override.total : null);
    const now = kind === 'task' ? (row.taskScores ? row.taskScores[String(pid)] : null) : row.total;
    const label = kind === 'task' ? i18n('task score (0–100)') : i18n('session total (0–100)');
    let body = `<div class="sld-evpop__adj" data-kind="${escapeHtml(kind)}" data-pid="${escapeHtml(pid || '')}" data-uid="${escapeHtml(d.uid)}">`;
    body += `<b>✎ ${escapeHtml(i18n('Teacher adjustment'))}</b>`;
    if (cur) {
      body += `<div class="sld-evpop__q">${escapeHtml(i18n('computed'))} <b>${escapeHtml(num(cur.computed))}</b> → ${escapeHtml(i18n('adjusted'))} <b>${escapeHtml(num(cur.score))}</b> · ${escapeHtml(cur.reason || '')} <span class="sld-evpop__meta">· ${escapeHtml(fmtTime(cur.at))}</span></div>`;
    } else {
      body += `<div class="sld-evpop__meta">${escapeHtml(i18n('Not adjusted — the value shown is the computed one.'))}</div>`;
    }
    body += `<input type="number" class="sld-adj-score" min="0" max="100" step="0.1" placeholder="${escapeHtml(label)}" value="${cur ? escapeHtml(num(cur.score)) : ''}">`
      + `<textarea class="sld-adj-reason" placeholder="${escapeHtml(i18n('Reason (shown to the student)'))}">${cur ? escapeHtml(cur.reason || '') : ''}</textarea>`
      + '<div class="sld-evpop__btnrow">'
      + `<button type="button" class="sld-adj-save">${escapeHtml(i18n('Save adjustment'))}</button>`
      + (cur ? `<button type="button" class="sld-adj-clear is-secondary">${escapeHtml(i18n('Remove adjustment'))}</button>` : '')
      + `<span class="sld-evpop__meta" style="align-self:center">${escapeHtml(i18n('now'))} ${escapeHtml(num(now))}</span>`
      + '</div></div>';
    return body;
  };
  const notEvaluated = () => `<div class="sld-evpop__note">${escapeHtml(i18n('This student has not been evaluated yet — press "Evaluate all students now" to compute the scores.'))}</div>`;

  /** The pop-up body for one cell kind. */
  const renderKind = (kind, pid, d) => {
    const row = d.row;
    const sh = d.shares || {};
    const t = pid ? d.tasks[String(pid)] : null;
    const key = String(pid);
    const fa = !!(row && row.fa && row.fa[key]);
    const sc = row && row.scores ? row.scores[key] : null;
    const unattemptedNote = () => `<div class="sld-evpop__note">${escapeHtml(i18n('No judged submission inside the counting window — the task counts 0 and stays in the denominator.'))}</div>`;
    if (kind === 'ach') {
      let body = '';
      if (!row) body += notEvaluated();
      else if (!sc) body += scoreBox('0', fa ? sh.faAch : sh.ach, '') + unattemptedNote();
      else {
        const share = fa ? sh.faAch : sh.ach;
        body += scoreBox(num((sc.effective * share) / 100), share, `${i18n('judged')} ${sc.effective} / 100 × ${share}%`)
          + (fa ? `<div class="sld-evpop__note">⭐ ${escapeHtml(i18n('Accepted on the first attempt: Achievement is worth {0} on this task.').replace('{0}', sh.faAch))}</div>` : '');
      }
      const list = (t && t.attempts) || [];
      body += `<div class="sld-evpop__sec">${escapeHtml(i18n('Judged submissions'))} <small>· ${list.length}</small></div>`;
      if (!list.length) body += `<div class="sld-evpop__note">${escapeHtml(i18n('None.'))}</div>`;
      else {
        body += `<table><thead><tr><th>#</th><th>${escapeHtml(i18n('When'))}</th><th>${escapeHtml(i18n('Verdict'))}</th><th class="num">${escapeHtml(i18n('Score'))}</th><th></th></tr></thead><tbody>`
          + list.map((a) => `<tr class="${a.counted ? 'is-counted' : ''}${a.excluded ? ' is-excluded' : ''}"><td>${a.no}</td><td>${escapeHtml(fmtTime(a.at))}</td><td>${escapeHtml(i18n(a.statusText))}</td><td class="num">${a.score}</td><td>${a.counted ? `★ ${escapeHtml(i18n('counted'))}` : ''}${a.late && !a.excluded ? ` ⏱ ${escapeHtml(i18n('late'))}` : ''}${a.excluded ? ` ✂ ${escapeHtml(i18n('after the hard end — not counted'))}` : ''}</td></tr>`).join('')
          + '</tbody></table>'
          + `<div class="sld-evpop__foot">${escapeHtml(i18n('The counted submission is the highest-scoring one (an on-time one wins a tie); submissions after the hard end never count. Late submissions keep their score — lateness is applied once, to the session total.'))}</div>`;
      }
      return body;
    }
    if (kind === 'own') {
      const ow = row && row.own ? row.own[key] : null;
      const share = fa ? sh.faOwn : sh.own;
      let body = '';
      if (!row) body += notEvaluated();
      else if (ow && ow.flagged) body += scoreBox('0', share, '', true);
      else if (ow && typeof ow.level === 'number') body += scoreBox(num(ow.pts), share, `${i18n('mean level')} ${num(ow.level, 2)} / 4 × ${share}`);
      else body += scoreBox('0', share, '') + `<div class="sld-evpop__note">${escapeHtml(i18n('No walkthrough yet — the tutor asks its questions once a submission is accepted.'))}</div>`;
      if (fa) body += `<div class="sld-evpop__note">⭐ ${escapeHtml(i18n('First-attempt acceptance: Code Ownership is worth {0} on this task and the walkthrough asks 5–6 questions.').replace('{0}', sh.faOwn))}</div>`;
      body += flagBlock(t, 'own');
      const w = t && t.walkthrough;
      if (w) {
        body += `<div class="sld-evpop__sec">${escapeHtml(i18n('Walkthrough'))} <small>· ${escapeHtml(i18n('{0} question(s) asked, budget {1}–{2}, {3}').replace('{0}', w.questions.length).replace('{1}', w.minQ).replace('{2}', w.maxQ).replace('{3}', w.done ? i18n('closed') : i18n('open')))}</small></div>`;
        body += w.questions.map((q) => {
          let a = '';
          if (q.answers.length) a = q.answers.map((x) => answerBlock(x.text, `${lvlChip(x.level, 'own')} <span class="sld-evpop__meta">· ${escapeHtml(fmtTime(x.at))}</span>`)).join('');
          else a = `<div class="sld-evpop__a"><em>${escapeHtml(i18n('never answered — counts as L0'))}</em></div>`;
          const graded = q.levels.length ? `<div class="sld-evpop__meta" style="margin-left:12px">${escapeHtml(i18n('grades counted'))}: ${q.levels.map((l) => `L${l}`).join(', ')}</div>` : '';
          return qLine(`Q${q.no}.`, q.question, q.line) + a + graded;
        }).join('');
        if (typeof w.mean === 'number') body += `<div class="sld-evpop__sum">${escapeHtml(i18n('mean of the counted grades'))} = ${num(w.mean, 2)} / 4 → × ${share} = ${num((w.mean / 4) * share)}</div>`;
      }
      return body;
    }
    if (kind === 'fix' || kind === 'rea' || kind === 'ini') {
      const share = { fix: sh.fix, rea: sh.rea, ini: sh.ini }[kind];
      const st = row && row[kind] ? row[kind][key] : null;
      let body = '';
      if (!row) body += notEvaluated();
      else if (fa) body += `<div class="sld-evpop__note">⭐ ${escapeHtml(i18n('Does not apply: this task was accepted on the very first attempt, so there was no failure phase to judge. Its 100 points are 🏆 {0} + 🎓 {1}.').replace('{0}', sh.faAch).replace('{1}', sh.faOwn))}</div>`;
      else if (st && st.flagged) body += scoreBox('0', share, '', true);
      else if (st && typeof st.level === 'number') {
        const f = kind === 'fix' ? `${i18n('penalty-weighted mean level')} ${num(st.level, 2)} / 4 × ${share}`
          : kind === 'rea' ? `${i18n('mean level')} ${num(st.level, 2)} / 4 × ${share}` : `L${st.level} / 4 × ${share}`;
        body += scoreBox(num(st.pts), share, f);
      } else body += scoreBox('0', share, '') + `<div class="sld-evpop__note">${escapeHtml(kind === 'fix' ? i18n('Nothing judged yet: no failed attempt was followed by answered guidance and a resubmission (counts 0).') : kind === 'rea' ? i18n('Nothing graded yet: no answer given while the program was failing (counts 0).') : i18n('Not judged yet: needs a closed first engagement with answers (counts 0).'))}</div>`;
      body += flagBlock(t, kind);
      if (fa) return body;
      if (kind === 'fix' && t && t.fix) {
        body += `<div class="sld-evpop__sec">${escapeHtml(i18n('Judged guidance → fix transitions'))} <small>· ${t.fix.transitions.length}</small></div>`;
        body += t.fix.transitions.map((x) => {
          const sub = (r) => (r ? `#${r.no} ${i18n(r.statusText)} (${r.score})` : '?');
          const head = `<div class="sld-evpop__q">T${x.trial} · ${escapeHtml(sub(x.from))} → ${escapeHtml(sub(x.to))} · ${lvlChip(x.level, 'fix')} · <span class="sld-evpop__meta">${escapeHtml(i18n('trial penalty'))} ×${x.penalty} · ${escapeHtml(i18n('{0} guidance answer(s)').replace('{0}', x.asked))}</span></div>`;
          const ex = (x.exchanges || []).map((e) => `${qLine('↳', e.question, null)}${answerBlock(e.answer)}`).join('');
          return head + ex;
        }).join('');
        if (typeof t.fix.mean === 'number') body += `<div class="sld-evpop__sum">${escapeHtml(i18n('mean of level × penalty'))} = ${num(t.fix.mean, 2)} / 4 → × ${share} = ${num((t.fix.mean / 4) * share)}</div>`;
      }
      if (kind === 'rea' && t && t.reasoning) {
        const r = t.reasoning;
        body += `<div class="sld-evpop__sec">${escapeHtml(i18n('Failure-phase exchanges'))} <small>· ${escapeHtml(i18n('{0} graded').replace('{0}', r.levels.length))}</small></div>`;
        body += r.exchanges.map((e) => qLine(`#${e.attemptNo}`, e.question, e.line) + answerBlock(e.answer, lvlChip(e.rlevel, 'rea'))).join('');
        if (typeof r.mean === 'number') body += `<div class="sld-evpop__sum">${escapeHtml(i18n('mean of the counted grades'))} = ${num(r.mean, 2)} / 4 → × ${share} = ${num((r.mean / 4) * share)}</div>`;
      }
      if (kind === 'ini' && t && t.initiative) {
        const n = t.initiative;
        body += `<div class="sld-evpop__sec">${escapeHtml(i18n('First engagement'))} <small>· ${escapeHtml(i18n('attempt #{0}').replace('{0}', n.attemptNo || '?'))} · ${escapeHtml(i18n('judged'))} ${escapeHtml(fmtTime(n.at))}</small></div>`;
        body += `<div class="sld-evpop__q">${lvlChip(n.level, 'ini')}</div>`;
        body += n.exchanges.map((e) => qLine('↳', e.question, null) + answerBlock(e.answer)).join('');
        if (!n.exchanges.length) body += `<div class="sld-evpop__note">${escapeHtml(i18n('The exchange texts of this engagement are no longer in the thread.'))}</div>`;
      }
      return body;
    }
    if (kind === 'task') {
      if (!row) return notEvaluated();
      const ts = row.taskScores ? row.taskScores[key] : null;
      if (!sc) return scoreBox('0', sh.taskMax, '') + unattemptedNote() + adjustBlock('task', pid, d);
      const parts = fa
        ? [['🏆', 'ach', (sc.effective * sh.faAch) / 100, sh.faAch], ['🎓', 'own', row.own && row.own[key] ? row.own[key].pts : 0, sh.faOwn]]
        : [['🏆', 'ach', (sc.effective * sh.ach) / 100, sh.ach], ['🎓', 'own', row.own && row.own[key] ? row.own[key].pts : 0, sh.own], ['🔧', 'fix', row.fix && row.fix[key] ? row.fix[key].pts : 0, sh.fix], ['🧩', 'rea', row.rea && row.rea[key] ? row.rea[key].pts : 0, sh.rea], ['💡', 'ini', row.ini && row.ini[key] ? row.ini[key].pts : 0, sh.ini]];
      const adjT = row.override && row.override.tasks ? row.override.tasks[key] : null;
      let body = scoreBox(num(ts), sh.taskMax, adjT ? `${i18n('adjusted by the teacher')} (${i18n('computed')} ${num(adjT.computed)})` : parts.map((p) => `${p[0]} ${num(p[2] || 0)}`).join(' + '));
      body += `<table><tbody>${parts.map((p) => `<tr><td>${p[0]} ${escapeHtml(i18n(TITLES[p[1]][1]))}</td><td class="num"><b>${num(p[2] || 0)}</b> / ${p[3]}</td></tr>`).join('')}</tbody></table>`;
      if (fa) body += `<div class="sld-evpop__note">⭐ ${escapeHtml(i18n('Accepted on the very first attempt: the task is 🏆 {0} + 🎓 {1}; 🔧 🧩 💡 do not apply.').replace('{0}', sh.faAch).replace('{1}', sh.faOwn))}</div>`;
      body += `<div class="sld-evpop__foot">${escapeHtml(i18n('Hover each part’s cell for its own proof.'))}</div>`;
      body += adjustBlock('task', pid, d);
      return body;
    }
    if (kind === 'blockA') {
      if (!row) return notEvaluated();
      if (row.allFa) return `<div class="sld-evpop__note">⭐⭐ ${escapeHtml(i18n('Every task was accepted on the first attempt, so the session is scored as 🏆 + 🎓 only (see the Total cell).'))}</div>`;
      const pids = d.programmingPids || [];
      const rows = pids.map((p) => [d.tasks[String(p)] ? d.tasks[String(p)].pidLabel : p, row.taskScores ? row.taskScores[String(p)] || 0 : 0]);
      const sum = rows.reduce((a, r) => a + (r[1] || 0), 0);
      return scoreBox(num(row.blockA), sh.blockA, `${num(sum)} / (${rows.length} × ${sh.taskMax}) × ${sh.blockA}`)
        + `<table><tbody>${rows.map((r) => `<tr><td>${escapeHtml(String(r[0]))}</td><td class="num">${num(r[1])} / ${sh.taskMax}</td></tr>`).join('')}<tr><td><b>Σ</b></td><td class="num"><b>${num(sum)}</b></td></tr></tbody></table>`
        + `<div class="sld-evpop__foot">${escapeHtml(i18n('An unattempted task counts 0 but stays in the denominator.'))}</div>`;
    }
    if (kind === 'trj') {
      if (!row) return notEvaluated();
      if (row.allFa) return `<div class="sld-evpop__note">⭐⭐ ${escapeHtml(i18n('Does not apply — every task was accepted on the first attempt.'))}</div>`;
      const tr = row.trj || {};
      let body = tr.flagged ? scoreBox('0', sh.trj, '', true)
        : typeof tr.level === 'number' ? scoreBox(num(tr.pts), sh.trj, `L${tr.level} / 4 × ${sh.trj}`)
          : scoreBox('0', sh.trj, '') + `<div class="sld-evpop__note">${escapeHtml(i18n('Not judged yet — one LLM judgment over the whole session history, run by the evaluation (counts 0).'))}</div>`;
      const tj = d.trajectory;
      if (tj) {
        body += `<div class="sld-evpop__sec">${escapeHtml(i18n('Judgment'))} <small>· ${escapeHtml(fmtTime(tj.at))}</small></div><div class="sld-evpop__q">${lvlChip(tj.level, 'trj')}</div>`;
        if (tj.basis) body += `<div class="sld-evpop__meta">${escapeHtml(i18n('history basis (tasks:records:answered exchanges)'))}: ${escapeHtml(tj.basis)}</div>`;
        if (tj.info && tj.info.points && tj.info.points.length) {
          body += `<div class="sld-evpop__sec">${escapeHtml(i18n('Tutor help at first engagement, task by task'))}</div><div class="sld-evpop__q">${tj.info.points.map((q) => `${escapeHtml(String(q.pid))}: ${q.pct}`).join(' → ')}</div><div class="sld-evpop__meta">${escapeHtml(i18n('class percentile of tutor help at first engagement, in the order tasks were started (low = little help)'))}</div>`;
        }
      }
      return body;
    }
    if (kind === 'trf') {
      if (!row) return notEvaluated();
      if (row.allFa) return `<div class="sld-evpop__note">⭐⭐ ${escapeHtml(i18n('Does not apply — every task was accepted on the first attempt.'))}</div>`;
      const tf = row.trf || {};
      let body = '';
      if (tf.flagged) body += scoreBox('0', sh.trf, '', true);
      else if (tf.state === 'assessed') body += scoreBox(num(tf.pts), sh.trf, `${i18n('mean level')} ${num(tf.level, 2)} / 4 × ${sh.trf}`);
      else if (tf.state === 'untestable') body += scoreBox(num(tf.pts), sh.trf, i18n('untestable → full credit')) + `<div class="sld-evpop__note">${escapeHtml(i18n('No knowledge point resolved on one task is exercised again by a later task, so nothing can be tested; the rubric grants the full points.'))}</div>`;
      else body += scoreBox('0', sh.trf, '') + `<div class="sld-evpop__note">${escapeHtml(i18n('Pending: surfacing and judging run on evaluation (counts 0 until then).'))}</div>`;
      const x = d.transfer || {};
      if (x.assessments && x.assessments.length) {
        body += `<div class="sld-evpop__sec">${escapeHtml(i18n('Re-encounters judged'))}</div>` + x.assessments.map((a) => `<div class="sld-evpop__q">${escapeHtml(a.concept)} <span class="sld-evpop__meta">${escapeHtml(a.fromPid)} → ${escapeHtml(a.toPid)}</span> ${lvlChip(a.level, 'trf')}${a.flagged ? ' 🚫' : ''}</div>`).join('');
      }
      if (x.surfaced && x.surfaced.length) {
        body += `<div class="sld-evpop__sec">${escapeHtml(i18n('Misconceptions surfaced in failure tutoring'))}</div>` + x.surfaced.map((sv) => `<div class="sld-evpop__q">${escapeHtml(sv.pid)}: <span class="sld-evpop__meta">${escapeHtml(sv.names.join(' · '))}</span></div>`).join('');
      }
      if (x.plan) body += `<div class="sld-evpop__meta">${escapeHtml(i18n('planner'))}: ${x.plan.candidates} ${escapeHtml(i18n('candidate re-encounter(s)'))}${x.plan.untestable ? ` · ${escapeHtml(i18n('untestable'))}` : ''} · ${escapeHtml(fmtTime(x.plan.at))}</div>`;
      return body;
    }
    if (kind === 'blockB') {
      if (!row) return notEvaluated();
      if (row.allFa) return `<div class="sld-evpop__note">⭐⭐ ${escapeHtml(i18n('Does not apply — every task was accepted on the first attempt.'))}</div>`;
      const trjPts = row.trj ? row.trj.pts || 0 : 0;
      const trfPts = row.trf ? row.trf.pts || 0 : 0;
      return scoreBox(num(row.blockB), sh.blockB, `📈 ${num(trjPts)} + 🧠 ${num(trfPts)}`)
        + `<table><tbody><tr><td>📈 ${escapeHtml(i18n('Independence Trajectory'))}</td><td class="num">${num(trjPts)} / ${sh.trj}</td></tr><tr><td>🧠 ${escapeHtml(i18n('Concept Transfer'))}</td><td class="num">${num(trfPts)} / ${sh.trf}</td></tr></tbody></table>`;
    }
    if (kind === 'total') {
      if (!row) return notEvaluated();
      let body = '';
      if (row.allFa) {
        body += scoreBox(num(row.total), sh.total, `🏆 ${num(row.sessAch)} / ${sh.faAch} + 🎓 ${num(row.sessOwn)} / ${sh.faOwn}${row.lateFactor ? ` × ${row.lateFactor}` : ''}`)
          + `<div class="sld-evpop__note">⭐⭐ ${escapeHtml(i18n('Every task was accepted on the first attempt: the session is the mean of the per-task 🏆 + 🎓 scores; Blocks A/B do not apply.'))}</div>`;
      } else {
        const base = (row.blockA || 0) + (row.blockB || 0);
        body += scoreBox(num(row.total), sh.total, `🅰 ${num(row.blockA)} + 🅱 ${num(row.blockB)}${row.lateFactor ? ` = ${num(base)} × ${row.lateFactor}` : ''}`);
      }
      if (row.lateFactor) {
        const rules = d.schedule && d.schedule.penaltyRules ? Object.entries(d.schedule.penaltyRules).map(([h, c]) => `${h}h → ×${c}`).join(', ') : '';
        body += `<div class="sld-evpop__flag" style="background:var(--pta-warn-soft);border-color:var(--pta-warn-line);color:var(--pta-warn-text)">⏱ ${escapeHtml(i18n('Last counted submission {0} h after the deadline — the tiered late rule multiplies the total by {1}.').replace('{0}', row.lateHours).replace('{1}', row.lateFactor))}${rules ? `<div class="sld-evpop__meta">${escapeHtml(i18n('rule'))}: ${escapeHtml(rules)}</div>` : ''}</div>`;
      } else if (d.schedule && d.schedule.endAt) body += `<div class="sld-evpop__meta">${escapeHtml(i18n('On time — no late penalty.'))}</div>`;
      body += `<div class="sld-evpop__foot">${escapeHtml(i18n('Attempts'))}: ${row.attempts} · 🏁 ${row.done} · ⏭ ${row.skipped}</div>`;
      body += adjustBlock('total', null, d);
      return body;
    }
    return '';
  };

  const evCache = new Map(); // uid -> evidence payload
  let $pop = null;
  let popKey = null;
  let pinnedCell = null;
  let hideTimer = null;
  const hideTip = (force) => {
    if (pinnedCell && !force) return;
    if ($pop) $pop.remove();
    $pop = null;
    popKey = null;
    if (pinnedCell) $(pinnedCell).removeClass('is-pinned');
    pinnedCell = null;
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideTip(false), 260);
  };
  const placePop = (cell) => {
    const r = cell.getBoundingClientRect();
    const w = $pop.outerWidth();
    const h = $pop.outerHeight();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    $pop.css({ left: `${left}px`, top: `${top}px` });
  };
  const renderPop = (cell, data) => {
    const kind = cell.getAttribute('data-ev');
    const pid = cell.getAttribute('data-pid');
    const uid = +cell.getAttribute('data-uid');
    const $row = $(cell).closest('tr');
    const who = data ? `${data.uname}${data.name ? ` ${data.name}` : ''}` : $row.find('td a').first().text().trim();
    const t = TITLES[kind] || ['', kind];
    const task = pid && data && data.tasks && data.tasks[String(pid)] ? data.tasks[String(pid)] : null;
    const sub = `${escapeHtml(who)}${task ? ` · ${escapeHtml(task.pidLabel)} ${escapeHtml(task.title)}` : ''}${data && data.computedAt ? ` · ${escapeHtml(i18n('evaluated'))} ${escapeHtml(fmtTime(data.computedAt))}` : ''}`;
    let body;
    try {
      body = data ? renderKind(kind, pid, data) : `<em>${escapeHtml(i18n('Loading…'))}</em>`;
    } catch (e) {
      body = `<em>${escapeHtml(i18n('Could not render the evidence.'))}</em>`;
    }
    const pinned = pinnedCell === cell;
    if ($pop) $pop.remove();
    $pop = $(`<div class="sld-evpop" role="dialog"><div class="sld-evpop__head"><div class="sld-evpop__title">${t[0]} ${escapeHtml(i18n(t[1]))}<small>${sub}</small></div>`
      + `<button type="button" class="sld-evpop__btn sld-evpop__pin" title="${escapeHtml(pinned ? i18n('Unpin') : i18n('Pin this pop-up (it stays open until closed)'))}">${pinned ? '📌' : '📍'}</button>`
      + `<button type="button" class="sld-evpop__btn sld-evpop__close" title="${escapeHtml(i18n('Close'))}">×</button></div>${body}</div>`)
      .appendTo(document.body)
      .on('mouseenter', () => clearTimeout(hideTimer))
      .on('mouseleave', scheduleHide);
    $pop.data('cell', cell);
    $pop.find('.sld-evpop__close').on('click', () => hideTip(true));
    $pop.find('.sld-evpop__pin').on('click', () => togglePin(cell)); // eslint-disable-line ts/no-use-before-define
    popKey = `${kind}:${uid}:${pid || ''}`;
    placePop(cell);
  };
  const showFor = (cell) => {
    const uid = +cell.getAttribute('data-uid');
    if (!uid) return;
    clearTimeout(hideTimer);
    renderPop(cell, evCache.get(uid) || null);
    if (evCache.has(uid)) return;
    const want = popKey;
    request.post(window.location.pathname, { operation: 'scoreEvidence', uid })
      .then((res) => {
        evCache.set(uid, res);
        if (popKey === want && $pop) renderPop(cell, res);
      })
      .catch((e) => {
        if (popKey === want && $pop) $pop.append(`<div class="sld-evpop__note">${escapeHtml((e && e.message) || i18n('Could not load the evidence.'))}</div>`);
      });
  };
  function togglePin(cell) {
    if (pinnedCell === cell) {
      $(cell).removeClass('is-pinned');
      pinnedCell = null;
      renderPop(cell, evCache.get(+cell.getAttribute('data-uid')) || null);
      scheduleHide();
      return;
    }
    if (pinnedCell) $(pinnedCell).removeClass('is-pinned');
    pinnedCell = cell;
    $(cell).addClass('is-pinned');
    clearTimeout(hideTimer);
    renderPop(cell, evCache.get(+cell.getAttribute('data-uid')) || null);
    if (!evCache.has(+cell.getAttribute('data-uid'))) showFor(cell);
  }
  /* ✎ Save / remove an adjustment from the pop-up form. */
  $(document).on('focusin', '.sld-evpop__adj input, .sld-evpop__adj textarea', () => {
    // Typing must not lose the pop-up: pin it to the cell it belongs to.
    const cell = $pop && $pop.data('cell');
    if (cell && pinnedCell !== cell) togglePin(cell);
  });
  const applyRowToTable = (uid, row) => {
    if (!row) return;
    const $tr = $(`.sld-results__table tr[data-uname]`).filter(function findRow() { return +$(this).find('.sld-ev[data-uid]').first().attr('data-uid') === uid; }).first();
    if (!$tr.length) return;
    $tr.attr('data-total', row.total);
    $tr.find('.sld-ev[data-ev="total"] b').text(row.total);
    $tr.find('.sld-ev[data-ev="blockA"]').each(function setA() { if (!$(this).hasClass('is-na')) $(this).text(typeof row.blockA === 'number' ? row.blockA : '—'); });
    $tr.find('.sld-ev[data-ev="task"]').each(function setTask() {
      const pid = $(this).attr('data-pid');
      const v = row.taskScores ? row.taskScores[String(pid)] : null;
      $(this).find('b').text(typeof v === 'number' ? v : '—');
      $(this).find('.sld-results__adj').remove();
      const o = row.override && row.override.tasks ? row.override.tasks[String(pid)] : null;
      if (o) $(this).append(`<span class="sld-results__adj" title="${escapeHtml(`${i18n('Adjusted by the teacher')}: ${o.reason} (${i18n('computed')} ${o.computed})`)}">✎</span>`);
    });
    const $tot = $tr.find('.sld-ev[data-ev="total"]');
    $tot.find('.sld-results__adj').remove();
    if (row.override && row.override.total) $tot.append(`<span class="sld-results__adj" title="${escapeHtml(`${i18n('Adjusted by the teacher')}: ${row.override.total.reason} (${i18n('computed')} ${row.override.total.computed})`)}">✎</span>`);
    applySort();
  };
  $(document).on('click', '.sld-adj-save, .sld-adj-clear', async function onAdjust() {
    const $box = $(this).closest('.sld-evpop__adj');
    const kind = $box.attr('data-kind');
    const pid = $box.attr('data-pid');
    const uid = +$box.attr('data-uid');
    const clear = $(this).hasClass('sld-adj-clear');
    const payload = { operation: clear ? 'clearOverride' : 'overrideScore', uid };
    if (kind === 'task') payload.pid = +pid;
    if (!clear) {
      const score = Number.parseFloat($box.find('.sld-adj-score').val());
      const reason = String($box.find('.sld-adj-reason').val() || '').trim();
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        Notification.error(i18n('Enter a score between 0 and 100.'));
        return;
      }
      if (!reason) {
        Notification.error(i18n('Please give a reason — the student will see it.'));
        return;
      }
      payload.score = score;
      payload.reason = reason;
    }
    $box.find('button').prop('disabled', true);
    try {
      const res = await request.post(window.location.pathname, payload);
      Notification.success(clear ? i18n('Adjustment removed.') : i18n('Score adjusted.'));
      const cached = evCache.get(uid);
      if (cached && res.row) cached.row = res.row;
      applyRowToTable(uid, res.row);
      const cell = $pop && $pop.data('cell');
      if (cell) renderPop(cell, evCache.get(uid) || null);
    } catch (e) {
      Notification.error(e.message || i18n('Could not save the adjustment.'));
      $box.find('button').prop('disabled', false);
    }
  });
  $(document).on('mouseenter', '.sld-ev', function onEvHover() {
    if (pinnedCell && pinnedCell !== this) return; // a pinned pop-up stays put
    showFor(this);
  });
  $(document).on('mouseleave', '.sld-ev', scheduleHide);
  $(document).on('click', '.sld-ev', function onEvClick(ev) {
    ev.preventDefault();
    togglePin(this);
  });
  $(document).on('keydown', (ev) => {
    if (ev.key === 'Escape' && $pop) hideTip(true);
  });

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
        evCache.clear();
        hideTip(true);
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
        const c = showEvalCard();
        if (job.force) c.markForce();
        c.setProgress(job.progress); // who is being judged now
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
    evCache.clear(); // results are about to be rewritten
    try {
      // ♻️ The button ALWAYS re-runs the full evaluation from scratch —
      // every answer, fix, dialogue and concept is judged anew.
      await request.post(window.location.pathname, { operation: 'recompute', force: true });
      showEvalCard().markForce();
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
        const c = showEvalCard();
        if (res.job.force) c.markForce();
        startPoll();
      }
    } catch (e) { /* no job info — nothing to re-attach */ }
  })();
});
