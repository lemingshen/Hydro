import { AutoComplete, AutoCompleteHandle, AutoCompleteProps } from '@hydrooj/components';
import type { ProblemDoc } from 'hydrooj/src/interface';
import MarkdownIt from 'markdown-it';
import PropTypes from 'prop-types';
import React, { forwardRef } from 'react';
import { api, i18n, request } from 'vj/utils';

/**
 * PTA UI: the picker a teacher uses to assemble a Test, a Homework or a
 * Self-Learning session.
 *
 * Upstream rendered two stacked lines per row (title, then "ID = n"), so a
 * course with a few hundred tasks produced a dropdown of near-identical
 * two-line entries with no way to tell what a task actually asks. Two
 * changes fix that:
 *
 *  1. Rows are ONE scannable line — kind badge, pid, title (ellipsised),
 *     difficulty and AC ratio — so roughly twice as many fit on screen and
 *     the useful signal is at the front of the line.
 *  2. Whatever row the teacher is on (mouse hover or arrow keys) opens a
 *     statement preview beside the list, so a task can be identified without
 *     leaving the form. The panel itself is generic and lives in
 *     @hydrooj/components; everything below is just its content.
 */

const KIND_LABEL: Record<string, string> = {
  programming: 'Programming',
  objective: 'Objective',
  subjective: 'Subjective',
};

/**
 * Mirrors problemKindOf() in hydrooj/src/handler/problem.ts. `quick` results
 * now carry `kind` from the server; the local fallback keeps the badge
 * working for cached payloads written by an older build, and for the
 * fetchItems() path which only selects docId/pid/title.
 */
function kindOf(pdoc: any): string {
  if (pdoc?.kind && KIND_LABEL[pdoc.kind]) return pdoc.kind;
  const pid = String(pdoc?.pid || '');
  if (/^s/i.test(pid)) return 'subjective';
  if (/^o/i.test(pid)) return 'objective';
  return 'programming';
}

function acRate(pdoc: any): string | null {
  const submit = +pdoc?.nSubmit || 0;
  if (!submit) return null;
  return `${Math.round(((+pdoc.nAccept || 0) / submit) * 100)}%`;
}

/** Statement markdown. `html: false` keeps embedded HTML escaped. */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * Previews are immutable for the lifetime of the form and a teacher sweeps
 * over the same rows repeatedly, so results are cached per problem. Keyed by
 * domain as well: the picker can be re-mounted after a domain switch without
 * a page load.
 */
const previewCache = new Map<string, any>();

interface PreviewState {
  status: 'loading' | 'done' | 'error';
  data: any;
}

