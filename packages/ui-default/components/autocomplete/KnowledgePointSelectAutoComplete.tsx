import AutoComplete from '.';
import KnowledgePointSelectAutoCompleteFC from './components/KnowledgePointSelectAutoComplete';

/**
 * PTA fork: multi-select of knowledge points (= a task's tags) backed by
 * the domain catalog. Attach it to the problem edit page's tag input: the
 * selection is written back as a comma-separated list, exactly what the
 * handler's parseCategory reads, and new names may be typed in (they are
 * registered in the catalog when the problem is saved).
 */
export default class KnowledgePointSelectAutoComplete extends AutoComplete {
  static DOMAttachKey = 'ucwKnowledgePointSelectAutoCompleteInstance';

  constructor($dom, options) {
    super($dom, {
      classes: 'knowledge-point-select',
      component: KnowledgePointSelectAutoCompleteFC,
      props: {
        multi: options.multi ?? true,
        freeSolo: options.freeSolo ?? true,
        height: 'auto',
      },
      ...options,
    });
  }

  /** Current selection as names (the wrapper's value() may hand back the raw input). */
  names(): string[] {
    const v: any = this.ref?.getSelectedItemKeys() ?? String(this.$dom.val() || '').split(',');
    return (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter((x) => x);
  }

  /** Replace the selection (chips + the underlying input). */
  setNames(names: string[]) {
    const clean = [...new Set(names.map((x) => String(x).trim()).filter((x) => x))];
    this.ref?.setSelectedKeys(clean);
    this.$dom.val(clean.join(','));
  }
}
