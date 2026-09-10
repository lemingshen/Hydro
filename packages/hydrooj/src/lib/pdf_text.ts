/**
 * PTA fork — PDF TEXT with positions, for the subjective-report grader.
 *
 * Two things the grader needs that the AI Studio's context extractor
 * (handler/ai_author.ts extractPdf, text only) cannot give:
 *
 *   1. PAGE STRUCTURE: the model reads the report page by page and cites
 *      evidence as { page, quote }, so the text it sees must carry page
 *      boundaries — pageTextForPrompt() renders "=== Page N ===" blocks.
 *   2. POSITIONS: a cited quote is verified against the page's real text
 *      (locateQuote — the guard against invented evidence) and turned into
 *      rectangles on the page (quoteRects) that the annotated copy of the
 *      PDF highlights (lib/subjective_grader.ts annotatePdf).
 *
 * Extraction is done with pdfjs-dist (the legacy CommonJS build; text only,
 * no canvas). The module is loaded lazily so a deployment that has not run
 * `yarn install` since this feature landed still boots — the grader then
 * reports a clear "pdfjs-dist is not installed" instead of crashing.
 */
import path from 'path';

export interface PdfTextSpan {
    /** Character range of this text item inside PdfPageText.text. */
    start: number;
    end: number;
    /** PDF user-space box (origin bottom-left, points). */
    x: number;
    y: number;
    w: number;
    h: number;
    str: string;
}

export interface PdfPageText {
    page: number;
    width: number;
    height: number;
    text: string;
    spans: PdfTextSpan[];
}

export interface PdfExtraction {
    pages: PdfPageText[];
    numPages: number;
    /** Pages actually read (≤ numPages when a page cap applied). */
    readPages: number;
    chars: number;
    /** No extractable text at all: an image-only (scanned) PDF. */
    scanned: boolean;
}

export interface QuoteRange {
    start: number;
    end: number;
    /** false when only the head of the quote could be matched. */
    exact: boolean;
}

export interface PdfRect { x: number, y: number, w: number, h: number }

let pdfjsCache: any = null;
let pdfjsError: string = '';

/** Load pdfjs-dist once. Returns null (and records the reason) when it is not installed. */
export function loadPdfjs(): any {
    if (pdfjsCache) return pdfjsCache;
    if (pdfjsError) return null;
    try {
        // pdfjs polyfills DOMMatrix / Path2D through `canvas` when they are
        // missing and warns loudly when it is not installed. Text extraction
        // never touches either, so stub them before the module loads.
        const g: any = globalThis;
        g.DOMMatrix ||= class DOMMatrixStub { };
        g.Path2D ||= class Path2DStub { };
        pdfjsCache = require('pdfjs-dist/legacy/build/pdf.js');
        return pdfjsCache;
    } catch (e) {
        pdfjsError = `pdfjs-dist is not installed (${e.message}). Run "yarn install" in the Hydro checkout.`;
        return null;
    }
}

export function pdfjsAvailable(): boolean {
    return !!loadPdfjs();
}

