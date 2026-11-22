/**
 * Markdown 編輯核心（docs/RENDER.md〈7.2〉、〈7.3〉）：工具列、快捷鍵、清單延續的文字處理。
 * 全部是純函式：輸入 (text, selStart, selEnd)，回傳一個編輯 { from, to, insert, selStart, selEnd }（或 null 表示不處理）。
 * 畫面以 document.execCommand('insertText') 套用編輯，讓 ⌘Z 可以逐步復原；npm test 直接 require 這個檔案。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditorCore = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const edit = (from, to, insert, selStart, selEnd = selStart) => ({ from, to, insert, selStart, selEnd });

  /* ───────────── 行 ───────────── */

  /** 選取範圍涵蓋的整行：[lineStart, lineEnd)（不含最後的換行）；選取結尾剛好在行首時不含那一行 */
  function lineRange(text, s, e) {
    let end = e;
    if (e > s && text[e - 1] === '\n') end = e - 1;
    const from = text.lastIndexOf('\n', s - 1) + 1;
    let to = text.indexOf('\n', end);
    if (to < 0) to = text.length;
    return [from, to];
  }

  function cursorInfo(text, pos) {
    const before = text.slice(0, pos);
    const line = (before.match(/\n/g) || []).length + 1;
    const col = pos - before.lastIndexOf('\n');
    return { line, col };
  }

  /** 字數：中日韓字元一字算一字，其他以英數單字計算 */
  function wordCount(text) {
    const cjk = text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) || [];
    const rest = text.replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, ' ');
    const words = rest.match(/[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*/g) || [];
    return cjk.length + words.length;
  }

  /* ───────────── 行內語法 ───────────── */

  /** 游標兩側同一個字元連續出現的次數 */
  function runBefore(text, i, ch) { let n = 0; while (i - n - 1 >= 0 && text[i - n - 1] === ch) n++; return n; }
  function runAfter(text, i, ch) { let n = 0; while (i + n < text.length && text[i + n] === ch) n++; return n; }

  /** 選取兩側剛好有 marker（* 與 ** 要分清楚：* 的連續數為奇數才算斜體） */
  function surrounded(text, s, e, marker) {
    const ch = marker[0];
    const b = runBefore(text, s, ch);
    const a = runAfter(text, e, ch);
    if (marker === '*') return b % 2 === 1 && a % 2 === 1;
    return b >= marker.length && a >= marker.length;
  }

  /** 選取的文字本身被 marker 包住 */
  function selfWrapped(sel, marker) {
    if (sel.length < marker.length * 2 + 1 || !sel.startsWith(marker) || !sel.endsWith(marker)) return false;
    if (marker === '*') return !sel.startsWith('**') || sel.startsWith('***');
    return true;
  }

  /**
   * 粗體、斜體、刪除線、行內程式碼：有選取時包住或移除；沒有選取時插入「marker + 預設文字 + marker」並選取預設文字
   */
  function toggleInline(text, s, e, marker, placeholder) {
    const m = marker.length;
    const sel = text.slice(s, e);
    if (sel && selfWrapped(sel, marker)) {
      const inner = sel.slice(m, -m);
      return edit(s, e, inner, s, s + inner.length);
    }
    if (surrounded(text, s, e, marker) && (sel || runBefore(text, s, marker[0]) >= m)) {
      if (!sel) {
        // 游標在空的 marker 中間（例如 **|**）：移除
        if (runAfter(text, e, marker[0]) >= m) return edit(s - m, e + m, '', s - m);
      } else {
        return edit(s - m, e + m, sel, s - m, e - m);
      }
    }
    if (!sel) {
      const insert = `${marker}${placeholder}${marker}`;
      return edit(s, e, insert, s + m, s + m + placeholder.length);
    }
    // 前後空白留在外面：** 粗體** 不是合法語法
    const lead = sel.match(/^\s*/)[0];
    const trail = sel.slice(lead.length).match(/\s*$/)[0];
    const core = sel.slice(lead.length, sel.length - trail.length);
    if (!core) return null;
    const insert = `${lead}${marker}${core}${marker}${trail}`;
    const start = s + lead.length + m;
    return edit(s, e, insert, start, start + core.length);
  }

  const INLINE_RE = {
    bold: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,
    italic: /(?<![*\w])\*(?![*\s])([^*\n]*?[^*\s])\*(?![*\w])|(?<![_\w])_(?![_\s])([^_\n]*?[^_\s])_(?![_\w])/g,
    strike: /~~(?=\S)([\s\S]*?\S)~~/g,
    code: /`[^`\n]+`/g,
  };

  /* ───────────── 行首語法 ───────────── */

  const PREFIX = {
    task: { re: /^(\s*)[-*+] \[[ xX]\] /, make: () => '- [ ] ' },
    ul: { re: /^(\s*)[-*+] (?!\[[ xX]\] )/, make: () => '- ' },
    ol: { re: /^(\s*)\d+[.)] /, make: (i) => `${i + 1}. ` },
  };
  const ANY_LIST = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;

  function linesOf(text, s, e) {
    const [from, to] = lineRange(text, s, e);
    return { from, to, lines: text.slice(from, to).split('\n') };
  }

  /** 套用到多行後，回傳編輯；游標（沒有選取時）跟著第一行的長度變化移動，有選取時選取整個範圍 */
  function lineEdit(text, s, e, from, to, newLines, oldLines) {
    const insert = newLines.join('\n');
    if (s === e) {
      const delta = newLines[0].length - oldLines[0].length;
      const pos = Math.max(from, Math.min(from + newLines[0].length, s + delta));
      return edit(from, to, insert, pos);
    }
    return edit(from, to, insert, from, from + insert.length);
  }

  /** 項目清單、編號清單、待辦清單：全部的非空行都已經是這一種時移除，否則加上（取代其他清單符號） */
  function toggleList(text, s, e, kind) {
    const { from, to, lines } = linesOf(text, s, e);
    const p = PREFIX[kind];
    const targets = lines.map((l, i) => (l.trim() || lines.length === 1 ? i : -1)).filter((i) => i >= 0);
    const all = targets.every((i) => p.re.test(lines[i]));
    let n = 0;
    const next = lines.map((l, i) => {
      if (!targets.includes(i)) return l;
      if (all) return l.replace(p.re, '$1');
      const indent = l.match(/^\s*/)[0];
      const body = l.replace(ANY_LIST, '').replace(/^\s*/, '');
      return `${indent}${p.make(n++)}${body}`;
    });
    return lineEdit(text, s, e, from, to, next, lines);
  }

  /** 引用：全部的行都已經是引用時移除，否則加上「> 」 */
  function toggleQuote(text, s, e) {
    const { from, to, lines } = linesOf(text, s, e);
    const all = lines.every((l) => /^\s{0,3}>/.test(l) || (!l.trim() && lines.length > 1));
    const next = lines.map((l) => (all ? l.replace(/^(\s{0,3})> ?/, '$1') : `> ${l}`));
    return lineEdit(text, s, e, from, to, next, lines);
  }

  /** 標題：level 0 為一般段落；全部的行都已經是這個層級時移除 */
  function setHeading(text, s, e, level) {
    const { from, to, lines } = linesOf(text, s, e);
    const re = /^\s{0,3}(#{1,6})(\s+|$)/;
    const same = level > 0 && lines.every((l) => { const m = l.match(re); return m && m[1].length === level; });
    const next = lines.map((l) => {
      const body = l.replace(re, '');
      if (same || level === 0) return body;
      return `${'#'.repeat(level)} ${body}`;
    });
    return lineEdit(text, s, e, from, to, next, lines);
  }

  /* ───────────── 區塊 ───────────── */

  /** 插入獨立的區塊：前後補到剛好空一行 */
  function insertBlock(text, s, e, block, selInBlock) {
    const before = text.slice(0, s);
    const after = text.slice(e);
    let pre = '';
    if (before && !before.endsWith('\n\n')) pre = before.endsWith('\n') ? '\n' : '\n\n';
    let post = '';
    if (!after.startsWith('\n\n')) post = after.startsWith('\n') ? '\n' : (after ? '\n\n' : '\n');
    const insert = `${pre}${block}${post}`;
    const base = s + pre.length;
    // 預設游標放在區塊的下一行（空行），方便繼續輸入
    const after1 = post ? block.length + 1 : block.length;
    const [a, b] = selInBlock || [after1, after1];
    return edit(s, e, insert, base + a, base + b);
  }

  function horizontalRule(text, s, e) { return insertBlock(text, s, e, '---'); }
  function pageBreak(text, s, e) { return insertBlock(text, s, e, '<!-- pagebreak -->'); }

  /** 表格：rows 為資料列數（不含表頭）；選取第一個表頭 */
  function table(text, s, e, cols, rows) {
    const c = Math.max(1, Math.min(10, cols | 0));
    const r = Math.max(1, Math.min(20, rows | 0));
    const head = Array.from({ length: c }, (_, i) => `欄位${i + 1}`);
    const lines = [
      `| ${head.join(' | ')} |`,
      `| ${head.map((h) => '-'.repeat(Math.max(3, h.length * 2))).join(' | ')} |`,
      ...Array.from({ length: r }, () => `| ${head.map((h) => ' '.repeat(Math.max(3, h.length * 2))).join(' | ')} |`),
    ];
    return insertBlock(text, s, e, lines.join('\n'), [2, 2 + head[0].length]);
  }

  /** 程式碼區塊：有選取時包住選取的行；沒有選取時插入空區塊，游標放在中間 */
  function codeBlock(text, s, e, lang = '') {
    if (s !== e) {
      const { from, to, lines } = linesOf(text, s, e);
      const body = lines.join('\n');
      const fenced = /^\s*```/.test(lines[0]) && /^\s*```\s*$/.test(lines[lines.length - 1]) && lines.length >= 2;
      if (fenced) {
        const inner = lines.slice(1, -1).join('\n');
        return edit(from, to, inner, from, from + inner.length);
      }
      const insert = `\`\`\`${lang}\n${body}\n\`\`\``;
      return edit(from, to, insert, from, from + insert.length);
    }
    const block = `\`\`\`${lang}\n\n\`\`\``;
    const mid = 3 + lang.length + 1;
    return insertBlock(text, s, e, block, [mid, mid]);
  }

  /** 連結：選取的是網址時放進括號 */
  function link(text, s, e) {
    const sel = text.slice(s, e);
    if (!sel) {
      const insert = '[連結文字](https://)';
      return edit(s, e, insert, s + 7, s + 7 + 8);
    }
    if (/^(https?:\/\/|www\.)\S+$/i.test(sel.trim())) {
      const insert = `[連結文字](${sel.trim()})`;
      return edit(s, e, insert, s + 1, s + 5);
    }
    const insert = `[${sel}](https://)`;
    const at = s + sel.length + 3;
    return edit(s, e, insert, at, at + 8);
  }

  function image(text, s, e, alt, src) {
    const insert = `![${String(alt).replace(/[[\]]/g, '')}](${src})`;
    return edit(s, e, insert, s + insert.length);
  }

  /* ───────────── 鍵盤 ───────────── */

  /** Enter：在清單或引用中延續；空的項目按 Enter 結束清單 */
  function enter(text, s, e) {
    if (s !== e) return null;
    const from = text.lastIndexOf('\n', s - 1) + 1;
    let to = text.indexOf('\n', s);
    if (to < 0) to = text.length;
    const line = text.slice(from, to);
    const head = line.slice(0, s - from);
    const m = head.match(/^(\s*)((?:> ?)*)(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) )?/);
    if (!m || (!m[2] && !m[4])) return null;
    const prefix = m[0];
    const content = line.slice(prefix.length);
    // 空的項目（游標在行尾）：結束清單或引用
    if (!content.trim() && s === to) {
      if (m[4]) {
        const keep = `${m[1]}${m[2]}`;
        return edit(from, to, keep, from + keep.length);
      }
      return edit(from, to, '', from);
    }
    let marker = '';
    if (m[4]) {
      if (m[5]) marker = `${Number(m[5]) + 1}${m[6]} `;
      else if (/\[[ xX]\]/.test(m[4])) marker = `${m[4][0]} [ ] `;
      else marker = m[4];
    }
    const insert = `\n${m[1]}${m[2]}${m[3]}${marker}`;
    return edit(s, e, insert, s + insert.length);
  }

  /** Tab / ⇧Tab：清單或多行選取時整行縮排兩格；一般文字插入兩個空白 */
  function indent(text, s, e, outdent) {
    const { from, to, lines } = linesOf(text, s, e);
    const multi = lines.length > 1;
    const inList = lines.every((l) => ANY_LIST.test(l) || !l.trim());
    if (!multi && !inList) {
      if (outdent) {
        const n = Math.min(2, lines[0].match(/^ */)[0].length);
        if (!n) return null;
        return edit(from, from + n, '', Math.max(from, s - n), Math.max(from, e - n));
      }
      return edit(s, e, '  ', s + 2);
    }
    const next = lines.map((l) => {
      if (!l.trim()) return l;
      if (!outdent) return `  ${l}`;
      return l.replace(/^ {1,2}/, '').replace(/^\t/, '');
    });
    const insert = next.join('\n');
    if (s === e) {
      const delta = next[0].length - lines[0].length;
      return edit(from, to, insert, Math.max(from, s + delta));
    }
    return edit(from, to, insert, from, from + insert.length);
  }

  /* ───────────── 狀態（按鈕亮起） ───────────── */

  function active(text, s, e) {
    const [from, to] = lineRange(text, s, e);
    const line = text.slice(from, to);
    const pos = s - from;
    const endPos = e - from;
    const out = {};
    for (const [k, re] of Object.entries(INLINE_RE)) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (pos >= m.index && endPos <= m.index + m[0].length && !(pos === m.index && endPos === m.index && s === e)) { out[k] = true; break; }
      }
    }
    const h = line.match(/^\s{0,3}(#{1,6})(\s|$)/);
    out.heading = h ? h[1].length : 0;
    out.task = PREFIX.task.re.test(line);
    out.ul = PREFIX.ul.re.test(line);
    out.ol = PREFIX.ol.re.test(line);
    out.quote = /^\s{0,3}>/.test(line);
    return out;
  }

  /** 套用編輯後的完整文字（測試與沒有 execCommand 時使用） */
  function apply(text, ed) {
    return ed ? text.slice(0, ed.from) + ed.insert + text.slice(ed.to) : text;
  }

  return {
    lineRange, cursorInfo, wordCount, toggleInline, toggleList, toggleQuote, setHeading,
    insertBlock, horizontalRule, pageBreak, table, codeBlock, link, image, enter, indent, active, apply,
  };
}));
