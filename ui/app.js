'use strict';
/* Markdown 編輯器畫面（docs/RENDER.md〈7〉）：文件內容在這裡，檔案與匯出交給後端 */
const td = window.tooldock;
const C = window.EditorCore;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const ed = $('#editor');
const paper = $('#paper');
const pane = $('#previewPane');
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const st = {
  info: null,
  doc: { file: null, name: '未命名.md', eol: '\n', bom: false, mtime: 0, savedText: '' },
  draftSavedAt: 0,
  lastDraftText: null,
  renderSeq: 0,
  lineTops: [], // 編輯區每一行的位置（捲動同步）
  anchors: [], // 預覽中有 data-line 的區塊：{ line, top }
  syncLock: 0,
  externalPrompt: false,
};

const basename = (p) => String(p || '').split(/[\\/]/).pop();
const dirty = () => ed.value !== st.doc.savedText;
const setting = (k, d) => { const v = st.info && st.info.settings[`markdownEditor.${k}`]; return v === undefined ? d : v; };
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(`me.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`me.${k}`, JSON.stringify(v)); } catch { /* 無法保存不影響使用 */ } },
};

/* ───────────── 提示 ───────────── */

let noticeTimer = null;
function notice(msg, kind = '') {
  const el = $('#stNotice');
  el.textContent = msg;
  el.className = `notice ${kind}`;
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}

function banner(msg, actions) {
  const b = $('#banner');
  if (!msg) { b.hidden = true; return; }
  b.querySelector('.msg').textContent = msg;
  const acts = b.querySelector('.acts');
  acts.innerHTML = '';
  for (const [label, fn, cls] of actions) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = cls || 'secondary';
    btn.onclick = () => { b.hidden = true; fn(); };
    acts.append(btn);
  }
  b.hidden = false;
}

/* ───────────── 狀態列 ───────────── */

function updateStatus() {
  const d = st.doc;
  $('#stName').textContent = `${dirty() ? '● ' : ''}${d.name}`;
  $('#stName').title = d.file || '尚未存檔';
  const { line, col } = C.cursorInfo(ed.value, ed.selectionStart);
  $('#stPos').textContent = `第 ${line} 行，第 ${col} 欄`;
  $('#stWords').textContent = `${C.wordCount(ed.value).toLocaleString()} 字`;
  const s = $('#stSave');
  if (!dirty()) { s.textContent = d.file ? '已儲存' : ''; s.className = ''; }
  else { s.textContent = st.draftSavedAt && st.lastDraftText === ed.value ? '未儲存（草稿已保存）' : '未儲存'; s.className = 'dirty'; }
}

function updateActive() {
  const a = C.active(ed.value, ed.selectionStart, ed.selectionEnd);
  for (const b of $$('[data-state]')) b.classList.toggle('on', !!a[b.dataset.state]);
  $('#headingBtn').textContent = a.heading ? `H${a.heading} ▾` : 'H ▾';
  $('#headingBtn').classList.toggle('on', !!a.heading);
}

/* ───────────── 編輯 ───────────── */

/** 套用 editor-core 的編輯：用 execCommand('insertText') 讓 ⌘Z 可以逐步復原 */
function applyEdit(e) {
  if (!e) return false;
  ed.focus();
  ed.setSelectionRange(e.from, e.to);
  let ok;
  if (e.insert === '') ok = e.from === e.to || document.execCommand('delete');
  else ok = document.execCommand('insertText', false, e.insert);
  if (!ok) {
    ed.setRangeText(e.insert, e.from, e.to, 'end');
    ed.dispatchEvent(new Event('input'));
  }
  ed.setSelectionRange(e.selStart, e.selEnd);
  updateActive();
  updateStatus();
  return true;
}

const run = (fn, ...args) => applyEdit(fn(ed.value, ed.selectionStart, ed.selectionEnd, ...args));

const FORMAT = {
  bold: () => run(C.toggleInline, '**', '粗體文字'),
  italic: () => run(C.toggleInline, '*', '斜體文字'),
  strike: () => run(C.toggleInline, '~~', '刪除線文字'),
  code: () => run(C.toggleInline, '`', 'code'),
  ul: () => run(C.toggleList, 'ul'),
  ol: () => run(C.toggleList, 'ol'),
  task: () => run(C.toggleList, 'task'),
  quote: () => run(C.toggleQuote),
  link: () => run(C.link),
  hr: () => run(C.horizontalRule),
  pagebreak: () => run(C.pageBreak),
  image: () => insertImage(),
};

