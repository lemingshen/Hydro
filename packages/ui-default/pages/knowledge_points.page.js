import $ from 'jquery';
import ProblemSelectAutoComplete from 'vj/components/autocomplete/ProblemSelectAutoComplete';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import { ensureAisStyle } from 'vj/pages/ai_studio.page';

/**
 * PTA fork: the DOMAIN KNOWLEDGE-POINT CATALOG (/knowledge-points).
 *
 * One table for the course's whole vocabulary of knowledge points — the
 * detailed skills its programming tasks are labeled with. Teachers search
 * it, add and describe points, rename (the tasks' tags follow), merge
 * duplicates, delete, open any point to see the tasks carrying it, and
 * attach / detach points on any task. Tags ARE knowledge points: the
 * problem edit page picks from this catalog, the AI Studio labels new
 * programming tasks against it, and tags in use on tasks that are not
 * catalog entries yet (older data, imports) are listed for import.
 */

const esc = (t) => $('<i>').text(String(t ?? '')).html();
const KIND_LABEL = { programming: 'Programming', objective: 'Objective', subjective: 'Subjective' };
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');
const base = () => window.location.pathname;
const jsonUrl = (params) => `${base()}?_fmt=json${params ? `&${params}` : ''}`;
const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];

const STYLE = [
  '.kp__bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 0 0 14px; }',
  '.kp__search { flex: 1 1 260px; max-width: 420px; }',
  '.kp__stat { font-size: 12px; color: var(--pta-ink-faint); }',
  '.kp__form { display: grid; grid-template-columns: minmax(180px, 1.2fr) minmax(220px, 2fr) minmax(160px, 1.2fr) minmax(120px, .8fr) auto; gap: 8px; align-items: center; margin: 0 0 16px; }',
  '.kp__form input, .kp__edit input { width: 100%; }',
  '@media (max-width: 900px) { .kp__form { grid-template-columns: 1fr 1fr; } }',
  '.kp__table { width: 100%; border-collapse: collapse; font-size: 13px; }',
  '.kp__table th, .kp__table td { padding: 8px 8px; border-bottom: 1px solid var(--pta-line-soft); text-align: left; vertical-align: top; }',
  '.kp__table th { font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--pta-ink-faint); }',
  '.kp__name { font-weight: 600; color: var(--pta-ink); cursor: pointer; }',
  '.kp__name:hover { text-decoration: underline; }',
  '.kp__desc { color: var(--pta-ink-soft); font-size: 12.5px; }',
  '.kp__alias { display: inline-block; border-radius: 999px; padding: 1px 8px; margin: 1px 4px 1px 0; font-size: 11px; background: var(--pta-card-3); border: 1px solid var(--pta-line); color: var(--pta-ink-soft); }',
  '.kp__cat { display: inline-block; border-radius: 6px; padding: 1px 7px; font-size: 11px; background: var(--pta-blue-soft); border: 1px solid var(--pta-blue-line); color: var(--pta-blue-text); }',
  '.kp__count { display: inline-block; min-width: 28px; text-align: center; border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: bold; background: var(--pta-violet-soft); color: var(--pta-violet-text); border: 1px solid var(--pta-violet-line); cursor: pointer; }',
  '.kp__count--zero { background: var(--pta-card-3); color: var(--pta-ink-faint); border-color: var(--pta-line); }',
  '.kp__src { font-size: 11px; color: var(--pta-ink-faint); }',
  '.kp__actions { white-space: nowrap; }',
  '.kp__actions .ais__btn { margin-right: 4px; }',
  '.kp__edit { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(220px, 2fr) minmax(160px, 1fr) minmax(120px, .7fr); gap: 8px; align-items: center; }',
  '.kp__detail { background: var(--pta-card-2); border-radius: 10px; padding: 10px 12px; }',
  '.kp__tasks { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 10px; }',
  '.kp__task { display: flex; gap: 8px; align-items: center; font-size: 12.5px; }',
  '.kp__task code { font-family: var(--code-font-family); }',
  '.kp__task .kp__hidden { font-size: 11px; color: var(--pta-ink-faint); }',
  '.kp__attach { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
  '.kp__attach .kp__attach-input { flex: 1 1 320px; max-width: 520px; }',
  '.kp__untracked { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
  '.kp__untracked .ais__btn { margin: 0; }',
  '.kp__untag { display: inline-flex; gap: 6px; align-items: center; border-radius: 999px; padding: 3px 6px 3px 10px; font-size: 12px; background: var(--pta-card-3); border: 1px solid var(--pta-line); color: var(--pta-ink-soft); }',
  '.kp__empty { color: var(--pta-ink-faint); font-size: 12.5px; padding: 14px 0; }',
].join('\n');

