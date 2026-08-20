import $ from 'jquery';
import MarkdownIt from 'markdown-it';
import Notification from 'vj/components/notification';
import { downloadAiReportPdf } from 'vj/components/ai-report/pdf';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, request } from 'vj/utils';

/** Tag the document once so scoped .pta-dark overrides can apply. */
function applyThemeTag() {
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
}

/** Markdown rendering for the AI report (html stays escaped). */
const mdReport = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * Site-wide PTA-style problem UI (all users, all domains, all surfaces):
 *
 * 1. Programming problems open directly in Scratchpad mode everywhere —
 *    problem set, contests, homework, training all route through
 *    `problem_detail`, so auto-entering here covers the whole site. The
 *    standalone submit page is retired and bounces back to the problem page.
 * 2. A PTA-style problem rail on the left follows the learner around
 *    (self-learning sessions get kind-grouped chips; contests/homework get
 *    the classic A/B/C grid) — in the IDE and, for quiz-style problems that
 *    have no IDE, below the navbar in normal page mode.
 * 3. The Scratchpad's records pane ("acceptance state below the editor") is
 *    disabled site-wide via UiContext.canViewRecord, which gates the pane,
 *    its toolbar button, and the auto-open on submit.
 * 4. The user's submission history renders below the problem description
 *    ("Submitted code": collapsible cards with verdict badges and code).
 * 5. After every submission a PTA-style "Submit Result" modal pops up:
 *    summary grid, per-test-case table (no hint column), the submitted
 *    source with line numbers, and the compiler output.
 *
 * The AI tutor is deliberately NOT part of this site-wide layer — it stays
 * exclusive to self-learning sessions, whose solve page runs its own richer
 * copy of this flow and is skipped by this module's page logic.
 */

const SCRATCHPAD_TYPES = ['default', 'remote_judge'];
// Contest and homework problem views share problem_detail.html but carry
// their own page names — the site-wide UI must register for all of them.
const PROBLEM_PAGES = ['problem_detail', 'contest_detail_problem', 'homework_detail_problem'];
const SUBMIT_PAGES = ['problem_submit', 'contest_detail_problem_submit', 'homework_detail_problem_submit'];
const RAIL_W = 190;
const RAIL_COLLAPSED_KEY = 'hydro:sl-rail-collapsed';

/* ------------------------------- shared helpers ------------------------------- */

function problemType() {
  try {
    return (window.UiContext && UiContext.pdoc && UiContext.pdoc.config && UiContext.pdoc.config.type) || '';
  } catch (e) {
    return '';
  }
}

