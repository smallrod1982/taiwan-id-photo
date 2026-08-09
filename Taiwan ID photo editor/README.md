# 證件照製作（純前端、免費部署）

這是一個完全在瀏覽器端運作的證件照工具，不需要任何後端伺服器，照片也不會上傳到任何地方。

## 功能

- 手機瀏覽器直接拍照（Android/iOS Chrome、Safari 皆可），或從相簿上傳
- AI 自動去背並套用標準底色（紅／藍／白／灰／自訂）
- 13 種常見證件照尺寸（一寸、二寸、護照、簽證…）可選，也可自訂 mm 尺寸
- 裁切、縮放、亮度、對比、磨皮美膚
- 自動排版：把證件照滿版塞進 5 寸／6 寸相紙或 A4 紙，附裁切線，下載後直接送洗

去背功能使用開源套件 [@imgly/background-removal](https://github.com/imgly/background-removal-js)，透過 CDN 在使用者瀏覽器內以 WebAssembly 執行 AI 模型，**完全免費、無使用次數限制**，第一次使用時瀏覽器需要下載模型檔案（幾 MB～數十 MB，依「快速／高品質」模式而定），下載後瀏覽器會快取，之後開啟會快很多。

## 本機測試

不需要安裝任何東西，用任何靜態伺服器打開 `index.html` 即可，例如：

```bash
cd id-photo-app
python3 -m http.server 8000
# 瀏覽器打開 http://localhost:8000
```

（不能直接用 `file://` 開啟，因為相機權限與 ES module 在部分瀏覽器下需要 http/https 網址。）

## 免費部署（三選一，都是拖拉幾下就好，完全免費）

### 方法一：Cloudflare Pages（推薦，速度快）
1. 到 https://pages.cloudflare.com 註冊（免費）
2. 建立新專案 → 選擇「直接上傳」，把整個資料夾（`index.html`、`style.css`、`app.js`）拖進去
3. 幾秒後就會拿到一個 `xxx.pages.dev` 的網址，手機直接開就能用

### 方法二：Netlify
1. 到 https://app.netlify.com/drop
2. 直接把資料夾拖進網頁裡，立刻部署，拿到 `xxx.netlify.app` 網址

### 方法三：GitHub Pages
1. 把這三個檔案 push 到一個 GitHub repo
2. Repo 設定 → Pages → Source 選 main branch，儲存
3. 幾分鐘後可用 `https://你的帳號.github.io/repo名稱/` 開啟

三種都是靜態網站託管，長期使用完全免費，沒有流量或用量限制的疑慮（除非流量非常大）。

## 之後想加強效果怎麼辦？

如果之後覺得手機瀏覽器跑的去背效果不夠精細（例如頭髮絲、複雜背景邊緣），可以另外做一個小型後端 API（例如用 HivisionIDPhotos 或 rembg 部署在 Hugging Face Spaces / Render 等），前端這裡加一個「進階去背」按鈕改呼叫該 API 即可，其餘裁切、修圖、排版邏輯完全不用改。

## 注意事項

- 這個工具沒有做嚴格的證件照國家法規驗證（例如頭部比例、眼睛位置的精確法規要求），排版與尺寸僅供一般使用參考，正式證件申請請以受理單位規定為準。
- 磨皮效果是簡化版（整體柔化＋原圖疊加），效果比專業修圖 App 陽春，之後可以再優化。
