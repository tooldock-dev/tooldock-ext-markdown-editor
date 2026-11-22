# 📝 Markdown 編輯器

ToolDock 擴充：編輯 Markdown、即時預覽，用工具列與快捷鍵插入常用語法；匯出 PDF 與單一 HTML，文件中的表格可以交給報表產生器輸出 Excel。

ToolDock 1.4.0 以上可以從擴充商店安裝。ToolDock 1.7.0～1.8.x 曾經內建這個擴充，1.9.0 起改由商店提供；從舊版升級的使用者安裝後，原本的草稿與最近開啟的檔案都還在。

## 功能

- **三種模式**：編輯、分割（預設）、預覽，記住上次的選擇；分割時可以拖曳中間的分隔線。
- **即時預覽**：白底紙張，寬度約等於 A4 內文；編輯區與預覽同步捲動（可在設定關閉）。
- **工具列**：標題、粗體、斜體、刪除線、行內程式碼、項目／編號／待辦清單、引用、連結、圖片、表格（點選欄列數）、程式碼區塊（可選語言）、水平線、分頁。再按一次會移除語法，全部可以 ⌘Z 復原。
- **快捷鍵**（Windows 為 Ctrl）：

  | 快捷鍵 | 動作 |
  |---|---|
  | ⌘B / ⌘I / ⌘⇧D / ⌘E | 粗體／斜體／刪除線／行內程式碼 |
  | ⌘K | 連結 |
  | ⌘1～⌘6、⌘0 | 標題 1～6、取消標題 |
  | ⌘S / ⌘⌥S / ⌘O / ⌘N | 儲存／另存新檔／開啟／新文件 |
  | ⌘P | 匯出 PDF |
  | Tab / ⇧Tab | 清單縮排／取消縮排 |
  | Enter | 在清單項目中延續清單；在空的項目按 Enter 結束清單 |

- **檔案**：開啟 `.md`、`.markdown`、`.txt`，保留原本的換行字元（LF／CRLF）與 BOM。未儲存的內容每 2 秒存成草稿，不正常結束後可以還原。檔案被其他程式修改時會詢問要重新載入或保留。
- **匯出**：
  - **PDF**（需要 ToolDock 1.7.0 以上）：頁碼、書籤，紙張、邊界、頁首頁尾可在設定調整；`<!-- pagebreak -->` 處換頁。
  - **HTML**：單一檔案，內嵌文件樣式與程式碼上色，可選擇把本機圖片內嵌進去。
- **資料交換**（需要 ToolDock 1.4.0 以上）：
  - 接收其他工具分享的 Markdown 文字，開成新的未命名文件。
  - 把文件以 `tooldock.text`（`text/markdown`）分享出去。
  - 把文件中的表格以 `tooldock.table` 交給報表產生器，輸出 Excel、Word 等。

### 在 ToolDock 1.4.0～1.6.x 上

- 「匯出 PDF」不可用，按鈕會顯示「需要 ToolDock 1.7.0 以上」；HTML 匯出與預覽照常。
- 平台還不支援只接收特定格式（`mimes`），所以其他工具分享任何文字時，Markdown 編輯器都會出現在接收清單中；不是 Markdown 的內容會以純文字開啟並提示格式。

## 會讀寫的檔案與網路

- **讀寫**：只讀寫你開啟、儲存或匯出時選擇的檔案。
- **圖片**：預覽與 HTML 匯出會讀取文件所在資料夾底下的本機圖片（單張 20 MB 以內）轉成 `data:` URL 顯示；未存檔的文件只接受絕對路徑。
- **擴充資料**：草稿存在擴充資料夾的 `drafts/`，最近開啟的檔案存在 `ctx.storage`。
- **網路**：擴充本身不連網。預覽中的網路圖片由畫面直接載入；PDF 預設擋下網路圖片，開啟設定 `markdownEditor.pdf.allowRemote` 後才會載入。預覽中點擊 `http`、`https` 連結會用預設瀏覽器開啟。
- **外部程式**：不執行。
- **安全**：Markdown 中的 HTML 一律當成文字顯示，預覽、HTML 與 PDF 都不會執行文件裡的 HTML 或腳本；`javascript:` 連結不會產生。

