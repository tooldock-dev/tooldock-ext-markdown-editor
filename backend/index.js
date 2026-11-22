'use strict';
/**
 * Markdown 編輯器後端（docs/RENDER.md〈7〉）
 * 文件內容在畫面上；後端負責檔案讀寫（保留換行字元與 BOM）、草稿、預覽的 HTML 與本機圖片、匯出與資料交換。
 */
const fs = require('fs');
const path = require('path');
const { render, titleOf, tables, escapeHtml } = require('./markdown');

const MAX_IMAGE = 20 * 1024 * 1024;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
const NUM_RE = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
const EXT_ROOT = path.join(__dirname, '..');

let ctx = null;
let pendingImport = null; // 收到但畫面還沒取走的 tooldock.text
let pendingCommand = null; // 畫面還沒開時收到的指令（例如命令面板的「匯出 PDF」）
const imageCache = new Map(); // 絕對路徑 → { mtime, url }

/* ───────────── 檔案 ───────────── */

/** 讀檔：統一成 LF 給畫面，記住原本的換行字元與 BOM，存檔時還原 */
function readDoc(file) {
  const buf = fs.readFileSync(file);
  let text = buf.toString('utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(^|[^\r])\n/g) || []).length;
  const eol = crlf > lf ? '\r\n' : '\n';
  return { file, name: path.basename(file), text: text.replace(/\r\n?/g, '\n'), eol, bom, mtime: fs.statSync(file).mtimeMs };
}

function writeDoc({ file, text, eol = '\n', bom = false }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('存檔路徑不正確');
  const body = String(text).replace(/\r\n?/g, '\n').replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, (bom ? '﻿' : '') + body, 'utf8');
  fs.renameSync(tmp, file);
  return { file, name: path.basename(file), mtime: fs.statSync(file).mtimeMs };
}

function remember(file) {
  const recent = [file, ...ctx.storage.get('recent', []).filter((f) => f !== file)].slice(0, 10);
  ctx.storage.set('recent', recent);
  return recent;
}

/* ───────────── 草稿（〈7.5〉） ───────────── */

const draftFile = () => path.join(ctx.paths.data, 'drafts', 'current.json');

function saveDraft(d) {
  const f = draftFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...d, savedAt: Date.now() }));
  return true;
}

function readDraft() {
  try { return JSON.parse(fs.readFileSync(draftFile(), 'utf8')); } catch { return null; }
}

function clearDraft() {
  fs.rmSync(draftFile(), { force: true });
  return true;
}

/* ───────────── 圖片 ───────────── */

const isRemote = (src) => /^(https?:)?\/\//i.test(src);
const isInline = (src) => /^(data|blob):/i.test(src);

