'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../ui/editor-core');

/** 用 | 標示游標、[ ] 標示選取：'a [bc] d' → { text: 'a bc d', s: 2, e: 4 } */
function parse(src) {
  if (src.includes('[') && src.includes(']') && src.indexOf('[') < src.lastIndexOf(']') && !src.includes('|')) {
    const s = src.indexOf('['), e = src.lastIndexOf(']') - 1;
    return { text: src.slice(0, s) + src.slice(s + 1, e + 1) + src.slice(e + 2), s, e };
  }
  const s = src.indexOf('|');
  return { text: src.slice(0, s) + src.slice(s + 1), s, e: s };
}
/** 套用編輯後以同樣的標記表示結果 */
function show(text, ed) {
  const t = C.apply(text, ed);
  if (ed.selStart === ed.selEnd) return t.slice(0, ed.selStart) + '|' + t.slice(ed.selStart);
  return t.slice(0, ed.selStart) + '[' + t.slice(ed.selStart, ed.selEnd) + ']' + t.slice(ed.selEnd);
}
const run = (src, fn, ...args) => { const { text, s, e } = parse(src); return show(text, fn(text, s, e, ...args)); };
// 選取標記用 ⟦ ⟧，避免和 Markdown 的 [ ] 混淆
function parse2(src) {
  const s = src.indexOf('⟦'); const e = src.indexOf('⟧');
  if (s >= 0) return { text: src.replace('⟦', '').replace('⟧', ''), s, e: e - 1 };
  const c = src.indexOf('|');
  return { text: src.slice(0, c) + src.slice(c + 1), s: c, e: c };
}
function show2(text, ed) {
  const t = C.apply(text, ed);
  if (ed.selStart === ed.selEnd) return t.slice(0, ed.selStart) + '|' + t.slice(ed.selStart);
  return t.slice(0, ed.selStart) + '⟦' + t.slice(ed.selStart, ed.selEnd) + '⟧' + t.slice(ed.selEnd);
}
const R = (src, fn, ...args) => { const { text, s, e } = parse2(src); const ed = fn(text, s, e, ...args); return ed ? show2(text, ed) : null; };

test('粗體：有選取時包住、再按一次移除；沒有選取時插入預設文字並選取', () => {
  assert.equal(R('a ⟦重點⟧ b', C.toggleInline, '**', '粗體文字'), 'a **⟦重點⟧** b');
  assert.equal(R('a **⟦重點⟧** b', C.toggleInline, '**', '粗體文字'), 'a ⟦重點⟧ b');
  assert.equal(R('a ⟦**重點**⟧ b', C.toggleInline, '**', '粗體文字'), 'a ⟦重點⟧ b');
  assert.equal(R('a | b', C.toggleInline, '**', '粗體文字'), 'a **⟦粗體文字⟧** b');
  assert.equal(R('a⟦ 重點 ⟧b', C.toggleInline, '**', '粗體文字'), 'a **⟦重點⟧** b', '前後空白留在外面');
});

test('斜體與粗體分得清楚；刪除線、行內程式碼', () => {
  assert.equal(R('**⟦重點⟧**', C.toggleInline, '*', '斜體文字'), '***⟦重點⟧***', '粗體裡加斜體');
  assert.equal(R('***⟦重點⟧***', C.toggleInline, '*', '斜體文字'), '**⟦重點⟧**', '移除斜體保留粗體');
  assert.equal(R('*⟦重點⟧*', C.toggleInline, '*', '斜體文字'), '⟦重點⟧');
  assert.equal(R('⟦舊⟧', C.toggleInline, '~~', '刪除線文字'), '~~⟦舊⟧~~');
  assert.equal(R('x |', C.toggleInline, '`', 'code'), 'x `⟦code⟧`');
  assert.equal(R('x **|**', C.toggleInline, '**', '粗體文字'), 'x |', '空的 marker 中間再按一次移除');
});

test('標題：設定、切換層級、再按一次移除', () => {
  assert.equal(R('月|報', C.setHeading, 1), '# 月|報');
  assert.equal(R('## 月|報', C.setHeading, 3), '### 月|報');
  assert.equal(R('## 月|報', C.setHeading, 2), '月|報');
  assert.equal(R('## 月|報', C.setHeading, 0), '月|報');
});

