'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const md = require('../backend/markdown');
const ext = require('../backend/index');
const { readDoc, writeDoc, imageDataUrl, toTablePayload, exportHtml, docTitle } = ext._internal;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-test-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('渲染：文件中的 HTML 被跳脫；分頁只認獨立一行；待辦清單；程式碼上色', () => {
  const html = md.render('<script>alert(1)</script>\n\n文字 <!-- pagebreak --> 中間\n\n<!-- pagebreak -->\n\n- [ ] 甲\n- [X] 乙\n- 丙\n\n```js\nlet a = 1\n```\n\n```nope\nx\n```');
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;'));
  assert.equal((html.match(/class="page-break"/g) || []).length, 1, '段落中的 pagebreak 不算');
  assert.ok(html.includes('<input type="checkbox" disabled> 甲') && html.includes('<input type="checkbox" disabled checked> 乙'));
  assert.ok(html.includes('<li>丙</li>'), '一般項目不受影響');
  assert.ok(html.includes('hljs-keyword') && html.includes('<code class="language-nope">x'), '認不出的語言不上色');
});

test('渲染：預覽才加 data-line；連結不允許 javascript:', () => {
  const src = '# 甲\n\n段落\n\n```\ncode\n```\n\n[壞](javascript:alert(1))';
  const a = md.render(src, { lineNumbers: true });
  assert.ok(a.includes('<h1 data-line="0">') && a.includes('<p data-line="2">') && a.includes('<pre data-line="4">'));
  assert.ok(!md.render(src).includes('data-line'));
  assert.ok(!a.includes('href="javascript'), a);
});

test('標題與表格抽取', () => {
  assert.equal(md.titleOf('前言\n\n# 月報 **10** 月\n\n# 第二個'), '月報 10 月');
  const t = md.tables('| a | a |  |\n|---|---|---|\n| 1 | x<br>y | \\| |\n\n## 第二\n\n| b |\n|---|\n| 2 |');
  assert.deepEqual(t.map((x) => x.name), ['表 1', '第二（表 2）']);
  assert.deepEqual(t[0].columns, ['a', 'a(2)', '欄位3']);
  assert.deepEqual(t[0].rows[0], ['1', 'x\ny', '|']);
});

test('讀寫檔案：保留 CRLF 與 BOM；畫面拿到的一律是 LF', async () => {
  await withTmp((dir) => {
    const f = path.join(dir, 'a.md');
    fs.writeFileSync(f, '﻿# 甲\r\n\r\n乙\r\n');
    const d = readDoc(f);
    assert.equal(d.text, '# 甲\n\n乙\n');
    assert.equal(d.eol, '\r\n');
    assert.equal(d.bom, true);
    writeDoc({ file: f, text: d.text + '丙\n', eol: d.eol, bom: d.bom });
    assert.equal(fs.readFileSync(f, 'utf8'), '﻿# 甲\r\n\r\n乙\r\n丙\r\n');
    const g = path.join(dir, 'b.md');
    writeDoc({ file: g, text: 'x\ny' });
    assert.equal(fs.readFileSync(g, 'utf8'), 'x\ny', '新文件：LF、沒有 BOM');
    assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
  });
});

test('預覽圖片：文件所在資料夾底下的轉成 data: URL；外面的、網路的不處理', async () => {
  await withTmp((dir) => {
    fs.mkdirSync(path.join(dir, 'doc', 'img'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'doc', 'img', 'a b.png'), PNG);
    fs.writeFileSync(path.join(dir, 'out.png'), PNG);
    const doc = path.join(dir, 'doc', 'a.md');
    assert.match(imageDataUrl('img/a%20b.png', doc), /^data:image\/png;base64,/);
    assert.equal(imageDataUrl('../out.png', doc), null, '文件資料夾外面');
    assert.equal(imageDataUrl(path.join(dir, 'out.png'), doc), null, '絕對路徑也要在文件資料夾底下');
    assert.match(imageDataUrl(path.join(dir, 'out.png'), null), /^data:image\/png/, '未存檔的文件接受絕對路徑');
    assert.equal(imageDataUrl('img/a.png', null), null, '未存檔的文件不接受相對路徑');
    assert.equal(imageDataUrl('https://example.com/a.png', doc), null);
    assert.equal(imageDataUrl('img/notes.txt', doc), null, '不是圖片');
  });
});