async function insertImage() {
  const r = await td.dialog.open({
    title: '插入圖片',
    properties: ['openFile'],
    filters: [{ name: '圖片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }],
  });
  if (r.canceled || !r.filePaths.length) { ed.focus(); return; }
  const target = r.filePaths[0];
  const src = await td.invoke('relPath', { docFile: st.doc.file, target });
  const alt = basename(target).replace(/\.[^.]+$/, '');
  run(C.image, alt, src);
  if (!st.doc.file) notice('文件還沒存檔，圖片使用絕對路徑；存檔後重新插入可改成相對路徑');
}

/* ───────────── 預覽與捲動同步 ───────────── */

let previewTimer = null;
function schedulePreview(delay = 150) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, delay);
}

async function renderPreview() {
  const seq = ++st.renderSeq;
  const text = ed.value;
  let html;
  try {
    html = await td.invoke('render', { text, file: st.doc.file });
  } catch (err) {
    notice(`預覽失敗：${err.message}`, 'err');
    return;
  }
  if (seq !== st.renderSeq) return; // 已有更新的內容
  paper.innerHTML = html;
  paper.classList.toggle('empty', !text.trim());
  measure();
  syncFromEditor();
}

/** 量測編輯區每一行的位置（有自動換行，所以用一個同樣設定的隱藏元素量）與預覽區塊的位置 */
function measure() {
  if (!document.body.classList.contains('mode-split')) { st.lineTops = []; st.anchors = []; return; }
  let mirror = $('#mirror');
  if (!mirror) {
    mirror = document.createElement('div');
    mirror.id = 'mirror';
    document.body.append(mirror);
  }
  const cs = getComputedStyle(ed);
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', boxSizing: 'border-box',
    width: `${ed.clientWidth}px`, padding: cs.padding, font: cs.font, lineHeight: cs.lineHeight,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', tabSize: cs.tabSize, letterSpacing: cs.letterSpacing,
  });
  const lines = ed.value.split('\n');
  mirror.replaceChildren(...lines.map((l) => { const d = document.createElement('div'); d.textContent = l || '​'; return d; }));
  st.lineTops = [...mirror.children].map((d) => d.offsetTop);
  st.lineTops.push(mirror.scrollHeight);
  const base = pane.getBoundingClientRect().top - pane.scrollTop;
  st.anchors = $$('#paper [data-line]').map((el) => ({ line: Number(el.dataset.line), top: el.getBoundingClientRect().top - base }));
  st.anchors.unshift({ line: 0, top: 0 });
  st.anchors.push({ line: lines.length, top: pane.scrollHeight });
}

/** 編輯區捲動位置 → 小數行號 */
function editorLine() {
  const t = st.lineTops;
  if (t.length < 2) return 0;
  const y = ed.scrollTop + parseFloat(getComputedStyle(ed).paddingTop);
  let lo = 0, hi = t.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= y) lo = mid; else hi = mid - 1; }
  const h = (t[lo + 1] - t[lo]) || 1;
  return lo + Math.min(1, Math.max(0, (y - t[lo]) / h));
}

function interpolate(list, key, value, out) {
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (value >= a[key] && value <= b[key]) {
      const span = b[key] - a[key];
      return a[out] + (span ? (value - a[key]) / span : 0) * (b[out] - a[out]);
    }
  }
  return list.length ? list[list.length - 1][out] : 0;
}

function lockScroll() { st.syncLock = Date.now(); }
const locked = () => Date.now() - st.syncLock < 80;