/** 圖片的本機路徑：相對路徑以文件所在資料夾為準；沒有存檔的文件只接受絕對路徑 */
function localImagePath(src, docFile) {
  if (!src || isRemote(src) || isInline(src) || /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^file:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return null;
  let p = src;
  if (/^file:/i.test(p)) {
    try { p = require('url').fileURLToPath(p); } catch { return null; }
  } else {
    try { p = decodeURI(p.split(/[?#]/)[0]); } catch { p = p.split(/[?#]/)[0]; }
  }
  if (!path.isAbsolute(p)) {
    if (!docFile) return null;
    p = path.resolve(path.dirname(docFile), p);
  }
  return p;
}

/** 預覽用：本機圖片轉成 data: URL（限文件所在資料夾底下，未存檔的文件不限；單張 20 MB；依修改時間快取） */
function imageDataUrl(src, docFile) {
  const p = localImagePath(src, docFile);
  if (!p) return null;
  let real;
  try { real = fs.realpathSync(p); } catch { return null; }
  if (docFile) {
    const dir = fs.realpathSync(path.dirname(docFile));
    if (real !== dir && !real.startsWith(dir + path.sep)) return null;
  }
  const mime = IMAGE_MIME[path.extname(real).slice(1).toLowerCase()];
  if (!mime) return null;
  let st;
  try { st = fs.statSync(real); } catch { return null; }
  if (!st.isFile() || st.size > MAX_IMAGE) return null;
  const hit = imageCache.get(real);
  if (hit && hit.mtime === st.mtimeMs) return hit.url;
  const url = `data:${mime};base64,${fs.readFileSync(real).toString('base64')}`;
  imageCache.set(real, { mtime: st.mtimeMs, url });
  if (imageCache.size > 200) imageCache.delete(imageCache.keys().next().value);
  return url;
}

/* ───────────── 匯出 ───────────── */

const readAsset = (rel) => fs.readFileSync(path.join(EXT_ROOT, rel), 'utf8');

function docTitle(text, file) {
  return titleOf(text) || (file ? path.basename(file).replace(/\.(md|markdown|txt)$/i, '') : '未命名');
}

/** 單一 HTML 檔：內嵌文件樣式與程式碼上色樣式；embedImages 時本機圖片轉成 data: URL */
function exportHtml({ text, file, output, embedImages }) {
  const title = docTitle(text, file);
  const body = render(text, embedImages ? { resolveImage: (src) => imageDataUrl(src, file) || src } : {});
  const css = `${readAsset('ui/document.css')}\n${readAsset('node_modules/highlight.js/styles/github.css')}\nbody{max-width:860px;margin:40px auto;padding:0 24px}`;
  const html = `<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n<style>\n${css}\n</style>\n</head>\n<body class="td-doc">\n${body}</body>\n</html>\n`;
  fs.writeFileSync(output, html, 'utf8');
  return { file: output, title, bytes: Buffer.byteLength(html) };
}

async function exportPdf({ text, file, output }) {
  if (!ctx.render) throw new Error('匯出 PDF 需要 ToolDock 1.7.0 以上');
  const s = (k, d) => ctx.settings.get(`markdownEditor.pdf.${k}`, d);
  const title = docTitle(text, file);
  // 已存檔：相對路徑的圖片由平台從文件所在資料夾讀取；未存檔：本機圖片先轉成 data: URL
  const body = render(text, file ? {} : { resolveImage: (src) => imageDataUrl(src, null) || src });
  const opts = {
    html: `<!doctype html><html lang="zh-Hant"><head><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`,
    output,
    title,
    stylesheet: 'document',
    css: readAsset('node_modules/highlight.js/styles/github.css'),
    page: { size: s('pageSize', 'A4'), landscape: !!s('landscape', false), margin: Math.max(0, Math.min(100, Number(s('margin', 15)) || 0)) },
    allowRemote: !!s('allowRemote', false),
  };
  if (file) opts.baseDir = path.dirname(file);
  const header = s('header', '');
  const footer = s('footer', '｜{page} / {pages}｜');
  if (header) opts.header = header;
  if (footer) opts.footer = footer;
  const r = await ctx.render.pdf(opts);
  ctx.log.info(`匯出 PDF：${output}（${r.status}${r.pages ? `，${r.pages} 頁` : ''}${r.blocked.length ? `，擋下 ${r.blocked.length} 個資源` : ''}）`);
  return { ...r, title };
}

/* ───────────── 資料交換 ───────────── */

/** 表格 → tooldock.table：整欄都是數字時轉成 int / float，其餘為文字 */
function toTablePayload(t) {
  const types = t.columns.map((_, ci) => {
    const vals = t.rows.map((r) => r[ci]).filter((v) => v !== '');
    if (!vals.length || !vals.every((v) => NUM_RE.test(v))) return 'string';
    return vals.every((v) => /^-?\d+$/.test(v)) ? 'int' : 'float';
  });
  return {
    columns: t.columns.map((name, i) => ({ name, type: types[i] })),
    rows: t.rows.map((r) => r.map((v, i) => (v === '' ? null : types[i] === 'string' ? v : Number(v)))),
  };
}

/* ───────────── 啟用 ───────────── */

exports.activate = (context) => {
  ctx = context;

  ctx.ui.handle('info', () => ({
    settings: ctx.settings.all(),
    recent: ctx.storage.get('recent', []),
    draft: readDraft(),
    canPdf: !!ctx.render,
    canShare: !!ctx.exchange,
    platform: ctx.platform.version,
  }));
  ctx.ui.handle('open', (file) => {
    const doc = readDoc(file);
    remember(file);
    return doc;
  });
  ctx.ui.handle('save', (doc) => {
    const r = writeDoc(doc);
    remember(r.file);
    return r;
  });
  ctx.ui.handle('stat', (file) => {
    try { return { mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
  });
  ctx.ui.handle('forgetRecent', (file) => {
    const recent = ctx.storage.get('recent', []).filter((f) => f !== file);
    ctx.storage.set('recent', recent);
    return recent;
  });
  ctx.ui.handle('render', ({ text, file }) => render(text, {
    lineNumbers: true,
    resolveImage: (src) => imageDataUrl(src, file) || src,
  }));
  ctx.ui.handle('relPath', ({ docFile, target }) => {
    if (!docFile) return target.split(path.sep).join('/');
    // 中文保持原樣（好讀）；空白與括號會破壞 Markdown 連結語法，需要編碼
    const rel = path.relative(path.dirname(docFile), target).split(path.sep).join('/');
    return rel.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  });
  ctx.ui.handle('saveDraft', (d) => saveDraft(d));
  ctx.ui.handle('clearDraft', () => clearDraft());
  ctx.ui.handle('exportHtml', (opts) => exportHtml(opts));
  ctx.ui.handle('exportPdf', (opts) => exportPdf(opts));
  ctx.ui.handle('tables', (text) => tables(text).map((t) => ({ name: t.name, line: t.line, columns: t.columns.length, rows: t.rows.length })));
  ctx.ui.handle('shareTable', ({ text, index }) => {
    if (!ctx.exchange) throw new Error('需要 ToolDock 1.4.0 以上');
    const t = tables(text)[index];
    if (!t) throw new Error('找不到這張表格');
    const pkg = ctx.exchange.create('tooldock.table', toTablePayload(t), {
      title: t.name.slice(0, 200),
      description: `由 Markdown 編輯器分享，共 ${t.rows.length} 筆、${t.columns.length} 個欄位`,
    });
    return ctx.exchange.share(pkg, { preferReceiver: 'table-report' });
  });
  ctx.ui.handle('shareText', ({ text, file }) => {
    if (!ctx.exchange) throw new Error('需要 ToolDock 1.4.0 以上');
    const title = docTitle(text, file);
    const pkg = ctx.exchange.create('tooldock.text', {
      mime: 'text/markdown',
      text,
      filename: file ? path.basename(file) : `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名'}.md`,
    }, { title: title.slice(0, 200), description: '由 Markdown 編輯器分享' });
    return ctx.exchange.share(pkg);
  });
  ctx.ui.handle('takePending', () => {
    const r = { import: pendingImport, command: pendingCommand };
    pendingImport = null;
    pendingCommand = null;
    return r;
  });

  const toView = async (command) => {
    pendingCommand = command;
    await ctx.window.openView('markdownEditor.main');
    ctx.ui.emit('command', { command });
  };
  ctx.subscriptions.push(
    ctx.commands.register('markdownEditor.open', () => ctx.window.openView('markdownEditor.main')),
    ctx.commands.register('markdownEditor.new', () => toView('new')),
    ctx.commands.register('markdownEditor.openFile', () => toView('openFile')),
    ctx.commands.register('markdownEditor.exportPdf', () => toView('exportPdf')),
    ctx.settings.onDidChange((key) => ctx.ui.emit('settingsChanged', { key, settings: ctx.settings.all() })),
  );
};

/** 資料交換：接收 tooldock.text，開成新的未命名文件（〈7.7〉） */
exports.importText = (context, pkg) => {
  const p = pkg.payload || {};
  if (typeof p.text !== 'string') return { status: 'rejected', message: 'payload.text 必須是字串' };
  const mime = String(p.mime || '').split(';')[0].trim().toLowerCase();
  const markdown = ['text/markdown', 'text/x-markdown'].includes(mime);
  pendingImport = {
    id: pkg.id,
    title: pkg.title,
    text: p.text.replace(/\r\n?/g, '\n'),
    filename: typeof p.filename === 'string' ? p.filename : '',
    notice: markdown || mime === 'text/plain' ? '' : `這份內容是 ${mime || '未標示的格式'}，已當作純文字開啟`,
  };
  ctx.ui.emit('import', { id: pkg.id });
  ctx.log.info(`收到文字交換包「${pkg.title}」（${mime}，${p.text.length} 字元）`);
  return { status: 'imported', message: `已在 Markdown 編輯器開啟「${pkg.title}」` };
};

exports.deactivate = () => {
  pendingImport = null;
  pendingCommand = null;
  imageCache.clear();
};

// 測試用
exports._internal = { readDoc, writeDoc, localImagePath, imageDataUrl, toTablePayload, exportHtml, docTitle };
