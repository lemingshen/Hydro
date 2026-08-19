import Prism from 'prismjs'; // eslint-disable-line

import 'prismjs/plugins/toolbar/prism-toolbar';
import 'prismjs/plugins/toolbar/prism-toolbar.css';
import 'prismjs/plugins/line-numbers/prism-line-numbers';
import 'prismjs/plugins/line-numbers/prism-line-numbers.css';
import 'prismjs/plugins/line-highlight/prism-line-highlight';

import Clipboard from 'clipboard';
import $ from 'jquery';
import components from 'prismjs/components';
import getLoader from 'prismjs/dependencies';
import Notification from 'vj/components/notification/index';
import { i18n } from 'vj/utils';
import languageMeta from './meta';

const files = require.context('prismjs/components/', true, /prism-[a-z0-9-]+\.js/);
const loadedLanguages = new Set();
function loadLanguages() {
  const languages = Object.keys(components.languages).filter((l) => l !== 'meta');
  const loaded = [...loadedLanguages, ...Object.keys(Prism.languages)];
  getLoader(components, languages, loaded).load((lang) => {
    files(`./prism-${lang}.js`);
    loadedLanguages.add(lang);
  });
}

const languageExtMap = {};
loadLanguages();
// Map possible language names to Prism language name
languageMeta.forEach((meta) => {
  for (let i = 0; i < meta.ext.length; ++i) {
    if (Prism.languages[meta.ext[i]] !== undefined) {
      meta.target = meta.ext[i];
      break;
    }
  }
  meta.ext.forEach((ext) => {
    languageExtMap[ext] = meta.target;
  });
});

// Copy to Clipboard
Prism.plugins.toolbar.registerButton('copy-to-clipboard', (env) => {
  const linkCopy = document.createElement('a');
  linkCopy.href = 'javascript:;';
  linkCopy.className = 'code-copy-btn';
  linkCopy.title = i18n('Copy');
  linkCopy.setAttribute('aria-label', i18n('Copy'));
  linkCopy.innerHTML = '<svg class="code-copy-btn__icon code-copy-btn__icon--copy" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>'
    + '<path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>'
    + '<svg class="code-copy-btn__icon code-copy-btn__icon--check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>';
  const clip = new Clipboard(linkCopy, { text: () => env.code });
  clip.on('success', () => {
    linkCopy.classList.add('code-copy-btn--ok');
    setTimeout(() => linkCopy.classList.remove('code-copy-btn--ok'), 1200);
    Notification.success(i18n('Content copied to clipboard!'), 1000);
  });
  clip.on('error', () => {
    Notification.error(i18n('Copy failed :('));
  });
  return linkCopy;
});

const invisibles = {
  tab: /\t/,
  crlf: /\r\n/,
  lf: /\n/,
  cr: /\r/,
  space: / /,
};

function addInvisibles(grammar) {
  if (!grammar || grammar.tab) return;
  for (const name in invisibles) {
    if (Object.hasOwn(invisibles, name)) {
      grammar[name] = invisibles[name];
    }
  }
  for (const name in grammar) {
    if (Object.hasOwn(grammar, name) && !invisibles[name]) {
      if (name === 'rest') addInvisibles(grammar.rest);
      else handlerInvisiblesToken(grammar, name); // eslint-disable-line ts/no-use-before-define
    }
  }
}

function handlerInvisiblesToken(tokens, name) {
  const value = tokens[name];
  const type = Prism.util.type(value);
  if (type === 'RegExp') {
    const inside = {};
    tokens[name] = { pattern: value, inside };
    addInvisibles(inside);
  } else if (type === 'Array') {
    for (let i = 0, l = value.length; i < l; i++) handlerInvisiblesToken(value, i);
  } else {
    value.inside ||= {};
    addInvisibles(value.inside);
  }
}

Prism.hooks.add('before-highlight', (env) => {
  if (UserContext.showInvisibleChar) addInvisibles(env.grammar);
});

const prismjsApiWrap = {
  highlightBlocks: ($dom) => {
    $dom.find('pre code').get().forEach((code) => {
      const $code = $(code);
      const $pre = $code.parent();
      $pre.addClass('syntax-hl');
      const language = ($(code).attr('class') || '').trim();
      // try to map the language name
      const m = language.match(/language-([a-z]+)/);
      if (m && m[1]) {
        const languageName = m[1].toLowerCase();
        if (languageExtMap[languageName]) {
          $(code).attr('class', `language-${languageExtMap[languageName]}`);
        }
      }
      Prism.highlightElement(code);
    });
  },
  highlight: (text, grammar, language) => Prism.highlight(text, grammar, language),
  Prism,
};

export default prismjsApiWrap;