let state = { points: [], untracked: [], total: 0, canEditProblems: false, q: '' };
let expanded = null; // point id whose task list is open
let editing = null; // point id whose row is in edit mode

function ensureStyle() {
  ensureAisStyle();
  if (!document.getElementById('kp-style')) $('<style>').attr('id', 'kp-style').text(STYLE).appendTo(document.head);
}

async function load(q) {
  const data = await request.get(jsonUrl(q ? `q=${encodeURIComponent(q)}` : ''));
  state = { ...state, ...data, q: q || '' };
}

function rowHtml(p) {
  const can = state.canEditProblems;
  if (editing === p._id) {
    return `<tr class="kp__row" data-id="${esc(p._id)}"><td colspan="7">
      <div class="kp__edit">
        <input type="text" class="textbox kp__e-name" maxlength="40" value="${esc(p.name)}" placeholder="${esc(i18n('Name'))}">
        <input type="text" class="textbox kp__e-desc" maxlength="400" value="${esc(p.description)}" placeholder="${esc(i18n('Description (one or two sentences)'))}">
        <input type="text" class="textbox kp__e-alias" value="${esc((p.aliases || []).join(', '))}" placeholder="${esc(i18n('Aliases, comma-separated'))}">
        <input type="text" class="textbox kp__e-cat" maxlength="40" value="${esc(p.category)}" placeholder="${esc(i18n('Category'))}">
      </div>
      <div class="aisd__bar" style="margin-top:8px;">
        <button class="ais__btn ais__btn--sm kp__e-save">💾 ${esc(i18n('Save'))}</button>
        <button class="ais__btn ais__btn--ghost ais__btn--sm kp__e-cancel">${esc(i18n('Cancel'))}</button>
        <span class="aisd__meta">${esc(i18n('Renaming rewrites the tag on every task that carries this point; the old name is kept as an alias.'))}</span>
      </div>
    </td></tr>`;
  }
  return `<tr class="kp__row" data-id="${esc(p._id)}">
    <td><span class="kp__name" title="${esc(i18n('Show the tasks carrying this point'))}">${esc(p.name)}</span></td>
    <td class="kp__desc">${esc(p.description || '')}</td>
    <td>${(p.aliases || []).map((a) => `<span class="kp__alias">${esc(a)}</span>`).join('')}</td>
    <td>${p.category ? `<span class="kp__cat">${esc(p.category)}</span>` : ''}</td>
    <td><span class="kp__count${p.count ? '' : ' kp__count--zero'}" title="${esc(i18n('Tasks carrying this point'))}">${p.count}</span></td>
    <td class="kp__src">${esc(i18n(p.source === 'ai' ? 'AI' : p.source === 'import' ? 'imported' : 'teacher'))}<br>${esc(fmtTs(p.updateAt))}</td>
    <td class="kp__actions">
      <button class="ais__btn ais__btn--ghost ais__btn--sm kp__edit-btn" title="${esc(i18n('Edit'))}">✎</button>
      ${can ? `<button class="ais__btn ais__btn--ghost ais__btn--sm kp__merge-btn" title="${esc(i18n('Merge into another point'))}">⇄</button>
      <button class="ais__btn ais__btn--ghost ais__btn--sm kp__del-btn" title="${esc(i18n('Delete'))}">🗑</button>` : ''}
    </td>
  </tr>${expanded === p._id ? `<tr class="kp__detail-row" data-id="${esc(p._id)}"><td colspan="7"><div class="kp__detail" data-id="${esc(p._id)}">${esc(i18n('Loading...'))}</div></td></tr>` : ''}`;
}