function ProblemPreview({ pdoc }: { pdoc: any }) {
  const { docId } = pdoc;
  const cacheKey = `${UiContext.domainId}/${docId}`;
  const [state, setState] = React.useState<PreviewState>(
    () => (previewCache.has(cacheKey)
      ? { status: 'done', data: previewCache.get(cacheKey) }
      : { status: 'loading', data: null }),
  );

  React.useEffect(() => {
    if (previewCache.has(cacheKey)) {
      setState({ status: 'done', data: previewCache.get(cacheKey) });
      return () => { };
    }
    let alive = true;
    setState({ status: 'loading', data: null });
    request.get(`/d/${UiContext.domainId}/p/${docId}/preview`)
      .then((data) => {
        previewCache.set(cacheKey, data);
        if (alive) setState({ status: 'done', data });
      })
      .catch(() => {
        // A hidden problem, a deleted problem or an offline server. The row
        // stays selectable either way — the preview is an aid, not a gate.
        if (alive) setState({ status: 'error', data: null });
      });
    return () => { alive = false; };
  }, [cacheKey]);

  const doc = state.status === 'done' ? state.data : pdoc;
  const kind = kindOf(doc);
  const rate = acRate(doc);
  const tags: string[] = Array.isArray(doc?.tag) ? doc.tag : [];

  return (
    <div className="problem-preview">
      <div className="problem-preview__head">
        <span className={`problem-select__kind problem-select__kind--${kind}`}>{i18n(KIND_LABEL[kind])}</span>
        {doc?.pid ? <span className="problem-preview__pid">{doc.pid}</span> : null}
        {doc?.hidden ? <span className="problem-preview__hidden">{i18n('Hidden')}</span> : null}
      </div>
      <div className="problem-preview__title">{doc?.title || ''}</div>
      <div className="problem-preview__meta">
        <span>{i18n('ID')} = {docId}</span>
        {doc?.difficulty ? <span>{i18n('Difficulty')}: {doc.difficulty}</span> : null}
        {rate ? <span>{i18n('AC rate')}: {rate}</span> : null}
        {doc?.nSubmit ? <span>{i18n('Submissions')}: {doc.nSubmit}</span> : null}
      </div>
      {tags.length ? (
        <div className="problem-preview__tags">
          {tags.slice(0, 8).map((t) => <span key={t} className="problem-preview__tag">{t}</span>)}
        </div>
      ) : null}
      <div className="problem-preview__body">
        {state.status === 'loading' && <p className="problem-preview__dim">{i18n('Loading preview...')}</p>}
        {state.status === 'error' && <p className="problem-preview__dim">{i18n('Preview unavailable.')}</p>}
        {state.status === 'done' && (
          state.data?.statement?.trim()
            ? (
              <div
                className="problem-preview__statement typo"
                // Rendered by markdown-it with html:false, so any HTML in the
                // statement source arrives here already escaped.
                dangerouslySetInnerHTML={{ __html: md.render(state.data.statement) }}
              />
            )
            : <p className="problem-preview__dim">{i18n('No statement provided.')}</p>
        )}
        {state.status === 'done' && state.data?.truncated && (
          <p className="problem-preview__dim">{i18n('Statement truncated.')}</p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- filter bar -------------------------------- */

interface Filters {
  kind: string;
  tags: string[];
  dMin: number;
  dMax: number;
}

const EMPTY_FILTERS: Filters = {
  kind: '', tags: [], dMin: 0, dMax: 0,
};

/** Stable, order-insensitive signature: drives AutoComplete's queryKey. */
function filterSignature(f: Filters): string {
  return [f.kind, [...f.tags].sort().join('\u0001'), f.dMin, f.dMax].join('\u0000');
}

function filtersActive(f: Filters): boolean {
  return !!(f.kind || f.tags.length || f.dMin || f.dMax);
}

/*
 * Difficulty is a 1..10 scale. Bands rather than two <select> boxes, for a
 * concrete reason: a native select must take focus to open its dropdown, and
 * taking focus blurs the problems input, which closes the results list the
 * teacher is filtering. Buttons can suppress focus on mousedown, so the list
 * stays open and refreshes live as bands are clicked.
 *
 * Change the granularity by editing this array alone — the backend takes an
 * arbitrary min/max, so per-level entries ({ label: '5', min: 5, max: 5 })
 * work without any further change.
 */
const DIFFICULTY_BANDS: { label: string, min: number, max: number }[] = [
  { label: 'All', min: 0, max: 0 },
  // Same bands as the AI Studio's rating: intro 1-3, medium 4-7, challenge 8-10.
  { label: '1-3', min: 1, max: 3 },
  { label: '4-7', min: 4, max: 7 },
  { label: '8-10', min: 8, max: 10 },
];

/**
 * The domain's tag vocabulary, fetched once per page. Tags that exist only on
 * hidden problems are already filtered out server-side.
 */
let tagFacetPromise: Promise<{ name: string, count: number }[]> | null = null;
function loadTagFacet(): Promise<{ name: string, count: number }[]> {
  tagFacetPromise ||= request.get(`/d/${UiContext.domainId}/problem/tags`)
    .then((r) => r.tags || [])
    .catch(() => []);
  return tagFacetPromise;
}

function FilterBar({ value, onChange, lockKind }: { value: Filters, onChange: (f: Filters) => void, lockKind?: string }) {
  const [tagQuery, setTagQuery] = React.useState('');
  const [facet, setFacet] = React.useState<{ name: string, count: number }[]>([]);
  const [tagsOpen, setTagsOpen] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    loadTagFacet().then((tags) => { if (alive) setFacet(tags); });
    return () => { alive = false; };
  }, []);

  const suggestions = React.useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    return facet
      .filter((t) => !value.tags.includes(t.name) && (!q || t.name.toLowerCase().includes(q)))
      .slice(0, 12);
  }, [facet, tagQuery, value.tags]);

  const toggleTag = (name: string) => {
    onChange({
      ...value,
      tags: value.tags.includes(name) ? value.tags.filter((t) => t !== name) : [...value.tags, name],
    });
    setTagQuery('');
  };

  // Buttons never need focus, so they can suppress it and leave the results
  // list open. The tag <input> genuinely needs focus and therefore must NOT
  // do this — suppressing it there was what made the field untypeable.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="problem-filter">
      <div className="problem-filter__group">
        <span className="problem-filter__label">{i18n('Type')}</span>
        {lockKind ? (
          // Pinned kind: a single, non-interactive segment so the teacher
          // can see the restriction instead of wondering where the other
          // tasks went.
          <button
            type="button"
            className="problem-filter__seg is-active"
            onMouseDown={keepFocus}
            title={i18n('Only this kind of task can be selected here')}
            disabled
          >
            {i18n(KIND_LABEL[lockKind] || lockKind)} · {i18n('only')}
          </button>
        ) : ['', 'programming', 'objective', 'subjective'].map((k) => (
          <button
            key={k || 'all'}
            type="button"
            className={`problem-filter__seg${value.kind === k ? ' is-active' : ''}`}
            onMouseDown={keepFocus}
            onClick={() => onChange({ ...value, kind: k })}
          >
            {i18n(k ? KIND_LABEL[k] : 'All')}
          </button>
        ))}
      </div>

      <div className="problem-filter__group">
        <span className="problem-filter__label">{i18n('Difficulty')}</span>
        {DIFFICULTY_BANDS.map((b) => (
          <button
            key={b.label}
            type="button"
            className={`problem-filter__seg${value.dMin === b.min && value.dMax === b.max ? ' is-active' : ''}`}
            onMouseDown={keepFocus}
            onClick={() => onChange({ ...value, dMin: b.min, dMax: b.max })}
          >
            {b.min ? b.label : i18n(b.label)}
          </button>
        ))}
      </div>

      <div className="problem-filter__group problem-filter__group--tags">
        <span className="problem-filter__label">{i18n('Knowledge points')}</span>
        {value.tags.map((t) => (
          <button
            key={t}
            type="button"
            className="problem-filter__tag is-active"
            onMouseDown={keepFocus}
            onClick={() => toggleTag(t)}
          >
            {t}<span className="problem-filter__x">×</span>
          </button>
        ))}
        <div className="problem-filter__tagbox">
          <input
            className="problem-filter__taginput"
            value={tagQuery}
            placeholder={i18n('Add tag')}
            autoComplete="off"
            onChange={(e) => { setTagQuery(e.target.value); setTagsOpen(true); }}
            onFocus={() => setTagsOpen(true)}
            onBlur={() => setTimeout(() => setTagsOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                // Exact match first, else the top suggestion: typing a tag
                // in full and pressing Enter should always work.
                const exact = facet.find((t) => t.name.toLowerCase() === tagQuery.trim().toLowerCase());
                const pick = exact || suggestions[0];
                if (pick) toggleTag(pick.name);
              } else if (e.key === 'Escape') setTagsOpen(false);
            }}
          />
          {tagsOpen && suggestions.length > 0 && (
            <ul className="problem-filter__suggest">
              {suggestions.map((t) => (
                <li key={t.name}>
                  {/* keepFocus here holds focus in the tag box, so several
                      tags can be added without re-clicking the field. */}
                  <button type="button" onMouseDown={keepFocus} onClick={() => toggleTag(t.name)}>
                    <span>{t.name}</span><span className="problem-filter__count">{t.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {tagsOpen && !suggestions.length && facet.length > 0 && tagQuery.trim() && (
            <ul className="problem-filter__suggest">
              <li className="problem-filter__empty">{i18n('No matching tags')}</li>
            </ul>
          )}
        </div>
      </div>

      {filtersActive(value) && (
        <button type="button" className="problem-filter__clear" onMouseDown={keepFocus} onClick={() => onChange({ ...EMPTY_FILTERS })}>
          {i18n('Clear filters')}
        </button>
      )}
    </div>
  );
}

type ProblemSelectProps = AutoCompleteProps<ProblemDoc> & {
  /**
   * Pin the picker to one task kind ('programming' | 'objective' |
   * 'subjective'): the Type filter becomes a fixed badge and every query
   * sends that kind, so nothing else is ever listed. Self-learning sessions
   * use it — they are programming-only and the server refuses the rest.
   */
  lockKind?: string;
};

const ProblemSelectAutoComplete = forwardRef<AutoCompleteHandle<ProblemDoc>, ProblemSelectProps>((allProps, ref) => {
  const { lockKind, ...props } = allProps;
  const [filters, setFilters] = React.useState<Filters>({ ...EMPTY_FILTERS });
  // The pinned kind always wins, whatever a stale filter state may hold.
  const kind = lockKind || filters.kind;
  const signature = filterSignature({ ...filters, kind });

  return (
    <div className="problem-select__shell">
      <FilterBar value={filters} onChange={setFilters} lockKind={lockKind} />
      <AutoComplete<ProblemDoc>
        ref={ref as any}
        cacheKey={`problem-${UiContext.domainId}`}
        // Changing this re-runs the query and segments the result cache, so
        // filtered and unfiltered results for the same text never collide.
        queryKey={signature}
        queryItems={async (query) => {
          const { pdocs } = await request.get(`/d/${UiContext.domainId}/p`, {
            q: query,
            quick: true,
            sort: query ? 'default' : 'recent',
            ...kind ? { kind } : {},
            ...filters.tags.length ? { tags: filters.tags.join(',') } : {},
            ...filters.dMin ? { difficultyMin: filters.dMin } : {},
            ...filters.dMax ? { difficultyMax: filters.dMax } : {},
          });
          return pdocs;
        }}
        fetchItems={(ids) => api('problems', { ids: ids.map((i) => +i) }, ['docId', 'pid', 'title'])}
        itemText={(pdoc) => `${`${pdoc.docId} ${pdoc.title}`}`}
        itemKey={(pdoc) => `${pdoc.docId || pdoc}`}
        renderItem={(pdoc: any) => {
          const kind = kindOf(pdoc);
          const rate = acRate(pdoc);
          return (
            <div className="problem-select__row">
              <span className={`problem-select__kind problem-select__kind--${kind}`}>{i18n(KIND_LABEL[kind])}</span>
              <span className="problem-select__pid">{pdoc.pid || `#${pdoc.docId}`}</span>
              <span className="problem-select__name" title={pdoc.title}>{pdoc.title}</span>
              {pdoc.difficulty ? <span className="problem-select__chip">{`\u2605 ${pdoc.difficulty}`}</span> : null}
              {rate ? <span className="problem-select__chip">{rate}</span> : null}
            </div>
          );
        }}
        renderPreview={(pdoc: any) => <ProblemPreview key={pdoc.docId} pdoc={pdoc} />}
        {...{
          width: '100%',
          height: 'auto',
          // Wide enough for a full title on one line; capped so the dropdown
          // still fits a laptop screen next to its preview panel.
          listStyle: { width: 'min(560px, 90vw)' },
          multi: false,
          selectedKeys: [],
          allowEmptyQuery: true,
          freeSolo: false,
          freeSoloConverter: (input) => input,
          ...props,
        }}
      />
    </div>
  );
});

ProblemSelectAutoComplete.propTypes = {
  width: PropTypes.string,
  height: PropTypes.string,
  listStyle: PropTypes.object,
  onChange: PropTypes.func.isRequired,
  multi: PropTypes.bool,
  selectedKeys: PropTypes.arrayOf(PropTypes.string),
  allowEmptyQuery: PropTypes.bool,
  freeSolo: PropTypes.bool,
  freeSoloConverter: PropTypes.func,
  lockKind: PropTypes.string,
};

ProblemSelectAutoComplete.displayName = 'ProblemSelectAutoComplete';

export default ProblemSelectAutoComplete;
