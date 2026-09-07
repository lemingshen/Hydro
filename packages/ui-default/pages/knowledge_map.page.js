/*
 * PTA fork: the PERSONAL KNOWLEDGE MAP page (/knowledge-map) and its
 * teacher-facing class twin (/knowledge-map/class).
 *
 * Both render entirely from the JSON twin of their own URL — the backend
 * ships an inline template shell only (handler/knowledge.ts), so everything
 * below is the actual view.
 *
 * Two deliberate presentation choices, because this page is shown to the
 * student it describes:
 *
 *  • NEXT STEPS COME FIRST, the full tree second. A learner opening this
 *    wants "what do I do now", not an audit of their weaknesses; the tree
 *    is the evidence behind the answer, not the answer.
 *  • CONFIDENCE IS ALWAYS VISIBLE. A state derived from one inferred data
 *    point and one derived from a graded tutor dialogue look different on
 *    screen, because they mean different things. Hiding that would make
 *    the map claim precision it does not have.
 */
import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

const STATES = ['mastered', 'resolving', 'exposed', 'shaky', 'untouched'];
const STATE_LABEL = {
  mastered: 'Mastered',
  resolving: 'Resolving',
  exposed: 'Exposed',
  shaky: 'Needs work',
  untouched: 'Not started',
};
const STATE_ICON = {
  mastered: '●', resolving: '◐', exposed: '○', shaky: '▲', untouched: '·',
};

function esc(text) {
  return $('<i>').text(String(text == null ? '' : text)).html();
}

/**
 * Every link on this page must survive being served from a DOMAIN prefix
 * (/d/<domain>/knowledge-map). Relative hrefs do not: the browser resolves
 * "../p/1" against /d/<domain>/ and lands on /d/p/1. Build absolute paths
 * from the prefix instead, the way trajectoryUrl() does in auto_scratchpad.
 */
