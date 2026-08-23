import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getAvailableLangs, getTheme, i18n, request } from 'vj/utils';

/**
 * AI Studio — list page. Teachers describe a programming task (topic +
 * pasted slide text) and the backend drafts + judge-verifies it. This
 * module renders the draft list and the "new draft" form, and also drops a
 * small entry banner on the problem-create page (which is already
 * teacher-gated, so the banner never shows to students).
 */

const esc = (t) => $('<i>').text(String(t ?? '')).html();
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');

export const AIS_STYLE = [
  '.ais { border: 1px solid #e9e2f9; border-radius: 14px; margin: 16px 0; background: #fff; overflow: hidden; box-shadow: 0 8px 28px rgba(95,61,196,.08); }',
  '.ais__head { display: flex; align-items: center; gap: 10px; padding: 12px 18px; background: linear-gradient(100deg, #7048e8 0%, #845ef7 55%, #b197fc 100%); color: #fff; }',
  '.ais__title { font-weight: bold; font-size: 14.5px; }',
  '.ais__hint { margin-left: auto; font-size: 11.5px; opacity: .92; text-align: right; }',
  '.ais__body { padding: 16px 18px 18px; font-size: 13px; }',
  '.ais__label { font-size: 11.5px; font-weight: bold; letter-spacing: .08em; text-transform: uppercase; color: #8a80b3; margin: 14px 0 6px; }',
  '.ais__label:first-child { margin-top: 0; }',
  '.ais__btn { border: none; border-radius: 18px; padding: 8px 22px; font-size: 13px; color: #fff; cursor: pointer; background: linear-gradient(90deg, #7048e8, #9775fa); box-shadow: 0 3px 12px rgba(112,72,232,.35); transition: filter .12s, transform .12s; }',
  '.ais__btn:hover { filter: brightness(1.08); transform: translateY(-1px); }',
  '.ais__btn:disabled { opacity: .55; cursor: default; transform: none; }',
  '.ais__btn--ghost { background: #fff; color: #7048e8; border: 1px solid #c7b8f5; box-shadow: none; }',
  '.ais__btn--ghost:hover { background: #f6f2ff; filter: none; }',
  '.ais__btn--sm { padding: 4px 14px; font-size: 12px; }',
  '.ais__btn--danger { background: #fff; color: #c2255c; border: 1px solid #f3c1d3; box-shadow: none; }',
  '.ais__btn--danger:hover { background: #fff0f4; filter: none; }',
  '.ais textarea, .ais input[type=text], .ais select { width: 100%; border: 1px solid #d5dbe7; border-radius: 10px; padding: 8px 10px; font-size: 13px; box-sizing: border-box; background: #fff; }',
  '.ais textarea { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px; line-height: 1.5; resize: vertical; }',
  '.ais__row { display: flex; gap: 14px; flex-wrap: wrap; }',
  '.ais__row > div { flex: 1 1 180px; }',
  '.ais__chip { display: inline-block; border-radius: 10px; padding: 2px 10px; font-size: 11.5px; background: #f1ecff; color: #7048e8; }',
  '.ais__badge { display: inline-block; border-radius: 10px; padding: 2px 10px; font-size: 11.5px; font-weight: bold; }',
  '.ais__badge--idle { background: #f1f3f5; color: #666; }',
  '.ais__badge--running { background: #e7f5ff; color: #1c7ed6; animation: ais-breathe 2.4s ease-in-out infinite; }',
  '.ais__badge--passed { background: #ebfbee; color: #2b8a3e; }',
  '.ais__badge--failed { background: #fff0f4; color: #c2255c; }',
  '.ais__badge--published { background: #f3f0ff; color: #7048e8; }',
  '.ais__table { width: 100%; border-collapse: separate; border-spacing: 0; }',
  '.ais__table th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: #8a80b3; padding: 8px 10px; border-bottom: 1px solid #ece7f8; background: #faf9ff; }',
  '.ais__table td { padding: 9px 10px; border-bottom: 1px solid #f1eefb; font-size: 12.5px; }',
  '.ais__table tr:hover td { background: #faf8ff; }',
  '.ais__empty { color: #98a2ac; padding: 10px 2px; font-size: 12.5px; }',
  '.ais__banner { position: relative; display: flex; align-items: center; gap: 12px; border: 1px solid transparent; border-radius: var(--pta-radius-lg); padding: 13px 16px; margin: 0 0 16px; background: linear-gradient(var(--pta-card), var(--pta-card)) padding-box, linear-gradient(120deg, #4dabf7, #845ef7, #4dabf7) border-box; background-size: 100% 100%, 220% 100%; box-shadow: 0 10px 28px -14px rgba(132, 94, 247, .45); font-size: 13.5px; color: var(--pta-ink); overflow: hidden; animation: ptaFadeUp .3s var(--pta-ease) backwards, ptaSheen 9s ease infinite; }',
  '.ais__banner-ic { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; background: var(--pta-grad-violet); color: #fff; font-size: 16px; flex: 0 0 auto; box-shadow: 0 6px 14px -6px rgba(112, 72, 232, .6); }',
  '.ais__banner-text { flex: 1 1 auto; min-width: 0; line-height: 1.5; color: var(--pta-ink-soft); }',
  '.ais__banner-cta { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: #fff !important; text-decoration: none !important; background: linear-gradient(120deg, #4c6ef5, #845ef7); box-shadow: 0 6px 16px -6px rgba(76, 110, 245, .6); transition: filter .12s ease, transform .12s var(--pta-ease), box-shadow .12s ease; }',
  '.ais__banner-cta:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 9px 20px -6px rgba(76, 110, 245, .7); }',
  '.ais__banner-arrow { font-style: normal; transition: transform .15s var(--pta-ease); }',
  '.ais__banner-cta:hover .ais__banner-arrow { transform: translateX(3px); }',
  '@media (max-width: 640px) { .ais__banner { flex-wrap: wrap; } .ais__banner-cta { width: 100%; justify-content: center; } }',
  '.ais__kinds { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 4px 0 12px; }',
  '@media (max-width: 640px) { .ais__kinds { grid-template-columns: 1fr; } }',
  '.ais__kind { display: block; cursor: pointer; margin: 0; position: relative; }',
  '.ais__kind input { position: absolute; opacity: 0; pointer-events: none; }',
  '.ais__kind-body { display: block; border: 1.5px solid var(--pta-line); border-radius: 12px; background: var(--pta-card); padding: 11px 13px; transition: border-color .15s, box-shadow .15s, background .15s, transform .15s var(--pta-ease); }',
  '.ais__kind:hover .ais__kind-body { border-color: var(--pta-violet-line); box-shadow: var(--pta-shadow-hover); transform: translateY(-1px); }',
  '.ais__kind input:checked + .ais__kind-body { border-color: #845ef7; background: var(--pta-violet-soft); box-shadow: 0 4px 16px -8px rgba(112, 72, 232, .5); }',
  '.ais__kind-name { font-weight: bold; font-size: 13.5px; color: var(--pta-ink); display: flex; align-items: center; gap: 7px; }',
  '.ais__kind-desc { display: block; margin-top: 3px; color: var(--pta-ink-soft); font-size: 12px; line-height: 1.45; }',
  '.ais__qts { display: flex; flex-wrap: wrap; gap: 7px; margin: 2px 0 4px; }',
  '.ais__qt { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--pta-violet-line); border-radius: 999px; padding: 4px 12px; font-size: 12px; color: var(--pta-violet-text); background: var(--pta-card); cursor: pointer; user-select: none; transition: background .13s, border-color .13s; }',
  '.ais__qt:hover { background: var(--pta-violet-soft); }',
  '.ais__qt input { accent-color: #845ef7; margin: 0; }',
  '.ais__kindchip { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 6px; font: bold 11px/1 ui-monospace, Consolas, monospace; color: #fff; margin-right: 7px; flex: 0 0 auto; vertical-align: -4px; }',
  '.ais__kindchip--p { background: linear-gradient(120deg, #339af0, #1c7ed6); }',
  '.ais__kindchip--o { background: linear-gradient(120deg, #20c997, #0ca678); }',
  '.ais__drop { border: 2px dashed #cdb9f7; border-radius: 12px; padding: 14px 12px; text-align: center; color: #7a6fae; cursor: pointer; background: #fcfbff; transition: background .15s, border-color .15s; user-select: none; }',
  '.ais__drop:hover, .ais__drop--over { background: #f6f1ff; border-color: #9775fa; }',
  '.ais__drop--busy { opacity: .6; pointer-events: none; }',
  '.ais__drop-main { font-weight: bold; font-size: 12.5px; }',
  '.ais__drop-sub { font-size: 11px; color: #a49ac9; margin-top: 3px; }',
  '.ais__pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }',
  '.ais__pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #e3dcf5; border-radius: 12px; padding: 3px 10px; font-size: 11.5px; background: #faf9ff; }',
  '.ais__pill button { border: none; background: transparent; color: #c2255c; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }',
  '.ais__pill span { color: #8a94a6; font-size: 11px; }',
  '.ais__dd { position: relative; display: inline-block; }',
  '.ais__dd-panel { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; background: #fff; border: 1px solid #e3dcf5; border-radius: 12px; padding: 10px 12px; max-height: 280px; overflow: auto; min-width: 300px; box-shadow: 0 10px 28px rgba(80,60,140,.2); display: grid; grid-template-columns: 1fr 1fr; gap: 4px 14px; }',
  '.ais__dd-panel[hidden] { display: none; }',
  '.ais__dd-panel label { font-size: 12px; white-space: nowrap; cursor: pointer; display: flex; align-items: center; gap: 5px; }',
  '.ais__dd-actions { grid-column: 1 / -1; margin-top: 8px; }',
  '@keyframes ais-flow { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }',
  '@keyframes ais-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .72; } }',
  '@keyframes ais-pulse { 0% { box-shadow: 0 0 0 0 rgba(112, 72, 232, .45); } 70% { box-shadow: 0 0 0 9px rgba(112, 72, 232, 0); } 100% { box-shadow: 0 0 0 0 rgba(112, 72, 232, 0); } }',
  '@keyframes ais-stripes { from { background-position: 0 0; } to { background-position: 28px 0; } }',
  '@keyframes ais-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }',
  '@keyframes ais-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }',
  '.ais { animation: ais-in .28s ease both; }',
  '.ais__head { background: linear-gradient(120deg, #7048e8, #9775fa, #845ef7, #7048e8); background-size: 260% 260%; animation: ais-flow 9s ease infinite; }',
  '.ais__btn { transition: transform .15s ease, box-shadow .15s ease, filter .15s ease; }',
  '.ais__btn:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(112, 72, 232, .28); }',
  '.ais__btn:not(:disabled):active { transform: translateY(0); box-shadow: 0 2px 6px rgba(112, 72, 232, .25); }',
  '.ais__btn:focus-visible { outline: 2px solid #9775fa; outline-offset: 2px; }',
  'input.textbox:focus, .ais textarea:focus, .ais select:focus { border-color: #9775fa; box-shadow: 0 0 0 3px rgba(151, 117, 250, .18); transition: box-shadow .15s ease, border-color .15s ease; }',
  '.ais__drop { transition: background .2s ease, border-color .2s ease, transform .2s ease; }',
  '.ais__drop--over { transform: scale(1.01); }',
  '.ais__row-hover:hover, .ais tbody tr:hover { background: rgba(151, 117, 250, .06); }',
  '.ais__progress { height: 6px; border-radius: 999px; background: rgba(151, 117, 250, .18); overflow: hidden; margin: 8px 0 10px; }',
  '.ais__progress > i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #7048e8, #9775fa); transition: width .6s ease; }',
  '.ais__progress--live > i { background-image: repeating-linear-gradient(45deg, #7048e8 0 10px, #9775fa 10px 20px); background-size: 28px 28px; animation: ais-stripes .9s linear infinite; }',
  '.ais__progress--bad > i { background: linear-gradient(90deg, #e03131, #ff6b6b); }',
  '.ais__msg--live { background: linear-gradient(90deg, #7a6fae 35%, #b197fc 50%, #7a6fae 65%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: ais-shimmer 2.2s linear infinite; }',
  '@media (prefers-reduced-motion: reduce) { .ais, .ais * { animation: none !important; transition: none !important; } }',
  /* dark */
  '.pta-dark .ais { background: #23272c; border-color: #37313f; box-shadow: 0 8px 28px rgba(0,0,0,.4); }',
  '.pta-dark .ais__body { color: #d5dade; }',
  '.pta-dark .ais__label { color: #9d93c9; }',
  '.pta-dark .ais textarea, .pta-dark .ais input[type=text], .pta-dark .ais select { background: #1e2227; border-color: #3a424b; color: #d5dade; }',
  '.pta-dark .ais__btn--ghost { background: #23272c; color: #b197fc; border-color: #5c4a8a; }',
  '.pta-dark .ais__btn--ghost:hover { background: #2c2440; }',
  '.pta-dark .ais__btn--danger { background: #23272c; }',
  '.pta-dark .ais__chip { background: #322a48; color: #cdbdfb; }',
  '.pta-dark .ais__table th { background: #262b31; color: #9d93c9; border-bottom-color: #37313f; }',
  '.pta-dark .ais__table td { border-bottom-color: #2c3238; }',
  '.pta-dark .ais__table tr:hover td { background: #2a2536; }',
  '.pta-dark .ais__empty { color: #7f8b97; }',
  '.pta-dark .ais__banner { box-shadow: 0 12px 30px -14px rgba(0, 0, 0, .65); }',
  '.pta-dark .ais__drop { background: #221f2c; border-color: #4d4070; color: #a99ed0; }',
  '.pta-dark .ais__drop:hover, .pta-dark .ais__drop--over { background: #292339; border-color: #7a5fd0; }',
  '.pta-dark .ais__drop-sub { color: #7f75a8; }',
  '.pta-dark .ais__pill { background: #262b31; border-color: #37313f; }',
  '.pta-dark .ais__dd-panel { background: #23202c; border-color: #4d4070; box-shadow: 0 10px 28px rgba(0,0,0,.5); }',
  '.pta-dark .ais__progress { background: rgba(151, 117, 250, .14); }',
  '.pta-dark .ais__msg--live { background: linear-gradient(90deg, #a99ed0 35%, #d0bfff 50%, #a99ed0 65%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; }',
  '.pta-dark .ais__row-hover:hover, .pta-dark .ais tbody tr:hover { background: rgba(151, 117, 250, .09); }',
  '.pta-dark .ais__badge--idle { background: #2a3036; color: #9aa4ad; }',
  '.pta-dark .ais__badge--running { background: #16283a; color: #4dabf7; }',
  '.pta-dark .ais__badge--passed { background: #1e3524; color: #69db7c; }',
  '.pta-dark .ais__badge--failed { background: #3a1f2c; color: #faa2c1; }',
  '.pta-dark .ais__badge--published { background: #2c2440; color: #d0bdfb; }',
].join('\n');

