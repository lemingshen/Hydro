import { AutoComplete, AutoCompleteHandle, AutoCompleteProps } from '@hydrooj/components';
import PropTypes from 'prop-types';
import React, { forwardRef } from 'react';
import { i18n, request } from 'vj/utils';

/**
 * PTA fork: knowledge-point picker fed by the domain catalog
 * (/knowledge-points JSON). Items are the catalog entries; a name typed
 * that the catalog does not know is accepted as-is (freeSolo) and becomes
 * a new entry when the task is saved. Keys are the names themselves, so
 * the selection round-trips through a plain comma-separated input.
 */
type KP = { name: string, description?: string, count?: number, rollup?: number, childCount?: number, pathText?: string, category?: string } | string;

const nameOf = (x: KP) => (typeof x === 'string' ? x : x.name);

const KnowledgePointSelectAutoComplete = forwardRef<AutoCompleteHandle<KP>, AutoCompleteProps<KP>>((props, ref) => (
  <AutoComplete<KP>
    ref={ref as any}
    cacheKey={`knowledge-${UiContext.domainId}`}
    queryItems={async (query) => {
      const r = await request.get(`${(window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0]}/knowledge-points`, {
        q: query, limit: 30,
      });
      return (r.points || []) as KP[];
    }}
    fetchItems={(keys) => keys.map((k) => ({ name: String(k) }))}
    itemText={nameOf}
    itemKey={nameOf}
    renderItem={(item: KP) => {
      const name = nameOf(item);
      const desc = typeof item === 'string' ? '' : (item.description || '');
      const count = typeof item === 'string' ? 0 : (item.count || 0);
      // 🌳 Where the point sits in the catalog tree, and — for a topic —
      // how many tasks sit beneath it (targeting a topic means "any of
      // the points under it").
      const path = typeof item === 'string' ? '' : (item.pathText || item.category || '');
      const kids = typeof item === 'string' ? 0 : (item.childCount || 0);
      const rollup = typeof item === 'string' ? 0 : (item.rollup || 0);
      return (
        <div className="problem-select__row">
          <span className="problem-select__name">{name}</span>
          {path ? <span className="problem-select__chip" title={i18n('Under')}>{path}</span> : null}
          {kids ? <span className="problem-select__chip" title={i18n('A topic: covers the points beneath it')}>{`${i18n('topic')} · ${kids}`}</span> : null}
          {count || rollup ? <span className="problem-select__chip" title={i18n('Tasks')}>{`\u00d7 ${kids ? rollup : count}`}</span> : null}
          {desc ? <span className="problem-select__chip" title={desc}>{desc}</span> : null}
        </div>
      );
    }}
    {...{
      width: '100%',
      height: 'auto',
      listStyle: { width: 'min(560px, 90vw)' },
      multi: true,
      selectedKeys: [],
      allowEmptyQuery: true,
      freeSolo: true,
      freeSoloConverter: (input) => String(input || '').replace(/[,，]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40),
      ...props,
    }}
  />
));

KnowledgePointSelectAutoComplete.propTypes = {
  width: PropTypes.string,
  height: PropTypes.string,
  listStyle: PropTypes.object,
  onChange: PropTypes.func.isRequired,
  multi: PropTypes.bool,
  selectedKeys: PropTypes.arrayOf(PropTypes.string),
  allowEmptyQuery: PropTypes.bool,
  freeSolo: PropTypes.bool,
  freeSoloConverter: PropTypes.func,
};

KnowledgePointSelectAutoComplete.displayName = 'KnowledgePointSelectAutoComplete';

export default KnowledgePointSelectAutoComplete;
