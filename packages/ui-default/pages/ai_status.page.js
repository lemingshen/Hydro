/*
 * PTA fork — AI STATUS CARD (ai-speedup WP6).
 *
 * On /manage/setting, right under the "AI Tutor" heading, a live card that
 * refreshes every 5 s from GET /ai/status (root only): slots in use per
 * lane, the queue by priority class, per-feature p50 / p95 service time and
 * time-to-first-token, the provider cache-hit rate, refusals, 429s and
 * timeouts of the retained hours. It stops refreshing while the tab is
 * hidden and resumes on focus.
 */
import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

const esc = (t) => $('<i>').text(String(t ?? '')).html();
const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];

const STYLE = `
.ais { margin: 8px 0 18px; border: 1px solid var(--pta-line, #e8ecf4); border-radius: 12px; background: var(--pta-card, #fff); padding: 12px 14px; font-size: 12.5px; }
.ais__head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.ais__title { font-weight: 700; font-size: 13.5px; }
.ais__dot { width: 9px; height: 9px; border-radius: 50%; background: #40c057; }
.ais__dot--off { background: #adb5bd; }
.ais__dot--hot { background: #f59f00; }
.ais__muted { color: var(--pta-ink-faint, #7c8aa3); }
.ais__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 10px; }
.ais__stat { border-radius: 9px; background: var(--pta-card-2, #f7f9fc); padding: 8px 10px; }
.ais__stat b { display: block; font-size: 17px; font-variant-numeric: tabular-nums; }
.ais__bar { height: 6px; border-radius: 3px; background: var(--pta-line, #e8ecf4); overflow: hidden; margin-top: 5px; }
.ais__bar i { display: block; height: 100%; background: #4dabf7; }
.ais__bar i.bg { background: #9775fa; }
.ais table { width: 100%; border-collapse: collapse; }
.ais th, .ais td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--pta-line, #e8ecf4); font-variant-numeric: tabular-nums; }
.ais th { font-weight: 600; color: var(--pta-ink-soft, #5b6b85); }
.ais td.num, .ais th.num { text-align: right; }
.ais__queue { display: inline-flex; gap: 4px; }
.ais__queue span { padding: 1px 6px; border-radius: 999px; background: var(--pta-card-2, #f7f9fc); }
.ais__foot { margin-top: 8px; display: flex; gap: 14px; flex-wrap: wrap; }
`;