test('清單：多行套用、移除、互相取代；空行略過', () => {
  assert.equal(R('⟦甲\n\n乙⟧', C.toggleList, 'ul'), '⟦- 甲\n\n- 乙⟧');
  assert.equal(R('⟦- 甲\n- 乙⟧', C.toggleList, 'ul'), '⟦甲\n乙⟧');
  assert.equal(R('⟦- 甲\n- 乙⟧', C.toggleList, 'ol'), '⟦1. 甲\n2. 乙⟧');
  assert.equal(R('  1. 甲|', C.toggleList, 'task'), '  - [ ] 甲|', '保留縮排');
  assert.equal(R('- [x] 完成|', C.toggleList, 'task'), '完成|');
  assert.equal(R('甲|', C.toggleQuote), '> 甲|');
  assert.equal(R('⟦> 甲\n> 乙⟧', C.toggleQuote), '⟦甲\n乙⟧');
});

test('區塊：前後補到剛好空一行；表格選取第一個表頭；程式碼區塊', () => {
  assert.equal(R('段落|', C.horizontalRule), '段落\n\n---\n|');
  assert.equal(R('甲\n\n|\n\n乙', C.pageBreak), '甲\n\n<!-- pagebreak -->|\n\n乙');
  assert.equal(R('|', C.table, 2, 1), '| ⟦欄位1⟧ | 欄位2 |\n| ------ | ------ |\n|        |        |\n');
  assert.equal(R('|', C.codeBlock, 'js'), '```js\n|\n```\n');
  assert.equal(R('⟦a = 1\nb = 2⟧', C.codeBlock, 'py'), '⟦```py\na = 1\nb = 2\n```⟧');
  assert.equal(R('⟦```\nx\n```⟧', C.codeBlock, ''), '⟦x⟧', '已經是程式碼區塊時移除');
});

test('連結與圖片', () => {
  assert.equal(R('|', C.link), '[連結文字](⟦https://⟧)');
  assert.equal(R('⟦https://a.tw/x⟧', C.link), '[⟦連結文字⟧](https://a.tw/x)');
  assert.equal(R('看⟦這裡⟧', C.link), '看[這裡](⟦https://⟧)');
  assert.equal(R('|', C.image, '圖[1]', 'img/a%20b.png'), '![圖1](img/a%20b.png)|');
});

test('Enter：延續清單、編號加一、待辦清單、引用；空的項目結束清單', () => {
  assert.equal(R('- 甲|', C.enter), '- 甲\n- |');
  assert.equal(R('  3. 甲|', C.enter), '  3. 甲\n  4. |');
  assert.equal(R('- [x] 完成|', C.enter), '- [x] 完成\n- [ ] |');
  assert.equal(R('> 引用|', C.enter), '> 引用\n> |');
  assert.equal(R('- 甲\n- |', C.enter), '- 甲\n|');
  assert.equal(R('  - |', C.enter), '  |', '縮排的空項目先移除符號');
  assert.equal(R('> |', C.enter), '|');
  assert.equal(R('一般文字|', C.enter), null);
  assert.equal(R('- 甲|乙', C.enter), '- 甲\n- |乙', '游標在中間時把後面的文字帶到新項目');
});

test('Tab：清單整行縮排、⇧Tab 減少；一般文字插入兩個空白', () => {
  assert.equal(R('- 甲|', C.indent, false), '  - 甲|');
  assert.equal(R('  - 甲|', C.indent, true), '- 甲|');
  assert.equal(R('文字|', C.indent, false), '文字  |');
  assert.equal(R('⟦甲\n乙⟧', C.indent, false), '⟦  甲\n  乙⟧');
});

test('按鈕狀態、字數、游標位置', () => {
  const t = '## 標題\n這是 **粗體** 與 *斜體* 和 `code`';
  const at = (s) => C.active(t, t.indexOf(s) + 1, t.indexOf(s) + 1);
  assert.equal(C.active(t, 3, 3).heading, 2);
  assert.ok(at('粗體').bold && !at('粗體').italic);
  assert.ok(at('斜體').italic && !at('斜體').bold);
  assert.ok(at('code').code);
  assert.ok(C.active('- [ ] x', 7, 7).task && !C.active('- [ ] x', 7, 7).ul);
  assert.equal(C.wordCount('Hello world，你好！It\'s 2026.'), 2 + 2 + 2);
  assert.deepEqual(C.cursorInfo('ab\ncde', 5), { line: 2, col: 3 });
});
