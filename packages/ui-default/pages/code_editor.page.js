import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';
import { delay } from 'vj/utils';

/**
 * Site-wide LeetCode-style code editing.
 *
 * Upgrades every plain code textarea — the problem submit page, its contest
 * and homework variants, the self-learning solve page, and anything else that
 * renders `textarea[name="code"]` — to the Monaco editor Hydro already ships
 * (the same engine LeetCode uses): syntax highlighting, line numbers, bracket
 * matching, find/replace, folding, multi-cursor. Highlighting follows the
 * form's language select live, including Hydro's visual language picker,
 * which writes to a hidden select without firing a change event.
 *
 * Textareas owned by the built-in editor autoload (data-markdown / data-yaml /
 * data-json / data-plain) are left to it, and if Monaco fails to load the
 * plain textarea keeps working untouched.
 */

const monacoLangOf = (key) => (window.LANGS && window.LANGS[key] && window.LANGS[key].monaco) || 'plaintext';

async function mount(element) {
  const $code = $(element);
  if ($code.data('monacoified')) return;
  if ($code.is('[data-markdown],[data-yaml],[data-json],[data-plain]')) return;
  $code.data('monacoified', true);
  const $form = $code.closest('form');
  const $lang = ($form.length ? $form : $code.parent()).find('select[name="lang"]');
  const initial = $lang.length ? monacoLangOf($lang.val()) : 'plaintext';
  const visible = $code.is(':visible') && ($code.height() || 0) > 0;
  if (visible && $code.height() < 320) $code.css('height', '420px');
  try {
    const [{ load }, { default: Editor }] = await Promise.all([
      import('vj/components/monaco/loader'),
      import('vj/components/editor'),
    ]);
    await load([initial]);
    const editor = Editor.getOrConstruct($code, {
      language: initial,
      // Hidden containers (e.g. lazily revealed forms) auto-grow with content
      // instead of collapsing to a zero-height pane.
      autoResize: !visible,
      autoLayout: true,
    });
    // Some pages restore cached drafts into the textarea asynchronously after
    // load; adopt such content if the editor is still empty when it arrives.
    setTimeout(() => {
      const v = $code.val();
      if (editor.model && v && !editor.model.getValue()) editor.model.setValue(v);
    }, 1000);
    if ($lang.length) {
      const syncLanguage = () => setTimeout(async () => {
        const next = monacoLangOf($lang.val());
        try {
          const { monaco } = await load([next]);
          if (editor.model && editor.model.getLanguageId?.() !== next) {
            monaco.editor.setModelLanguage(editor.model, next);
          }
        } catch (e) { /* keep the previous highlighting */ }
      }, 50);
      $lang.on('change', syncLanguage);
      // Hydro's visual language picker sets the hidden select's value without
      // triggering change — listen to the picker's own selects as well.
      $(document).on('change', '#codelang-selector select', syncLanguage);
    }
  } catch (e) {
    $code.removeData('monacoified'); // Monaco unavailable: the textarea still works
  }
}

function scan($container) {
  $container.find('textarea[name="code"]').get().forEach(mount);
}

export default new AutoloadPage('slGlobalCodeEditorPage', () => {
  scan($('body'));
  $(document).on('vjContentNew', async (e) => {
    await delay(0);
    scan($(e.target));
  });
});
