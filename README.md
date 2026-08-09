# 證件照製作（純前端、免費部署）

這是一個完全在瀏覽器端運作的證件照工具，照片不會上傳到任何地方（選用 Gemini 去背時，照片只會傳到你自己部署的伺服器函式再轉送給 Google，其他情況完全在你的裝置本機處理）。

## 功能

- 手機瀏覽器直接拍照（Android/iOS Chrome、Safari 皆可），或從相簿上傳
- AI 自動去背並套用標準底色（紅／藍／白／灰／自訂）
- 依台灣官方規格製作證件照：身分證/護照/台胞證（3.5×4.5cm）、健保卡/國際駕照/學生證（4.2×4.7cm）、1吋（2.8×3.5cm）、美簽、日簽等，也可自訂 mm 尺寸
- 裁切畫面會疊一層**白色虛線頭部對齊框**（頭頂線＋下巴允許範圍＋臉部橢圓），對照官方規定的頭長比例即時顯示，方便對準
- 裁切、縮放、亮度、對比、磨皮美膚
- 自動排版：預設把證件照滿版塞進 **4×6 吋相紙（152×102mm，超商沖印機最常見的規格）**，也可以選 5 寸相紙或 A4 紙，附裁切線，下載後直接送洗

## 去背引擎（兩種可選，畫面上可以切換）

### 1. 本機瀏覽器 AI（預設，免費，不用設定）

使用開源套件 [@imgly/background-removal](https://github.com/imgly/background-removal-js)，透過 CDN 在使用者瀏覽器內以 WebAssembly 執行 AI 模型，完全免費、無使用次數限制。第一次使用時瀏覽器需要下載模型檔案（幾 MB～數十 MB，依「快速／高品質」模式而定），下載後瀏覽器會快取。

### 2. Gemini API（更精準，需要自己部署 + 申請金鑰）

**這個模式的設計重點：Gemini 只負責畫出「哪裡是人、哪裡是背景」的遮罩（黑白分割線），完全不會去重新產生或修改照片內容。實際輸出的每一個像素都是直接從你原始拍的照片複製過去的，AI 不會「重畫」臉，所以臉部、膚色、五官不可能被 AI 改動——這跟本機模式是同一種安全設計，只是遮罩換成 Gemini 來判斷，通常對頭髮絲、複雜背景的邊緣會判斷得更準。**

要用這個模式，需要三個步驟：

1. 到 https://aistudio.google.com/apikey 免費申請一組 Gemini API Key（Google 帳號即可申請，有免費額度，個人使用通常足夠；用量大才會產生費用，收費標準請直接查 Gemini API 官方定價頁面）。
2. 用「方法一：Cloudflare Pages」部署整個資料夾（**必須包含 `functions/api/segment.js` 這個檔案**，Cloudflare Pages 會自動把 `functions/` 資料夾底下的檔案變成後端 API，不需要額外設定伺服器）。
3. 部署完成後，到 Cloudflare Pages 專案 → **Settings → Environment variables**，新增一個名為 `GEMINI_API_KEY` 的變數，型別選 **Secret**，值貼上你的金鑰，存檔後重新部署一次（Redeploy）讓變數生效。

設定完成後，畫面上「去背引擎」選 Gemini API 即可使用；金鑰只存在 Cloudflare 後台，不會出現在瀏覽器或網頁原始碼裡。

> 這個模式只有部署在 **Cloudflare Pages** 才能直接運作，因為需要 `functions/` 資料夾支援的後端函式。如果部署在 GitHub Pages 或 Netlify Drop（純靜態），畫面上選 Gemini API 去背會顯示連線失敗的錯誤訊息，此時改選「本機瀏覽器 AI」即可正常使用。

## 本機測試

不需要安裝任何東西，用任何靜態伺服器打開 `index.html` 即可（Gemini 去背功能無法在純靜態伺服器測試，需部署到 Cloudflare Pages 才能用）：

```bash
cd id-photo-app
python3 -m http.server 8000
# 瀏覽器打開 http://localhost:8000
```

（不能直接用 `file://` 開啟，因為相機權限與 ES module 在部分瀏覽器下需要 http/https 網址。）

## 免費部署

### 方法一：Cloudflare Pages（推薦，速度快，且支援 Gemini 去背功能）
1. 到 https://pages.cloudflare.com 註冊（免費）
2. 建立新專案 → 選擇「直接上傳」，把整個資料夾（`index.html`、`style.css`、`app.js`、`functions/` 資料夾）都拖進去
3. 幾秒後就會拿到一個 `xxx.pages.dev` 的網址，手機直接開就能用
4. 如果要用 Gemini 去背，記得照上面「Gemini API」段落設定 `GEMINI_API_KEY`

### 方法二：Netlify（純靜態，不支援 Gemini 去背）
1. 到 https://app.netlify.com/drop
2. 直接把資料夾拖進網頁裡，立刻部署，拿到 `xxx.netlify.app` 網址

### 方法三：GitHub Pages（純靜態，不支援 Gemini 去背）
1. 把 `index.html`、`style.css`、`app.js` push 到一個 GitHub repo
2. Repo 設定 → Pages → Source 選 main branch，儲存
3. 幾分鐘後可用 `https://你的帳號.github.io/repo名稱/` 開啟

以上都是免費方案，長期使用不用錢，沒有流量或用量限制的疑慮（除非流量非常大，或 Gemini API 用量超過免費額度）。

## 注意事項

- 尺寸與頭部對齊虛線框已依台灣官方公告（內政部戶政司國民身分證相片規格、外交部領事事務局晶片護照相片規格）設定頭長 3.2〜3.6cm、臉部占比 70%〜80% 等數字，但這個工具沒有做嚴格的自動法規驗證（例如沒有真的偵測五官位置），排版與尺寸僅供對齊參考，正式證件申請前請自行核對受理單位最新規定。
- 磨皮效果是簡化版（整體柔化＋原圖疊加），效果比專業修圖 App 陽春，之後可以再優化。
- Gemini 模型名稱寫在 `functions/api/segment.js` 最上面的 `GEMINI_MODEL` 常數，如果之後 Google 更新了更新的模型，改這一行即可。
