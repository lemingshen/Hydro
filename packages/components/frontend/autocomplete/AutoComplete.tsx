import './autocomplete.scss';

import { debounce, uniqueId } from 'lodash';
import React, {
  forwardRef, useCallback, useEffect, useLayoutEffect,
  useImperativeHandle, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import Icon from '../Icon';

export interface AutoCompleteProps<Item> {
  width?: string;
  /**
   * if you need fix height, set to at least "30px"
   * for Hydro, no less then "34px" can be better
   */
  height?: string;
  disabled?: boolean;
  placeholder?: string;
  disabledHint?: string;
  listStyle?: React.CSSProperties;
  cacheKey?: string;
  renderItem?: (item: Item) => any;
  /**
   * Optional detail panel for the item the user is currently on (hover OR
   * keyboard focus). When supplied, the panel is portalled to <body> and
   * positioned beside the dropdown, because `.autocomplete-list` is a
   * scrolling `overflow: auto` box that would otherwise clip it.
   * Autocompletes that omit this prop are completely unaffected.
   */
  renderPreview?: (item: Item) => React.ReactNode;
  /**
   * Opaque token describing consumer-owned state that changes what
   * queryItems() returns (filters, scopes...). Changing it re-runs the query
   * and segments the result cache, so filtered and unfiltered results for
   * the same text never collide. Consumers that omit it are unaffected.
   */
  queryKey?: string | number;
  queryItems?: (query: string) => Promise<Item[]> | Item[];
  fetchItems?: (ids: string[]) => Promise<Item[]> | Item[];
  itemText?: (item: Item) => string;
  itemKey?: (item: Item) => string;
  onChange?: (value: string) => any;
  multi?: boolean;
  draggable?: boolean;
  selectedKeys?: string[];
  allowEmptyQuery?: boolean;
  freeSolo?: boolean;
  freeSoloConverter?: (value: string) => string;
  /**
   * Multi mode: keep items that are already selected OUT of the dropdown
   * (upstream lists them with a check mark and toggles them off on click).
   * Picking an item removes it from the list at once; removing its tag puts
   * it back. When everything the query returned is already selected, the
   * dropdown shows `emptyHint` instead of nothing. Consumers that omit it
   * are unaffected.
   */
  hideSelected?: boolean;
  /** Text of the single row shown when `hideSelected` leaves nothing to pick. */
  emptyHint?: string;
}

export interface AutoCompleteHandle<Item> {
  getSelectedItems: () => Item[];
  getSelectedItemKeys: () => string[];
  setSelectedItems: (items: Item[]) => void;
  getQuery: () => string;
  setQuery: (query: string) => void;
  setSelectedKeys: (keys: string[]) => void;
  triggerQuery: () => any;
  closeList: () => void;
  getValue: () => string;
  clear: () => void;
  focus: () => void;
}

const superCache = {};

/** Hover-preview panel geometry (see AutoCompleteProps.renderPreview). */
const PREVIEW_WIDTH = 380;
const PREVIEW_GAP = 8;
const PREVIEW_MIN_HEIGHT = 160;
const PREVIEW_DELAY = 160;

function DraggableSelection({
  type, id, move, children, ...props
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, drag] = useDrag<{ id: string }, any, boolean>(() => ({
    type,
    item: { id },
    collect: (m) => m.isDragging(),
  }));
  const [, drop] = useDrop({
    accept: type,
    hover: (item: { id: string }) => {
      if (!ref.current) return;
      move(item.id, id);
    },
  });
  drag(drop(ref));
  return (
    <div ref={ref} {...props} style={{ opacity: isDragging ? 0.2 : 1 }}>
      {children}
    </div>
  );
}

// eslint-disable-next-line prefer-arrow-callback
const AutoComplete = forwardRef(function Impl<T>(props: AutoCompleteProps<T>, ref: React.Ref<AutoCompleteHandle<T>>) {
  const {
    multi = false, width = '100%', height = 'auto',
    freeSolo = false, allowEmptyQuery = false, listStyle = {},
    disabled = false, disabledHint = '', draggable = multi,
    hideSelected = false, emptyHint = '',
  } = props;
  const queryItems = props.queryItems ?? (() => []);
  const renderItem = props.renderItem ?? ((item) => item);
  const itemText = props.itemText ?? ((item) => item.toString());
  const itemKey = props.itemKey ?? itemText;
  const onChange = props.onChange ?? (() => { });
  const freeSoloConverter = freeSolo ? props.freeSoloConverter ?? ((i) => i) : (i) => i;

  const [focused, setFocused] = useState(false); // is focused
  const [selectedKeys, setSelectedKeys] = useState(props.selectedKeys || []); // keys of selected items
  const [itemList, setItemList] = useState([]); // items list
  const [currentItem, setCurrentItem] = useState(null); // index of current item (in item list)
  const [rerender, setRerender] = useState(false);
  const [draggableId] = useState(() => uniqueId());

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  /*
   * The rows actually on screen. With `hideSelected` (multi mode) the
   * selected items drop out of the query result as they are picked and
   * return as their tags are removed — the query result itself is left
   * intact, so no re-query is needed either way. Everything that walks the
   * dropdown (keyboard, mouse, preview, render) goes through this list.
   */
  const hidingSelected = hideSelected && multi;
  const visibleList = hidingSelected ? itemList.filter((item) => !selectedKeys.includes(itemKey(item))) : itemList;
  const allSelected = hidingSelected && itemList.length > 0 && visibleList.length === 0;
  useEffect(() => {
    // Keep the highlighted row inside the visible list after it shrinks or grows.
    if (!hidingSelected) return;
    if (currentItem !== null && currentItem >= visibleList.length) setCurrentItem(visibleList.length ? visibleList.length - 1 : null);
    else if (currentItem === null && visibleList.length && !freeSolo) setCurrentItem(0);
  }, [visibleList.length, hidingSelected]);

  let [queryCache, valueCache] = [useRef({}).current, useRef({}).current];
  if (props.cacheKey) {
    superCache[props.cacheKey] ||= { query: {}, value: {} };
    queryCache = superCache[props.cacheKey].query;
    valueCache = superCache[props.cacheKey].value;
  }

  const queryList = async (query) => {
    if (!query && !allowEmptyQuery) {
      setItemList([]);
      setCurrentItem(null);
      return;
    }
    // Cache per (queryKey, query): the same text yields different results
    // under different filters. valueCache stays shared so the labels of
    // already-selected items survive a filter change.
    const cacheId = `${props.queryKey ?? ''}\u0000${query}`;
    try {
      queryCache[cacheId] ||= await queryItems(query);
      for (const item of queryCache[cacheId]) valueCache[itemKey(item)] = item;
      setItemList(queryCache[cacheId]);
      setCurrentItem((!freeSolo && queryCache[cacheId].length) ? 0 : null);
    } catch (e) {
      console.error('Failed to query items', e);
      setItemList([]);
      setCurrentItem(null);
    }
  };

  useEffect(() => {
    setSelectedKeys(props.selectedKeys || []);
  }, [JSON.stringify(props.selectedKeys)]);
  const dispatchChange = () => {
    if (!multi) onChange(inputRef.current?.value);
    else onChange(selectedKeys.filter((v) => v?.trim().length).join(','));
  };

  useEffect(() => {
    dispatchChange();
    if (!multi) return; // Load pre-selected items only in multi mode
    const ids = [];
    for (const key of selectedKeys) if (!valueCache[key]) ids.push(key);
    if (!ids.length) return;
    Promise.resolve(props.fetchItems(ids)).then((items) => {
      for (const item of items) valueCache[itemKey(item)] = item;
      setRerender(!rerender);
    }).catch((e) => {
      console.error('Failed to fetch items', e);
    });
  }, [selectedKeys, multi]);

  const handleInputChange = debounce((e?) => queryList(e ? e.target.value : ''), 300);

  /*
   * Re-query when the consumer's filters change. Defined in the current
   * render on purpose, so it closes over the CURRENT queryList (and thus the
   * current queryItems and cache bucket) — routing this through the
   * imperative handle instead would capture a stale closure, because that
   * handle is only rebuilt when selectedKeys/multi change.
   */
  const queryKeyMounted = useRef(false);
  useEffect(() => {
    if (props.queryKey === undefined) return;
    if (!queryKeyMounted.current) {
      queryKeyMounted.current = true;
      return;
    }
    // Nothing is on screen while the dropdown is closed; the next focus
    // re-queries anyway via allowEmptyQuery.
    if (focused) queryList(inputRef.current?.value ?? '');
  }, [props.queryKey]);

  const toggleItem = (item: T, key = itemKey(item), preserve = false) => {
    const shouldKeepOpen = multi && allowEmptyQuery && inputRef.current.value === '';
    if (multi) {
      const idx = selectedKeys.indexOf(key);
      if (idx !== -1) {
        setSelectedKeys((s) => {
          const newSelectedKeys = [...s];
          newSelectedKeys.splice(idx, 1);
          return newSelectedKeys;
        });
      } else {
        setSelectedKeys((s) => [...s, key]);
      }
      if (!preserve) inputRef.current.value = '';
      inputRef.current.focus();
    } else {
      setSelectedKeys([key]);
      inputRef.current.value = key;
    }
    if (!shouldKeepOpen) {
      setItemList([]);
      setCurrentItem(null);
    }
  };

  const handleInputKeyDown = (e) => {
    const { key, target } = e;
    if (key === 'Escape') {
      setItemList([]);
      setCurrentItem(null);
      return;
    }
    if (key === 'Enter' || key === ',') {
      e.preventDefault();
      if (currentItem !== null && visibleList[currentItem] !== undefined) {
        toggleItem(visibleList[currentItem]);
        return;
      }
      if (freeSolo && target.value !== '') {
        toggleItem(freeSoloConverter(target.value));
      }
      return;
    }
    if (key === 'Backspace') {
      if (target.value.length) return;
      if (selectedKeys.length) {
        setSelectedKeys((s) => s.slice(0, -1));
      }
      return;
    }
    if (key === 'ArrowUp') {
      e.preventDefault();
      if (visibleList.length === 0) return;
      const idx = (currentItem ?? 0) - 1;
      const newIdx = idx < 0 ? visibleList.length - 1 : idx;
      setCurrentItem(newIdx);
      listRef.current?.children[newIdx]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (key === 'ArrowDown') {
      e.preventDefault();
      if (visibleList.length === 0) return;
      const idx = (currentItem ?? visibleList.length - 1) + 1;
      const newIdx = idx >= visibleList.length ? 0 : idx;
      setCurrentItem(newIdx);
      listRef.current?.children[newIdx]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // eslint-disable-next-line no-useless-return
      return;
    }
    // TODO: handle other keys
  };

  useImperativeHandle(ref, () => ({
    getSelectedItems: () => selectedKeys.map((key) => valueCache[key]),
    getSelectedItemKeys: () => [...selectedKeys, inputRef.current?.value].filter((v) => v?.trim().length),
    setSelectedItems: (items) => {
      setSelectedKeys(items.map((i) => itemKey(i)));
      if (!multi && inputRef.current) inputRef.current.value = items.map((i) => itemKey(i)).join(',');
    },
    setSelectedKeys,
    getQuery: () => inputRef.current?.value,
    setQuery: (query) => {
      if (inputRef.current) inputRef.current.value = query;
    },
    triggerQuery: () => queryList(inputRef.current?.value),
    closeList: () => {
      setItemList([]);
      setCurrentItem(null);
    },
    getValue: () => (multi ? selectedKeys.join(',') : (inputRef.current.value ?? '')),
    clear: () => {
      setSelectedKeys([]);
      if (inputRef.current) inputRef.current.value = '';
    },
    focus: () => {
      setFocused(true);
      inputRef.current?.focus();
    },
  }), [selectedKeys, inputRef, multi]);

  /* ----------------------------- hover preview ----------------------------- */
  // `currentItem` already tracks hover (li onMouseMove) and keyboard focus
  // (ArrowUp / ArrowDown), so the preview simply follows it.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewPos, setPreviewPos] = useState<{ top: number, left: number, maxHeight: number } | null>(null);

  useEffect(() => {
    if (!props.renderPreview || currentItem === null || !visibleList.length) {
      setPreviewIndex(null);
      return () => { };
    }
    // Settle first: holding ArrowDown through a few hundred rows should not
    // mount (and fire a request for) a preview of every row it passes.
    const timer = setTimeout(() => setPreviewIndex(currentItem), PREVIEW_DELAY);
    return () => clearTimeout(timer);
  }, [currentItem, itemList, visibleList.length, !props.renderPreview]);

  const positionPreview = useCallback(() => {
    const rect = listRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Prefer the right of the dropdown; flip left when the viewport is too
    // narrow, and clamp so the panel is never pushed off-screen either way.
    const left = window.innerWidth - rect.right - PREVIEW_GAP >= PREVIEW_WIDTH
      ? rect.right + PREVIEW_GAP
      : Math.max(PREVIEW_GAP, rect.left - PREVIEW_WIDTH - PREVIEW_GAP);
    const top = Math.max(PREVIEW_GAP, Math.min(rect.top, window.innerHeight - PREVIEW_MIN_HEIGHT - PREVIEW_GAP));
    setPreviewPos({ top, left, maxHeight: Math.max(PREVIEW_MIN_HEIGHT, window.innerHeight - top - PREVIEW_GAP) });
  }, []);

  useLayoutEffect(() => {
    if (previewIndex === null) return () => { };
    positionPreview();
    window.addEventListener('resize', positionPreview);
    // Capture phase: the dropdown may sit inside a scrolling form panel.
    window.addEventListener('scroll', positionPreview, true);
    return () => {
      window.removeEventListener('resize', positionPreview);
      window.removeEventListener('scroll', positionPreview, true);
    };
  }, [previewIndex, positionPreview]);

  const previewItem = previewIndex === null ? null : (visibleList[previewIndex] ?? null);

  const move = (dragId: string, hoverId: string) => {
    if (dragId === hoverId || !draggable) return;
    const dragIndex = selectedKeys.indexOf(dragId);
    const hoverIndex = selectedKeys.indexOf(hoverId);
    setSelectedKeys((s) => {
      const a = [...s];
      a.splice(dragIndex, 1);
      a.splice(hoverIndex, 0, s[dragIndex]);
      return a;
    });
  };

  return (
    <div className="autocomplete-container" style={{ display: 'inline-block', width: '100%', marginBottom: '1rem' }}>
      <div
        className={focused ? 'autocomplete-wrapper focused' : 'autocomplete-wrapper'}
        style={{ width, height }}
      >
        <DndProvider backend={HTML5Backend} context={window}>
          {multi && selectedKeys.map((key) => {
            const item = valueCache[key];
            return (
              <DraggableSelection type={draggableId} id={key} move={move} className="autocomplete-tag" key={item ? key : `draft-${key}`}>
                <div>{item ? itemText(item) : key}</div>
                <Icon name="close" onClick={() => toggleItem(item, key, true)} />
              </DraggableSelection>
            );
          })}
          <input
            ref={inputRef}
            autoComplete="off"
            hidden={disabled}
            onChange={(e) => {
              dispatchChange();
              handleInputChange(e);
            }}
            onFocus={() => {
              if (allowEmptyQuery) handleInputChange();
              setFocused(true);
            }}
            onPaste={async (e) => {
              if (!multi) return;
              const text = e.clipboardData.getData('text');
              if (!text || (!text.includes(',') && !text.includes('，'))) return;
              e.preventDefault();
              const ids = text.replace(/，/g, ',').split(',').filter((v) => v?.trim().length && !selectedKeys.includes(v));
              if (!ids.length) return;
              try {
                const fetched = await props.fetchItems(ids);
                for (const item of fetched) valueCache[itemKey(item)] = item;
                setSelectedKeys([...selectedKeys, ...fetched.map((val) => itemKey(val))]);
              } catch (err) {
                console.error('Failed to fetch items on paste', err);
              }
            }}
            placeholder={props.placeholder}
            onBlur={() => setFocused(false)}
            onKeyDown={handleInputKeyDown}
            defaultValue={multi ? '' : selectedKeys.join(',')}
          />
        </DndProvider>
      </div>
      {disabled && (
        <input
          disabled
          autoComplete="off"
          value={disabledHint}
        />
      )}
      {focused && allSelected && (
        <ul className="autocomplete-list" style={listStyle} onMouseDown={(e) => e.preventDefault()}>
          <li data-empty="true" style={{ opacity: 0.65, cursor: 'default' }}><div>{emptyHint || 'All matching items are already selected.'}</div></li>
        </ul>
      )}
      {focused && visibleList.length > 0 && (
        <ul ref={listRef} className="autocomplete-list" style={listStyle} onMouseDown={(e) => e.preventDefault()}>
          {visibleList.map((item, idx) => {
            const inner = renderItem(item);
            if (!inner) return null;
            return <li
              key={itemKey(item)}
              onClick={() => toggleItem(item)}
              onMouseMove={() => setCurrentItem(idx)}
              data-selected={selectedKeys.includes(itemKey(item))}
              data-focus={idx === currentItem}
            >
              <div>{inner}</div>
              {selectedKeys.includes(itemKey(item)) && <Icon name="check" />}
            </li>;
          })}
        </ul>
      )}
      {focused && visibleList.length > 0 && previewItem && previewPos && createPortal(
        <div
          className="autocomplete-preview"
          style={{
            top: previewPos.top, left: previewPos.left, width: PREVIEW_WIDTH, maxHeight: previewPos.maxHeight,
          }}
          // Same guard the list uses: clicking or dragging inside the panel
          // must not blur the input and tear the dropdown down.
          onMouseDown={(e) => e.preventDefault()}
        >
          {props.renderPreview(previewItem)}
        </div>,
        document.body,
      )}
    </div>
  );
}) as (<T>(props: AutoCompleteProps<T> & { ref: React.Ref<AutoCompleteHandle<T>> }) => React.ReactElement) & React.FC;

AutoComplete.displayName = 'AutoComplete';

export default AutoComplete;
