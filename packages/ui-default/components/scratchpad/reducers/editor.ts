let cacheKey = `${UserContext._id}/${UiContext.pdoc.domainId}/${UiContext.pdoc.docId}`;
if (UiContext.tdoc?._id) cacheKey += `@${UiContext.tdoc._id}`;

/**
 * PTA fork — FUNCTION TASKS. The stub for a language, by exact id and then
 * by family (`cc.cc14o2` → `cc`), mirroring harnessFor() on the server.
 * Null on an ordinary task, so nothing below changes for P tasks.
 */
function stubFor(lang: string): string | null {
  const stubs = (UiContext as any).functionTask?.stub;
  if (!stubs || !lang) return null;
  return stubs[lang] || stubs[lang.split('.')[0]] || null;
}

/** True when the editor still holds a stub verbatim (or nothing) — i.e. the student has not typed. */
function untouched(code: string, lang: string): boolean {
  const c = (code || '').trim();
  if (!c) return true;
  const stubs = (UiContext as any).functionTask?.stub;
  if (!stubs) return false;
  const ownStub = stubFor(lang);
  if (ownStub && ownStub.trim() === c) return true;
  // Any stub at all: a student who switched languages twice without typing.
  return Object.values(stubs).some((sv: any) => String(sv || '').trim() === c);
}

// TODO switch to indexeddb
export default function reducer(state = {
  lang: localStorage.getItem(`${cacheKey}#lang`) || UiContext.codeLang,
  code: localStorage.getItem(cacheKey) || UiContext.codeTemplate,
}, action: any = {}) {
  if (action.type === 'SCRATCHPAD_EDITOR_UPDATE_CODE') {
    localStorage.setItem(cacheKey, action.payload);
    return {
      ...state,
      code: action.payload,
    };
  }
  if (action.type === 'SCRATCHPAD_EDITOR_SET_LANG') {
    localStorage.setItem(`${cacheKey}#lang`, action.payload);
    /*
     * On a function task, a language switch swaps the STUB — but only if
     * the student has not started writing. A C stub left in a Python
     * editor is the wrong signature in the wrong syntax; a half-written
     * answer, on the other hand, is never thrown away by a dropdown.
     */
    const nextStub = stubFor(action.payload);
    if (nextStub && untouched(state.code, state.lang)) {
      localStorage.setItem(cacheKey, nextStub);
      return { ...state, lang: action.payload, code: nextStub };
    }
    return {
      ...state,
      lang: action.payload,
    };
  }
  return state;
}