function alphaLabel(i) {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

function esc(text) {
  return $('<i>').text(String(text)).html();
}

/** Bottom edge of the fixed navbar, or 0 when it is absent/hidden/slid away. */
function navTop() {
  const nav = document.querySelector('.nav');
  if (!nav) return 0;
  const r = nav.getBoundingClientRect();
  if (r.height <= 0 || r.bottom <= 0) return 0;
  return Math.round(r.bottom);
}

/** Stable display key for a test case (subtask-aware). */
function caseKey(c) {
  if (c == null) return null;
  if (c.subtaskId != null && c.id != null) return `${c.subtaskId}-${c.id}`;
  return c.id != null ? String(c.id) : null;
}

const PRISM_LANG = {
  py: 'python', cc: 'cpp', c: 'c', pas: 'pascal', java: 'java', kt: 'kotlin', js: 'javascript', ts: 'typescript', go: 'go', rs: 'rust', rb: 'ruby', cs: 'csharp', php: 'php', bash: 'bash',
};
const prismLang = (lang) => PRISM_LANG[String(lang || '').split('.')[0]] || 'none';
const STATUS_COLORS = {
  0: '#1c7ed6', // Waiting
  1: '#2f9e44', // Accepted
  2: '#e03131', // Wrong Answer
  3: '#e8590c', // Time Limit Exceeded
  4: '#9c36b5', // Memory Limit Exceeded
  5: '#e8590c', // Output Limit Exceeded
  6: '#c2255c', // Runtime Error
  7: '#5f3dc4', // Compile Error
  8: '#495057', // System Error
  9: '#868e96', // Canceled
  11: '#e03131', // Hacked
  20: '#1c7ed6', // Judging
  21: '#1c7ed6', // Compiling
};
/** Subjective (project-level) tasks: the display pid's S prefix is the marker. */
function isSubjectivePid() {
  const pdoc = window.UiContext && UiContext.pdoc;
  return /^s/i.test(String((pdoc && pdoc.pid) || ''));
}

function reportFileName() {
  const pdoc = (window.UiContext && UiContext.pdoc) || {};
  return `AI-Suggestions-${pdoc.pid ?? pdoc.docId ?? 'report'}.pdf`.replace(/[^\w.-]+/g, '-');
}

const DARK_STATUS_OVERRIDES = { 8: '#9aa4ad', 9: '#9aa4ad' }; // grays legible on dark
const statusColor = (st, accepted) => {
  if (accepted) return STATUS_COLORS[1];
  if (getTheme() === 'dark' && DARK_STATUS_OVERRIDES[st]) return DARK_STATUS_OVERRIDES[st];
  return STATUS_COLORS[st] || '#d9480f';
};
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');
const langDisplay = (l) => (window.LANGS && window.LANGS[l] && window.LANGS[l].display) || l || '-';

/** Canonical problem route prefix for API calls, wherever the page lives. */
function trajectoryUrl() {
  const domainPrefix = (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
  const docId = window.UiContext && UiContext.pdoc && UiContext.pdoc.docId;
  return `${domainPrefix}/p/${docId}/trajectory`;
}

/* ---------------------------------- the rail ---------------------------------- */

const RAIL_STYLE = [
  '.sl-rail { position: fixed; left: 0; top: 0; bottom: 0; width: 190px; z-index: 260; background: #fff; border-right: 1px solid #e3e3e3; display: flex; flex-direction: column; font-size: 13px; box-shadow: 2px 0 8px rgba(0,0,0,.06); }',
  '.sl-rail__head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #eee; font-weight: bold; color: #333; flex: 0 0 auto; }',
  '.sl-rail__head button { border: none; background: transparent; cursor: pointer; font-size: 14px; color: #666; padding: 2px 6px; border-radius: 4px; }',
  '.sl-rail__head button:hover { background: #f0f0f0; }',
  '.sl-rail__body { flex: 1 1 auto; overflow-y: auto; padding-bottom: 10px; }',
  '.sl-rail__cat { padding: 12px 12px 0; font-size: 11.5px; font-weight: bold; color: #8a8a8a; letter-spacing: .05em; text-transform: uppercase; }',
  '.sl-rail__grid { padding: 8px 12px 2px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; align-content: start; }',
  '.sl-rail__chip { display: flex; align-items: center; justify-content: center; height: 34px; border: 1px solid #d0d0d0; border-radius: 6px; color: #555; text-decoration: none; background: #fff; font-size: 13px; }',
  '.sl-rail__chip:hover { border-color: #339af0; color: #339af0; }',
  '.sl-rail__chip.ac { border-color: #2f9e44; color: #2f9e44; background: #f0faf2; }',
  '.sl-rail__chip.tried { border-color: #e03131; color: #e03131; background: #fff5f5; }',
  '.sl-rail__chip.quiz { border-style: dashed; }',
  '.sl-rail__chip.current { outline: 2px solid #339af0; outline-offset: 1px; }',
  '.sl-rail__expander { position: fixed; left: 0; top: 50%; transform: translateY(-50%); z-index: 260; width: 26px; height: 60px; border: 1px solid #d0d0d0; border-left: none; border-radius: 0 8px 8px 0; background: #fff; cursor: pointer; color: #666; font-size: 15px; box-shadow: 2px 0 8px rgba(0,0,0,.12); }',
  '.sl-rail__expander:hover { color: #339af0; }',
  '.sl-rail__foot { flex: 0 0 auto; padding: 10px 12px; border-top: 1px solid #eee; background: #fbfcfe; }',
  '.sl-rail__lastsub { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; border: none; border-radius: 15px; padding: 8px 10px; font-size: 12.5px; color: #fff; cursor: pointer; background: linear-gradient(90deg, #339af0, #1c7ed6); box-shadow: 0 2px 8px rgba(28,126,214,.35); transition: filter .12s ease, transform .12s ease; }',
  '.sl-rail__lastsub:hover { filter: brightness(1.08); transform: translateY(-1px); }',
  '.sl-rail__lastsub:disabled { opacity: .7; cursor: default; transform: none; }',
  '.pta-dark .sl-rail { background: #1e2227; border-right-color: #2e3338; }',
  '.pta-dark .sl-rail__head { color: #c6cdd4; border-bottom-color: #2e3338; }',
  '.pta-dark .sl-rail__group { color: #7f8b97; }',
  '.pta-dark .sl-rail__chip { background: #262b31; border-color: #49515a; color: #cfd6dd; }',
  '.pta-dark .sl-rail__chip:hover { background: #2d333a; border-color: #5a6470; }',
  '.pta-dark .sl-rail__chip.current { border-color: #4dabf7; background: #1c2f42; color: #d8ecff; }',
  '.sl-rail__chip.subj { border-style: dashed; border-color: #b197fc; color: #845ef7; }',
  '.sl-rail__chip.subj:hover { border-color: #845ef7; background: #f6f2ff; }',
  '.sl-rail__chip.subj.current { border-color: #845ef7; background: #f3edff; color: #5f3dc4; border-style: solid; }',
  '.pta-dark .sl-rail__chip.subj { border-color: #6f5bb5; color: #b197fc; background: #26232e; }',
  '.pta-dark .sl-rail__chip.subj.current { border-color: #b197fc; background: #2c2440; color: #d0bdfb; }',
  '.pta-dark .sl-rail__foot { background: #23282e; border-top-color: #2e3338; }',
  '.pta-dark .sl-rail__expander { background: #1e2227; border-color: #2e3338; color: #9aa4ad; }',
].join('\n');

/** 'scratchpad' | 'page' | null — which surface the rail is currently attached to. */
let railMode = null;

/** Cached fetch of the current contest/homework problems' kinds and titles. */
let activityKindsPromise = null;
function fetchActivityKinds() {
  const uc = window.UiContext || {};
  // Preferred path: the backend render hook serializes the kinds straight
  // into UiContext — synchronous, no extra request, no failure modes.
  if (Array.isArray(uc.tdocKinds) && uc.tdocKinds.length) {
    console.info('[pta-ui] rail kinds: server-rendered,', uc.tdocKinds.length, 'problem(s)');
    return Promise.resolve(uc.tdocKinds);
  }
  const tid = uc.tdoc && uc.tdoc.docId;
  if (!tid) return Promise.resolve(null);
  console.info('[pta-ui] rail kinds: not server-rendered (backend hook inactive?), trying the endpoint...');
  if (!activityKindsPromise) {
    const domainPrefix = (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
    activityKindsPromise = request.get(`${domainPrefix}/activity/${tid}/problem-kinds`)
      .then((res) => {
        if (res && res.pids && res.pids.length) {
          console.info('[pta-ui] rail kinds: fetched from endpoint,', res.pids.length, 'problem(s)');
          return res.pids;
        }
        console.warn('[pta-ui] rail kinds: endpoint returned no data — flat grid fallback');
        return null;
      })
      .catch((e) => {
        console.warn('[pta-ui] rail kinds: endpoint failed (%s) — the BACKEND is likely running old code; '
          + 'restart it with the latest files. Falling back to the flat A/B grid.', (e && e.message) || e);
        return null;
      });
  }
  return activityKindsPromise;
}

/** Contest/homework chip groups: kind-grouped when kinds are known, flat otherwise. */
function buildTdocGroups(kinds) {
  const uc = window.UiContext || {};
  const prefix = window.location.pathname.split('/p/')[0];
  const current = uc.pdoc && uc.pdoc.docId;
  const pids = uc.tdoc.pids;
  if (kinds) {
    const byPid = {};
    for (const k of kinds) byPid[String(k.pid)] = k;
    const quizzes = [];
    const subj = [];
    const programming = [];
    for (const pid of pids) {
      const info = byPid[String(pid)] || {};
      const kind3 = info.kind === 'subjective' ? 'subjective' : (info.kind && info.kind !== 'programming' ? 'objective' : 'programming');
      const item = {
        cls: `${kind3 === 'objective' ? ' quiz' : (kind3 === 'subjective' ? ' subj' : '')}${String(pid) === String(current) ? ' current' : ''}`,
        name: info.title || String(pid),
        href: `${prefix}/p/${pid}?tid=${uc.tdoc.docId}`,
      };
      (kind3 === 'programming' ? programming : (kind3 === 'subjective' ? subj : quizzes)).push(item);
    }
    const groups = [];
    if (quizzes.length) groups.push({ header: i18n('Objectives'), items: quizzes });
    if (subj.length) groups.push({ header: i18n('Subjective Tasks'), items: subj });
    if (programming.length) groups.push({ header: i18n('Programming'), items: programming });
    for (const g of groups) {
      g.items.forEach((it, i) => {
        it.label = String(i + 1);
        it.title = `${i + 1}. ${it.name}`;
      });
    }
    return groups;
  }
  return [{
    header: null,
    items: pids.map((pid, i) => ({
      label: alphaLabel(i),
      cls: String(pid) === String(current) ? ' current' : '',
      title: alphaLabel(i),
      href: `${prefix}/p/${pid}?tid=${uc.tdoc.docId}`,
    })),
  }];
}

/**
 * Chip groups for the current activity, or null when the page has no
 * activity context. Self-learning sessions AND contests/homework both split
 * into quiz-style vs programming groups with independent 1..n numbering
 * (contest kinds arrive via the activity_problem_kinds endpoint; a flat grid
 * is the fallback when it is unavailable).
 */
async function getRailGroups() {
  const uc = window.UiContext || {};
  if (Array.isArray(uc.slProblems) && uc.slProblems.length) {
    const prefix = window.location.pathname.split('/self-learning/')[0];
    const quizzes = [];
    const subj = [];
    const programming = [];
    for (const p of uc.slProblems) {
      const kindCls = p.kind === 'objective' ? ' quiz' : (p.kind === 'subjective' ? ' subj' : '');
      const item = {
        accepted: p.status === 1,
        cls: `${p.status === 1 ? ' ac' : (p.status ? ' tried' : '')}${kindCls}`
          + (String(p.pid) === String(uc.slPid) ? ' current' : ''),
        name: p.title || String(p.pid),
        href: `${prefix}/self-learning/${uc.slSsid}/p/${p.pid}`,
      };
      (p.kind === 'programming' ? programming : (p.kind === 'subjective' ? subj : quizzes)).push(item);
    }
    const groups = [];
    if (quizzes.length) groups.push({ header: i18n('Objectives'), items: quizzes });
    if (subj.length) groups.push({ header: i18n('Subjective Tasks'), items: subj });
    if (programming.length) groups.push({ header: i18n('Programming'), items: programming });
    for (const g of groups) {
      g.items.forEach((it, i) => {
        it.label = it.accepted ? '✓' : String(i + 1);
        it.title = `${i + 1}. ${it.name}`;
      });
    }
    return groups;
  }
  if (uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) {
    const serverRendered = Array.isArray(uc.tdocKinds) && uc.tdocKinds.length;
    const kinds = await fetchActivityKinds();
    console.info('[pta-ui] activity kinds source:',
      serverRendered ? 'server-rendered' : (kinds ? `fetched (${kinds.length})` : 'none -> flat grid (is the backend up to date?)'));
    return buildTdocGroups(kinds);
  }
  const tr = uc.trainingRail;
  if (tr && Array.isArray(tr.kinds) && tr.kinds.length > 1) {
    // Training: problems live on the plain problem page; ?trid=... carries
    // the context (decorated onto training links by this module) and keeps
    // it while hopping between chips.
    console.info('[pta-ui] rail kinds: server-rendered (training),', tr.kinds.length, 'problem(s)');
    const prefix = window.location.pathname.split('/p/')[0];
    const current = uc.pdoc && uc.pdoc.docId;
    const quizzes = [];
    const subj = [];
    const programming = [];
    for (const info of tr.kinds) {
      const kind3 = info.kind === 'subjective' ? 'subjective' : (info.kind && info.kind !== 'programming' ? 'objective' : 'programming');
      const item = {
        cls: `${kind3 === 'objective' ? ' quiz' : (kind3 === 'subjective' ? ' subj' : '')}${String(info.pid) === String(current) ? ' current' : ''}`,
        name: info.title || String(info.pid),
        href: `${prefix}/p/${info.pid}?trid=${tr.trid}`,
      };
      (kind3 === 'programming' ? programming : (kind3 === 'subjective' ? subj : quizzes)).push(item);
    }
    const groups = [];
    if (quizzes.length) groups.push({ header: i18n('Objectives'), items: quizzes });
    if (subj.length) groups.push({ header: i18n('Subjective Tasks'), items: subj });
    if (programming.length) groups.push({ header: i18n('Programming'), items: programming });
    for (const g of groups) {
      g.items.forEach((it, i) => {
        it.label = String(i + 1);
        it.title = `${i + 1}. ${it.name}`;
      });
    }
    return groups;
  }
  const ps = uc.psetRail;
  if (ps && Array.isArray(ps.kinds) && ps.kinds.length > 1) {
    // Problem set: a window of neighboring problems around the current one,
    // server-selected in docId order with visibility already applied.
    console.info('[pta-ui] rail kinds: server-rendered (problem set),', ps.kinds.length, 'problem(s)');
    const prefix = window.location.pathname.split('/p/')[0];
    const current = uc.pdoc && uc.pdoc.docId;
    const quizzes = [];
    const subj = [];
    const programming = [];
    for (const info of ps.kinds) {
      const kind3 = info.kind === 'subjective' ? 'subjective' : (info.kind && info.kind !== 'programming' ? 'objective' : 'programming');
      const item = {
        cls: `${kind3 === 'objective' ? ' quiz' : (kind3 === 'subjective' ? ' subj' : '')}${String(info.pid) === String(current) ? ' current' : ''}`,
        name: info.title || String(info.pid),
        href: `${prefix}/p/${info.pid}`,
      };
      (kind3 === 'programming' ? programming : (kind3 === 'subjective' ? subj : quizzes)).push(item);
    }
    const groups = [];
    if (quizzes.length) groups.push({ header: i18n('Objectives'), items: quizzes });
    if (subj.length) groups.push({ header: i18n('Subjective Tasks'), items: subj });
    if (programming.length) groups.push({ header: i18n('Programming'), items: programming });
    for (const g of groups) {
      g.items.forEach((it, i) => {
        it.label = String(i + 1);
        it.title = `${i + 1}. ${it.name}`;
      });
    }
    return groups;
  }
  return null;
}

/** Squeeze whichever content surface the current rail mode owns. */
function squeezeContent(width) {
  if (railMode === 'page') {
    $('.main, .footer').css('margin-left', width ? `${width}px` : '');
  } else {
    $('.scratchpad-container').css({ left: `${width}px`, width: `calc(100% - ${width}px)` });
    window.dispatchEvent(new Event('resize')); // let Monaco and the split panes relayout
  }
}

export function removeRail() {
  $('#sl-rail, #sl-rail-expander').remove();
  $('.scratchpad-container').css({ left: '0px', width: '100%' });
  $('.main, .footer').css('margin-left', '');
  railMode = null;
}

function setCollapsed(collapsed) {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '');
  } catch (e) { /* best-effort */ }
  $('#sl-rail').toggle(!collapsed);
  $('#sl-rail-expander').toggle(collapsed);
  squeezeContent(collapsed ? 0 : RAIL_W);
}

/** In BOTH modes the rail sits below the fixed navbar; keep that on resize. */
function syncRailTop() {
  if (!railMode) return;
  $('#sl-rail').css('top', `${navTop()}px`);
}

let railBuilding = false;

async function injectRail(mode) {
  if (document.getElementById('sl-rail')) {
    if (railMode === mode) return;
    removeRail(); // re-homing between the IDE and the page rebuilds cleanly
  }
  if (railBuilding) return;
  railBuilding = true;
  let groups = null;
  try {
    groups = await getRailGroups();
  } finally {
    railBuilding = false;
  }
  if (document.getElementById('sl-rail')) return; // a concurrent build won
  if (!groups) {
    const uc = window.UiContext || {};
    console.info('[pta-ui] problem rail skipped:', {
      slProblems: Array.isArray(uc.slProblems) ? uc.slProblems.length : 'absent',
      tdocPids: uc.tdoc && Array.isArray(uc.tdoc.pids) ? uc.tdoc.pids.length : 'absent',
    });
    return;
  }
  applyThemeTag();
  if (!document.getElementById('sl-rail-style')) {
    $('<style>').attr('id', 'sl-rail-style').text(RAIL_STYLE).appendTo(document.head);
  }
  railMode = mode;
  console.info('[pta-ui] rail: attaching in', mode, 'mode with', groups.length, 'group(s)');
  const body = groups.map((g) => {
    const chips = g.items.map((it) => `<a class="sl-rail__chip${it.cls}" href="${it.href}" title="${esc(it.title)}">${esc(it.label)}</a>`).join('');
    return `${g.header ? `<div class="sl-rail__cat">${esc(g.header)}</div>` : ''}<div class="sl-rail__grid">${chips}</div>`;
  }).join('');
  $(`<div id="sl-rail" class="sl-rail" style="top:${navTop()}px">`
    + `<div class="sl-rail__head"><span>${esc(i18n('Problems'))}</span>`
    + `<button id="sl-rail-toggle" type="button" title="${esc(i18n('Collapse'))}">⟨</button></div>`
    + `<div class="sl-rail__body">${body}</div>`
    + ((window.UiContext && UiContext.pdoc && UiContext.pdoc.docId)
      ? `<div class="sl-rail__foot"><button type="button" id="sl-rail-lastsub" class="sl-rail__lastsub">🕘 ${esc(i18n('View Last Submission'))}</button></div>`
      : '')
    + '</div>').appendTo(document.body);
  $('#sl-rail-lastsub').on('click', function onLastSub() {
    openLastSubmission($(this));
  });
  $(`<button id="sl-rail-expander" class="sl-rail__expander" type="button" style="display:none" title="${esc(i18n('Problems'))}">≡</button>`).appendTo(document.body);
  $('#sl-rail-toggle').on('click', () => setCollapsed(true));
  $('#sl-rail-expander').on('click', () => setCollapsed(false));
  let collapsed = false;
  try {
    const saved = localStorage.getItem(RAIL_COLLAPSED_KEY);
    if (saved === '1') collapsed = true;
    // First visit on a narrow page: content space beats the rail.
    else if (saved === null && mode === 'page' && window.matchMedia('(max-width: 600px)').matches) collapsed = true;
  } catch (e) { /* default expanded */ }
  setCollapsed(collapsed);
  // The IDE/nav layout settles asynchronously; keep the header out from
  // under the fixed navbar.
  syncRailTop();
  setTimeout(syncRailTop, 350);
  setTimeout(syncRailTop, 900);
}

/** Wait for scratchpad mode to be active, then attach the rail inside the IDE. */
export function injectRailWhenReady() {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if ($('body').hasClass('mode--scratchpad')) {
      clearInterval(timer);
      injectRail('scratchpad');
    } else if (tries > 50) clearInterval(timer);
  }, 100);
}