## 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| `markdownEditor.defaultMode` | `split` | 開啟時的模式：`edit`、`split`、`preview` |
| `markdownEditor.fontSize` | 14 | 編輯區字級（像素） |
| `markdownEditor.syncScroll` | true | 編輯區和預覽同步捲動 |
| `markdownEditor.pdf.pageSize` | `A4` | `A4`、`A3`、`A5`、`Letter`、`Legal` |
| `markdownEditor.pdf.landscape` | false | PDF 橫向 |
| `markdownEditor.pdf.margin` | 15 | PDF 邊界（公釐） |
| `markdownEditor.pdf.header` | （空白） | 頁首，可用 `{page}`、`{pages}`、`{title}`、`{date}`，以全形 `｜` 分隔左中右 |
| `markdownEditor.pdf.footer` | `｜{page} / {pages}｜` | 頁尾（預設置中頁碼） |
| `markdownEditor.pdf.allowRemote` | false | PDF 是否載入網路圖片 |

## 測試

```bash
npm test
```

測試 Markdown 渲染（HTML 跳脫、分頁、待辦清單、程式碼上色、行號、連結過濾）、表格抽取、檔案讀寫（CRLF、BOM）、本機圖片的路徑限制、HTML 匯出，以及工具列與清單的編輯規則。

在 ToolDock repo 中執行時，另外會比對 `ui/document.css` 與平台的 `src/sdk/document.css`，以及表格抽取與報表產生器的結果；單獨執行這個 repo 時會略過這兩項。

## 開發

需要先安裝 ToolDock 和 Node.js 18 以上。

| 指令 | 說明 |
|---|---|
| `npm run dev` | 以開發模式啟動 ToolDock 並載入這個擴充。存檔後會自動重新載入後端和畫面 |
| `npm run debug` | 同上，並開啟後端偵錯埠 `127.0.0.1:9229` |
| `npm run validate` | 檢查 manifest、檔案和相依套件 |
| `npm run pack` | 打包成 `dist/markdown-editor-<版本>.tbx`，只含正式相依 |
| `npm run install-local` | 打包並安裝到本機的 ToolDock |

> 1.9.0 起這個 repo 是唯一的原始碼。ToolDock repo 的自我測試會從平台 repo 旁的這個資料夾以連結方式安裝，測試分享、工具列與 PDF 匯出，修改後可以在 ToolDock repo 執行 `npm run selftest` 一併確認。

## 發佈

推送 `v*` tag 後，GitHub Actions（`.github/workflows/release.yml`）會自動驗證、執行測試、打包、簽章，並建立 GitHub Release。ToolDock 商店會從 Release 下載並驗證簽章。

```bash
npm version patch        # 或 minor / major；會更新 package.json 並建立 v<版本> tag
git push --follow-tags
```

需要的設定（repo → Settings → Secrets and variables → Actions）：

| 種類 | 名稱 | 內容 |
|---|---|---|
| Secret | `TOOLDOCK_SIGNING_KEY` | ToolDock 發佈金鑰的私鑰（PEM 檔完整內容） |
| Variable | `TOOLDOCK_PUBLIC_KEY` | 公鑰字串，CI 發佈前會再驗證一次 |

Release 會附上 `markdown-editor-<版本>.tbx`、`.tbx.sha256`、`.tbx.sig`。詳見 ToolDock 的 [docs/RELEASE.md](https://github.com/tooldock-dev/tooldock-releases/blob/main/docs/RELEASE.md)。

## 專案結構

```
backend/
  index.js        啟用、檔案讀寫、草稿、圖片、匯出、資料交換
  markdown.js     markdown-it 設定、分頁、待辦清單、程式碼上色、標題與表格抽取
ui/
  index.html      畫面與樣式
  app.js          編輯、預覽與捲動同步、檔案、匯出
  editor-core.js  純函式：工具列、快捷鍵、清單延續的文字處理
  document.css    文件樣式（與平台的 tooldock://sdk/document.css 相同）
test/
```

## 授權

使用的 markdown-it 採 MIT 授權、highlight.js 採 BSD-3-Clause 授權，授權條款隨套件附在 `node_modules/` 中。
