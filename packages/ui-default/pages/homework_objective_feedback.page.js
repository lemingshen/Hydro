import $ from 'jquery';
import { aiMarkdown } from 'vj/components/ai-report/pdf';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

/**
 * PTA fork — "🤖 Explain" next to every objective question a student did
 * not get right, on the homework's PAPER page (objective_paper.html) once
 * the homework has ended.
 *
 * The explanation is appended INLINE, right under the question it belongs
 * to — never a pop-up: the student reads the question, their answer and
 * the explanation in one place, and can scroll through several at once.
 * The button starts a background job for that one question, the panel
 * shows the progress, and the rendered Markdown replaces it when the job
 * ends. Afterwards the button toggles the panel open and closed; the panel
 * itself offers "Explain again". Leaving the page never stops a job.
 */
const esc = (t) => $('<i>').text(String(t ?? '')).html();

export default new NamedPage('homework_paper', () => {
  const cfg = (window.UiContext && UiContext.paperFeedback) || null;
  if (!cfg || !cfg.url) return;
  const urlOf = (pid) => `${cfg.url}?pid=${pid}`;
  const timers = {};

  const panelOf = (pid) => {
    let $p = $(`#hwof-p-${pid}`);
    if (!$p.length) {
      $p = $(`<div class="section__body hwof-panel" id="hwof-p-${pid}"></div>`);
      const $q = $(`#q-${pid}`);
      // Below the question's content (and below the per-question footer, when there is one).
      $q.append($p);
    }
    return $p;
  };
  const setBtn = ($btn, state) => {
    if (state === 'open') $btn.addClass('hwof-btn--has').html(`📖 ${esc(i18n('Hide explanation'))}`).prop('disabled', false);
    else if (state === 'closed') $btn.addClass('hwof-btn--has').html(`📘 ${esc(i18n('View explanation'))}`).prop('disabled', false);
    else $btn.html(`🤖 ${esc(i18n('Explain'))}`).prop('disabled', false);
  };
  const waiting = (pid) => {
    panelOf(pid).removeClass('is-hidden').html(`<div class="hwof-wait"><div class="hwof-spin"></div><div>`
      + `<b class="hwof-dots">${esc(i18n('The AI is preparing your explanation'))}</b>`
      + `<div class="hwof-meta">${esc(i18n('This takes a few seconds. You can keep reading — the explanation appears here when it is ready, and is saved for next time.'))}</div></div></div>`);
  };
  const show = (pid, res, $btn) => {
    const $p = panelOf(pid).removeClass('is-hidden');
    $p.html(`<div class="hwof-panel__head">🤖 ${esc(i18n('AI explanation'))}</div>`
      + '<div class="hwof-panel__body typo"></div>'
      + `<div class="hwof-panel__foot"><span class="hwof-meta">${res.generatedAt ? `${esc(i18n('Generated'))} ${esc(new Date(res.generatedAt).toLocaleString())}` : ''}</span>`
      + `<span class="spacer"></span><button type="button" class="hwof-again">↻ ${esc(i18n('Explain again'))}</button></div>`);
    $p.find('.hwof-panel__body').html(aiMarkdown.render(String(res.report || '')));
    $p.find('.hwof-again').on('click', () => generate(pid, $btn)); // eslint-disable-line ts/no-use-before-define
    setBtn($btn, 'open');
  };
  const poll = (pid, $btn) => {
    clearTimeout(timers[pid]);
    timers[pid] = setTimeout(async () => {
      try {
        const probe = await request.get(`${urlOf(pid)}&job=1`);
        if (probe.job && probe.job.status === 'running') {
          poll(pid, $btn);
          return;
        }
        const res = await request.get(urlOf(pid));
        const failedNow = probe.job && probe.job.status === 'failed'
          && (!res.generatedAt || new Date(res.generatedAt) < new Date(probe.job.startedAt));
        if (res.report && !failedNow) show(pid, res, $btn);
        else {
          const msg = (probe.job && probe.job.error) || i18n('The explanation could not be generated.');
          Notification.error(msg);
          panelOf(pid).html(`<div class="hwof-panel__error">⚠ ${esc(msg)}</div>`);
          setBtn($btn, 'new');
        }
      } catch (e) {
        poll(pid, $btn); // transient: keep watching
      }
    }, 2000);
  };
  async function generate(pid, $btn) {
    waiting(pid);
    $btn.prop('disabled', true);
    try {
      const res = await request.post(cfg.url, { pid });
      if (!res.started) Notification.info(i18n('An explanation is already being generated for this task.'));
      poll(pid, $btn);
    } catch (e) {
      const msg = e.message || i18n('Could not start the explanation.');
      Notification.error(msg);
      panelOf(pid).html(`<div class="hwof-panel__error">⚠ ${esc(msg)}</div>`);
      setBtn($btn, 'new');
    }
  }

  $(document).on('click', '.hwof-btn[data-pid]', async function onExplain() {
    const $btn = $(this);
    const pid = +$btn.attr('data-pid');
    const $p = $(`#hwof-p-${pid}`);
    // Already loaded: the button just folds the explanation away and back.
    if ($p.length && $p.find('.hwof-panel__body').length) {
      // An explicit class, not :visible — the state must be unambiguous.
      const hidden = $p.hasClass('is-hidden');
      $p.toggleClass('is-hidden', !hidden);
      setBtn($btn, hidden ? 'open' : 'closed');
      return;
    }
    waiting(pid);
    $btn.prop('disabled', true);
    try {
      const res = await request.get(urlOf(pid));
      const running = res.job && res.job.status === 'running';
      if (res.report && !running) show(pid, res, $btn);
      else if (running) poll(pid, $btn);
      else generate(pid, $btn);
    } catch (e) {
      Notification.error(e.message || i18n('Could not load the explanation.'));
      panelOf(pid).remove();
      setBtn($btn, 'new');
    }
  });

  // A job still running when the page was (re)loaded: watch it and fill the panel in place.
  $('.hwof-btn[data-running="1"]').each(function attach() {
    const $btn = $(this);
    const pid = +$btn.attr('data-pid');
    waiting(pid);
    $btn.prop('disabled', true);
    poll(pid, $btn);
  });
});