function syncFromEditor() {
  if (!setting('syncScroll', true) || !st.anchors.length) return;
  const anchors = st.anchors.slice().sort((a, b) => a.line - b.line || a.top - b.top);
  const max = ed.scrollHeight - ed.clientHeight;
  const y = ed.scrollTop >= max - 2 && max > 0 ? pane.scrollHeight : interpolate(anchors, 'line', editorLine(), 'top');
  lockScroll();
  pane.scrollTop = y;
}

function syncFromPreview() {
  if (!setting('syncScroll', true) || !st.anchors.length || st.lineTops.length < 2) return;
  const anchors = st.anchors.slice().sort((a, b) => a.top - b.top);
  const line = interpolate(anchors, 'top', pane.scrollTop, 'line');
  const i = Math.max(0, Math.min(st.lineTops.length - 2, Math.floor(line)));
  const y = st.lineTops[i] + (line - i) * (st.lineTops[i + 1] - st.lineTops[i]) - parseFloat(getComputedStyle(ed).paddingTop);
  lockScroll();
  ed.scrollTop = Math.max(0, y);
}

/* ───────────── 草稿 ───────────── */

let draftTimer = null;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 2000);
}

async function saveDraft() {
  const text = ed.value;
  if (text === st.lastDraftText) return;
  try {
    if (!dirty()) await td.invoke('clearDraft');
    else await td.invoke('saveDraft', { file: st.doc.file, name: st.doc.name, text, eol: st.doc.eol, bom: st.doc.bom });
    st.lastDraftText = text;
    st.draftSavedAt = Date.now();
    updateStatus();
  } catch (err) {
    notice(`草稿保存失敗：${err.message}`, 'err');
  }
}

/* ───────────── 檔案 ───────────── */

function setDoc(doc, text = doc.savedText) {
  st.doc = doc;
  ed.value = text;
  ed.setSelectionRange(0, 0);
  ed.scrollTop = 0;
  pane.scrollTop = 0;
  st.lastDraftText = null;
  updateStatus();
  updateActive();
  renderRecent();
  schedulePreview(0);
}

/** 新的未命名文件；text 不是空的時候（例如匯入、還原草稿）視為未儲存 */
function untitled(name = '未命名.md', text = '') {
  setDoc({ file: null, name, eol: '\n', bom: false, mtime: 0, savedText: '' }, text);
}

/** 有未儲存的變更時詢問；回傳 true 表示可以繼續 */
async function confirmDiscard() {
  if (!dirty()) return true;
  const r = await td.dialog.message({
    type: 'question',
    message: `要儲存「${st.doc.name}」的變更嗎？`,
    detail: '不儲存的話，這次的變更會遺失。',
    buttons: ['儲存', '不儲存', '取消'],
    defaultId: 0,
    cancelId: 2,
  });
  if (r.response === 2) return false;
  if (r.response === 0) return save();
  return true;
}

async function newDoc() {
  if (!(await confirmDiscard())) return;
  untitled();
  await td.invoke('clearDraft');
  ed.focus();
}

