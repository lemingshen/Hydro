import AutoComplete from '.';
import ProblemSelectAutoCompleteFC from './components/ProblemSelectAutoComplete';

export default class ProblemSelectAutoComplete extends AutoComplete {
  static DOMAttachKey = 'ucwProblemSelectAutoCompleteInstance';

  constructor($dom, options) {
    super($dom, {
      classes: 'problem-select',
      component: ProblemSelectAutoCompleteFC,
      props: {
        multi: options.multi,
        height: 'auto',
        // PTA fork: pin the picker to one task kind (e.g. 'programming' for
        // self-learning sessions). The Type filter disappears and every
        // query carries that kind; omit for the unrestricted picker.
        lockKind: options.lockKind,
      },
      ...options,
    });
  }
}
