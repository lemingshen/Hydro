import $ from 'jquery';
import MarkdownIt from 'markdown-it';
import Notification from 'vj/components/notification';
import { i18n } from 'vj/utils';

/**
 * Shared AI-report machinery: the markdown instance used across AI report
 * views, and the selectable-text PDF exporter (pdfmake with standard-font
 * Courier metrics; print-window fallback). Extracted from the submit-result
 * modal so the class report reuses one proven pipeline.
 */

export const aiMarkdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

function esc(text) {
  return $('<i>').text(String(text ?? '')).html();
}
/* ------------------- report PDF export (selectable text) ------------------- */

let pdfMakePromise = null;
function ensurePdfMake() {
  if (window.pdfMake && window.pdfMake.vfs) return Promise.resolve(window.pdfMake);
  if (!pdfMakePromise) {
    const load = (src) => new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`could not load ${src.split('/').pop()} from the CDN`));
      document.head.appendChild(el);
    });
    pdfMakePromise = load('https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/pdfmake.min.js')
      .then(() => load('https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/vfs_fonts.js'))
      .then(async () => {
        if (!window.pdfMake) throw new Error('pdfMake failed to initialize');
        // Standard fonts embed nothing, but the layout engine still needs
        // their AFM metric files in the virtual file system (the stock vfs
        // ships only Roboto). Pull Courier's metrics from pdfkit's tagged
        // source — plain-text, ~16KB each, fetched once and cached.
        const AFM_BASE = 'https://raw.githubusercontent.com/foliojs/pdfkit/v0.15.0/lib/font/data/';
        const faces = ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'];
        await Promise.all(faces.map(async (face) => {
          const key = `data/${face}.afm`;
          if (window.pdfMake.vfs[key]) return;
          const resp = await fetch(`${AFM_BASE}${face}.afm`);
          if (!resp.ok) throw new Error(`could not load ${face}.afm (HTTP ${resp.status})`);
          window.pdfMake.vfs[key] = await resp.text();
        }));
        // Courier is a PDF standard font: real monospace with zero embedding.
        window.pdfMake.fonts = {
          Roboto: {
            normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf',
          },
          Courier: {
            normal: 'Courier', bold: 'Courier-Bold', italics: 'Courier-Oblique', bolditalics: 'Courier-BoldOblique',
          },
        };
        return window.pdfMake;
      });
  }
  return pdfMakePromise;
}

const PDF_CODE = {
  font: 'Courier', fontSize: 8.6, lineHeight: 1.25, color: '#24292f', preserveLeadingSpaces: true,
};

function pdfCodeBlock(content) {
  return {
    table: { widths: ['*'], body: [[{ text: String(content || '').replace(/\n$/, ''), ...PDF_CODE, margin: [6, 5, 6, 5] }]] },
    layout: {
      hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#d8dee4', vLineColor: () => '#d8dee4', fillColor: () => '#f6f8fa',
    },
    margin: [0, 3, 0, 7],
  };
}

/** markdown-it inline children -> pdfmake text runs. */
function pdfInline(children) {
  const runs = [];
  let bold = 0;
  let italics = 0;
  let link = null;
  for (const t of children || []) {
    if (t.type === 'strong_open') bold++;
    else if (t.type === 'strong_close') bold--;
    else if (t.type === 'em_open') italics++;
    else if (t.type === 'em_close') italics--;
    else if (t.type === 'link_open') link = (t.attrs || []).find((a) => a[0] === 'href')?.[1] || null;
    else if (t.type === 'link_close') link = null;
    else if (t.type === 'code_inline') {
      runs.push({
        text: t.content, font: 'Courier', fontSize: 9, color: '#9e2335', background: '#f6f8fa',
      });
    } else if (t.type === 'softbreak' || t.type === 'hardbreak') runs.push({ text: '\n' });
    else if (t.type === 'text' || t.type === 'html_inline') {
      const run = { text: t.content };
      if (bold > 0) run.bold = true;
      if (italics > 0) run.italics = true;
      if (link) { run.link = link; run.color = '#0969da'; }
      runs.push(run);
    }
  }
  return runs.length ? runs : [{ text: '' }];
}

/**
 * markdown-it token stream -> pdfmake content. Covers the report's shapes:
 * headings, paragraphs, bold/italic/inline code/links, bullet & ordered
 * lists (nested), fenced code, blockquotes, tables, and rules.
 */