test('表格轉 tooldock.table：整欄是數字時轉成 int / float，前導零保留文字', () => {
  const p = toTablePayload({ columns: ['代碼', '數量', '比例', '名稱'], rows: [['0812', '3', '1.5', '甲'], ['0815', '', '2', '']] });
  assert.deepEqual(p.columns.map((c) => c.type), ['string', 'int', 'float', 'string']);
  assert.deepEqual(p.rows, [['0812', 3, 1.5, '甲'], ['0815', null, 2, null]]);
});

test('HTML 匯出：單一檔案、內嵌樣式；可選擇內嵌本機圖片', async () => {
  await withTmp((dir) => {
    fs.writeFileSync(path.join(dir, 'a.png'), PNG);
    const doc = path.join(dir, '報告.md');
    const text = '# 報告 <x>\n\n![圖](a.png)';
    const out = path.join(dir, 'a.html');
    const r = exportHtml({ text, file: doc, output: out, embedImages: false });
    const html = fs.readFileSync(out, 'utf8');
    assert.equal(r.title, '報告 <x>');
    assert.ok(html.includes('<title>報告 &lt;x&gt;</title>') && html.includes('<body class="td-doc">') && html.includes('.td-doc h1') && html.includes('.hljs'));
    assert.ok(html.includes('src="a.png"'));
    exportHtml({ text, file: doc, output: out, embedImages: true });
    assert.ok(fs.readFileSync(out, 'utf8').includes('src="data:image/png;base64,'));
    assert.equal(docTitle('沒有標題', doc), '報告');
    assert.equal(docTitle('', null), '未命名');
  });
});

test('資料交換：markdown 正常開啟；其他 mime 提示；格式錯誤被拒絕', () => {
  const events = [];
  ext.activate({
    ui: { handle() {}, emit: (e) => events.push(e) },
    log: { info() {} },
    commands: { register: () => ({ dispose() {} }) },
    settings: { onDidChange: () => ({ dispose() {} }), all: () => ({}) },
    subscriptions: [],
    storage: { get: (k, d) => d, set() {} },
    window: {},
    paths: { data: os.tmpdir() },
    platform: { version: '1.7.0' },
  });
  const ok = ext.importText(null, { id: '1', title: '筆記', payload: { mime: 'text/markdown; charset=utf-8', text: 'a\r\nb' } });
  assert.equal(ok.status, 'imported');
  const csv = ext.importText(null, { id: '2', title: '表', payload: { mime: 'text/csv', text: 'a,b' } });
  assert.equal(csv.status, 'imported');
  const bad = ext.importText(null, { id: '3', title: '壞', payload: { mime: 'text/plain' } });
  assert.equal(bad.status, 'rejected');
  assert.deepEqual(events, ['import', 'import']);
});

test('自帶的 document.css 與平台的 src/sdk/document.css 規則相同', () => {
  const strip = (s) => s.replace(/^\/\*[\s\S]*?\*\/\s*/, '');
  const mine = fs.readFileSync(path.join(__dirname, '..', 'ui', 'document.css'), 'utf8');
  const platform = path.join(__dirname, '..', '..', '..', 'src', 'sdk', 'document.css');
  if (!fs.existsSync(platform)) return; // 不在平台 repo 中時略過
  assert.equal(strip(mine), strip(fs.readFileSync(platform, 'utf8')), '兩份 document.css 不一致，請同步');
});

test('表格抽取與報表產生器的 Markdown 來源結果一致', () => {
  const other = path.join(__dirname, '..', '..', 'table-report', 'backend', 'sources', 'markdown.js');
  if (!fs.existsSync(other) || !fs.existsSync(path.join(__dirname, '..', '..', 'table-report', 'node_modules', 'markdown-it'))) return;
  const tr = require(other);
  const sample = fs.readFileSync(path.join(__dirname, '..', '..', 'table-report', 'samples', 'monthly-report.md'), 'utf8')
    + '\n\n| 空 |  | 空 |\n|---|---|---|\n| `a \\| b` | x<br>y | \\<br\\> |\n';
  const mine = md.tables(sample).map(({ name, columns, rows }) => ({ name, columns, rows }));
  assert.deepEqual(mine, tr.parseTables(sample));
});
