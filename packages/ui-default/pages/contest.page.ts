import $ from 'jquery';
import { formatSeconds } from '@hydrooj/utils/lib/common';
import NProgress from 'nprogress';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { addSpeculationRules, i18n, tpl } from 'vj/utils';

const contestTimer = $(tpl`<pre class="contest-timer" style="display:none"></pre>`);
contestTimer.appendTo(document.body);

/** Remaining time, with days when there are more than 24 hours of them. */
function formatLeft(seconds: number) {
  const days = Math.floor(seconds / 86400);
  return days > 0 ? `${days}${i18n('d')} ${formatSeconds(seconds - days * 86400)}` : formatSeconds(seconds);
}

export default new NamedPage([
  'contest_detail', 'contest_problemlist', 'contest_detail_problem', 'contest_scoreboard', 'contest_paper',
  'homework_detail', 'homework_detail_problem', 'homework_paper',
], (pagename) => {
  if (!UiContext.tdoc) return;
  const isHomework = UiContext.tdoc.rule === 'homework' || !!UiContext.tdoc.penaltySince;
  const beginAt = new Date((UiContext.tdoc.duration && UiContext.tsdoc?.startAt) || UiContext.tdoc.beginAt).getTime();
  const endAt = new Date(UiContext.tsdoc?.endAt || UiContext.tdoc.endAt).getTime();
  const dueAt = isHomework && UiContext.tdoc.penaltySince ? new Date(UiContext.tdoc.penaltySince).getTime() : endAt;
  NProgress.configure({ trickle: false, showSpinner: false, minimum: 0 });
  /*
   * PTA: ONE countdown for every page of a test — the paper, a programming
   * task's IDE, the test page. Blue while there is time, amber in the last
   * ten minutes, RED with a larger face (pulsing) in the last five, "Time is
   * up" after the end. It docks at the top of the problems rail whenever the
   * rail is on the page and open (the rail is fixed, so the timer is always
   * in view and never collides with the IDE toolbar); otherwise it floats
   * at the top-right of the viewport. Managers' tabular list and the
   * scoreboard get the floating form. The stock corner timer stays hidden.
   */
  const $pill = $(tpl`<span class="paper-timer" role="timer" aria-live="off"><span class="paper-timer__icon">⏱</span><span class="paper-timer__text"></span></span>`).appendTo(document.body);
  let docked = false;
  /*
   * PTA: when the deadline passes while a student is working, the page is
   * sent back to the test's own page, which now shows the detailed scores
   * (contest_detail "Your results"); on that page a reload reveals them.
   * Managers are never moved. Only a transition observed live triggers it —
   * a page opened after the end stays where it is (review).
   */
  const isManager = !!(UiContext.canManageContest);
  const containerUrl = (() => {
    const base = window.location.pathname.replace(/\/(contest|homework)\/[^/]+.*$/, '').replace(/\/p\/.*$/, '');
    return `${base}/${isHomework ? 'homework' : 'contest'}/${UiContext.tdoc.docId}`;
  })();
  let wasLive = false;
  function onDeadline() {
    if (isManager) return;
    if (pagename === 'contest_detail' || pagename === 'homework_detail') {
      window.location.reload();
      return;
    }
    Notification.info(i18n('Time is up — returning to the test page.'));
    setTimeout(() => { window.location.href = containerUrl; }, 1200);
  }
  function dock() {
    const slot = document.getElementById('sl-rail-timer');
    const railOpen = !!slot && $('#sl-rail').is(':visible');
    if (railOpen && !docked) {
      $pill.addClass('paper-timer--rail').appendTo(slot);
      docked = true;
    } else if (!railOpen && docked) {
      $pill.removeClass('paper-timer--rail').appendTo(document.body);
      docked = false;
    }
  }
  function updateProgress() {
    const now = Date.now();
    contestTimer.hide();
    dock();
    const live = isHomework ? (now >= beginAt && now < endAt) : (beginAt <= now && now <= endAt);
    if (wasLive && !live) {
      wasLive = false;
      onDeadline();
    } else if (live) wasLive = true;
    if (isHomework) {
      /*
       * Homework: the deadline (penaltySince) first — "Due in …" — then the
       * late window up to the hard end, always amber, then "Closed". Red
       * with the larger face in the last five minutes of either.
       */
      if (now < beginAt) {
        $pill.find('.paper-timer__text').text(i18n('Not started'));
        $pill.removeClass('is-warn is-danger');
      } else if (now < dueAt) {
        NProgress.set((now - beginAt) / Math.max(1, dueAt - beginAt));
        const left = Math.floor((dueAt - now) / 1000);
        $pill.find('.paper-timer__text').text(`${i18n('Due in')} ${formatLeft(left)}`);
        $pill.toggleClass('is-warn', left <= 600 && left > 300).toggleClass('is-danger', left <= 300);
      } else if (now < endAt) {
        NProgress.set((now - dueAt) / Math.max(1, endAt - dueAt));
        const left = Math.floor((endAt - now) / 1000);
        $pill.find('.paper-timer__text').text(`${i18n('Late window')} ${formatLeft(left)}`);
        $pill.toggleClass('is-warn', left > 300).toggleClass('is-danger', left <= 300);
      } else {
        $pill.find('.paper-timer__text').text(i18n('Closed'));
        $pill.removeClass('is-warn').addClass('is-danger');
      }
      return;
    }
    if (beginAt <= now && now <= endAt) {
      NProgress.set((now - beginAt) / (endAt - beginAt));
      const left = Math.floor((endAt - now) / 1000);
      $pill.find('.paper-timer__text').text(formatSeconds(left));
      $pill.toggleClass('is-warn', left <= 600 && left > 300).toggleClass('is-danger', left <= 300);
    } else {
      $pill.find('.paper-timer__text').text(now > endAt ? i18n('Time is up') : i18n('Not started'));
      $pill.removeClass('is-warn').toggleClass('is-danger', now > endAt);
    }
  }
  NProgress.start();
  updateProgress();
  setInterval(updateProgress, 1000);

  addSpeculationRules({
    prerender: [{
      where: {
        or: [
          { href_matches: '/p/*' },
          { href_matches: '/d/*/p/*' },
        ],
      },
    }],
  });
});
