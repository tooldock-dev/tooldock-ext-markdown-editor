'use strict';
/**
 * Markdown 解析與輸出（docs/RENDER.md〈7.4〉）：預覽、HTML 匯出、PDF 匯出共用同一份規則。
 *   - markdown-it：CommonMark + GFM 表格、刪除線；linkify 開啟、typographer 關閉
 *   - html: false：文件中的 HTML 一律當文字
 *   - 待辦清單：- [ ] / - [x] 顯示成核取方塊（只能看）
 *   - 分頁：獨立一行 <!-- pagebreak --> → <div class="page-break"></div>
 *   - 程式碼上色：highlight.js（常用語言），認不出的語言不上色
 *   - 預覽時區塊加上 data-line（原始行號，捲動同步用）
 */
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js/lib/common');

const PAGEBREAK_RE = /^ {0,3}<!--\s*pagebreak\s*-->\s*$/i;
const TASK_RE = /^\[([ xX])\][ \t]+/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 區塊規則：獨立一行的 <!-- pagebreak --> */
function pagebreakPlugin(md) {
  md.block.ruler.before('html_block', 'pagebreak', (state, startLine, _endLine, silent) => {
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    if (!PAGEBREAK_RE.test(line)) return false;
    if (silent) return true;
    const token = state.push('pagebreak', 'div', 0);
    token.map = [startLine, startLine + 1];
    token.block = true;
    state.line = startLine + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.pagebreak = (tokens, idx) => {
    const line = tokens[idx].attrGet('data-line');
    return `<div class="page-break"${line != null ? ` data-line="${line}"` : ''}></div>\n`;
  };
}

/** 待辦清單：清單項目的第一段以 [ ] / [x] 開頭時，換成核取方塊 */
function taskListPlugin(md) {
  md.core.ruler.after('inline', 'task-list', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const first = inline.children && inline.children[0];
      if (!first || first.type !== 'text') continue;
      const m = TASK_RE.exec(first.content);
      if (!m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
      inline.children.unshift(box);
      tokens[i - 2].attrJoin('class', 'task-list-item');
      // 外層清單也加上 class，方便去掉項目符號
      for (let j = i - 3; j >= 0; j--) {
        if ((tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') && tokens[j].level === tokens[i - 2].level - 1) {
          if (!(tokens[j].attrGet('class') || '').includes('contains-task-list')) tokens[j].attrJoin('class', 'contains-task-list');
          break;
        }
      }
    }
  });
}

/** 預覽：每個有原始行號的區塊加上 data-line */
function lineNumbersPlugin(md) {
  md.core.ruler.push('data-line', (state) => {
    if (!state.env || !state.env.lineNumbers) return;
    for (const t of state.tokens) {
      if (t.map && t.level === 0 && (t.nesting === 1 || t.type === 'fence' || t.type === 'code_block' || t.type === 'hr' || t.type === 'pagebreak')) {
        t.attrSet('data-line', String(t.map[0]));
      }
    }
  });
  // fence / code_block / hr 的預設 renderer 不輸出屬性：自己處理
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const out = fence(tokens, idx, opts, env, self);
    const line = tokens[idx].attrGet('data-line');
    return line != null ? out.replace(/^<pre/, `<pre data-line="${line}"`) : out;
  };
  const code = md.renderer.rules.code_block;
  md.renderer.rules.code_block = (tokens, idx, opts, env, self) => {
    const out = code(tokens, idx, opts, env, self);
    const line = tokens[idx].attrGet('data-line');
    return line != null ? out.replace(/^<pre/, `<pre data-line="${line}"`) : out;
  };
}

/** 圖片：可以替換 src（預覽時本機圖片轉成 data: URL） */
function imagePlugin(md) {
  const image = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    if (env && typeof env.resolveImage === 'function') {
      const src = t.attrGet('src');
      const next = env.resolveImage(src);
      if (next && next !== src) t.attrSet('src', next);
    }
    return image(tokens, idx, opts, env, self);
  };
}

function highlight(code, lang) {
  const name = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (!name || !hljs.getLanguage(name)) return '';
  try {
    return `<pre class="hljs"><code class="language-${escapeHtml(name)}">${hljs.highlight(code, { language: name, ignoreIllegals: true }).value}</code></pre>`;
  } catch {
    return '';
  }
}

function createMarkdown() {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, highlight });
  md.use(pagebreakPlugin).use(taskListPlugin).use(lineNumbersPlugin).use(imagePlugin);
  return md;
}

const md = createMarkdown();
// 抽取文字用：不合併文字 token，才能分辨 <br>（換行）與跳脫的 \<br\>（原文）
const mdText = createMarkdown();
mdText.disable('text_join');

/**
 * Markdown → HTML 片段
 * options.lineNumbers：區塊加上 data-line（預覽用）
 * options.resolveImage(src) → 新的 src（或原值）
 */
function render(src, options = {}) {
  return md.render(String(src || ''), { lineNumbers: !!options.lineNumbers, resolveImage: options.resolveImage });
}

/** 文件標題：第一個 # 標題的文字 */
function titleOf(src) {
  const tokens = mdText.parse(String(src || ''), {});
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'heading_open' && tokens[i].tag === 'h1') return plain(tokens[i + 1]);
  }
  return '';
}

/** inline token → 純文字（去掉行內語法；<br> 還原成換行） */
function plain(inline) {
  if (!inline || !inline.children) return '';
  let out = '';
  for (const t of inline.children) {
    if (t.type === 'text') out += t.content.replace(/<br\s*\/?>/gi, '\n');
    else if (t.type === 'text_special' || t.type === 'code_inline') out += t.content;
    else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
    else if (t.type === 'image') out += plain(t);
  }
  return out.replace(/[ \t]+\n|\n[ \t]+/g, '\n').trim();
}

/**
 * 文件中的 GFM 表格（與報表產生器的 Markdown 來源規則相同）：
 * [{ name, line, columns, rows }]，名稱為「前面最近的標題（表 N）」或「表 N」
 */
function tables(src) {
  const tokens = mdText.parse(String(src || ''), {});
  const out = [];
  let heading = '';
  let cur = null;
  let row = null;
  let inHead = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') heading = plain(tokens[i + 1]);
    else if (t.type === 'table_open') cur = { heading, line: t.map ? t.map[0] : 0, head: [], rows: [] };
    else if (t.type === 'thead_open') inHead = true;
    else if (t.type === 'thead_close') inHead = false;
    else if (t.type === 'tr_open') row = [];
    else if (t.type === 'th_open' || t.type === 'td_open') row.push(plain(tokens[i + 1]));
    else if (t.type === 'tr_close') { if (inHead) cur.head = row; else cur.rows.push(row); row = null; }
    else if (t.type === 'table_close') {
      const n = out.length + 1;
      const seen = new Map();
      const columns = cur.head.map((h, ci) => {
        const b = h || `欄位${ci + 1}`;
        const k = seen.get(b) || 0;
        seen.set(b, k + 1);
        return k ? `${b}(${k + 1})` : b;
      });
      out.push({
        name: cur.heading ? `${cur.heading}（表 ${n}）` : `表 ${n}`,
        line: cur.line,
        columns,
        rows: cur.rows.map((r) => columns.map((_, ci) => r[ci] ?? '')),
      });
      cur = null;
    }
  }
  return out;
}

module.exports = { render, titleOf, tables, escapeHtml, PAGEBREAK_RE };