export function ensureAisStyle() {
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
  if (!document.getElementById('ais-style')) {
    $('<style>').attr('id', 'ais-style').text(AIS_STYLE).appendTo(document.head);
  }
}

const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];

export const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Upload one context file (slides/notes) to a draft; server extracts the text. */
/**
 * Hydro serializes errors as { message: <i18n template>, params: [...] } —
 * for classes like BadRequestError the template is just the class name and
 * the human sentence rides in params. Reassemble whichever shape arrives.
 */
function hydroErrorText(body, status) {
  const err = (body && body.error) || {};
  let msg = String(err.message || '');
  const params = Array.isArray(err.params) ? err.params : [];
  if (/\{\d+\}/.test(msg)) msg = msg.replace(/\{(\d+)\}/g, (_, i) => String(params[+i] ?? ''));
  else if ((!msg || /^[A-Za-z]*Error$/.test(msg)) && params.length) msg = params.join(' ');
  return msg || `Upload failed (HTTP ${status})`;
}

export async function uploadContextFile(url, file) {
  const fd = new FormData();
  fd.append('csrfToken', (window.UiContext || {}).csrfToken || '');
  fd.append('operation', 'uploadContext');
  fd.append('file', file);
  const resp = await fetch(url, { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(hydroErrorText(body, resp.status));
  return body;
}

/** Language options: the server's judge config, same filter as the scratchpad. */
export function langEntries(serverLangs) {
  let langs = serverLangs;
  if (!langs || !Object.keys(langs).length) {
    const avail = getAvailableLangs();
    langs = {};
    for (const k of Object.keys(avail)) langs[k] = avail[k].display || k;
  }
  return langs;
}

const ddLabel = (n) => (n ? `${n} ${i18n('languages selected')}` : i18n('All languages allowed'));

/** Compact multi-select dropdown for language restriction. */
export function renderAllowLangsDd(langsMap, selected, disabled) {
  const sel = new Set(selected || []);
  return `<div class="ais__dd">
    <button type="button" class="ais__btn ais__btn--ghost ais__btn--sm ais__dd-btn" ${disabled ? 'disabled' : ''}>🌐 <span class="ais__dd-label">${esc(ddLabel(sel.size))}</span> ▾</button>
    <div class="ais__dd-panel" hidden>
      ${Object.entries(langsMap).map(([id, disp]) => `<label><input type="checkbox" class="ais__dd-cb" value="${id}" ${sel.has(id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}> ${esc(disp)}</label>`).join('')}
      <div class="ais__dd-actions"><button type="button" class="ais__btn ais__btn--ghost ais__btn--sm ais__dd-clear" ${disabled ? 'disabled' : ''}>${esc(i18n('Clear (allow all)'))}</button></div>
    </div></div>`;
}

export function wireAllowLangsDd($scope, onChange) {
  const $dd = $scope.find('.ais__dd');
  if (!$dd.length) return;
  const $panel = $dd.find('.ais__dd-panel');
  $dd.find('.ais__dd-btn').on('click', (ev) => { ev.stopPropagation(); $panel.prop('hidden', !$panel.prop('hidden')); });
  $panel.on('click', (ev) => ev.stopPropagation());
  $(document).off('click.aisdd').on('click.aisdd', () => $panel.prop('hidden', true));
  const emit = () => {
    const langs = $dd.find('.ais__dd-cb:checked').map(function cv() { return $(this).val(); }).get();
    $dd.find('.ais__dd-label').text(ddLabel(langs.length));
    if (onChange) onChange(langs);
  };
  $dd.find('.ais__dd-cb').on('change', emit);
  $dd.find('.ais__dd-clear').on('click', () => { $dd.find('.ais__dd-cb').prop('checked', false); emit(); });
}

export function langOptionsHtml(serverLangs, selected) {
  const langs = langEntries(serverLangs);
  const keys = Object.keys(langs);
  const sel = selected && keys.includes(selected) ? selected
    : ['cc', 'c', 'py.py3', 'py', 'java'].find((k) => keys.includes(k)) || keys[0];
  return keys.map((k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${$('<i>').text(langs[k]).html()}</option>`).join('');
}

const STATUS_LABEL = {
  idle: 'Draft', running: 'Verifying…', passed: 'Verified', failed: 'Failed',
};

function badge(d) {
  if (d.published) return `<span class="ais__badge ais__badge--published">✓ ${esc(i18n('Published'))}</span>`;
  const cls = `ais__badge--${d.status || 'idle'}`;
  return `<span class="ais__badge ${cls}">${esc(i18n(STATUS_LABEL[d.status] || d.status))}</span>`;
}

function renderList($root, data) {
  const provider = data.provider || {};
  const rows = (data.drafts || []).map((d) => `<tr>`
    + `<td><span class="ais__kindchip ais__kindchip--${d.kind === 'objective' ? 'o' : 'p'}" title="${esc(i18n(d.kind === 'objective' ? 'Objective task' : 'Programming task'))}">${d.kind === 'objective' ? 'O' : 'P'}</span><b>${esc(d.title || d.topic)}</b></td>`
    + `<td>${d.kind === 'objective' ? '—' : `<span class="ais__chip">${esc(d.language)}</span>`}</td>`
    + `<td>${esc(i18n(d.difficulty))}</td>`
    + `<td>${badge(d)}</td>`
    + `<td>${esc(fmtTs(d.updateAt))}</td>`
    + `<td><a class="ais__btn ais__btn--ghost ais__btn--sm" href="${domainPrefix()}/ai-studio/${d._id}">${esc(i18n('Open'))}</a></td>`
    + '</tr>').join('');
  $root.html(`
    <div class="ais">
      <div class="ais__head">✨ <span class="ais__title">${esc(i18n('AI Studio — Programming Tasks'))}</span>
        <span class="ais__hint">${esc(i18n('Model'))}: ${esc(provider.provider || '?')} / ${esc(provider.model || '?')}</span></div>
      <div class="ais__body">
        <div class="ais__label">🧠 ${esc(i18n('New draft'))}</div>
        <div class="ais__label" style="text-transform:none;letter-spacing:0;font-weight:normal;">${esc(i18n('Describe the task you want and attach the relevant slides below. The AI drafts the statement, solutions and tests — then the judge verifies everything before you can publish.'))}</div>
        <div class="ais__label">${esc(i18n('What kind of task?'))}</div>
        <div class="ais__kinds">
          <label class="ais__kind"><input type="radio" name="ais-kind" value="programming" checked>
            <span class="ais__kind-body"><span class="ais__kind-name">💻 ${esc(i18n('Programming task'))}</span>
            <span class="ais__kind-desc">${esc(i18n('Statement + reference solution + tests — the judge verifies everything in the sandbox before publishing.'))}</span></span></label>
          <label class="ais__kind"><input type="radio" name="ais-kind" value="objective">
            <span class="ais__kind-body"><span class="ais__kind-name">📝 ${esc(i18n('Objective task'))}</span>
            <span class="ais__kind-desc">${esc(i18n('Auto-graded quiz — true/false, choice, fill-in-the-blank — generated together with its answer key.'))}</span></span></label>
        </div>
        <textarea class="ais__topic" rows="2" placeholder="${esc(i18n('e.g. A problem practicing prefix sums, based on the attendance example from today\'s lecture'))}"></textarea>
        <div class="ais__row" style="margin-top:10px;">
          <div class="ais__prog-only"><div class="ais__label">${esc(i18n('Language'))}</div>
            <select class="ais__lang">${langOptionsHtml(data.langs)}</select></div>
          <div><div class="ais__label">${esc(i18n('Difficulty'))}</div>
            <select class="ais__diff"><option value="intro">${esc(i18n('intro'))}</option><option value="medium">${esc(i18n('medium'))}</option><option value="challenge">${esc(i18n('challenge'))}</option></select></div>
          <div class="ais__prog-only"><div class="ais__label">${esc(i18n('Cross-check'))}</div>
            <select class="ais__cross"><option value="1">${esc(i18n('On (recommended)'))}</option><option value="0">${esc(i18n('Off'))}</option></select></div>
          <div class="ais__prog-only" style="min-width:230px;"><div class="ais__label">${esc(i18n('Allowed languages for students'))}</div>
            ${renderAllowLangsDd(langEntries(data.langs), [], false)}
            <div class="aisd__meta">${esc(i18n('Empty = every judge language.'))}</div></div>
        </div>
        <div class="ais__obj-only" hidden>
          <div class="ais__label">${esc(i18n('Question types (optional — the AI mixes them sensibly)'))}</div>
          <div class="ais__qts">
            ${[['tf', 'True / False'], ['single', 'Single choice'], ['multi', 'Multiple choice'], ['fill', 'Fill in the blank'], ['dropdown', 'Dropdown'], ['short', 'Short answer']]
    .map(([v, lb]) => `<label class="ais__qt"><input type="checkbox" class="ais__qt-cb" value="${v}"> ${esc(i18n(lb))}</label>`).join('')}
          </div>
        </div>
        <div class="ais__label">📚 ${esc(i18n('Context files (slides, notes)'))}</div>
        <div class="ais__drop">
          <div class="ais__drop-main">${esc(i18n('Drop the course files here, or click to choose'))}</div>
          <div class="ais__drop-sub">${esc(i18n('Slides, documents, spreadsheets, PDFs, notebooks and source code (.pptx .docx .xlsx .pdf .txt .ipynb .py .cpp …) · legacy .doc / .ppt / .xls are read best-effort · up to 8 files · 15 MB each. Text is extracted on upload; the original files are not stored.'))}</div>
        </div>
        <input type="file" class="ais__pick" multiple style="display:none">
        <div class="ais__pills"></div>
        <div class="ais__label">🧷 ${esc(i18n('Extra requirements (optional)'))}</div>
        <textarea class="ais__notes" rows="3" placeholder="${esc(i18n('e.g. must use a loop and no arrays; write the statement in English'))}"></textarea>
        <div style="margin-top:12px;"><button type="button" class="ais__btn ais__create">✨ ${esc(i18n('Create draft'))}</button></div>
        <div class="ais__label" style="margin-top:22px;">🗂 ${esc(i18n('My drafts'))}</div>
        ${rows ? `<table class="ais__table"><tr><th>${esc(i18n('Title / Topic'))}</th><th>${esc(i18n('Language'))}</th><th>${esc(i18n('Difficulty'))}</th><th>${esc(i18n('Status'))}</th><th>${esc(i18n('Updated'))}</th><th></th></tr>${rows}</table>`
    : `<div class="ais__empty">${esc(i18n('No drafts yet.'))}</div>`}
      </div>
    </div>`);
  let allowSel = [];
  wireAllowLangsDd($root, (langs) => { allowSel = langs; });
  const OBJ_PLACEHOLDER = i18n("e.g. A 6-question check-in quiz on loops and conditionals, based on this week's slides");
  const PROG_PLACEHOLDER = i18n('e.g. A problem practicing prefix sums, based on the attendance example from today\'s lecture');
  $root.find('input[name="ais-kind"]').on('change', function onKind() {
    const isObj = $root.find('input[name="ais-kind"]:checked').val() === 'objective';
    $root.find('.ais__prog-only').toggle(!isObj);
    $root.find('.ais__obj-only').prop('hidden', !isObj);
    $root.find('.ais__topic').attr('placeholder', isObj ? OBJ_PLACEHOLDER : PROG_PLACEHOLDER);
  });

  const pending = []; // File objects picked before the draft exists
  const $pills = $root.find('.ais__pills');
  const renderPills = () => {
    $pills.html(pending.map((f, i) => `<span class="ais__pill">📄 ${esc(f.name)} <span class="aisd__meta">${fmtSize(f.size)}</span><button type="button" data-i="${i}" title="${esc(i18n('Remove'))}">×</button></span>`).join(''));
  };
  $pills.on('click', 'button', function onRm() {
    pending.splice(+$(this).data('i'), 1);
    renderPills();
  });
  const addFiles = (list) => {
    for (const f of Array.from(list || [])) {
      if (f.size > 15 * 1024 * 1024) Notification.error(`${f.name}: ${i18n('The file exceeds the 15 MB limit.')}`);
      else if (pending.length >= 8) Notification.warn(i18n('At most 8 context files.'));
      else pending.push(f);
    }
    renderPills();
  };
  const $drop = $root.find('.ais__drop');
  const $pick = $root.find('.ais__pick');
  $drop.on('click', () => $pick.trigger('click'));
  $pick.on('change', function onPick() { addFiles(this.files); this.value = ''; });
  $drop.on('dragenter dragover', (ev) => { ev.preventDefault(); $drop.addClass('ais__drop--over'); });
  $drop.on('dragleave drop', (ev) => { ev.preventDefault(); $drop.removeClass('ais__drop--over'); });
  $drop.on('drop', (ev) => {
    const dt = ev.originalEvent && ev.originalEvent.dataTransfer;
    if (dt?.files?.length) addFiles(dt.files);
  });

  $root.find('.ais__create').on('click', async function onCreate() {
    const topic = String($root.find('.ais__topic').val() || '').trim();
    if (!topic) {
      Notification.warn(i18n('Please describe the task first.'));
      return;
    }
    const $b = $(this).prop('disabled', true);
    try {
      let kind = $root.find('input[name="ais-kind"]:checked').val() || 'programming';
      const smellsObjective = /single[- ]?choice|multiple[- ]?choice|true[/ ]?(?:or )?false|fill[- ]?in[- ]?the[- ]?blank|\bquiz(?:zes)?\b|\bmcqs?\b|判断题|选择题|填空题|单选|多选|小测|测验|問答題|選擇題|判斷題|填空題|單選|多選/i.test(topic);
      if (kind === 'programming' && smellsObjective
        && window.confirm(i18n('This requirement sounds like an objective quiz. Create it as an OBJECTIVE task instead? (OK = objective task, Cancel = keep programming)'))) {
        kind = 'objective';
        $root.find('input[name="ais-kind"][value="objective"]').prop('checked', true).trigger('change');
      }
      const qtypes = $root.find('.ais__qt-cb:checked').map(function qv() { return $(this).val(); }).get();
      const res = await request.post(window.location.pathname, {
        operation: 'create',
        kind,
        topic,
        language: $root.find('.ais__lang').val(),
        difficulty: $root.find('.ais__diff').val(),
        crosscheck: $root.find('.ais__cross').val() === '1',
        notes: String($root.find('.ais__notes').val() || ''),
        ...(kind === 'programming' ? { allowLangs: allowSel.join(',') } : { qtypes: qtypes.join(',') }),
      });
      const url = res.url || `${domainPrefix()}/ai-studio/${res.id}`;
      for (let k = 0; k < pending.length; k++) {
        $b.text(`${i18n('Uploading context')} ${k + 1}/${pending.length}…`);
        try {
          await uploadContextFile(url, pending[k]); // eslint-disable-line no-await-in-loop
        } catch (e) {
          Notification.error(`${pending[k].name}: ${e.message}`);
        }
      }
      window.location.href = url;
    } catch (e) {
      Notification.error(e.message);
      $b.prop('disabled', false).text(`✨ ${i18n('Create draft')}`);
    }
  });
}

export default new NamedPage(['ai_studio', 'problem_create'], (pagename) => {
  ensureAisStyle();
  if (pagename === 'problem_create') {
    // Entry banner on the (already teacher-gated) create-problem page.
    const $host = $('.medium-9.columns, .medium-12.columns').first();
    if ($host.length && !document.getElementById('ais-entry')) {
      $host.prepend(`<div class="ais__banner" id="ais-entry">
        <span class="ais__banner-ic" aria-hidden="true">✨</span>
        <span class="ais__banner-text">${esc(i18n('Creating a programming task? Let the AI draft it from your slides — the judge verifies everything before publishing.'))}</span>
        <a class="ais__banner-cta" href="${domainPrefix()}/ai-studio">${esc(i18n('Open AI Studio'))} <i class="ais__banner-arrow">→</i></a></div>`);
    }
    return;
  }
  const $root = $('#ais-root');
  request.get(window.location.pathname)
    .then((data) => renderList($root, data))
    .catch((e) => $root.html(`<div class="ais"><div class="ais__body"><div class="ais__empty">⚠ ${esc(e.message)}</div></div></div>`));
});