async function openDoc(file) {
  if (!(await confirmDiscard())) return false;
  let target = file;
  if (!target) {
    const r = await td.dialog.open({
      title: '開啟 Markdown',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }, { name: '文字檔', extensions: ['txt'] }, { name: '所有檔案', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return false;
    target = r.filePaths[0];
  }
  try {
    const d = await td.invoke('open', target);
    st.info.recent = [target, ...st.info.recent.filter((f) => f !== target)].slice(0, 10);
    setDoc({ file: d.file, name: d.name, eol: d.eol, bom: d.bom, mtime: d.mtime, savedText: d.text });
    await td.invoke('clearDraft');
    ed.focus();
    return true;
  } catch (err) {
    td.toast(`無法開啟：${err.message}`, 'error');
    if (file) {
      st.info.recent = await td.invoke('forgetRecent', file);
      renderRecent();
    }
    return false;
  }
}

async function save() {
  if (!st.doc.file) return saveAs();
  return writeTo(st.doc.file);
}

async function saveAs() {
  const r = await td.dialog.save({
    title: '另存新檔',
    defaultPath: st.doc.file || st.doc.name,
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文字檔', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return false;
  return writeTo(r.filePath);
}

async function writeTo(file) {
  const text = ed.value;
  try {
    const r = await td.invoke('save', { file, text, eol: st.doc.eol, bom: st.doc.bom });
    const moved = file !== st.doc.file;
    st.doc = { ...st.doc, file: r.file, name: r.name, mtime: r.mtime, savedText: text };
    st.info.recent = [r.file, ...st.info.recent.filter((f) => f !== r.file)].slice(0, 10);
    await td.invoke('clearDraft');
    st.lastDraftText = text;
    updateStatus();
    renderRecent();
    if (moved) schedulePreview(0); // 相對路徑的圖片改以新位置解析
    notice(`已儲存 ${r.name}`);
    return true;
  } catch (err) {
    td.toast(`儲存失敗：${err.message}`, 'error');
    return false;
  }
}

/** 畫面重新取得焦點時檢查檔案是否被其他程式修改（〈7.5〉） */
async function checkExternal() {
  const d = st.doc;
  if (!d.file || st.externalPrompt) return;
  const s = await td.invoke('stat', d.file).catch(() => null);
  if (!s || Math.abs(s.mtime - d.mtime) < 1) return;
  st.externalPrompt = true;
  banner(`「${d.name}」已被其他程式修改。`, [
    ['重新載入', async () => {
      st.externalPrompt = false;
      const n = await td.invoke('open', d.file).catch((err) => { td.toast(err.message, 'error'); return null; });
      if (n) setDoc({ file: n.file, name: n.name, eol: n.eol, bom: n.bom, mtime: n.mtime, savedText: n.text });
    }, ''],
    ['保留我的版本', () => {
      st.externalPrompt = false;
      st.doc.mtime = s.mtime;
      st.doc.savedText = null; // 和磁碟上的不同：視為未儲存
      updateStatus();
    }],
  ]);
}

function renderRecent() {
  const box = $('#recentBox');
  box.innerHTML = '';
  const list = (st.info && st.info.recent) || [];
  if (!list.length) return;
  box.append(Object.assign(document.createElement('div'), { className: 'sep' }));
  box.append(Object.assign(document.createElement('div'), { className: 'label', textContent: '最近開啟' }));
  for (const f of list) {
    const b = document.createElement('button');
    b.className = 'item';
    b.textContent = basename(f);
    b.title = f;
    b.onclick = () => { closeMenus(); openDoc(f); };
    box.append(b);
  }
}

/* ───────────── 匯出與分享 ───────────── */

const docTitleGuess = () => {
  const m = ed.value.match(/^ {0,3}# +(.+?)\s*#*\s*$/m);
  return (m && m[1].replace(/[*_`~[\]]/g, '').trim()) || st.doc.name.replace(/\.(md|markdown|txt)$/i, '');
};
const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名';

async function exportPdf() {
  if (!st.info.canPdf) { td.toast('匯出 PDF 需要 ToolDock 1.7.0 以上', 'warn'); return; }
  const base = st.doc.file ? st.doc.file.replace(/\.(md|markdown|txt)$/i, '') : safeName(docTitleGuess());
  const r = await td.dialog.save({ title: '匯出 PDF', defaultPath: `${base}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return;
  notice('正在產生 PDF…');
  try {
    const res = await td.invoke('exportPdf', { text: ed.value, file: st.doc.file, output: r.filePath });
    if (res.status === 'done') {
      notice(`已匯出 ${basename(res.file)}（${res.pages} 頁）`);
      td.toast(`已匯出 PDF：${basename(res.file)}（${res.pages} 頁）`, 'success');
      if (res.blocked.length) td.toast(`有 ${res.blocked.length} 個資源沒有載入（例如網路圖片；可在設定開啟「PDF 載入網路圖片」）`, 'warn');
    } else {
      notice('');
      td.toast(`PDF 沒有產生：${res.message || res.status}`, res.status === 'cancelled' ? 'info' : 'error');
    }
  } catch (err) {
    notice('');
    td.toast(`匯出 PDF 失敗：${err.message}`, 'error');
  }
}

async function exportHtml() {
  const ask = await td.dialog.message({
    type: 'question',
    message: '匯出 HTML',
    detail: '產生單一 HTML 檔，內含文件樣式。',
    checkboxLabel: '內嵌本機圖片（檔案可以單獨傳送，但會變大）',
    checkboxChecked: false,
    buttons: ['選擇位置…', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (ask.response !== 0) return;
  const base = st.doc.file ? st.doc.file.replace(/\.(md|markdown|txt)$/i, '') : safeName(docTitleGuess());
  const r = await td.dialog.save({ title: '匯出 HTML', defaultPath: `${base}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] });
  if (r.canceled || !r.filePath) return;
  try {
    const res = await td.invoke('exportHtml', { text: ed.value, file: st.doc.file, output: r.filePath, embedImages: ask.checkboxChecked });
    td.toast(`已匯出 HTML：${basename(res.file)}`, 'success');
  } catch (err) {
    td.toast(`匯出 HTML 失敗：${err.message}`, 'error');
  }
}

function shareMessage(r) {
  if (r.status === 'delivered') return [r.result && r.result.message ? r.result.message : `已交給 ${r.receiver.name}`, 'success'];
  if (r.status === 'exported') return [`已存成交換檔 ${basename(r.filePath)}`, 'success'];
  if (r.status === 'no-receiver') return ['目前沒有可以接收的工具', 'warn'];
  if (r.status === 'cancelled') return ['已取消分享', 'info'];
  return [`分享失敗：${r.message || r.status}`, 'error'];
}

async function shareText() {
  if (!st.info.canShare) { td.toast('分享需要 ToolDock 1.4.0 以上', 'warn'); return; }
  try {
    const r = await td.invoke('shareText', { text: ed.value, file: st.doc.file });
    td.toast(...shareMessage(r));
  } catch (err) {
    td.toast(err.message, 'error');
  }
}

async function shareTable() {
  if (!st.info.canShare) { td.toast('分享需要 ToolDock 1.4.0 以上', 'warn'); return; }
  const list = await td.invoke('tables', ed.value);
  if (!list.length) { td.toast('這份文件沒有表格', 'warn'); return; }
  let index = 0;
  if (list.length > 1) {
    const shown = list.slice(0, 8);
    const r = await td.dialog.message({
      type: 'question',
      message: '要用報表產生器開啟哪一張表格？',
      detail: list.length > 8 ? `文件中有 ${list.length} 張表格，這裡列出前 8 張。` : `文件中有 ${list.length} 張表格。`,
      buttons: [...shown.map((t) => `${t.name}（${t.rows} 筆）`), '取消'],
      cancelId: shown.length,
    });
    if (r.response >= shown.length) return;
    index = r.response;
  }
  try {
    const r = await td.invoke('shareTable', { text: ed.value, index });
    td.toast(...shareMessage(r));
  } catch (err) {
    td.toast(err.message, 'error');
  }
}

/* ───────────── 指令、選單、快捷鍵 ───────────── */

const COMMANDS = {
  ...FORMAT,
  new: newDoc,
  open: () => openDoc(),
  openFile: () => openDoc(),
  save,
  saveAs,
  exportPdf,
  exportHtml,
  shareText,
  shareTable,
};

function runCommand(name) {
  closeMenus();
  const fn = COMMANDS[name];
  if (!fn) return;
  Promise.resolve(fn()).catch((err) => td.toast(err.message, 'error'));
}

function closeMenus(except) {
  for (const m of $$('.menu')) if (m !== except) m.hidden = true;
}

function toggleMenu(btn, menu) {
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // 不讓編輯區失去選取
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    closeMenus(menu);
    menu.hidden = !open;
  });
}

function buildTableGrid() {
  const grid = $('#gridPick');
  const label = $('#gridLabel');
  for (let r = 1; r <= 8; r++) {
    for (let c = 1; c <= 10; c++) {
      const cell = document.createElement('span');
      cell.dataset.r = r;
      cell.dataset.c = c;
      grid.append(cell);
    }
  }
  grid.addEventListener('mouseover', (e) => {
    const t = e.target.closest('span');
    if (!t) return;
    const R = +t.dataset.r, Cc = +t.dataset.c;
    for (const s of grid.children) s.classList.toggle('on', +s.dataset.r <= R && +s.dataset.c <= Cc);
    label.textContent = `${Cc} 欄 × ${R - 1 || 1} 列資料`;
  });
  grid.addEventListener('mousedown', (e) => e.preventDefault());
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('span');
    if (!t) return;
    closeMenus();
    run(C.table, +t.dataset.c, Math.max(1, +t.dataset.r - 1));
  });
}

function bindToolbar() {
  for (const b of $$('[data-cmd]')) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => runCommand(b.dataset.cmd));
  }
  for (const b of $$('[data-heading]')) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { closeMenus(); run(C.setHeading, +b.dataset.heading); });
  }
  for (const b of $$('[data-lang]')) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { closeMenus(); run(C.codeBlock, b.dataset.lang); });
  }
  toggleMenu($('#fileBtn'), $('#fileMenu'));
  toggleMenu($('#headingBtn'), $('#headingMenu'));
  toggleMenu($('#tableBtn'), $('#tableMenu'));
  toggleMenu($('#codeBtn'), $('#codeMenu'));
  toggleMenu($('#exportBtn'), $('#exportMenu'));
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
  for (const k of $$('[data-key]')) k.textContent = IS_MAC ? `⌘${k.dataset.key}` : `Ctrl+${k.dataset.key.replace('⌥', 'Alt+')}`;
  for (const b of $$('#modes button')) b.addEventListener('click', () => setMode(b.dataset.mode));
}

/** 快捷鍵（〈7.3〉）：平台選單已佔用的組合（⌘W、⌘⇧P、⌘⇧X、⌘⇧S…）不使用 */
function onKeyDown(e) {
  if (e.isComposing || e.keyCode === 229) return; // 注音、倉頡等輸入法組字中
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const inEditor = e.target === ed;
  if (e.key === 'Escape') { closeMenus(); return; }
  if (mod) {
    const code = e.code;
    let cmd = null;
    if (code === 'KeyS' && e.altKey && !e.shiftKey) cmd = 'saveAs';
    else if (e.altKey) return;
    else if (code === 'KeyS' && !e.shiftKey) cmd = 'save';
    else if (code === 'KeyO' && !e.shiftKey) cmd = 'open';
    else if (code === 'KeyN' && !e.shiftKey) cmd = 'new';
    else if (code === 'KeyP' && !e.shiftKey) cmd = 'exportPdf';
    else if (inEditor && code === 'KeyB' && !e.shiftKey) cmd = 'bold';
    else if (inEditor && code === 'KeyI' && !e.shiftKey) cmd = 'italic';
    else if (inEditor && code === 'KeyD' && e.shiftKey) cmd = 'strike';
    else if (inEditor && code === 'KeyE' && !e.shiftKey) cmd = 'code';
    else if (inEditor && code === 'KeyK' && !e.shiftKey) cmd = 'link';
    else if (inEditor && /^Digit[0-6]$/.test(code) && !e.shiftKey) {
      e.preventDefault();
      run(C.setHeading, Number(code.slice(5)));
      return;
    }
    if (cmd) { e.preventDefault(); runCommand(cmd); }
    return;
  }
  if (!inEditor || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    run(C.indent, e.shiftKey);
  } else if (e.key === 'Enter' && !e.shiftKey) {
    const edit = C.enter(ed.value, ed.selectionStart, ed.selectionEnd);
    if (edit) { e.preventDefault(); applyEdit(edit); }
  }
}

/* ───────────── 模式與分隔線 ───────────── */

function setMode(mode) {
  const m = ['edit', 'split', 'preview'].includes(mode) ? mode : 'split';
  document.body.classList.remove('mode-edit', 'mode-split', 'mode-preview');
  document.body.classList.add(`mode-${m}`);
  for (const b of $$('#modes button')) b.classList.toggle('on', b.dataset.mode === m);
  store.set('mode', m);
  requestAnimationFrame(() => { measure(); syncFromEditor(); });
}

function bindSplitter() {
  const main = $('#main');
  const apply = (ratio) => {
    const r = Math.min(0.8, Math.max(0.2, ratio));
    main.style.setProperty('--left', `${r}fr`);
    main.style.setProperty('--right', `${1 - r}fr`);
    return r;
  };
  apply(store.get('split', 0.5));
  const sp = $('#splitter');
  sp.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sp.classList.add('drag');
    const rect = main.getBoundingClientRect();
    let ratio = null;
    const move = (ev) => { ratio = apply((ev.clientX - rect.left) / rect.width); };
    const up = () => {
      sp.classList.remove('drag');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (ratio !== null) store.set('split', ratio);
      measure();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function applySettings() {
  const size = Math.max(10, Math.min(28, Number(setting('fontSize', 14)) || 14));
  document.documentElement.style.setProperty('--editor-font', `${size}px`);
  $('#pdfItem').disabled = !st.info.canPdf;
  $('#pdfItem').title = st.info.canPdf ? '' : '需要 ToolDock 1.7.0 以上';
  $('#shareTextItem').disabled = !st.info.canShare;
  $('#shareTableItem').disabled = !st.info.canShare;
}

/* ───────────── 匯入、命令面板 ───────────── */

async function drainPending() {
  const p = await td.invoke('takePending');
  if (p.import) {
    const im = p.import;
    if (!(await confirmDiscard())) { notice(`已略過分享的「${im.title}」`); return; }
    const name = im.filename ? basename(im.filename) : `${safeName(im.title)}.md`;
    untitled(/\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`, im.text);
    notice(im.notice || `已開啟分享的「${im.title}」`, im.notice ? 'err' : '');
  }
  if (p.command) runCommand(p.command);
}

/* ───────────── 啟動 ───────────── */

async function init() {
  st.info = await td.invoke('info');
  applySettings();
  bindToolbar();
  buildTableGrid();
  bindSplitter();
  setMode(store.get('mode', setting('defaultMode', 'split')));
  untitled();

  ed.addEventListener('input', () => {
    updateStatus();
    updateActive();
    schedulePreview();
    scheduleDraft();
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== ed) return;
    updateStatus();
    updateActive();
  });
  document.addEventListener('keydown', onKeyDown);
  ed.addEventListener('scroll', () => { if (!locked()) syncFromEditor(); });
  pane.addEventListener('scroll', () => { if (!locked()) syncFromPreview(); });
  window.addEventListener('resize', () => { measure(); });
  paper.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) td.shell.openExternal(href).catch(() => {});
  });
  window.addEventListener('focus', () => { checkExternal(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkExternal(); });

  td.on('import', () => drainPending().catch((err) => td.toast(err.message, 'error')));
  td.on('command', () => drainPending().catch((err) => td.toast(err.message, 'error')));
  td.on('settingsChanged', ({ settings }) => {
    st.info.settings = settings;
    applySettings();
    measure();
  });

  // 上次沒有正常結束：詢問要不要還原草稿
  const d = st.info.draft;
  if (d && typeof d.text === 'string' && d.text.trim()) {
    const when = new Date(d.savedAt).toLocaleString('zh-TW', { hour12: false });
    banner(`發現 ${when} 未儲存的「${d.name || '未命名'}」。`, [
      ['還原', async () => {
        if (d.file) {
          const ok = await td.invoke('open', d.file).then((n) => { setDoc({ file: n.file, name: n.name, eol: n.eol, bom: n.bom, mtime: n.mtime, savedText: n.text }, d.text); return true; }).catch(() => false);
          if (ok) return;
        }
        untitled(d.name || '未命名.md', d.text);
      }, ''],
      ['捨棄', () => td.invoke('clearDraft')],
    ]);
  }
  await drainPending();
  ed.focus();
}

init().catch((err) => {
  document.body.innerHTML = `<div style="padding:24px;color:var(--err)">Markdown 編輯器無法啟動：${td.escape(err.message)}</div>`;
});