function render($root) {
  const untracked = state.untracked || [];
  $root.html(`
    <div class="ais">
      <div class="ais__head">🏷️ <span class="ais__title">${esc(i18n('Knowledge points'))}</span>
        <span class="ais__hint">${esc(i18n('The domain\u2019s shared vocabulary. A task\u2019s tags are its knowledge points: the edit page picks from this catalog, and the AI Studio labels programming tasks against it.'))}</span></div>
      <div class="ais__body">
        <div class="kp__bar">
          <input type="text" class="textbox kp__search" value="${esc(state.q)}" placeholder="${esc(i18n('Search by name, alias, description or category…'))}">
          <span class="kp__stat">${esc(i18n('{0} points in this domain').replace('{0}', state.total))}${state.q ? ` · ${esc(i18n('{0} shown').replace('{0}', state.points.length))}` : ''}</span>
          <a class="ais__btn ais__btn--ghost ais__btn--sm" href="${domainPrefix()}/ai-studio">✨ ${esc(i18n('AI Studio'))}</a>
        </div>
        <div class="ais__label">➕ ${esc(i18n('Add a knowledge point'))}</div>
        <div class="kp__form">
          <input type="text" class="textbox kp__n-name" maxlength="40" placeholder="${esc(i18n('Name (2\u20136 words, e.g. \u201cOff-by-one in loop bounds\u201d)'))}">
          <input type="text" class="textbox kp__n-desc" maxlength="400" placeholder="${esc(i18n('Description (one or two sentences)'))}">
          <input type="text" class="textbox kp__n-alias" placeholder="${esc(i18n('Aliases, comma-separated'))}">
          <input type="text" class="textbox kp__n-cat" maxlength="40" placeholder="${esc(i18n('Category'))}">
          <button class="ais__btn ais__btn--sm kp__n-add">➕ ${esc(i18n('Add'))}</button>
        </div>
        ${state.points.length ? `<table class="kp__table">
          <thead><tr><th>${esc(i18n('Name'))}</th><th>${esc(i18n('Description'))}</th><th>${esc(i18n('Aliases'))}</th><th>${esc(i18n('Category'))}</th><th>${esc(i18n('Tasks'))}</th><th>${esc(i18n('Source'))}</th><th></th></tr></thead>
          <tbody>${state.points.map(rowHtml).join('')}</tbody>
        </table>` : `<div class="kp__empty">${esc(state.q ? i18n('No knowledge point matches your search.') : i18n('The catalog is empty. Add points here, import the tags below, or let the AI Studio label a task — its points are registered automatically.'))}</div>`}
        ${untracked.length ? `
        <div class="ais__label" style="margin-top:18px;">📥 ${esc(i18n('Tags on programming tasks that are not catalog entries yet'))}</div>
        <div class="aisd__meta" style="margin-bottom:8px;">${esc(i18n('Import the ones that are knowledge points; remove organizational leftovers (e.g. \u201cai-draft\u201d) from every task with the bin button, or leave them alone.'))}</div>
        <div class="kp__untracked">
          ${untracked.map((t) => `<span class="kp__untag"><b>${esc(t.name)}</b> <span class="aisd__meta">×${t.count}</span><button class="ais__btn ais__btn--ghost ais__btn--sm kp__import" data-name="${esc(t.name)}">${esc(i18n('Import'))}</button>${state.canEditProblems ? `<button class="ais__btn ais__btn--ghost ais__btn--sm kp__untag-rm" data-name="${esc(t.name)}" title="${esc(i18n('Remove this tag from every task'))}">🗑</button>` : ''}</span>`).join('')}
          ${untracked.length > 1 ? `<button class="ais__btn ais__btn--ghost ais__btn--sm kp__import-all">${esc(i18n('Import all'))}</button>` : ''}
        </div>` : ''}
      </div>
    </div>`);
  wire($root);
  if (expanded) loadDetail($root, expanded);
}