function domainPrefix() {
  return (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
}
const problemUrl = (docId) => `${domainPrefix()}/p/${docId}`;
/** The class table links OUT to the per-student page, not back to itself. */
const studentMapUrl = (uid) => `${domainPrefix()}/knowledge-map?uid=${uid}`;
/*
 * The class board had no entry point anywhere in the UI — it was reachable
 * only by typing the URL. Staff get a link to it from their own map.
 */
const classMapUrl = () => `${domainPrefix()}/knowledge-map/class`;

const STYLE = `
.km { display: flex; flex-direction: column; gap: 16px; }
.km__card { background: var(--pta-card, #fff); border: 1px solid var(--pta-line, #e8ecf4); border-radius: 14px; box-shadow: var(--pta-shadow, 0 6px 18px -12px rgba(15,23,42,.3)); overflow: hidden; }
.km__head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--pta-line, #e8ecf4); font-weight: 600; color: var(--pta-ink, #33415c); }
.km__head .km__sub { font-weight: 400; font-size: 12px; color: var(--pta-ink-soft, #7d8aa3); margin-left: auto; }
.km__body { padding: 14px 16px; }
.km__legend { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--pta-line, #e8ecf4); font-size: 12px; }
.km__chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--pta-line, #dfe5ef); color: var(--pta-ink-soft, #5b6b85); background: var(--pta-card-2, #fbfcfe); }
.km__chip.mastered { border-color: #a9e0b8; background: #f0fbf3; color: #2f7d43; }
.km__chip.resolving { border-color: #a5d0f7; background: #eef6fe; color: #1864ab; }
.km__chip.exposed { border-color: #dfe5ef; }
.km__chip.shaky { border-color: #ffc9c9; background: #fff5f5; color: #c92a2a; }
.km__chip.untouched { opacity: .7; }
.pta-dark .km__chip.mastered { border-color: #2c6b3c; background: #14251a; color: #6ecf8a; }
.pta-dark .km__chip.resolving { border-color: #2b74b8; background: #14202c; color: #8fc6ff; }
.pta-dark .km__chip.shaky { border-color: #6e3038; background: #251518; color: #ff9d9d; }

/* ---- next steps ---- */
.km__next { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.km__step { border: 1px solid var(--pta-line, #e8ecf4); border-left: 4px solid #adb5bd; border-radius: 12px; padding: 12px 13px; background: var(--pta-card-2, #fbfcfe); }
.km__step.shaky { border-left-color: #e03131; }
.km__step.resolving { border-left-color: #1c7ed6; }
.km__step.exposed { border-left-color: #868e96; }
.km__step h4 { margin: 0 0 3px; font-size: 14px; color: var(--pta-ink, #33415c); }
.km__step .km__path { font-size: 11px; color: var(--pta-ink-faint, #93a0b5); margin-bottom: 6px; }
.km__step .km__reason { font-size: 12.5px; color: var(--pta-ink-soft, #5b6b85); line-height: 1.5; margin-bottom: 9px; }
.km__tasks { display: flex; flex-wrap: wrap; gap: 6px; }
.km__task { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid #a5d0f7; color: #1864ab; background: #f4f9ff; text-decoration: none; }
.km__task:hover { background: #e7f2fd; color: #1864ab; }
.pta-dark .km__task { border-color: #2b74b8; background: #16222f; color: #8fc6ff; }
.km__conf { font-size: 11px; color: var(--pta-ink-faint, #93a0b5); margin-top: 8px; }
.km__conf i { display: inline-block; width: 46px; height: 4px; border-radius: 999px; background: #e8ecf4; vertical-align: middle; margin: 0 5px; position: relative; overflow: hidden; }
.km__conf i b { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #4dabf7, #1c7ed6); }

/* ---- tree ---- */
.km__tree { font-size: 13px; }
.km__row { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 9px; }
.km__row:hover { background: var(--pta-card-3, #f6f8fc); }
.km__row .km__dot { flex: 0 0 auto; width: 16px; text-align: center; font-size: 12px; }
.km__row.mastered .km__dot { color: #2f9e44; }
.km__row.resolving .km__dot { color: #1c7ed6; }
.km__row.shaky .km__dot { color: #e03131; }
.km__row.exposed .km__dot { color: #868e96; }
.km__row.untouched .km__dot { color: #ced4da; }
.km__row .km__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pta-ink, #33415c); }
.km__row.untouched .km__name { color: var(--pta-ink-faint, #adb5bd); }
.km__row .km__meta { flex: 0 0 auto; font-size: 11px; color: var(--pta-ink-faint, #93a0b5); }
.km__why { margin: 0 8px 8px 33px; padding: 9px 11px; border-left: 2px solid var(--pta-line, #e8ecf4); font-size: 12px; color: var(--pta-ink-soft, #5b6b85); }
.km__why ul { margin: 4px 0 0; padding-left: 16px; }
.km__why li { margin: 2px 0; line-height: 1.45; }
.km__toggle { cursor: pointer; }

/* ---- class view ---- */
.km__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.km__table th, .km__table td { padding: 8px 10px; border-bottom: 1px solid var(--pta-line, #eef1f6); text-align: left; }
.km__table th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--pta-ink-faint, #93a0b5); }
.km__bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: #eef1f6; min-width: 120px; }
.km__bar span { display: block; height: 100%; }
.km__bar .s-mastered { background: #40c057; }
.km__bar .s-resolving { background: #4dabf7; }
.km__bar .s-exposed { background: #ced4da; }
.km__bar .s-shaky { background: #ff6b6b; }
.km__empty { padding: 22px; text-align: center; color: var(--pta-ink-faint, #93a0b5); }
.km__btn { border: none; border-radius: 999px; padding: 6px 14px; font-size: 12.5px; font-weight: 600; color: #fff; cursor: pointer; background: linear-gradient(120deg, #4dabf7, #1c7ed6); }
.km__btn:disabled { opacity: .6; cursor: default; }

/* ---- problem-set sidebar panel ---- */
.km__sidenote { font-size: 12.5px; line-height: 1.5; color: var(--pta-ink-soft, #5b6b85); margin: 0 0 8px; }
.km__siderow { padding: 7px 0; border-bottom: 1px solid var(--pta-line, #eef1f6); }
.km__siderow:last-of-type { border-bottom: none; }
.km__sidename { font-size: 12.5px; color: var(--pta-ink, #33415c); margin-bottom: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.km__sidename.shaky { color: #c92a2a; }
.km__sidename.resolving { color: #1864ab; }
.km__sidelink { display: inline-block; margin-top: 9px; font-size: 12.5px; }
`;

function ensureStyle() {
  if (document.getElementById('km-style')) return;
  $('<style>').attr('id', 'km-style').text(STYLE).appendTo(document.head);
  if (document.documentElement.classList.contains('theme--dark')) document.documentElement.classList.add('pta-dark');
}

const confBar = (c) => `<span class="km__conf">${esc(i18n('confidence'))}<i><b style="width:${Math.round((c || 0) * 100)}%"></b></i>${Math.round((c || 0) * 100)}%</span>`;

/* --------------------------------- student --------------------------------- */

function renderNext(map) {
  const next = (map && map.next) || [];
  if (!next.length) {
    return `<div class="km__empty">${esc(i18n('Nothing to recommend yet — solve a few tasks and this will fill in.'))}</div>`;
  }
  return `<div class="km__next">${next.map((n) => `
    <div class="km__step ${esc(n.state)}">
      <h4>${esc(n.name)}</h4>
      ${n.path && n.path.length > 1 ? `<div class="km__path">${esc(n.path.slice(0, -1).join(' › '))}</div>` : ''}
      <div class="km__reason">${esc(n.reason)}</div>
      <div class="km__tasks">${(n.tasks || []).map((t) => `<a class="km__task" href="${esc(problemUrl(t.docId))}" title="${esc(t.title)}">${esc(t.pid)}${typeof t.difficulty === 'number' ? ` · ${esc(t.difficulty)}/10` : ''}</a>`).join('')}</div>
      ${confBar(n.confidence)}
    </div>`).join('')}</div>`;
}

/**
 * The catalog as a tree. `path` already carries the ancestor names root
 * first, so indentation needs no second pass over the data.
 */
function renderTree(map, showUntouched) {
  const points = ((map && map.points) || [])
    .filter((p) => showUntouched || p.state !== 'untouched')
    .sort((a, b) => (a.path.join(' › ') || a.name).localeCompare(b.path.join(' › ') || b.name));
  if (!points.length) {
    return `<div class="km__empty">${esc(i18n('No knowledge points recorded for this domain yet.'))}</div>`;
  }
  return `<div class="km__tree">${points.map((p, i) => {
    const indent = Math.max(0, (p.depth || 0)) * 16;
    const meta = p.tasks && p.tasks.total
      ? `${p.tasks.solved}/${p.tasks.total} ${i18n('solved')}`
      : '';
    return `<div class="km__row ${esc(p.state)} km__toggle" data-i="${i}" style="padding-left:${8 + indent}px">
        <span class="km__dot" title="${esc(i18n(STATE_LABEL[p.state] || p.state))}">${STATE_ICON[p.state] || '·'}</span>
        <span class="km__name">${esc(p.name)}</span>
        <span class="km__meta">${esc(meta)}</span>
      </div>
      <div class="km__why" data-why="${i}" hidden>
        ${p.evidence && p.evidence.length
    ? `<b>${esc(i18n('Why'))}</b><ul>${p.evidence.map((e) => `<li>${e.polarity > 0 ? '✔' : '✘'} ${esc(e.note || e.kind)}${e.label ? ` <small>(${esc(e.label)})</small>` : ''}</li>`).join('')}</ul>`
    : esc(i18n('No evidence recorded for this point yet.'))}
        ${confBar(p.confidence)}
      </div>`;
  }).join('')}</div>`;
}

function renderStudent($root, data) {
  const map = data.map || {};
  const s = map.stats || {};
  const counts = STATES.map((k) => `<span class="km__chip ${k}">${STATE_ICON[k]} ${esc(i18n(STATE_LABEL[k]))} ${s[k] || 0}</span>`).join('');
  const stale = map.computedAt ? new Date(map.computedAt).toLocaleString() : '-';
  $root.html(`<div class="km">
    <div class="km__card">
      <div class="km__head">🗺 ${esc(data.self ? i18n('Your knowledge map') : i18n('Knowledge map of {0}').replace('{0}', data.uname))}
        <span class="km__sub">${esc(i18n('Updated'))}: ${esc(stale)}${s.llmCalls ? ` · ${s.llmCalls} ${esc(i18n('AI lookups'))}` : ''}</span>
      </div>
      <div class="km__legend">${counts}</div>
      <div class="km__body">
        <button type="button" class="km__btn km__refresh">↻ ${esc(i18n('Rebuild map'))}</button>
        ${data.isStaff ? `<a class="km__sidelink" style="margin-left:12px" href="${esc(classMapUrl())}">👥 ${esc(i18n('Class knowledge map'))} →</a>` : ''}
      </div>
    </div>
    <div class="km__card">
      <div class="km__head">🎯 ${esc(i18n('Practise next'))}</div>
      <div class="km__body">${renderNext(map)}</div>
    </div>
    <div class="km__card">
      <div class="km__head">📚 ${esc(i18n('All knowledge points'))}
        <span class="km__sub"><label><input type="checkbox" class="km__showall"> ${esc(i18n('Show not-started'))}</label></span>
      </div>
      <div class="km__body">${renderTree(map, false)}</div>
    </div>
  </div>`);

  $root.find('.km__toggle').on('click', function onToggle() {
    const i = $(this).attr('data-i');
    $root.find(`[data-why="${i}"]`).each((_, el) => { el.hidden = !el.hidden; });
  });
  $root.find('.km__showall').on('change', function onShowAll() {
    const show = $(this).is(':checked');
    $(this).closest('.km__card').find('.km__body').html(renderTree(map, show));
    $root.find('.km__toggle').off('click').on('click', function onToggle2() {
      const i = $(this).attr('data-i');
      $root.find(`[data-why="${i}"]`).each((_, el) => { el.hidden = !el.hidden; });
    });
  });
  $root.find('.km__refresh').on('click', async function onRefresh() {
    const $b = $(this);
    $b.prop('disabled', true).text(i18n('Rebuilding...'));
    try {
      const fresh = await request.get(`${window.location.pathname}?refresh=true${data.self ? '' : `&uid=${data.uid}`}`);
      renderStudent($root, fresh);
      Notification.success(i18n('Knowledge map rebuilt.'));
    } catch (e) {
      Notification.error(e.message);
      $b.prop('disabled', false).text(`↻ ${i18n('Rebuild map')}`);
    }
  });
}

/* ---------------------------------- class ---------------------------------- */

function renderClass($root, data) {
  const rows = (data.students || []).map((st) => {
    const s = st.stats || {};
    const total = Math.max(1, (s.mastered || 0) + (s.resolving || 0) + (s.exposed || 0) + (s.shaky || 0));
    const seg = (k) => `<span class="s-${k}" style="width:${Math.round(((s[k] || 0) / total) * 100)}%"></span>`;
    return `<tr>
      <td><a href="${esc(studentMapUrl(st.uid))}">${esc(st.uname)}</a></td>
      <td>${st.built
    ? `<div class="km__bar">${seg('mastered')}${seg('resolving')}${seg('exposed')}${seg('shaky')}</div>`
    : `<span class="km__chip untouched">${esc(i18n('Not built'))}</span>`}</td>
      <td>${st.built ? esc(String(s.shaky || 0)) : '-'}</td>
      <td>${esc((st.top || []).join(', '))}</td>
    </tr>`;
  }).join('');
  $root.html(`<div class="km">
    <div class="km__card">
      <div class="km__head">🗺 ${esc(i18n('Class knowledge map'))}
        <span class="km__sub">${esc(i18n('Built'))}: ${esc(data.built)} / ${esc(data.total)}</span>
      </div>
      <div class="km__body">
        <button type="button" class="km__btn km__build">⚙ ${esc(i18n('Build missing maps'))}</button>
        <a class="km__sidelink" style="margin-left:12px" href="${esc(domainPrefix())}/knowledge-map">← ${esc(i18n('Your knowledge map'))}</a>
        <span class="km__conf">${esc(i18n('Maps are built in batches; press again to continue.'))}</span>
      </div>
    </div>
    <div class="km__card">
      <div class="km__head">⚠ ${esc(i18n('Weakest points across the class'))}</div>
      <div class="km__body">
        ${(data.points || []).length ? `<table class="km__table"><thead><tr>
          <th>${esc(i18n('Knowledge point'))}</th><th>${esc(i18n('Needs work'))}</th><th>${esc(i18n('Resolving'))}</th><th>${esc(i18n('Mastered'))}</th><th>${esc(i18n('Weak rate'))}</th>
        </tr></thead><tbody>${data.points.map((p) => `<tr>
          <td title="${esc((p.path || []).join(' › '))}">${esc(p.name)}</td>
          <td>${esc(p.shaky)}</td><td>${esc(p.resolving)}</td><td>${esc(p.mastered)}</td><td>${esc(p.weakRate)}%</td>
        </tr>`).join('')}</tbody></table>`
    : `<div class="km__empty">${esc(i18n('No maps built yet.'))}</div>`}
      </div>
    </div>
    <div class="km__card">
      <div class="km__head">👥 ${esc(i18n('Students'))}</div>
      <div class="km__body">
        <table class="km__table"><thead><tr>
          <th>${esc(i18n('Student'))}</th><th>${esc(i18n('Mastery spread'))}</th><th>${esc(i18n('Needs work'))}</th><th>${esc(i18n('Top priorities'))}</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>
  </div>`);

  $root.find('.km__build').on('click', async function onBuild() {
    const $b = $(this);
    $b.prop('disabled', true).text(i18n('Building...'));
    try {
      const res = await request.post(window.location.pathname, { operation: 'rebuild' });
      Notification.success(i18n('Built {0} map(s), {1} remaining.').replace('{0}', res.built).replace('{1}', res.remaining));
      const fresh = await request.get(window.location.pathname);
      renderClass($root, fresh);
    } catch (e) {
      Notification.error(e.message);
      $b.prop('disabled', false).text(`⚙ ${i18n('Build missing maps')}`);
    }
  });
}

/* ------------------------- homepage: "Practise next" ------------------------- */

/**
 * 🎯 The compact recommendation card in the homepage side column.
 *
 * The homepage is where a learner lands and asks "what should I do today",
 * which is why this moved here from the problem set — a list of problems is
 * already a list of things to do, so the panel was answering a question
 * nobody was asking there.
 *
 * Reads the CACHED map (?brief=true) and never triggers a derivation, so
 * the homepage stays as fast as it was. The endpoint also drops tasks the
 * student has already solved, so a just-finished task cannot linger here
 * while the background rebuild catches up.
 *
 * The card's shell is rendered server-side by
 * templates/partials/homepage/practise_next.html; this only fills the body.
 */
async function fillHomePanel() {
  const $body = $('#km-home-body');
  if (!$body.length) return;
  let data;
  try {
    data = await request.get(`${domainPrefix()}/knowledge-map?brief=true`);
  } catch (e) {
    // Strictly optional furniture: a failure here must not mark up the
    // homepage, so the card simply removes itself.
    $('#km-home').remove();
    return;
  }
  const mapHref = `${domainPrefix()}/knowledge-map`;
  if (!data.built) {
    $body.html(`<p class="km__sidenote">${esc(i18n('Build your knowledge map to get personalised practice suggestions.'))}</p>
      <a class="km__task" href="${esc(mapHref)}">${esc(i18n('Build my map'))}</a>`);
    return;
  }
  if (!(data.next || []).length) {
    $body.html(`<p class="km__sidenote">${esc(i18n('Nothing to recommend right now — nice work.'))}</p>
      <a class="km__task" href="${esc(mapHref)}">${esc(i18n('Open knowledge map'))}</a>`);
    return;
  }
  $body.html(`${data.next.map((n) => `<div class="km__siderow">
      <div class="km__sidename ${esc(n.state)}">${STATE_ICON[n.state] || '·'} ${esc(n.name)}</div>
      <div class="km__tasks">${(n.tasks || []).slice(0, 2).map((t) => `<a class="km__task" href="${esc(problemUrl(t.docId))}" title="${esc(t.title)}">${esc(t.pid)}</a>`).join('')}</div>
    </div>`).join('')}
    <a class="km__sidelink" href="${esc(mapHref)}">${esc(i18n('Open knowledge map'))} →</a>`);
}

export default new NamedPage(['knowledge_map', 'knowledge_map_class', 'homepage'], async (pagename) => {
  ensureStyle();
  if (pagename === 'homepage') {
    fillHomePanel();
    return;
  }
  const $root = $('#km-root');
  const mode = $root.attr('data-mode') || 'student';
  try {
    const data = await request.get(window.location.pathname + window.location.search);
    if (mode === 'class') renderClass($root, data);
    else renderStudent($root, data);
  } catch (e) {
    $root.html(`<div class="km__card"><div class="km__empty">⚠ ${esc(e.message)}</div></div>`);
  }
});