function pdfWalk(tokens, start, closeType) {
  const out = [];
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (closeType && t.type === closeType) return { content: out, next: i + 1 };
    if (t.type === 'heading_open') {
      const inline = tokens[i + 1];
      out.push({ text: pdfInline(inline.children), style: `h${t.tag.slice(1)}` });
      i += 3;
    } else if (t.type === 'paragraph_open') {
      const inline = tokens[i + 1];
      out.push({ text: pdfInline(inline.children), margin: [0, 2, 0, 5] });
      i += 3;
    } else if (t.type === 'fence' || t.type === 'code_block') {
      out.push(pdfCodeBlock(t.content));
      i += 1;
    } else if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      const ordered = t.type === 'ordered_list_open';
      const closer = ordered ? 'ordered_list_close' : 'bullet_list_close';
      const items = [];
      let j = i + 1;
      while (j < tokens.length && tokens[j].type !== closer) {
        if (tokens[j].type === 'list_item_open') {
          const r = pdfWalk(tokens, j + 1, 'list_item_close');
          items.push(r.content.length === 1 ? r.content[0] : r.content);
          j = r.next;
        } else j += 1;
      }
      out.push({ [ordered ? 'ol' : 'ul']: items, margin: [0, 1, 0, 5] });
      i = j + 1;
    } else if (t.type === 'blockquote_open') {
      const r = pdfWalk(tokens, i + 1, 'blockquote_close');
      out.push({
        table: { widths: [2, '*'], body: [[{ text: '', fillColor: '#b197fc' }, { stack: r.content, margin: [8, 2, 0, 2] }]] },
        layout: 'noBorders',
        margin: [0, 3, 0, 6],
      });
      i = r.next;
    } else if (t.type === 'table_open') {
      const rows = [];
      let j = i + 1;
      let row = null;
      while (j < tokens.length && tokens[j].type !== 'table_close') {
        const tt = tokens[j];
        if (tt.type === 'tr_open') row = [];
        else if (tt.type === 'tr_close') { rows.push(row); row = null; }
        else if (tt.type === 'th_open' || tt.type === 'td_open') {
          row.push({ text: pdfInline(tokens[j + 1].children), bold: tt.type === 'th_open', fontSize: 9.5 });
          j += 2;
        }
        j += 1;
      }
      if (rows.length) {
        out.push({
          table: { headerRows: 1, widths: rows[0].map(() => 'auto'), body: rows },
          layout: {
            hLineColor: () => '#d8dee4', vLineColor: () => '#d8dee4', hLineWidth: () => 0.5, vLineWidth: () => 0.5,
          },
          margin: [0, 3, 0, 7],
        });
      }
      i = j + 1;
    } else if (t.type === 'hr') {
      out.push({
        canvas: [{
          type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#d8dee4',
        }],
        margin: [0, 6, 0, 8],
      });
      i += 1;
    } else i += 1;
  }
  return { content: out, next: i };
}

/**
 * "Download PDF": a REAL text PDF — selectable, searchable, and always in
 * the light theme by construction (built from the markdown, never from the
 * themed page). Falls back to the clean print flow (also selectable text)
 * when the CDN library is unreachable.
 */
export async function downloadAiReportPdf(reportMd, reportHtml, fileName, opts = {}) {
  try {
    const pdfMake = await ensurePdfMake();
    const tokens = aiMarkdown.parse(String(reportMd || ''), {});
    const { content } = pdfWalk(tokens, 0, null);
    if (!content.length) throw new Error('empty report');
    // Figures (base64 PNG charts) slot in right after the title block so the
    // teacher sees the visual overview before the prose.
    if (Array.isArray(opts.figures) && opts.figures.length) {
      const figNodes = [{ text: opts.figuresTitle || 'Statistics Overview', style: 'h2' }];
      for (const f of opts.figures) {
        if (!f || !f.dataUrl) continue;
        if (f.title) {
          figNodes.push({
            text: f.title, fontSize: 9.5, bold: true, color: '#57606a', margin: [0, 6, 0, 2],
          });
        }
        figNodes.push({ image: f.dataUrl, width: f.pdfWidth || 500, margin: [0, 0, 0, 4] });
      }
      content.splice(1, 0, ...figNodes);
    }
    pdfMake.createPdf({
      pageSize: 'A4',
      pageMargins: [42, 44, 42, 50],
      defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.35, color: '#1f2328' },
      styles: {
        h1: { fontSize: 17, bold: true, color: '#1a3d6d', margin: [0, 0, 0, 8] },
        h2: {
          fontSize: 13.5, bold: true, color: '#1a3d6d', margin: [0, 12, 0, 5],
        },
        h3: { fontSize: 11.5, bold: true, margin: [0, 9, 0, 4] },
        h4: { fontSize: 10.5, bold: true, margin: [0, 8, 0, 3] },
      },
      footer: (page, pages) => ({
        text: `${page} / ${pages}`, alignment: 'center', fontSize: 8.5, color: '#8b949e', margin: [0, 16, 0, 0],
      }),
      content,
    }).download(fileName);
  } catch (e) {
    console.warn('[pta-ui] pdfmake unavailable (%s) — falling back to the print dialog', e && e.message);
    printReportFallback(reportHtml, fileName);
  }
}

/**
 * Fallback printable view. @page { margin: 0 } removes the area where
 * browsers print their own header/footer (timestamp, URL, page numbers),
 * so even this path produces a clean, meta-free PDF via "Save as PDF".
 */
export function printReportFallback(reportHtml, fileName) {
  const w = window.open('', '_blank');
  if (!w) {
    Notification.error(i18n('Popup blocked — please allow popups to download the PDF.'));
    return;
  }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(String(fileName || 'report.pdf').replace(/\.pdf$/, ''))}</title><style>
    @page { size: A4; margin: 0; }
    body { font: 14px/1.65 -apple-system, "Segoe UI", Arial, sans-serif; color: #1f2328; margin: 0; padding: 14mm 15mm; }
    h1, h2, h3 { color: #1f2328; } h1 { font-size: 21px; } h2 { font-size: 17px; margin-top: 20px; border-bottom: 1px solid #d8dee4; padding-bottom: 4px; }
    code { background: #f6f8fa; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
    pre { background: #f6f8fa; border: 1px solid #d8dee4; border-radius: 6px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; break-inside: avoid; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; } td, th { border: 1px solid #d8dee4; padding: 4px 10px; }
  </style></head><body>${reportHtml}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => {
    try {
      w.print();
    } catch (e) { /* the user can still print manually */ }
  }, 350);
}
