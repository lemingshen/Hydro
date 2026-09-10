import $ from 'jquery';
import { confirm } from 'vj/components/dialog';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

/**
 * PTA fork — AI GRADING REVIEW of a subjective report task inside a homework
 * (/homework/:tid/subjective/:pid, handler/subjective_grading.ts).
 *
 * The page is rendered by the server (homework_report_review.html; the page
 * name differs from the route name on purpose, so a stale UI bundle's older
 * script for this page never runs against the new markup) and every action
 * is a plain form post that redirects back, so it works with no script.
 * This module adds the LIVE layer while a grading run is in progress:
 *   - every student's row shows the pipeline stage the grader is at
 *     (📄 reading → 🤖 grading → 🔍 verifying quotes → ✏️ annotating),
 *     the current step pulsing; a finished row pops its verdict chip and
 *     counts its score up, a failed one turns red;
 *   - the job card's bar shimmers and grows, with an estimate of the time
 *     left computed from the rate so far;
 *   - when the run ends: a banner, a confetti burst, and the page reloads
 *     itself so the server-rendered table is final;
 *   - the destructive forms ask first; the table sorts and filters; a
 *     comment jumps the annotated PDF to its page.
 */

const STAGES = [
  ['extract', '📄', 'Reading the PDF'],
  ['grading', '🤖', 'Grading against the rubric'],
  ['verify', '🔍', 'Verifying the quotes'],
  ['annotate', '✏️', 'Annotating the PDF'],
];
const STAGE_INDEX = { queued: -1, extract: 0, grading: 1, verify: 2, annotate: 3, done: 4 };
/** How far through one report each stage is (grading, the model call, is the long part). */
const STAGE_FRACTION = { queued: 0.04, extract: 0.18, grading: 0.55, verify: 0.82, annotate: 0.92, done: 1, failed: 1, skipped: 1 };
const FLAG_TEXT = {
  off_topic: 'off topic', missing_sections: 'missing sections', possible_ai_text: 'possibly AI-written', grader_manipulation: 'grader manipulation', not_a_report: 'not a report', incomplete_grading: 'incomplete grading', truncated: 'truncated', scanned: 'scanned',
};
const esc = (t) => $('<i>').text(String(t ?? '')).html();
const num1 = (x) => (typeof x === 'number' && Number.isFinite(x) ? String(Math.round(x * 10) / 10) : '—');

/**
 * The stage pipeline of one row: done steps lit green with green
 * connectors, the current one pulsing with light flowing into it, then the
 * step's name with an animated ellipsis and the seconds spent on it.
 */
function pipeHtml(stage, stageAt, withLabel = true) {
  const at = STAGE_INDEX[stage] ?? -1;
  const parts = [];
  STAGES.forEach(([, icon, title], i) => {
    if (i > 0) parts.push(`<s class="${i <= at ? (i === at ? 'is-now' : 'is-done') : ''}"></s>`);
    parts.push(`<i class="${i < at ? 'is-done' : i === at ? 'is-now' : ''}" title="${esc(i18n(title))}">${icon}</i>`);
  });
  const label = at < 0 ? i18n('queued') : (STAGES[at] ? i18n(STAGES[at][2]) : '');
  const since = stageAt ? new Date(stageAt).getTime() : 0;
  return `<span class="hsr__pipe" data-since="${since}">${parts.join('')}${withLabel ? `<em><span class="hsr__ell">${esc(label)}</span> <b data-tick="since"></b></em>` : ''}</span>`;
}