async function loadDetail($root, id) {
  const $box = $root.find(`.kp__detail[data-id="${id}"]`);
  if (!$box.length) return;
  try {
    const data = await request.get(jsonUrl(`id=${encodeURIComponent(id)}`));
    const problems = data.problems || [];
    const can = state.canEditProblems;
    $box.html(`
      <div class="ais__label" style="margin-top:0;">${esc(i18n('Tasks carrying \u201c{0}\u201d').replace('{0}', data.point.name))} (${problems.length})</div>
      ${problems.length ? `<div class="kp__tasks">${problems.map((p) => `<div class="kp__task" data-doc="${p.docId}">
          <span class="problem-select__kind problem-select__kind--${esc(p.kind || 'programming')}">${esc(i18n(KIND_LABEL[p.kind] || KIND_LABEL.programming))}</span>
          <a href="${domainPrefix()}/p/${esc(p.pid)}" target="_blank" rel="noopener"><code>${esc(p.pid)}</code> ${esc(p.title)}</a>
          ${p.hidden ? `<span class="kp__hidden">(${esc(i18n('hidden'))})</span>` : ''}
          ${can ? `<button class="ais__btn ais__btn--ghost ais__btn--sm kp__detach" data-doc="${p.docId}" title="${esc(i18n('Remove this point from the task'))}">×</button>` : ''}
        </div>`).join('')}</div>` : `<div class="kp__empty">${esc(i18n('No task carries this point yet.'))}</div>`}
      ${can ? `<div class="kp__attach">
        <span class="aisd__meta">${esc(i18n('Attach to a task'))}:</span>
        <input type="text" class="textbox kp__attach-input" placeholder="${esc(i18n('Search a task…'))}">
      </div>` : ''}`);
    if (can) {
      const $in = $box.find('.kp__attach-input');
      const picker = ProblemSelectAutoComplete.getOrConstruct($in, { multi: false, clearDefaultValue: false });
      picker.onChange(async (v) => {
        const docId = String(v || '').split(',')[0].trim();
        if (!docId) return;
        try {
          await request.post(base(), { operation: 'attach', pid: docId, id });
          Notification.success(i18n('Attached.'));
          await refresh($root);
        } catch (e) {
          Notification.error(e.message);
        }
      });
    }
    $box.find('.kp__detach').on('click', async function onDetach() {
      const docId = $(this).attr('data-doc');
      try {
        await request.post(base(), { operation: 'detach', pid: docId, id });
        await refresh($root);
      } catch (e) {
        Notification.error(e.message);
      }
    });
  } catch (e) {
    $box.html(`<div class="kp__empty">⚠ ${esc(e.message)}</div>`);
  }
}

async function refresh($root) {
  await load(state.q);
  render($root);
}