function standardFontDir(): string | undefined {
    try {
        return `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;
    } catch (e) {
        return undefined;
    }
}

/**
 * Extract every page's text with the box of each text item. `maxPages`
 * caps the pages READ (the numPages field still reports the real count).
 */
export async function extractPdfText(buf: Buffer, opts: { maxPages?: number } = {}): Promise<PdfExtraction> {
    const pdfjs = loadPdfjs();
    if (!pdfjs) throw new Error(pdfjsError);
    const task = pdfjs.getDocument({
        data: new Uint8Array(buf),
        standardFontDataUrl: standardFontDir(),
        isEvalSupported: false,
        disableFontFace: true,
        verbosity: 0,
    });
    const doc = await task.promise;
    const numPages: number = doc.numPages;
    const cap = opts.maxPages && opts.maxPages > 0 ? Math.min(numPages, opts.maxPages) : numPages;
    const pages: PdfPageText[] = [];
    let chars = 0;
    try {
        for (let p = 1; p <= cap; p++) {
            // eslint-disable-next-line no-await-in-loop
            const page = await doc.getPage(p);
            const vp = page.getViewport({ scale: 1 });
            // eslint-disable-next-line no-await-in-loop
            const tc = await page.getTextContent({ includeMarkedContent: false });
            let text = '';
            const spans: PdfTextSpan[] = [];
            for (const it of tc.items as any[]) {
                const str = String(it.str ?? '');
                if (str) {
                    const [a, b, c, d, e, f] = it.transform || [1, 0, 0, 1, 0, 0];
                    const h = Math.abs(it.height || d || a) || 10;
                    spans.push({
                        start: text.length, end: text.length + str.length, x: e, y: f, w: Math.abs(it.width || 0), h, str,
                    });
                    void b; void c;
                    text += str;
                }
                // pdf.js marks line ends; a plain item boundary is a space.
                text += it.hasEOL ? '\n' : (str ? ' ' : '');
            }
            text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
            chars += text.trim().length;
            pages.push({
                page: p, width: vp.width, height: vp.height, text, spans,
            });
            page.cleanup?.();
        }
    } finally {
        try { await doc.destroy(); } catch (e) { /* best-effort */ }
    }
    return {
        pages, numPages, readPages: cap, chars, scanned: chars < 20,
    };
}

/* ------------------------------------------------------------------ */
/*  Quote matching                                                     */
/* ------------------------------------------------------------------ */

/** Lower-case, fold quotes/dashes, collapse every non-alphanumeric run to one space. */
function normalizeChar(ch: string): string {
    const c = ch.toLowerCase();
    if (/[\u2018\u2019\u201A\u201B]/.test(c)) return "'";
    if (/[\u201C\u201D\u201E\u201F]/.test(c)) return '"';
    if (/[\u2010-\u2015]/.test(c)) return '-';
    if (c === '\u00A0') return ' ';
    return c;
}

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

/** Normalized text plus a map from every normalized index back to the raw index. */
function normalizedIndex(raw: string): { n: string, map: number[] } {
    let n = '';
    const map: number[] = [];
    let prevSpace = true;
    for (let i = 0; i < raw.length; i++) {
        const c = normalizeChar(raw[i]);
        if (isWordChar(c)) {
            n += c;
            map.push(i);
            prevSpace = false;
        } else if (!prevSpace) {
            n += ' ';
            map.push(i);
            prevSpace = true;
        }
    }
    return { n, map };
}

export function normalizeQuote(quote: string): string {
    return normalizedIndex(String(quote || '')).n.trim();
}

/**
 * Find `quote` in a page's text, tolerant to case, punctuation, quotes,
 * dashes and whitespace differences (PDF extraction and model output never
 * agree on those). When the whole quote is not found, the longest matching
 * head of at least 24 normalized characters is accepted as a partial match.
 */
export function locateQuote(page: PdfPageText, quote: string): QuoteRange | null {
    const q = normalizeQuote(quote);
    if (q.length < 6) return null;
    const { n, map } = normalizedIndex(page.text);
    if (!n) return null;
    const hit = (needle: string): number => n.indexOf(needle);
    let idx = hit(q);
    let exact = true;
    let len = q.length;
    if (idx < 0) {
        exact = false;
        // Shrink from the end, word by word, down to a 24-char head.
        let head = q;
        for (;;) {
            const cut = head.lastIndexOf(' ');
            if (cut < 24) break;
            head = head.slice(0, cut);
            idx = hit(head);
            if (idx >= 0) {
                len = head.length;
                break;
            }
        }
        if (idx < 0) return null;
    }
    const start = map[idx];
    const end = map[Math.min(map.length - 1, idx + len - 1)] + 1;
    return { start, end, exact };
}

/**
 * Rectangles (PDF user space) covering a character range of the page: one
 * per text item touched, trimmed proportionally inside the first and last
 * item (pdf.js gives an item's width, not per-glyph advances — proportional
 * trimming is accurate enough for a highlight).
 */
export function quoteRects(page: PdfPageText, range: QuoteRange): PdfRect[] {
    const rects: PdfRect[] = [];
    for (const s of page.spans) {
        const a = Math.max(range.start, s.start);
        const b = Math.min(range.end, s.end);
        if (a >= b) continue;
        const per = s.w / Math.max(1, s.str.length);
        rects.push({
            x: s.x + (a - s.start) * per,
            y: s.y - s.h * 0.25,
            w: Math.max(2, (b - a) * per),
            h: s.h * 1.3,
        });
    }
    return rects;
}

/* ------------------------------------------------------------------ */
/*  Prompt rendering                                                   */
/* ------------------------------------------------------------------ */

/**
 * The report as the model reads it: page blocks in order, cut at
 * `maxChars` (whole pages first, then a truncated page with a marker).
 */
export function pageTextForPrompt(ext: PdfExtraction, opts: { maxChars: number }): { text: string, truncated: boolean, pagesIncluded: number } {
    const parts: string[] = [];
    let used = 0;
    let truncated = false;
    let pagesIncluded = 0;
    for (const p of ext.pages) {
        const body = p.text.trim();
        const head = `=== Page ${p.page} ===\n`;
        if (used + head.length + body.length > opts.maxChars) {
            const room = opts.maxChars - used - head.length - 40;
            // A partial page is worth sending when there is real room for
            // it — or when it is the FIRST page, so the model always sees
            // something of the report.
            if (room > 400 || !parts.length) {
                parts.push(`${head}${body.slice(0, Math.max(room, 200))}\n[... page ${p.page} truncated ...]`);
                pagesIncluded += 1;
            }
            truncated = true;
            break;
        }
        parts.push(head + body);
        used += head.length + body.length + 2;
        pagesIncluded += 1;
    }
    if (ext.readPages < ext.numPages) truncated = true;
    return { text: parts.join('\n\n'), truncated, pagesIncluded };
}
