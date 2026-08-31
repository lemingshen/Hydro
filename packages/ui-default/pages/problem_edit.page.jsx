import $ from 'jquery';
import ReactDOM from 'react-dom/client';
import KnowledgePointSelectAutoComplete from 'vj/components/autocomplete/KnowledgePointSelectAutoComplete';
import { confirm } from 'vj/components/dialog';
import Editor from 'vj/components/editor/index';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request, tpl } from 'vj/utils';
import {
  ensureAisStyle, langEntries, renderAllowLangsDd, wireAllowLangsDd,
} from 'vj/pages/ai_studio.page';

/*
 * PTA fork: tags ARE knowledge points. The tag input is a multi-select
 * picker over the domain catalog (new names may be typed and are registered
 * when the problem is saved), and the sidebar lists the catalog for
 * click-to-add. Hydro's site-wide category widget is gone from this page.
 */
function initKnowledgePoints() {
  const $txt = $('[name="tag"]');
  if (!$txt.length) return;
  const picker = KnowledgePointSelectAutoComplete.getOrConstruct($txt, { multi: true, freeSolo: true, clearDefaultValue: false });
  const $chips = $('.kpp__chip[data-kp]');
  const syncChips = () => {
    const have = new Set(picker.names().map((n) => n.toLowerCase()));
    $chips.each(function markChip() {
      const on = have.has(String($(this).attr('data-kp') || '').toLowerCase());
      $(this).toggleClass('kpp__chip--on', on);
    });
  };
  picker.onChange(syncChips);
  $chips.on('click', function onChipClick(ev) {
    ev.preventDefault();
    const name = String($(this).attr('data-kp') || '');
    if (!name) return;
    const cur = picker.names();
    const idx = cur.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(name);
    picker.setNames(cur);
    syncChips();
  });
  syncChips();
}

export default new NamedPage(['problem_create', 'problem_edit'], () => {
  // Allowed-languages dropdown (shared with the AI Studio): syncs a
  // comma-joined id list into the hidden form input the handler reads.
  const $peMount = $('#pe-allowlangs');
  if ($peMount.length) {
    ensureAisStyle();
    const $peInput = $('#pe-allowlangs-input');
    const selected = String($peInput.val() || '').split(',').map((i) => i.trim()).filter(Boolean);
    $peMount.html(renderAllowLangsDd(langEntries(null), selected));
    wireAllowLangsDd($peMount, (langs) => $peInput.val(langs.join(',')));
  }

  let confirmed = false;
  $(document).on('click', '[name="operation"]', (ev) => {
    ev.preventDefault();
    if (confirmed) {
      return request.post('.', { operation: 'delete' }).then((res) => {
        window.location.href = res.url;
      }).catch((e) => {
        Notification.error(e.message);
      });
    }
    return confirm(i18n('Confirm deleting this problem? Its files, submissions, discussions and solutions will be deleted as well.')).then((yes) => {
      if (!yes) return;
      confirmed = true;
      ev.target.click();
    });
  });
  initKnowledgePoints();

  const $main = $('textarea[data-editor]');
  const $field = $('textarea[data-markdown-upload]');
  let content = $field.val();
  let isObject = false;
  let activeTab = $('[data-lang]').first().attr('data-lang');
  try {
    content = JSON.parse(content);
    isObject = !(content instanceof Array);
    if (!isObject) content = JSON.stringify(content);
  } catch (e) { }
  if (!isObject) content = { [activeTab]: content };
  function getContent(lang) {
    let c = '';
    if (content[lang]) c = content[lang];
    else {
      const list = Object.keys(content).filter((l) => l.startsWith(lang));
      if (list.length) c = content[list[0]];
    }
    if (typeof c !== 'string') c = JSON.stringify(c);
    return c;
  }
  $main.val(getContent(activeTab));
  function onChange(val) {
    try {
      val = JSON.parse(val);
      if (!(val instanceof Array)) val = JSON.stringify(val);
    } catch { }
    const empty = /^\s*$/.test(val);
    if (empty) delete content[activeTab];
    else content[activeTab] = val;
    if (!Object.keys(content).length) $field.text('');
    else $field.text(JSON.stringify(content));
  }
  const editor = Editor.getOrConstruct($main, { onChange });
  $('[data-lang]').on('click', (ev) => {
    $('[data-lang]').removeClass('tab--active');
    $(ev.currentTarget).addClass('tab--active');
    const lang = $(ev.currentTarget).attr('data-lang');
    activeTab = lang;
    const val = getContent(lang);
    editor.value(val);
  });
  $('[type="submit"]').on('click', (ev) => {
    if (!$('[name="title"]').val().toString().length) {
      Notification.error(i18n('Title is required.'));
      $('body').scrollTop();
      $('html, body').animate(
        { scrollTop: 0 },
        300,
        () => $('[name="title"]').focus(),
      );
      ev.preventDefault();
    }
  });

  if (localStorage.getItem('polyhedron-hint') === 'dismiss') return;
  $(tpl`<div name="hint" class="typo"></div>`).prependTo('.medium-9.columns .section__body');
  const root = ReactDOM.createRoot(document.querySelector('[name="hint"]'));
  function ignore() {
    root.unmount();
    localStorage.setItem('polyhedron-hint', 'dismiss');
  }
  /* eslint-disable max-len */
  root.render(<blockquote className="note">
    <p>{i18n('For better problem version management and validation, we suggest using Polyhedron to prepare problems.')}</p>
    <p>{i18n('Polyhedron supports managing problem version history, testing solutions, checking time limits, composing contest statements, cooperation and much more.')}</p>
    <p>{i18n('Problems created in polyhedron can be directly imported into any Hydro based online judge system.')}</p>
    <a href="https://polyhedron.hydro.ac/" target="_blank">{i18n('Open Polyhedron')}</a> / <a onClick={() => root.unmount()}>{i18n('Dismiss')}</a> / <a onClick={ignore}>{i18n("Don't show again")}</a>
  </blockquote>);
});