/** Attach the rail to a normal document page (quiz / answer-submission pages). */
export function injectRailForPage() {
  injectRail('page');
}

$(window).on('resize', syncRailTop);

/* ------------------- training links carry their context ------------------- */

/**
 * Training problems link to the plain problem page with no activity context,
 * so the sidebar could never know its siblings there. Decorate every problem
 * link on the training page with ?trid=<trainingId>; the backend rail hook
 * resolves it into the grouped sidebar, and chip navigation keeps it alive.
 */
function decorateTrainingLinks() {
  const m = window.location.pathname.match(/\/training\/([0-9a-f]{24})/i);
  if (!m) return;
  const trid = m[1];
  let n = 0;
  document.querySelectorAll('a[href]').forEach((a) => {
    let u;
    try {
      u = new URL(a.getAttribute('href'), window.location.origin);
    } catch (e) {
      return;
    }
    if (u.origin !== window.location.origin) return;
    if (!/^(\/d\/[^/]+)?\/p\/[^/?#]+\/?$/.test(u.pathname)) return;
    if (u.searchParams.has('trid') || u.searchParams.has('tid')) return;
    u.searchParams.set('trid', trid);
    a.setAttribute('href', u.pathname + u.search + u.hash);
    n += 1;
  });
  if (n) console.info('[pta-ui] training: decorated', n, 'problem link(s) with trid=', trid);
}

/* --------------- site-wide submit-result modal + judging pill --------------- */

const SITE_UI_STYLE = [
  '@keyframes slmMaskIn { from { opacity: 0; } }',
  '@keyframes slmPopIn { from { opacity: 0; transform: translateY(16px) scale(.95); } 70% { transform: translateY(-2px) scale(1.005); } to { opacity: 1; transform: none; } }',
  '.slm-mask { animation: slmMaskIn .2s ease-out; }',
  '.slm { animation: slmPopIn .3s cubic-bezier(.2,.8,.3,1); }',
  '.slm-mask--closing { transition: opacity .18s ease; opacity: 0; pointer-events: none; }',
  '.slm-mask--closing .slm { transition: transform .18s ease, opacity .18s ease; transform: translateY(12px) scale(.97); opacity: 0; }',
  '.slm-mask { position: fixed; inset: 0; z-index: 3200; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 20px; }',
  '.slm { background: #fff; border-radius: 10px; width: 900px; max-width: 96vw; max-height: 92vh; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,.3); overflow: hidden; }',
  '.slm__head { display: flex; align-items: center; justify-content: space-between; padding: 13px 20px; border-bottom: 2px solid #e8f1fb; flex: 0 0 auto; }',
  '.slm__title { color: #1a73d1; font-size: 17px; font-weight: bold; }',
  '.slm__close { border: none; background: transparent; font-size: 20px; color: #888; cursor: pointer; padding: 2px 8px; border-radius: 4px; line-height: 1; }',
  '.slm__close:hover { background: #f0f0f0; color: #333; }',
  '.slm__body { padding: 16px 20px; overflow-y: auto; }',
  '.slm__summary { background: #f7f8fa; border: 1px solid #ececec; border-radius: 6px; padding: 14px 16px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px 20px; font-size: 13px; }',
  '.slm__k { color: #8a8a8a; margin-bottom: 3px; }',
  '.slm__v { color: #333; word-break: break-word; }',
  '.slm__st { font-weight: bold; }',
  '.slm__msg { color: #8a8a8a; font: 11.5px/1.45 monospace; font-weight: normal; margin-top: 2px; white-space: pre-wrap; word-break: break-word; max-width: 430px; }',
  '.pta-dark .slm { background: #23272c; color: #d5dade; }',
  '.pta-dark .slm__head { border-bottom-color: #2f3941; }',
  '.pta-dark .slm__title { color: #4dabf7; }',
  '.pta-dark .slm__close { color: #9aa4ad; }',
  '.pta-dark .slm__close:hover { background: #2e343a; color: #e2e7ec; }',
  '.pta-dark .slm__summary { background: #262b31; border-color: #333a41; }',
  '.pta-dark .slm__k { color: #8b97a3; }',
  '.pta-dark .slm__v { color: #e2e7ec; }',
  '.pta-dark .slm__sect { border-color: #333a41; }',
  '.pta-dark .slm__secthead { background: #2a3036; color: #c2c9d1; border-bottom-color: #333a41; }',
  '.pta-dark .slm__table th { background: #2a3036; color: #8b97a3; border-bottom-color: #333a41; }',
  '.pta-dark .slm__table td { border-bottom-color: #2c3238; color: #cfd6dd; }',
  '.pta-dark .slm__msg { color: #98a2ac; }',
  '.pta-dark .slm__foot { border-top-color: #2f3941; }',
  '.pta-dark .slm__genwrap .slm__gentext { color: #c4cbd2; }',
  '.pta-dark .slm__spinner { border-color: #3a4a63; border-top-color: #4dabf7; }',
  '.pta-dark .slm__sect--ai { border-color: #6741d9; box-shadow: 0 4px 18px rgba(132,94,247,.28); }',
  '.pta-dark .slm__ai { background: #241f2e; color: #d6d0e6; }',
  '.pta-dark .slm__ai h1, .pta-dark .slm__ai h2, .pta-dark .slm__ai h3 { color: #b197fc; }',
  '.pta-dark .slm__ai h2 { border-bottom-color: #3a3350; }',
  '.pta-dark .slm__ai code { background: #322a44; color: #d0bdfb; }',
  '.pta-dark .slm__ai blockquote { background: #2a2440; border-left-color: #845ef7; color: #b9b0d6; }',
  '.pta-dark .slm__ai hr { border-top-color: #3a3350; }',
  '.pta-dark .slm__ai td, .pta-dark .slm__ai th { border-color: #3a3350; }',
  '.pta-dark .slm__codearea { background: #1b1f24; }',
  '.pta-dark .slm pre, .pta-dark .sl-attempt pre { background: #1b1f24 !important; border-color: #30363d !important; }',
  '.pta-dark .slm pre > code, .pta-dark .sl-attempt pre > code { color: #d4d4d4; text-shadow: none; }',
  '.pta-dark .slm .token.comment, .pta-dark .sl-attempt .token.comment { color: #6a9955; }',
  '.pta-dark .slm .token.keyword, .pta-dark .slm .token.boolean, .pta-dark .slm .token.constant, .pta-dark .sl-attempt .token.keyword, .pta-dark .sl-attempt .token.boolean, .pta-dark .sl-attempt .token.constant { color: #569cd6; }',
  '.pta-dark .slm .token.string, .pta-dark .slm .token.char, .pta-dark .slm .token.attr-value, .pta-dark .sl-attempt .token.string, .pta-dark .sl-attempt .token.char { color: #ce9178; }',
  '.pta-dark .slm .token.number, .pta-dark .sl-attempt .token.number { color: #b5cea8; }',
  '.pta-dark .slm .token.function, .pta-dark .sl-attempt .token.function { color: #dcdcaa; }',
  '.pta-dark .slm .token.class-name, .pta-dark .slm .token.builtin, .pta-dark .sl-attempt .token.class-name, .pta-dark .sl-attempt .token.builtin { color: #4ec9b0; }',
  '.pta-dark .slm .token.operator, .pta-dark .slm .token.punctuation, .pta-dark .sl-attempt .token.operator, .pta-dark .sl-attempt .token.punctuation { color: #c8ccd0; background: none; }',
  '.pta-dark .slm .token.property, .pta-dark .slm .token.variable, .pta-dark .slm .token.attr-name, .pta-dark .sl-attempt .token.property, .pta-dark .sl-attempt .token.variable { color: #9cdcfe; }',
  '.pta-dark .slm .token.tag, .pta-dark .sl-attempt .token.tag { color: #569cd6; }',
  '.pta-dark .slm .line-numbers-rows, .pta-dark .sl-attempt .line-numbers-rows { border-right-color: #30363d !important; }',
  '.pta-dark .slm .line-numbers-rows > span:before, .pta-dark .sl-attempt .line-numbers-rows > span:before { color: #6e7681 !important; }',
  '.pta-dark .slm div.code-toolbar > .toolbar > .toolbar-item > a.code-copy-btn, .pta-dark .sl-attempt div.code-toolbar > .toolbar > .toolbar-item > a.code-copy-btn { background: #2d333b !important; border-color: #444c56; color: #adbac7 !important; }',
  '.pta-dark .slm div.code-toolbar > .toolbar > .toolbar-item > a.code-copy-btn:hover, .pta-dark .sl-attempt div.code-toolbar > .toolbar > .toolbar-item > a.code-copy-btn:hover { background: #39414a !important; color: #cdd9e5 !important; border-color: #545d68; }',
  '.pta-dark .slm div.code-toolbar > .toolbar > .toolbar-item > a.code-copy-btn.code-copy-btn--ok, .pta-dark .sl-attempt div.code-toolbar > .toolbar > .toolbar-item > a.code-copy-btn.code-copy-btn--ok { background: #1e3524 !important; border-color: #347d39; color: #69db7c !important; }',
  '.slm__sect { margin-top: 16px; border: 1px solid #ececec; border-radius: 6px; overflow: hidden; }',
  '.slm__secthead { background: #f7f8fa; padding: 8px 14px; font-weight: bold; font-size: 13.5px; color: #444; border-bottom: 1px solid #ececec; }',
  '.slm__langtag { color: #888; font-weight: normal; margin-left: 8px; font-size: 12px; }',
  '.slm__table { width: 100%; border-collapse: collapse; font-size: 13px; }',
  '.slm__table th { background: #fff; color: #8a8a8a; font-weight: normal; text-align: left; padding: 8px 14px; border-bottom: 1px solid #f0f0f0; }',
  '.slm__table td { padding: 9px 14px; border-bottom: 1px solid #f5f5f5; color: #333; }',
  '.slm__table tr:last-child td { border-bottom: none; }',
  '.slm__codearea { max-height: 360px; overflow: auto; background: #fff; }',
  '.slm__codearea .code-toolbar { margin: 0; width: 100%; }',
  '.slm__codearea pre.slm__code { display: block; box-sizing: border-box; width: max-content; min-width: 100%; margin: 0; border: none; border-radius: 0; background: #fff; padding: 12px 14px 12px 3.8em; font-size: 12.5px; line-height: 1.55; }',
  '.slm__codearea pre.slm__code > code { background: none; padding: 0; white-space: pre; font-size: 12.5px; line-height: 1.55; }',
  '.slm__codearea .line-numbers-rows { border-right: 1px solid #ececec; }',
  '.slm__codearea .line-numbers-rows > span:before { color: #b5b5b5; }',
  '.slm__compile { background: #2b2b2b; color: #e8e8e8; margin: 0; padding: 12px 14px; font: 12.5px/1.5 monospace; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }',
  '.slm__foot { padding: 12px 20px; border-top: 1px solid #eee; display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }',
  '.slm__spacer { flex: 1 1 auto; }',
  '.slm__sect--ai { border: 1px solid #b197fc; box-shadow: 0 4px 18px rgba(132,94,247,.16); }',
  '.slm__aihead { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: linear-gradient(90deg, #4c6ef5 0%, #845ef7 55%, #b197fc 100%); color: #fff; font-weight: bold; font-size: 14px; }',
  '.slm__aihead .slm__aititle { flex: 1 1 auto; letter-spacing: .02em; }',
  '.slm__pdf { background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.75); color: #fff; padding: 3px 14px; font-size: 12px; border-radius: 14px; cursor: pointer; flex: 0 0 auto; }',
  '.slm__pdf:disabled { opacity: .6; cursor: default; }',
  '.slm__aits { font-size: 11px; color: rgba(255,255,255,.85); flex: 0 0 auto; }',
  '.slm__pdf:hover { background: rgba(255,255,255,.32); }',
  '.slm__ai-btn { background: linear-gradient(90deg, #4c6ef5, #845ef7); color: #fff; border: none; border-radius: 16px; padding: 7px 18px; font-size: 13px; cursor: pointer; box-shadow: 0 2px 10px rgba(76,110,245,.35); }',
  '.slm__ai-btn:hover { filter: brightness(1.08); }',
  '.slm__ai-btn:disabled { opacity: .78; cursor: default; }',
  '.slm__ai-btn .slm__btnspin { border-color: rgba(255,255,255,.45); border-top-color: #fff; }',
  '.slm__ai { padding: 16px 18px; max-height: 480px; overflow: auto; font-size: 13.5px; line-height: 1.65; background: #fdfcff; }',
  '.slm__ai h1 { font-size: 17px; margin: 0 0 10px; color: #5f3dc4; }',
  '.slm__ai h2 { font-size: 15px; margin: 18px 0 8px; color: #5f3dc4; border-bottom: 1px solid #eee3ff; padding-bottom: 4px; }',
  '.slm__ai h3 { font-size: 13.5px; margin: 12px 0 4px; color: #4b3b8f; }',
  '.slm__ai pre { background: #f8f7fc; border: 1px solid #e9e4f5; border-radius: 6px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; }',
  '.slm__ai pre code { background: none; padding: 0; }',
  '.slm__ai code { background: #f1edfa; border-radius: 3px; padding: 1px 5px; font-size: 12.5px; color: #5f3dc4; }',
  '.slm__ai .code-toolbar { margin: 6px 0; }',
  '.slm__ai blockquote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid #b197fc; background: #f7f4ff; color: #555; }',
  '.slm__ai hr { border: none; border-top: 1px solid #eee3ff; margin: 14px 0; }',
  '.slm__ai table { border-collapse: collapse; margin: 8px 0; } .slm__ai td, .slm__ai th { border: 1px solid #e5ddf5; padding: 4px 10px; }',
  '@keyframes slm-spin { to { transform: rotate(360deg); } }',
  '.slm__genwrap { display: flex; align-items: center; gap: 14px; padding: 18px 16px; }',
  '.slm__spinner { width: 28px; height: 28px; border: 3px solid #d8e6f8; border-top-color: #1a73d1; border-radius: 50%; animation: slm-spin .8s linear infinite; flex: 0 0 auto; }',
  '.slm__gentext { color: #444; font-size: 13.5px; line-height: 1.55; }',
  '.slm__btnspin { display: inline-block; width: 12px; height: 12px; border: 2px solid #cfd8e3; border-top-color: #1a73d1; border-radius: 50%; animation: slm-spin .8s linear infinite; vertical-align: -2px; margin-right: 6px; }',
  '#sl-judging { position: fixed; top: 64px; left: 50%; transform: translateX(-50%); z-index: 3100; background: #333; color: #fff; padding: 8px 18px; border-radius: 20px; font-size: 13px; box-shadow: 0 4px 14px rgba(0,0,0,.3); }',
  '#sl-attempts { margin-top: 20px; border-top: 1px solid #e3e3e3; padding-top: 12px; }',
  '#sl-attempts h3 { font-size: 15px; margin: 0 0 8px; }',
  '.sl-attempt { margin: 8px 0; border: 1px solid #e6e6e6; border-radius: 6px; background: #fbfbfb; }',
  '.sl-attempt summary { cursor: pointer; padding: 6px 10px; font-size: 12.5px; color: #444; user-select: none; }',
  '.sl-attempt[open] summary { border-bottom: 1px solid #eee; }',
  '.sl-attempt pre { margin: 0; border-radius: 0 0 6px 6px; background: #f4f4f4; padding: 8px; overflow-x: auto; }',
  '.sl-attempt .sl-badge { display: inline-block; border-radius: 8px; padding: 0 8px; font-size: 11.5px; margin-right: 4px; background: #fbdedb; color: #c0392b; }',
  '.sl-attempt .sl-badge.pass { background: #d3f1d3; color: #25ad40; }',
  '.pta-dark #sl-attempts { border-top-color: #2e3338; }',
  '.pta-dark #sl-attempts h3 { color: #c6cdd4; }',
  '.pta-dark .sl-attempt { background: #23272c; border-color: #333a41; }',
  '.pta-dark .sl-attempt summary { color: #cfd6dd; }',
  '.pta-dark .sl-attempt[open] summary { border-bottom-color: #333a41; }',
  '.pta-dark .sl-attempt .sl-badge { background: #3a2225; color: #ff8787; }',
  '.pta-dark .sl-attempt .sl-badge.pass { background: #1e3524; color: #69db7c; }',
].join('\n');

function ensureSiteStyle() {
  applyThemeTag();
  if (!document.getElementById('sw-ui-style')) {
    $('<style>').attr('id', 'sw-ui-style').text(SITE_UI_STYLE).appendTo(document.head);
  }
}

function showJudging() {
  ensureSiteStyle();
  if (!document.getElementById('sl-judging')) {
    $(`<div id="sl-judging">⏳ ${esc(i18n('Judging...'))}</div>`).appendTo(document.body);
  }
}

function hideJudging() {
  $('#sl-judging').remove();
}

/**
 * The PTA-style "Submit Result" modal: summary grid, per-test-case detail
 * (deliberately WITHOUT any hint column), the submitted source with line
 * numbers, and the compiler output.
 */
export function showSubmitModal(data, onClose) {
  ensureSiteStyle();
  const conf = (window.UiContext && UiContext.pdoc && typeof UiContext.pdoc.config === 'object' && UiContext.pdoc.config) || {};
  const timeLimit = conf.timeMax || conf.time || null;
  const memLimitKB = conf.memoryMax ? conf.memoryMax * 1024 : null;
  const stColor = statusColor(data.status, data.accepted);
  const pdoc = (window.UiContext && UiContext.pdoc) || {};
  const problemName = `${pdoc.pid ?? pdoc.docId ?? ''}. ${pdoc.title || ''}`;
  const userName = (window.UserContext && (UserContext.uname || UserContext.displayName)) || `#${(window.UserContext || {})._id ?? ''}`;
  const cell = (k, v, cls = '') => `<div><div class="slm__k">${esc(i18n(k))}</div><div class="slm__v ${cls}">${v}</div></div>`;
  let html = '<div class="slm__summary">';
  html += cell('Problem', esc(problemName));
  html += cell('User', esc(userName));
  html += cell('Submit At', esc(fmtTs(data.submitAt)));
  html += cell('Compiler', esc(langDisplay(data.lang)));
  html += cell('Memory Usage', esc(`${data.memory}${memLimitKB ? ` / ${memLimitKB}` : ''} KB`));
  html += cell('Time Usage', esc(`${data.time}${timeLimit ? ` / ${timeLimit}` : ''} ms`));
  html += `<div><div class="slm__k">${esc(i18n('Status'))}</div><div class="slm__v" style="color:${stColor};font-weight:bold">${esc(data.statusText || '')}</div></div>`;
  html += cell('Score', esc(String(data.score ?? 0)));
  html += cell('Judge At', esc(fmtTs(data.judgeAt)));
  html += '</div>';
  if (data.cases && data.cases.length) {
    html += `<div class="slm__sect"><div class="slm__secthead">${esc(i18n('Submission Detail'))}</div>`
      + `<table class="slm__table"><thead><tr><th>${esc(i18n('Test Case'))}</th><th>${esc(i18n('Memory(KB)'))}</th>`
      + `<th>${esc(i18n('Time(ms)'))}</th><th>${esc(i18n('Status'))}</th><th>${esc(i18n('Score'))}</th></tr></thead><tbody>`;
    for (const c of data.cases) {
      const key = caseKey(c) ?? '?';
      // Full status name in its semantic color, with the judge's per-case
      // detail message (when any) right beneath it.
      html += `<tr><td>${esc(String(key))}</td><td>${esc(String(c.memory ?? '-'))}</td>`
        + `<td>${esc(String(c.time ?? '-'))}</td>`
        + `<td class="slm__st" style="color:${statusColor(c.status)}">${esc(c.statusText || '')}`
        + (c.message ? `<div class="slm__msg">${esc(c.message)}</div>` : '')
        + `</td><td>${esc(String(c.score ?? '-'))}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  html += `<div class="slm__sect"><div class="slm__secthead">${esc(i18n('Submission Code'))}`
    + `<span class="slm__langtag">[ ${esc(langDisplay(data.lang))} ]</span></div>`
    + `<div class="slm__codearea"><pre class="slm__code line-numbers"><code class="language-${prismLang(data.lang)}">${esc(data.code || '')}</code></pre></div></div>`;
  if (data.compilerTexts) {
    html += `<div class="slm__sect"><div class="slm__secthead">${esc(i18n('Compilation Output'))}</div>`
      + `<pre class="slm__compile">${esc(data.compilerTexts)}</pre></div>`;
  }
  const aiEligible = !!data.accepted && SCRATCHPAD_TYPES.includes(problemType());
  const $mask = $('<div class="slm-mask"></div>').appendTo(document.body);
  const $modal = $(`<div class="slm" role="dialog" aria-label="${esc(i18n('Submit Result'))}">`
    + `<div class="slm__head"><span class="slm__title">${esc(i18n('Submit Result'))}</span>`
    + `<button type="button" class="slm__close" title="${esc(i18n('Close'))}">×</button></div>`
    + `<div class="slm__body">${html}</div>`
    + '<div class="slm__foot">'
    + (aiEligible ? `<button type="button" class="slm__ai-btn">🤖 ${esc(i18n('AI Suggestions'))}</button>` : '')
    + '<span class="slm__spacer"></span>'
    + `<button type="button" class="rounded primary button slm__ok">${esc(i18n('OK'))}</button></div>`
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
  // Requirement: post-acceptance AI report — statement + FULL trajectory as
  // context, rendered as Markdown inside this modal, downloadable as PDF.
  // Saved-report probe: if this problem already has a generated report in the
  // database, the button flips to an instant, token-free "View" affordance.
  let aiSaved = null; // { report, updateAt }
  const aiUrl = () => trajectoryUrl().replace(/\/trajectory$/, '/ai-suggestions');
  if (aiEligible) {
    request.get(aiUrl()).then((r) => {
      if (r && r.report) {
        aiSaved = { report: String(r.report), updateAt: r.updateAt };
        $modal.find('.slm__ai-btn').html(`📄 ${esc(i18n('View AI Suggestions'))}`);
      }
    }).catch(() => { /* no saved report — the button stays in generate mode */ });
  }

  /** Render a report section (used for saved, fresh, and regenerated). */
  function renderReportSection(report, updateAt, $replaceEl) {
    const reportMd = String(report || '');
    const reportHtml = mdReport.render(reportMd);
    const $sect = $('<div class="slm__sect slm__sect--ai">'
      + `<div class="slm__aihead">🤖 <span class="slm__aititle">${esc(i18n('AI Suggestions'))}</span>`
      + (updateAt ? `<span class="slm__aits">${esc(i18n('Saved'))}: ${esc(fmtTs(updateAt))}</span>` : '')
      + `<button type="button" class="slm__pdf slm__regen" title="${esc(i18n('Regenerate'))}">↻ ${esc(i18n('Regenerate'))}</button>`
      + `<button type="button" class="slm__pdf slm__dl">⬇ ${esc(i18n('Download PDF'))}</button></div>`
      + '<div class="slm__ai typo"></div></div>');
    $sect.find('.slm__ai').html(reportHtml);
    if ($replaceEl) $replaceEl.replaceWith($sect);
    else $modal.find('.slm__body').append($sect);
    import('vj/components/highlighter/prismjs')
      .then(({ default: prism }) => prism.highlightBlocks($sect))
      .catch(() => { /* highlighting is optional */ });
    $sect[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
    $sect.find('.slm__dl').on('click', function onPdfClick() {
      const $p = $(this);
      $p.prop('disabled', true);
      downloadAiReportPdf(reportMd, reportHtml, reportFileName()).finally(() => $p.prop('disabled', false));
    });
    $sect.find('.slm__regen').on('click', () => startGeneration($sect, null));
    return $sect;
  }

  /** Generate (or regenerate): spinner section -> LLM -> saved server-side. */
  async function startGeneration($replaceEl, $btn) {
    if ($btn) $btn.prop('disabled', true).html(`<span class="slm__btnspin"></span>${esc(i18n('Generating suggestions...'))}`);
    const $gen = $('<div class="slm__sect slm__sect--ai">'
      + `<div class="slm__aihead">🤖 <span class="slm__aititle">${esc(i18n('AI Suggestions'))}</span></div>`
      + '<div class="slm__genwrap"><div class="slm__spinner"></div>'
      + `<div class="slm__gentext"><b>${esc(i18n('The AI is generating your report...'))}</b><br>`
      + `${esc(i18n('This usually takes 10-30 seconds. Please keep this window open and do not quit.'))}</div></div></div>`);
    if ($replaceEl) $replaceEl.replaceWith($gen);
    else $modal.find('.slm__body').append($gen);
    $gen[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const res = await request.post(aiUrl(), {});
      aiSaved = { report: String((res && res.report) || ''), updateAt: res && res.updateAt };
      renderReportSection(aiSaved.report, aiSaved.updateAt, $gen);
      if ($btn) $btn.remove();
    } catch (e) {
      $gen.remove();
      Notification.error(e.message);
      if ($btn) $btn.prop('disabled', false).text(aiSaved ? `📄 ${i18n('View AI Suggestions')}` : `🤖 ${i18n('AI Suggestions')}`);
    }
  }

  $modal.find('.slm__ai-btn').on('click', function onAiClick() {
    const $btn = $(this);
    if (aiSaved) {
      // Instant view straight from the database — no LLM call, no tokens.
      renderReportSection(aiSaved.report, aiSaved.updateAt, null);
      $btn.remove();
      return;
    }
    startGeneration(null, $btn);
  });
  $(document).on('keydown.slmodal', (ev) => {
    if (ev.key === 'Escape') close();
  });
}

/* -------------- "Submitted code" panel below the problem statement -------------- */

/**
 * Requirement: every submitted program of the current user on this problem,
 * as collapsible cards at the bottom of the problem description. The panel
 * lives inside .problem-content, which the Scratchpad reuses as its
 * statement pane, so it shows both in and out of the IDE. Pretest runs are
 * excluded server-side.
 */
export async function refreshAttemptsPanel() {
  const uc = window.UiContext || {};
  if (!uc.pdoc || !uc.pdoc.docId) return;
  if (!SCRATCHPAD_TYPES.includes(problemType())) return; // code history only
  let res;
  try {
    res = await request.get(trajectoryUrl());
  } catch (e) {
    return; // guests / errors: the panel is best-effort
  }
  const attempts = res.attempts || [];
  ensureSiteStyle();
  let $panel = $('#sl-attempts');
  if (!$panel.length) {
    const $content = $('.problem-content');
    if (!$content.length) return;
    $panel = $('<div id="sl-attempts" class="typo"></div>').appendTo($content);
  }
  let html = `<h3>${esc(i18n('Submitted code'))}</h3>`;
  if (!attempts.length) {
    html += `<p class="text-gray">${esc(i18n('No submissions yet.'))}</p>`;
    $panel.html(html);
    return;
  }
  attempts.forEach((a, idx) => {
    const open = idx === attempts.length - 1 ? ' open' : '';
    const when = a.at ? new Date(a.at).toLocaleString() : '';
    html += `<details class="sl-attempt"${open}>`
      + `<summary><span class="sl-badge${a.accepted ? ' pass' : ''}">${esc(a.statusText || '')}</span>`
      + `${esc(i18n('Attempt'))} #${idx + 1} · ${esc(String(a.score ?? 0))} · ${esc(a.lang || '')}${when ? ` · ${esc(when)}` : ''}</summary>`
      + `<pre><code class="language-${prismLang(a.lang)}">${esc(a.code || '')}</code></pre>`
      + '</details>';
  });
  $panel.html(html);
  import('vj/components/highlighter/prismjs')
    .then(({ default: prism }) => prism.highlightBlocks($panel))
    .catch(() => { /* highlighting is optional */ });
}

/* --------------------- submission tracking (poll -> modal) --------------------- */

let lastTrackedRid = null;

/**
 * Rail footer: re-open the Submit Result modal for the user's LATEST
 * submission on the current problem — works on every surface (the
 * self-learning pages share this rail and modal too).
 */
async function openLastSubmission($btn) {
  const label = $btn.html();
  try {
    $btn.prop('disabled', true).text(i18n('Loading...'));
    const list = await request.get(trajectoryUrl());
    const attempts = (list && list.attempts) || [];
    if (!attempts.length) {
      Notification.info(i18n('No submissions yet.'));
      return;
    }
    const rid = attempts[attempts.length - 1].rid;
    const data = await request.get(`${trajectoryUrl()}?rid=${rid}`);
    showSubmitModal(data);
  } catch (e) {
    Notification.error(e.message);
  } finally {
    $btn.prop('disabled', false).html(label);
  }
}

/**
 * Poll a submission until judged, then refresh the history panel and pop
 * the result modal. Used for scratchpad submissions (via the store hook
 * below) and for inline objective submissions (called from the core problem
 * page instead of redirecting to the record page).
 */
export async function trackSubmission(rid) {
  if (!rid || rid === lastTrackedRid) return;
  lastTrackedRid = rid;
  console.info('[pta-ui] tracking submission', rid, '— judging pill up, modal on verdict');
  showJudging();
  let verdict = null;
  for (let i = 0; i < 120; i++) {
    try {
      const data = await request.get(`${trajectoryUrl()}?rid=${rid}`); // eslint-disable-line no-await-in-loop
      if (data.judged) {
        verdict = data;
        break;
      }
    } catch (e) {
      hideJudging();
      console.warn('[pta-ui] verdict poll failed:', e && e.message);
      Notification.error((e && e.message) || i18n('Submit failed.'));
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, 1500); }); // eslint-disable-line no-await-in-loop
  }
  hideJudging();
  if (!verdict) return;
  refreshAttemptsPanel();
  showSubmitModal(verdict);
}