function wire($root) {
  let searchTimer = null;
  $root.find('.kp__search').on('input', function onSearch() {
    const q = String($(this).val() || '');
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        await load(q);
        const keepFocus = document.activeElement === this;
        render($root);
        if (keepFocus) {
          const $s = $root.find('.kp__search').trigger('focus');
          const el = $s.get(0);
          if (el && el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
        }
      } catch (e) {
        Notification.error(e.message);
      }
    }, 250);
  });

  const act = async ($b, fn) => {
    $b.prop('disabled', true);
    try {
      await fn();
    } catch (e) {
      Notification.error(e.message);
    } finally {
      $b.prop('disabled', false);
    }
  };

  $root.find('.kp__n-add').on('click', function onAdd() {
    const name = String($root.find('.kp__n-name').val() || '').trim();
    if (!name) {
      Notification.warn(i18n('A knowledge point needs a name.'));
      return;
    }
    act($(this), async () => {
      await request.post(base(), {
        operation: 'create',
        name,
        description: String($root.find('.kp__n-desc').val() || ''),
        aliases: String($root.find('.kp__n-alias').val() || ''),
        category: String($root.find('.kp__n-cat').val() || ''),
      });
      Notification.success(i18n('Knowledge point added.'));
      await refresh($root);
    });
  });
  $root.find('.kp__n-name, .kp__n-desc, .kp__n-alias, .kp__n-cat').on('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      $root.find('.kp__n-add').trigger('click');
    }
  });

  $root.find('.kp__name, .kp__count').on('click', function onToggle() {
    const id = $(this).closest('tr').attr('data-id');
    expanded = expanded === id ? null : id;
    render($root);
  });

  $root.find('.kp__edit-btn').on('click', function onEdit() {
    editing = $(this).closest('tr').attr('data-id');
    render($root);
    $root.find('.kp__e-name').trigger('focus');
  });
  $root.find('.kp__e-cancel').on('click', () => {
    editing = null;
    render($root);
  });
  $root.find('.kp__e-save').on('click', function onSave() {
    const $row = $(this).closest('tr');
    const id = $row.data('id');
    act($(this), async () => {
      const res = await request.post(base(), {
        operation: 'update',
        id,
        name: String($row.find('.kp__e-name').val() || ''),
        description: String($row.find('.kp__e-desc').val() || ''),
        aliases: String($row.find('.kp__e-alias').val() || ''),
        category: String($row.find('.kp__e-cat').val() || ''),
      });
      editing = null;
      Notification.success(res.touched
        ? i18n('Saved — the tag was rewritten on {0} task(s).').replace('{0}', res.touched)
        : i18n('Saved.'));
      await refresh($root);
    });
  });

  $root.find('.kp__del-btn').on('click', function onDel() {
    const $row = $(this).closest('tr');
    const id = $row.data('id');
    const p = state.points.find((x) => x._id === id);
    if (!p) return;
    const msg = p.count
      ? i18n('Delete \u201c{0}\u201d? It is removed from the {1} task(s) that carry it.').replace('{0}', p.name).replace('{1}', p.count)
      : i18n('Delete \u201c{0}\u201d?').replace('{0}', p.name);
    if (!window.confirm(msg)) return;
    act($(this), async () => {
      await request.post(base(), { operation: 'delete', id });
      if (expanded === id) expanded = null;
      Notification.success(i18n('Deleted.'));
      await refresh($root);
    });
  });

  $root.find('.kp__merge-btn').on('click', function onMerge() {
    const $row = $(this).closest('tr');
    const id = $row.data('id');
    const p = state.points.find((x) => x._id === id);
    if (!p) return;
    const others = state.points.filter((x) => x._id !== id);
    if (!others.length) {
      Notification.warn(i18n('There is no other knowledge point to merge into.'));
      return;
    }
    const target = window.prompt(
      `${i18n('Merge \u201c{0}\u201d into which knowledge point? Type its exact name.').replace('{0}', p.name)}\n\n${others.slice(0, 40).map((x) => `• ${x.name}`).join('\n')}${others.length > 40 ? '\n…' : ''}`,
    );
    if (!target?.trim()) return;
    const dst = others.find((x) => x.name.toLowerCase() === target.trim().toLowerCase())
      || others.find((x) => (x.aliases || []).some((a) => a.toLowerCase() === target.trim().toLowerCase()));
    if (!dst) {
      Notification.error(i18n('No knowledge point named \u201c{0}\u201d.').replace('{0}', target.trim()));
      return;
    }
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'merge', id, into: dst._id });
      if (expanded === id) expanded = null;
      Notification.success(i18n('Merged into \u201c{0}\u201d — {1} task(s) relabeled.').replace('{0}', res.point.name).replace('{1}', res.touched || 0));
      await refresh($root);
    });
  });

  $root.find('.kp__import').on('click', function onImport() {
    const name = $(this).attr('data-name');
    act($(this), async () => {
      await request.post(base(), { operation: 'import', names: name });
      await refresh($root);
    });
  });
  $root.find('.kp__untag-rm').on('click', function onRemoveTag() {
    const name = $(this).attr('data-name');
    const t = (state.untracked || []).find((x) => x.name === name);
    const count = t ? t.count : 0;
    if (!window.confirm(i18n('Remove the tag \u201c{0}\u201d from all {1} task(s)? This cannot be undone.').replace('{0}', name).replace('{1}', count))) return;
    act($(this), async () => {
      const res = await request.post(base(), { operation: 'removeTag', name });
      Notification.success(i18n('Removed \u201c{0}\u201d from {1} task(s).').replace('{0}', name).replace('{1}', res.touched || 0));
      await refresh($root);
    });
  });
  $root.find('.kp__import-all').on('click', function onImportAll() {
    const names = (state.untracked || []).map((t) => t.name).join('\n');
    if (!window.confirm(i18n('Import all {0} tags as knowledge points?').replace('{0}', state.untracked.length))) return;
    act($(this), async () => {
      await request.post(base(), { operation: 'import', names });
      await refresh($root);
    });
  });
}

export default new NamedPage('knowledge_points', () => {
  ensureStyle();
  const $root = $('#kp-root');
  load('').then(() => render($root))
    .catch((e) => $root.html(`<div class="ais"><div class="ais__body"><div class="ais__empty">⚠ ${esc(e.message)}</div></div></div>`));
});