const ms = (v) => (v === null || v === undefined ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const pct = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
const n = (v) => (v === null || v === undefined ? '–' : String(v));

function render($card, data) {
  const s = data.scheduler || {};
  const m = data.metrics || {};
  const total = m.total || {};
  const run = s.running || { total: 0, interactive: 0, background: 0 };
  const q = s.queued || { interactive: [0, 0, 0, 0], background: [0, 0, 0, 0], total: 0, users: 0 };
  const feats = (m.features || []).filter((f) => f.calls);
  const bgLimit = Math.max(1, Math.min(s.backgroundMax || 1, (s.effectiveSlots || s.slots || 1) - (s.interactiveReserve || 0)));
  const cacheable = feats.reduce((a, f) => a + f.tokensIn + f.cacheRead + f.cacheWrite, 0);
  const cacheHit = cacheable ? feats.reduce((a, f) => a + f.cacheRead, 0) / cacheable : null;
  const dot = !s.enabled ? 'ais__dot--off' : (run.total >= (s.effectiveSlots || s.slots || 1) ? 'ais__dot--hot' : '');
  $card.html(`
    <div class="ais__head">
      <span class="ais__dot ${dot}"></span>
      <span class="ais__title">${esc(i18n('AI status'))}</span>
      <span class="ais__muted">${esc(s.enabled ? i18n('scheduler on') : i18n('scheduler off (direct calls)'))} · ${esc(data.streaming ? i18n('streaming on') : i18n('streaming off'))} · ${esc(i18n('refreshes every 5 s'))}</span>
    </div>
    <div class="ais__grid">
      <div class="ais__stat"><span class="ais__muted">${esc(i18n('Slots in use'))}</span><b>${run.total} / ${n(s.effectiveSlots || s.slots)}</b>
        <span class="ais__muted">${s.adaptive ? `${esc(i18n('adaptive'))} ${n(s.slots)}–${n(s.slotsMax)}` : esc(i18n('fixed'))}</span>
        <div class="ais__bar"><i style="width:${Math.min(100, (run.total / Math.max(1, s.effectiveSlots || s.slots || 1)) * 100)}%"></i></div></div>
      <div class="ais__stat"><span class="ais__muted">${esc(i18n('Interactive'))}</span><b>${run.interactive}</b>
        <span class="ais__muted">${esc(i18n('reserve'))} ${n(s.interactiveReserve)}</span></div>
      <div class="ais__stat"><span class="ais__muted">${esc(i18n('Background'))}</span><b>${run.background} / ${bgLimit}</b>
        <div class="ais__bar"><i class="bg" style="width:${Math.min(100, (run.background / bgLimit) * 100)}%"></i></div></div>
      <div class="ais__stat"><span class="ais__muted">${esc(i18n('Queued'))}</span><b>${q.total}</b>
        <span class="ais__muted">${q.users} ${esc(i18n('students waiting'))}</span></div>
      <div class="ais__stat"><span class="ais__muted">${esc(i18n('Cache hit rate'))}</span><b>${pct(cacheHit)}</b>
        <span class="ais__muted">${esc(i18n('of prefix tokens'))}</span></div>
      <div class="ais__stat"><span class="ais__muted">${esc(i18n('Refusals / 429 / timeouts'))}</span><b>${n(total.refusals)} / ${n(total.rateLimits)} / ${n(total.timeouts)}</b>
        <span class="ais__muted">${esc(i18n('last 24 h'))}${s.cooldownMs ? ` · ${esc(i18n('cool-down'))} ${Math.ceil(s.cooldownMs / 1000)} s` : ''}</span></div>
    </div>
    <div style="margin-bottom:8px">
      <span class="ais__muted">${esc(i18n('Queue by class (interactive)'))}</span>
      <span class="ais__queue">${(q.interactive || []).map((c, i) => `<span title="class ${i}">${c}</span>`).join('')}</span>
      &nbsp; <span class="ais__muted">${esc(i18n('(background)'))}</span>
      <span class="ais__queue">${(q.background || []).map((c, i) => `<span title="class ${i}">${c}</span>`).join('')}</span>
    </div>
    ${feats.length ? `<table>
      <thead><tr><th>${esc(i18n('Feature'))}</th><th class="num">${esc(i18n('calls'))}</th><th class="num">${esc(i18n('in flight'))}</th><th class="num">${esc(i18n('errors'))}</th><th class="num">${esc(i18n('wait p50'))}</th><th class="num">${esc(i18n('service p50'))}</th><th class="num">${esc(i18n('service p95'))}</th><th class="num">${esc(i18n('first token'))}</th><th class="num">${esc(i18n('cache'))}</th><th class="num">${esc(i18n('tokens in / out'))}</th></tr></thead>
      <tbody>${feats.map((f) => {
        const sf = (s.features || {})[f.feature] || {};
        return `<tr><td>${esc(f.feature)}</td><td class="num">${f.calls}</td><td class="num">${sf.inflight || 0}${sf.cap ? ` / ${sf.cap}` : ''}</td><td class="num">${f.errors}</td><td class="num">${ms(f.waitP50)}</td><td class="num">${ms(f.serviceP50)}</td><td class="num">${ms(f.serviceP95)}</td><td class="num">${ms(f.ttftP50)}</td><td class="num">${pct(f.cacheHitRate)}</td><td class="num">${f.tokensIn + f.cacheRead} / ${f.tokensOut}</td></tr>`;
      }).join('')}</tbody></table>` : `<div class="ais__muted">${esc(i18n('No AI calls in this process yet.'))}</div>`}
    <div class="ais__foot ais__muted">
      <span>${esc(i18n('Live streams'))}: ${n(data.streams)}</span>
      <span>${esc(i18n('Single-flight keys'))}: ${n(s.singleFlight)}</span>
      <span>${esc(i18n('Updated'))}: ${esc(new Date(data.at || Date.now()).toLocaleTimeString())}</span>
    </div>`);
}

export default new NamedPage('manage_setting', () => {
  const $heading = $('#setting_ai_tutor');
  if (!$heading.length) return;
  $('<style>').text(STYLE).appendTo(document.head);
  const $card = $('<div class="ais"></div>');
  $heading.closest('.section__header').after($card);
  let timer = null;
  const tick = async () => {
    try {
      render($card, await request.get(`${domainPrefix()}/ai/status`));
    } catch (e) {
      $card.html(`<div class="ais__head"><span class="ais__dot ais__dot--off"></span><span class="ais__title">${esc(i18n('AI status'))}</span><span class="ais__muted">${esc(e.message)}</span></div>`);
    }
  };
  const start = () => {
    if (timer) return;
    tick();
    timer = setInterval(tick, 5000);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  start();
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
});