let hookedStore = null;
let lastToastAt = 0;
let lastToastMsg = '';
let lastSubmitErrorAt = 0;

/** Rejections (e.g. empty code failing server validation) become a toast (deduped across layers). */
function submitErrorToast(e) {
  const msg = String((e && e.message) || e || '');
  const now = Date.now();
  lastSubmitErrorAt = now;
  if (msg === lastToastMsg && now - lastToastAt < 1500) return; // both layers may observe the same failure
  lastToastAt = now;
  lastToastMsg = msg;
  Notification.error(/Field code|\bcode\b.*validation|validation.*\bcode\b/i.test(msg)
    ? i18n('Please write some code before submitting.')
    : (msg || i18n('Submit failed.')));
}

/** Last resort: the newest attempt in the trajectory IS the fresh submission. */
async function latestAttemptRid() {
  try {
    const res = await request.get(trajectoryUrl());
    const attempts = (res && res.attempts) || [];
    return attempts.length ? attempts[attempts.length - 1].rid : null;
  } catch (e) {
    return null;
  }
}

/** Shared rid derivation + tracking for both observation layers. */
async function trackFromSubmitResponse(res, source) {
  let rid = res && res.rid;
  if (!rid && res && res.url) rid = String(res.url).split('/record/')[1];
  if (!rid) {
    // Self-record-hidden contests/homework return { tid } with no rid and no
    // /record/ URL; the backend restores it, and this covers a stale backend.
    rid = await latestAttemptRid();
    if (rid) console.info('[pta-ui] submit rid derived from the trajectory (backend rid-restore hook inactive?)');
  }
  if (rid) trackSubmission(String(rid).split(/[/?#]/)[0]); // lastTrackedRid dedupes across layers
  else {
    console.warn('[pta-ui] submission accepted (via %s) but no rid was derivable — no result modal. '
      + 'Is the backend running the latest self_learning.ts?', source);
  }
}

/**
 * Capture-proof submission tracking at the NETWORK layer — the primary path.
 * react-redux captures store.dispatch BY REFERENCE when the toolbar mounts,
 * so a dispatch wrapper installed after mount sees nothing: that is why every
 * store-level hook was silently inert on core problem pages while the
 * self-learning page (which wraps before mounting) worked. The exported
 * `request` helper is a shared mutable object, so patching request.post is
 * seen by every caller: observe posts to UiContext.postSubmitUrl and drive
 * the judging pill + result modal from their responses.
 */
let submitObserverInstalled = false;
function installSubmitObserver() {
  if (submitObserverInstalled) return;
  submitObserverInstalled = true;
  const origPost = request.post.bind(request);
  request.post = (url, data, ...rest) => {
    const p = origPost(url, data, ...rest);
    try {
      const target = window.UiContext && UiContext.postSubmitUrl;
      if (target && String(url) === String(target)) {
        const isPretest = !!(data && data.pretest);
        p.catch(submitErrorToast); // real submits and pretests both get a friendly failure toast
        if (!isPretest) {
          console.info('[pta-ui] submit observed at the network layer');
          p.then((res) => trackFromSubmitResponse(res, 'network observer'))
            .catch(() => { /* the toast above already handled it */ });
        }
      }
    } catch (e) { /* observation is best-effort */ }
    return p;
  };
  // The promise middleware re-rejects internally on failed submits, and the
  // toolbar discards that derived promise — nothing can catch it. Suppress
  // only rejections that immediately follow a submit failure WE toasted.
  window.addEventListener('unhandledrejection', (ev) => {
    if (Date.now() - lastSubmitErrorAt < 3000) ev.preventDefault();
  });
  console.info('[pta-ui] network-layer submit observer installed — result modal armed');
}

const HOOKED_ACTIONS = ['SCRATCHPAD_POST_SUBMIT', 'SCRATCHPAD_POST_PRETEST'];

/**
 * Action-layer tracking — effective ONLY when installed BEFORE the React
 * tree mounts (react-redux captures the dispatch reference at mount). The
 * core problem page now calls this right after creating the store, mirroring
 * the self-learning page; the late poller below is a harmless no-op belt.
 */
export function hookScratchpadStore() {
  const s = window.store;
  if (!s || typeof s.dispatch !== 'function' || hookedStore === s) return false;
  hookedStore = s;
  console.info('[pta-ui] store.dispatch wrapped (action-layer tracking)');
  const orig = s.dispatch.bind(s);
  s.dispatch = (action) => {
    const hooked = action && HOOKED_ACTIONS.includes(action.type)
      && action.payload && typeof action.payload.then === 'function';
    if (hooked) {
      action.payload.then((res) => {
        if (action.type !== 'SCRATCHPAD_POST_SUBMIT') return;
        return trackFromSubmitResponse(res, 'action layer');
      }).catch(submitErrorToast);
    } else if (action && action.type === 'SCRATCHPAD_POST_SUBMIT_FULFILLED' && action.payload && action.payload.rid) {
      trackSubmission(String(action.payload.rid)); // fallback, if middleware ever routes it here
    }
    const result = orig(action);
    // The toast already fired via the payload catch; this catch only marks
    // the middleware's returned promise as handled.
    if (hooked && result && typeof result.catch === 'function') result.catch(() => {});
    return result;
  };
  return true;
}

function pollStoreHook() {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (hookScratchpadStore() || tries > 150) clearInterval(timer);
  }, 200);
}

/* --------------------------------- page wiring --------------------------------- */

export default new NamedPage([...PROBLEM_PAGES, ...SUBMIT_PAGES, 'self_learning_solve', 'training_detail'], (pagename) => {
  console.info('[pta-ui] site-wide problem UI active on', pagename);
  if (pagename === 'training_detail') {
    // The training page itself only needs its problem links decorated so the
    // problem pages know their training siblings.
    decorateTrainingLinks();
    $(document).on('vjContentNew', decorateTrainingLinks); // pjax section loads
    return;
  }
  // The rail follows the IDE everywhere: any open control (core sidebar or the
  // self-learning button) attaches it; the quit control detaches it.
  $(document).on('click', '[name="problem-sidebar__open-scratchpad"], #sl-open-scratchpad', () => {
    console.info('[pta-ui] rail: scratchpad opening, waiting to attach');
    injectRailWhenReady();
  });
  // Only detach the IDE-mode rail here: on the self-learning solve page the
  // quit flow re-homes the rail into page mode, and that must survive
  // regardless of delegated-handler binding order.
  $(document).on('click', '[name="problem-sidebar__quit-scratchpad"]', () => {
    if (railMode !== 'scratchpad') return;
    removeRail();
    // Contest/homework navigation keeps the same left sidebar on the plain
    // page too, re-homed below the navbar.
    const uc = window.UiContext || {};
    if (PROBLEM_PAGES.includes(pagename) && ((uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) || uc.trainingRail || uc.psetRail)) {
      injectRailForPage();
    }
  });

  if (pagename === 'self_learning_solve') return; // the solve page runs its own richer copy

  if (PROBLEM_PAGES.includes(pagename)) {
    // Requirement 3: no acceptance state below the editor, site-wide. The
    // flag gates the records pane, its toolbar button, and the auto-open on
    // submit — and the scratchpad reads it lazily, after this line runs.
    window.UiContext = window.UiContext || {};
    UiContext.canViewRecord = false;
    fetchActivityKinds(); // warm the kind-grouped rail for contests/homework
  }

  const type = problemType();

  if (!SCRATCHPAD_TYPES.includes(type)) {
    // Quiz-style problems have no IDE, but contest/homework navigation still
    // deserves the same left sidebar, below the navbar in page mode. Their
    // submit flow pops the result modal via trackSubmission, called from the
    // core problem page instead of redirecting to the record page.
    const uc = window.UiContext || {};
    if (PROBLEM_PAGES.includes(pagename) && ((uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) || uc.trainingRail || uc.psetRail)) {
      injectRailForPage();
    }
    return;
  }

  const isDomainRoot = !!(window.UiContext && UiContext.isDomainRoot);
  if (SUBMIT_PAGES.includes(pagename)) {
    if (isSubjectivePid()) return; // subjective tasks have no code submit page
    if (isDomainRoot) return; // problem authors keep the classic submit page
    // The plain paste-code page is superseded by the IDE.
    const target = window.location.pathname.replace(/\/submit\/?$/, '') + window.location.search;
    window.location.replace(target);
    return;
  }

  if (isSubjectivePid()) {
    // Project-level subjective task (pid S...): no judge pipeline at all —
    // the dedicated module renders the submission UI; only the rail applies.
    const uc = window.UiContext || {};
    if (PROBLEM_PAGES.includes(pagename) && ((uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) || uc.trainingRail || uc.psetRail)) {
      injectRailForPage();
    }
    return;
  }

  // Problem pages, programming: submission history + result-modal tracking.
  refreshAttemptsPanel();
  $(document).on('vjContentNew', refreshAttemptsPanel); // statement pjax swaps rebuild the panel
  installSubmitObserver(); // capture-proof primary: observes the submit POST itself
  pollStoreHook(); // belt: no-op once the core page wraps the store before mount

  if (isDomainRoot) {
    // Requirement: domain roots (and super-admins) keep the ORIGINAL problem
    // page — with its edit sidebar — instead of auto-entering the IDE. The
    // page's own "Enter IDE" button still works manually, and the rail plus
    // submission features above remain available.
    console.info('[pta-ui] domain root detected — keeping the original problem page');
    return;
  }

  // Auto-enter: the core page binds the open handler in its own module; poll
  // briefly so module ordering never matters, then enter exactly once.
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if ($('body').hasClass('mode--scratchpad')) {
      clearInterval(timer);
      injectRailWhenReady();
      return;
    }
    const $btn = $('[name="problem-sidebar__open-scratchpad"]');
    if ($btn.length) {
      clearInterval(timer);
      $btn.first().trigger('click'); // the click hook above attaches the rail
    } else if (tries > 30) {
      clearInterval(timer); // ~3s: no scratchpad affordance on this page
    }
  }, 100);
});