const fmtSecs = (s) => (s < 60 ? `${Math.floor(s)} s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

/** Ease a number into an element over `ms` (score count-up). */
function countUp($el, to, ms = 900, format = num1) {
  const start = performance.now();
  const from = 0;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    $el.text(format(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function confetti(n = 90) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Brand palette (the confetti is a one-off flourish, not themed surface colour).
  const colors = ['#7048e8', '#9775fa', '#2f9e44', '#f5b301', '#c2255c', '#1c7ed6'];
  const $box = $('<div class="hsr__confetti"></div>').appendTo(document.body);
  for (let i = 0; i < n; i++) {
    const dur = 1.3 + Math.random() * 1.4;
    $(`<i style="left:${Math.random() * 100}vw;background:${colors[i % colors.length]};--dx:${Math.round((Math.random() - 0.5) * 240)}px;--rot:${Math.round(360 + Math.random() * 720)}deg;animation-duration:${dur.toFixed(2)}s;animation-delay:${(Math.random() * 0.4).toFixed(2)}s;width:${6 + Math.round(Math.random() * 6)}px"></i>`).appendTo($box);
  }
  setTimeout(() => $box.remove(), 3400);
}

const fmtLeft = (s) => {
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
};

export default new NamedPage('homework_report_review', () => {
  const $root = $('#hsr-root');
  if (!$root.length) return;
  const url = $root.data('url') || window.location.pathname;
  const $tbody = $('#hsr-table tbody');
  const rubricTotal = (() => {
    const m = $root.find('.hsr__chip:contains("/")').first().text().match(/\/\s*([\d.]+)/);
    return m ? m[1] : '';
  })();

  /* ------------------------- confirmations ------------------------- */
  $root.on('submit', 'form[data-confirm]', function onConfirm(ev) {
    const form = this;
    if (form.dataset.confirmed === '1') return;
    ev.preventDefault();
    confirm(String(form.dataset.confirm)).then((ok) => {
      if (!ok) return;
      form.dataset.confirmed = '1';
      form.submit();
    });
  });

  /* ---------------------- the live grading layer --------------------- */
  const rowState = {}; // uid -> last status we rendered
  $tbody.find('tr[data-uid]').each(function init() {
    rowState[this.dataset.uid] = this.dataset.status;
    if (this.dataset.status === 'running' || this.dataset.status === 'queued') {
      $(this).find('.hsr__live-status').replaceWith(pipeHtml(this.dataset.stage || 'queued', this.dataset.stageAt || null));
    }
  });
  // Seconds tick locally between polls: the elapsed time of the run and of every step in progress.
  const $jobCard = $('#hsr-job');
  const startedAt = new Date($jobCard.find('.hsr__job').data('started-at') || Date.now()).getTime();
  setInterval(() => {
    const now = Date.now();
    $root.find('.hsr__pipe[data-since]').each(function tick() {
      const since = +this.dataset.since;
      $(this).find('[data-tick="since"]').text(since ? `· ${fmtSecs((now - since) / 1000)}` : '');
    });
    if ($jobCard.find('.hsr__job--live').length) $jobCard.find('[data-job="elapsed"]').text(`${fmtSecs((now - startedAt) / 1000)} ${i18n('elapsed')} ·`);
  }, 1000);
  // The open student's "in progress" note becomes the vertical pipeline.
  const $detailLive = $('#hsr-detail-live');
  const renderDetailLive = (stage) => {
    const at = STAGE_INDEX[stage] ?? -1;
    $detailLive.html(`<div class="hsr__steps">${STAGES.map(([, icon, label], i) => `<div class="hsr__step ${i < at ? 'is-done' : i === at ? 'is-now' : ''}"><span class="hsr__pipe"><i class="${i < at ? 'is-done' : i === at ? 'is-now' : ''}">${icon}</i></span><span>${esc(i18n(label))}</span>${i < at ? '<span class="hsr__meta">✓</span>' : ''}</div>`).join('')}</div>`);
  };
  if ($detailLive.length) renderDetailLive($detailLive.data('stage') || 'queued');

  /* ------------------ the live spotlight (auto-cycling) ------------------ */
  /*
   * One report at a time, without clicking: the spotlight shows the step
   * list of a report in progress, keeps it for a few seconds, then moves to
   * the next one (the row is highlighted meanwhile). A report that finishes
   * while in the spotlight shows its result first. Pause / next are there
   * for a teacher who wants to linger.
   */
  const SPOT_DWELL = 4500;
  const SPOT_RESULT = 3000;
  const spot = {
    uid: null, since: 0, paused: false, stage: null, resultUntil: 0, $el: null, latest: {}, queue: [],
  };
  const rowInfo = (uid) => {
    const $tr = $tbody.find(`tr[data-uid="${uid}"]`);
    return { name: $tr.find('td').eq(0).text().replace(/\s+/g, ' ').trim(), pdf: $tr.find('td').eq(1).find('a').first().text().trim() };
  };
  const inFlightUids = () => Object.keys(spot.latest).map(Number).filter((u) => spot.latest[u] && (spot.latest[u].status === 'running' || spot.latest[u].status === 'queued'));
  const spotStepsHtml = (stage) => {
    const at = STAGE_INDEX[stage] ?? -1;
    return `<div class="hsr__steps">${STAGES.map(([, icon, label], i) => `<div class="hsr__step ${i < at ? 'is-done' : i === at ? 'is-now' : ''}"><span class="hsr__pipe"><i class="${i < at ? 'is-done' : i === at ? 'is-now' : ''}">${icon}</i></span><span>${esc(i18n(label))}</span>${i === at ? '<span class="hsr__meta hsr__ell"></span>' : i < at ? '<span class="hsr__meta">✓</span>' : ''}</div>`).join('')}</div>`;
  };
  const spotEnsure = () => {
    if (spot.$el) return spot.$el;
    spot.$el = $(`<div class="hsr__spot" id="hsr-spot"><div class="hsr__spot-head"><span>🔎 ${esc(i18n('Now grading'))}: <b data-spot="name"></b></span><span class="hsr__spot-dots" data-spot="dots"></span><span class="hsr__spot-tools"><button type="button" data-spot="prev" title="${esc(i18n('previous report'))}">‹</button><button type="button" data-spot="pause">⏸ ${esc(i18n('pause'))}</button><button type="button" data-spot="next" title="${esc(i18n('next report'))}">›</button></span></div><div class="hsr__spot-body" data-spot="body"></div><div class="hsr__spot-foot"><span data-spot="pdf"></span><span class="hsr__spot-next" data-spot="countdown"></span></div></div>`);
    $('#hsr-job').after(spot.$el);
    spot.$el.on('click', '[data-spot="pause"]', () => {
      spot.paused = !spot.paused;
      spot.$el.find('[data-spot="pause"]').text(spot.paused ? `▶ ${i18n('auto')}` : `⏸ ${i18n('pause')}`);
    });
    spot.$el.on('click', '[data-spot="next"]', () => spot.advance(1));
    spot.$el.on('click', '[data-spot="prev"]', () => spot.advance(-1));
    return spot.$el;
  };
  const spotRemove = () => {
    if (!spot.$el) return;
    spot.$el.remove();
    spot.$el = null;
    spot.uid = null;
    $tbody.find('tr.is-live').removeClass('is-live');
  };
  const spotShow = (uid) => {
    const g = spot.latest[uid];
    if (!g) return;
    const $el = spotEnsure();
    const info = rowInfo(uid);
    spot.uid = uid;
    spot.since = Date.now();
    spot.stage = g.stage || 'queued';
    spot.resultUntil = 0;
    $tbody.find('tr.is-live').removeClass('is-live');
    $tbody.find(`tr[data-uid="${uid}"]`).addClass('is-live');
    $el.find('[data-spot="name"]').text(info.name);
    $el.find('[data-spot="pdf"]').text(info.pdf ? `📄 ${info.pdf}` : '');
    const $body = $el.find('[data-spot="body"]');
    $body.replaceWith(`<div class="hsr__spot-body" data-spot="body">${spotStepsHtml(spot.stage)}</div>`);
    spot.dots();
  };
  const spotDots = () => {
    if (!spot.$el) return;
    const uids = inFlightUids();
    spot.$el.find('[data-spot="dots"]').html(uids.map((u) => `<i class="${u === spot.uid ? 'is-on' : ''}" title="${esc(rowInfo(u).name)}"></i>`).join(''));
  };
  spot.dots = spotDots;
  /**
   * Move the spotlight: a report that finished while out of the spotlight
   * gets its result moment first (the automatic order only), then the next
   * report in flight.
   */
  const spotAdvance = (dir = 1, auto = false) => {
    if (auto && spot.queue.length) {
      const uid = spot.queue.shift();
      if (spot.latest[uid]) {
        spotShow(uid);
        spot.result(uid, spot.latest[uid]);
        return;
      }
    }
    const uids = inFlightUids();
    if (!uids.length) {
      spotRemove();
      return;
    }
    const i = uids.indexOf(spot.uid);
    const next = uids[(i < 0 ? 0 : i + dir + uids.length) % uids.length];
    spotShow(next);
  };
  spot.advance = spotAdvance;
  /** A report in the spotlight has finished: show its verdict before moving on. */
  const spotResult = (uid, g) => {
    if (!spot.$el) return;
    const $body = spot.$el.find('[data-spot="body"]');
    const bad = g.status !== 'done';
    const text = g.status === 'done'
      ? `<span class="hsr__total"><span class="hsr__count"></span><small> / ${esc(g.maxTotal ?? rubricTotal)} ${esc(i18n('pts'))} · ${esc(i18n('score'))} ${esc(Math.round(g.score100 || 0))} / 100</small></span>${(g.flags || []).map((f) => `<span class="hsr__flag">${esc(i18n(FLAG_TEXT[f] || f))}</span>`).join('')}`
      : `<b>${esc(g.status === 'failed' ? i18n('Grading failed') : i18n('Not graded'))}</b> <span class="hsr__meta">${esc(g.error || '')}</span>`;
    $body.replaceWith(`<div class="hsr__spot-body" data-spot="body"><div class="hsr__spot-result ${bad ? 'hsr__spot-result--bad' : ''}"><span class="hsr__st ${bad ? 'hsr__st--bad' : 'hsr__st--done'} hsr__pop">${bad ? '✗' : '✓'} ${esc(g.status === 'done' ? i18n('graded') : i18n(g.status))}</span>${text}</div></div>`);
    if (g.status === 'done') countUp(spot.$el.find('.hsr__count'), g.total || 0);
    spot.resultUntil = Date.now() + SPOT_RESULT;
  };
  spot.result = spotResult;
  /** Called after every poll with the fresh grade states. */
  const spotUpdate = (rows) => {
    for (const r of rows || []) {
      const prev = spot.latest[r.uid];
      const wasBusy = prev && (prev.status === 'running' || prev.status === 'queued');
      const busyNow = r.grade && (r.grade.status === 'running' || r.grade.status === 'queued');
      // Finished out of the spotlight: queued for its result moment.
      if (wasBusy && !busyNow && r.uid !== spot.uid && !spot.queue.includes(r.uid)) spot.queue.push(r.uid);
      spot.latest[r.uid] = r.grade;
    }
    const uids = inFlightUids();
    if (spot.uid !== null && spot.latest[spot.uid]) {
      const g = spot.latest[spot.uid];
      const busy = g.status === 'running' || g.status === 'queued';
      if (!busy && !spot.resultUntil) spotResult(spot.uid, g);
      else if (busy && (g.stage || 'queued') !== spot.stage) {
        spot.stage = g.stage || 'queued';
        spot.$el.find('[data-spot="body"]').replaceWith(`<div class="hsr__spot-body" data-spot="body">${spotStepsHtml(spot.stage)}</div>`);
      }
    } else if (uids.length) spotShow(uids[0]);
    else if (spot.queue.length && !spot.resultUntil) spotAdvance(1, true);
    spotDots();
  };
  /** Once a second: dwell time, result time, the "next in N s" hint. */
  const spotTick = () => {
    if (!spot.$el) return;
    const now = Date.now();
    const uids = inFlightUids();
    const $cd = spot.$el.find('[data-spot="countdown"]');
    if (spot.resultUntil) {
      if (now >= spot.resultUntil) {
        spot.resultUntil = 0;
        if (uids.length || spot.queue.length) spotAdvance(1, true);
        else spotRemove();
      } else $cd.text(uids.length || spot.queue.length ? `${i18n('next in {0} s').replace('{0}', Math.ceil((spot.resultUntil - now) / 1000))}` : '');
      return;
    }
    if (spot.queue.length && !spot.paused) {
      spotAdvance(1, true); // a finished report is waiting for its moment
      return;
    }
    if (spot.paused || uids.length < 2) {
      $cd.text(spot.paused ? `⏸ ${i18n('paused')}` : `${i18n('this step for')} ${fmtSecs((now - (new Date(spot.latest[spot.uid]?.stageAt || spot.since).getTime())) / 1000)}`);
      return;
    }
    const left = Math.ceil((spot.since + SPOT_DWELL - now) / 1000);
    if (left <= 0) spotAdvance(1, true);
    else $cd.text(`${i18n('next in {0} s').replace('{0}', left)}`);
  };
  setInterval(spotTick, 1000);
  // Seed the spotlight from the server-rendered rows (before the first poll).
  spotUpdate($tbody.find('tr[data-uid]').get().filter((tr) => tr.dataset.status === 'running' || tr.dataset.status === 'queued').map((tr) => ({ uid: +tr.dataset.uid, grade: { status: tr.dataset.status, stage: tr.dataset.stage || 'queued', stageAt: tr.dataset.stageAt || null } })));

  /** Repaint one row from the polled grade state; animate transitions. */
  const applyRow = (row) => {
    const $tr = $tbody.find(`tr[data-uid="${row.uid}"]`);
    if (!$tr.length) return;
    const g = row.grade;
    const status = g ? g.status : (row.file ? 'zz' : 'zzz');
    const prev = rowState[row.uid];
    const $cells = $tr.children('td');
    const $status = $cells.eq(2);
    const $total = $cells.eq(3);
    const $score = $cells.eq(4);
    const $conf = $cells.eq(5);
    const $flags = $cells.eq(6);
    const $rel = $cells.eq(7);
    if (g && (status === 'running' || status === 'queued')) {
      const stage = g.stage || 'queued';
      // Re-render only when the step changes, so the pulse and the ticking seconds are not reset every poll.
      if ($tr.attr('data-stage') !== stage || !$status.find('.hsr__pipe').length) {
        $status.html(pipeHtml(stage, g.stageAt || null));
        $tr.attr('data-stage', stage);
      }
      // A stale result must not show through while this run is in progress.
      const dash = '<span class="hsr__meta">—</span>';
      $total.html(dash);
      $score.html(dash);
      $conf.html(dash);
      $flags.empty();
      $rel.empty();
      if ($detailLive.length && +$('#hsr-detail').data('uid') === row.uid) renderDetailLive(stage);
    } else if (status === 'done' && prev !== 'done') {
      const pct100 = Math.round(g.score100 || 0);
      const tone = pct100 < 40 ? ' hsr__meter--low' : pct100 < 70 ? ' hsr__meter--mid' : '';
      $status.html(`<span class="hsr__st hsr__st--done hsr__pop">✓ ${esc(i18n('graded'))}</span>${g.stale ? ` <span class="hsr__st hsr__st--warn">${esc(i18n('changed'))}</span>` : ''}`);
      $total.html(`<span class="hsr__score"><b><span class="hsr__count"></span>${g.adjusted ? '<span class="hsr__adj">✎</span>' : ''} <span class="hsr__meta">/ ${esc(rubricTotal || (g.maxTotal ?? ''))}</span></b><span class="hsr__meter${tone}"><i style="width:0%"></i></span></span>`);
      countUp($total.find('.hsr__count'), g.total || 0);
      setTimeout(() => $total.find('.hsr__meter i').css('width', `${pct100}%`), 60);
      $score.html('<span class="hsr__count"></span>');
      countUp($score.find('.hsr__count'), g.score100 || 0, 900, (x) => String(Math.round(x)));
      $conf.html(typeof g.confidence === 'number' ? `${Math.round(g.confidence * 100)}%` : '<span class="hsr__meta">—</span>');
      $flags.html((g.flags || []).length ? `<div class="hsr__flags">${(g.flags || []).map((f) => `<span class="hsr__flag hsr__pop" title="${esc(i18n(FLAG_TEXT[f] || f))}">${esc(i18n(FLAG_TEXT[f] || f))}</span>`).join('')}</div>` : '');
      $rel.html(g.released ? `<span class="hsr__rel--on">✓ ${esc(i18n('yes'))}</span>` : `<span class="hsr__rel--off">🔒 ${esc(i18n('no'))}</span>`);
      $tr.addClass('hsr__flash');
      setTimeout(() => $tr.removeClass('hsr__flash'), 2000);
    } else if (status === 'failed' && prev !== 'failed') {
      $status.html(`<span class="hsr__st hsr__st--bad hsr__pop" title="${esc(g.error || '')}">✗ ${esc(i18n('failed'))}</span>`);
    } else if (status === 'skipped' && prev !== 'skipped') {
      $status.html(`<span class="hsr__st hsr__st--warn hsr__pop" title="${esc(g.error || '')}">${esc(i18n('manual'))}</span>`);
    }
    rowState[row.uid] = status;
    $tr.attr('data-status', status);
    if (g && typeof g.total === 'number') $tr.attr('data-total', g.total);
  };

  /**
   * The job card: counts, the bar and the time-left estimate. Progress is
   * FRACTIONAL — every report in flight adds the share of its current
   * step — so the bar moves while the reports are being read and graded,
   * not only when one of them finishes.
   */
  const applyJob = (job, rows) => {
    const $card = $('#hsr-job');
    $card.find('[data-job="progress"]').text(`${job.done}/${job.total}`);
    $card.find('[data-job="graded"]').text(String(job.graded));
    $card.find('[data-job="skipped"]').text(String(job.skipped));
    $card.find('[data-job="failed"]').text(String(job.failed));
    const inFlight = (rows || []).filter((r) => r.grade && (r.grade.status === 'running' || r.grade.status === 'queued'));
    const partial = inFlight.reduce((a, r) => a + (STAGE_FRACTION[r.grade.stage || 'queued'] || 0), 0);
    const progress = job.total ? Math.min(0.99, (job.done + partial) / job.total) : 0;
    $card.find('[data-job="bar"]').css('width', `${Math.max(2, Math.round(progress * 100))}%`);
    $card.find('[data-job="inflight"]').html(inFlight.length ? `<b>${inFlight.length}</b> ${esc(i18n('in progress'))} · ` : '');
    const started = new Date($card.find('.hsr__job').data('started-at') || job.startedAt).getTime();
    const elapsed = (Date.now() - started) / 1000;
    const left = progress > 0.05 ? (elapsed / progress) * (1 - progress) : Number.NaN;
    const $eta = $card.find('[data-job="eta"]');
    if (job.total <= job.done) $eta.text(i18n('finishing…'));
    else if (Number.isFinite(left) && elapsed > 8) $eta.text(`${i18n('about {0} left').replace('{0}', fmtLeft(left))}`);
    else $eta.text(i18n('warming up…'));
  };

  const finish = (res) => {
    const job = res.job || {};
    const $card = $('#hsr-job');
    spotRemove();
    const graded = job.graded || 0;
    $card.html(`<div class="hsr__banner">${graded ? '🎉 ' : '✅ '}${esc(i18n('Grading finished'))}: ${graded} ${esc(i18n('graded'))}, ${job.skipped || 0} ${esc(i18n('skipped'))}, ${job.failed || 0} ${esc(i18n('failed'))}. <span class="hsr__meta">${esc(i18n('Refreshing the table…'))}</span></div>`);
    $root.find('.hsr__title').removeClass('hsr__title--live');
    if (graded) confetti();
    setTimeout(() => window.location.reload(), graded ? 2600 : 1400);
  };

  let failures = 0;
  const poll = async () => {
    let res;
    try {
      res = await request.post(url, { operation: 'status' });
      failures = 0;
    } catch (e) {
      failures += 1;
      if (failures > 12) return; // the server is unreachable; stop nagging it
      setTimeout(poll, 3000);
      return;
    }
    for (const row of res.rows || []) applyRow(row);
    spotUpdate(res.rows);
    const job = res.job;
    const rowsBusy = (res.rows || []).some((r) => r.grade && (r.grade.status === 'running' || r.grade.status === 'queued'));
    if (job && job.status === 'running') {
      applyJob(job, res.rows);
      setTimeout(poll, 1500);
    } else if (rowsBusy) {
      setTimeout(poll, 1500); // a per-student regrade without a job card
    } else finish(res);
  };
  const anyRunning = String($root.data('running')) === 'true' || $tbody.find('tr[data-status="running"], tr[data-status="queued"]').length > 0;
  if (anyRunning) setTimeout(poll, 800);

  /* ---------------------- sorting and filtering --------------------- */
  const rows = () => $tbody.find('tr[data-uid]').get();
  let sortKey = 'uname';
  let sortDir = 1;
  const valueOf = (tr, key) => {
    const v = tr.dataset[key];
    if (key === 'total' || key === 'confidence') return Number(v);
    if (key === 'file') return v ? new Date(v).getTime() : 0;
    return String(v || '').toLowerCase();
  };
  $root.on('click', '#hsr-table th[data-sort]', function onSort() {
    const key = String(this.dataset.sort);
    if (sortKey === key) sortDir = -sortDir;
    else {
      sortKey = key;
      sortDir = 1;
    }
    const sorted = rows().sort((a, b) => {
      const x = valueOf(a, key);
      const y = valueOf(b, key);
      if (x < y) return -sortDir;
      if (x > y) return sortDir;
      return 0;
    });
    for (const tr of sorted) $tbody.append(tr);
    $('#hsr-table th').each(function mark() { $(this).text($(this).text().replace(/ [▲▼]$/, '')); });
    $(this).text(`${$(this).text()} ${sortDir > 0 ? '▲' : '▼'}`);
  });
  $root.on('input', '.hsr__search', function onFilter() {
    const q = String($(this).val() || '').trim().toLowerCase();
    for (const tr of rows()) tr.style.display = !q || String(tr.dataset.uname || '').toLowerCase().includes(q) ? '' : 'none';
  });

  /* -------------------- comment → page in the viewer ----------------- */
  $root.on('click', '.hsr__cmt', function onJump() {
    const $frame = $('#hsr-frame');
    if (!$frame.length) return;
    const base = String($frame.attr('src') || '').split('#')[0];
    $frame.attr('src', `${base}#page=${this.dataset.page}`);
    $frame[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
});
