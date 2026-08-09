// ===================== 證件照製作 App =====================
// 全部處理都在瀏覽器端完成（去背用 @imgly/background-removal，透過 CDN 動態載入）
// 不會把照片上傳到任何伺服器。

// ---------- 常數設定 ----------

const DPI = 300; // 輸出解析度
const mm2px = (mm) => Math.round((mm / 25.4) * DPI);

// 尺寸與頭長規格依據台灣官方公告（內政部戶政司國民身分證相片規格 / 外交部領事事務局晶片護照相片規格）。
// headMin/headMax（mm）＝「頭頂至下顎」官方規定範圍，用於畫面上的虛線對齊參考框；
// 沒有標示 headMin/headMax 的尺寸表示查無官方頭長規定，對齊框僅供構圖參考、非法規要求。
const SIZE_PRESETS = [
  {
    label: "身分證 / 護照 / 台胞證（2吋大頭照 3.5×4.5cm）",
    w: 35,
    h: 45,
    headMin: 32,
    headMax: 36,
    officialWhiteBg: true,
  },
  { label: "健保卡 / 國際駕照 / 學生證（2吋半身照 4.2×4.7cm）", w: 42, h: 47 },
  { label: "一般1吋照片（國內駕照 / 身心障礙手冊 2.8×3.5cm）", w: 28, h: 35 },
  { label: "美國簽證（5×5cm）", w: 50, h: 50, headMin: 25, headMax: 35 },
  { label: "日本簽證（3×4cm）", w: 30, h: 40 },
  { label: "日本打工度假簽證（4.5×3cm）", w: 45, h: 30 },
  { label: "自訂尺寸…", w: null, h: null, custom: true },
];

const PAPER_PRESETS = [
  { label: "4×6吋相紙 152×102mm（超商沖印最常見規格）", w: 152, h: 102 },
  { label: "5 寸相紙 127×89mm", w: 127, h: 89 },
  { label: "A4 紙 210×297mm", w: 210, h: 297 },
  { label: "自訂尺寸…", w: null, h: null, custom: true },
];

const BG_COLORS = [
  { label: "紅底", value: "#C8161D" },
  { label: "藍底", value: "#3379C4" },
  { label: "白底", value: "#FFFFFF" },
  { label: "淺灰", value: "#E0E0E0" },
];

const MAX_SOURCE_DIM = 1400; // 送去去背前先縮圖，加快處理速度
const PREVIEW_MAX_DIM = 560; // 修圖預覽用的縮圖上限（讓滑桿即時反應更順）

// ---------- 全域狀態 ----------

const state = {
  step: 1,
  cameraStream: null,
  facingMode: "user",
  sourceCanvas: null, // 原始照片（已縮圖）
  processedCanvas: null, // 去背+套底色後的照片（跟 sourceCanvas 同大小）
  selectedColor: BG_COLORS[0].value,
  selectedSize: SIZE_PRESETS[0],
  quality: "fast",
  crop: { offsetX: 0, offsetY: 0, scale: 1 }, // 相對於 processedCanvas 的裁切狀態
  adjust: { brightness: 0, contrast: 0, smooth: 0, whiten: 0, rosy: 0, sharpen: 0 },
  finalCanvas: null, // 最終單張證件照 canvas（已套用裁切+修圖，尺寸=目標mm@300dpi）
  selectedPaper: PAPER_PRESETS[0],
};

// ---------- 小工具 ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showOverlay(text) {
  $("#loadingText").textContent = text;
  $("#loadingOverlay").classList.remove("hidden");
}
function hideOverlay() {
  $("#loadingOverlay").classList.add("hidden");
}

function canvasToBlob(canvas, type = "image/png", quality = 0.92) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, "image/png");
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------- Step 導覽 ----------

function goToStep(n) {
  state.step = n;
  for (let i = 1; i <= 4; i++) {
    $(`#panel-${i}`).classList.toggle("hidden", i !== n);
  }
  $$("#stepsBar .step-dot").forEach((dot) => {
    const s = Number(dot.dataset.step);
    dot.classList.toggle("active", s === n);
    dot.classList.toggle("done", s < n);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (n === 1) {
    startCameraIfNeeded();
  } else {
    stopCamera();
  }
}

// ---------- Step 1：相機 / 上傳 ----------

function initTabs() {
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $("#tab-camera").classList.toggle("hidden", tab !== "camera");
      $("#tab-upload").classList.toggle("hidden", tab !== "upload");
      if (tab === "camera") startCameraIfNeeded();
      else stopCamera();
    });
  });
}

async function startCameraIfNeeded() {
  const cameraTabActive = !$("#tab-camera").classList.contains("hidden");
  if (!cameraTabActive || state.step !== 1) return;
  if (state.cameraStream) return; // 已經開啟
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    state.cameraStream = stream;
    $("#video").srcObject = stream;
    $("#cameraHint").textContent = "請正臉面對鏡頭，保持光線充足。";
    $("#btnSwitchCam").hidden = false;
  } catch (err) {
    $("#cameraHint").textContent =
      "無法開啟相機（" + (err && err.message ? err.message : "權限被拒絕") + "），請改用「從相簿上傳」。";
  }
}

function stopCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
}

function resizeToCanvas(img) {
  let { width, height } = img;
  if (width > height && width > MAX_SOURCE_DIM) {
    height = Math.round((height * MAX_SOURCE_DIM) / width);
    width = MAX_SOURCE_DIM;
  } else if (height >= width && height > MAX_SOURCE_DIM) {
    width = Math.round((width * MAX_SOURCE_DIM) / height);
    height = MAX_SOURCE_DIM;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

function setSourceImageFromCanvas(canvas) {
  state.sourceCanvas = canvas;
  const preview = $("#sourcePreview");
  preview.width = canvas.width;
  preview.height = canvas.height;
  preview.getContext("2d").drawImage(canvas, 0, 0);
  goToStep(2);
}

function initCapture() {
  $("#btnCapture").addEventListener("click", () => {
    const video = $("#video");
    if (!video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    // 前鏡頭鏡像修正：拍出來的照片維持正常（非鏡像）方向
    if (state.facingMode === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    setSourceImageFromCanvas(resizeToCanvas(canvas));
  });

  $("#btnSwitchCam").addEventListener("click", () => {
    state.facingMode = state.facingMode === "user" ? "environment" : "user";
    stopCamera();
    startCameraIfNeeded();
  });

  const fileInput = $("#fileInput");
  const uploadBox = $(".upload-box");
  fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
  uploadBox.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadBox.classList.add("dragover");
  });
  uploadBox.addEventListener("dragleave", () => uploadBox.classList.remove("dragover"));
  uploadBox.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadBox.classList.remove("dragover");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  async function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      setSourceImageFromCanvas(resizeToCanvas(img));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  $("#btnRetake").addEventListener("click", () => goToStep(1));
}

// ---------- Step 2：規格 / 底色 / 去背 ----------

function initSizeAndColor() {
  const sel = $("#sizePreset");
  SIZE_PRESETS.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", () => {
    const preset = SIZE_PRESETS[Number(sel.value)];
    state.selectedSize = preset;
    $("#customSizeWrap").classList.toggle("hidden", !preset.custom);
    updateSizeSpecHint();
  });

  $("#customW").addEventListener("input", updateCustomSize);
  $("#customH").addEventListener("input", updateCustomSize);
  function updateCustomSize() {
    const w = Number($("#customW").value) || 0;
    const h = Number($("#customH").value) || 0;
    state.selectedSize = { label: "自訂", w, h, custom: true };
    updateSizeSpecHint();
  }

  updateSizeSpecHint();

  const swatchWrap = $("#colorSwatches");
  BG_COLORS.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "swatch" + (i === 0 ? " selected" : "");
    el.style.background = c.value;
    el.title = c.label;
    el.addEventListener("click", () => {
      $$(".swatch").forEach((s) => s.classList.remove("selected"));
      el.classList.add("selected");
      state.selectedColor = c.value;
    });
    swatchWrap.appendChild(el);
  });
  // 自訂顏色選項
  const customSwatch = document.createElement("input");
  customSwatch.type = "color";
  customSwatch.className = "swatch";
  customSwatch.value = "#00A651";
  customSwatch.title = "自訂顏色";
  customSwatch.addEventListener("input", () => {
    $$(".swatch").forEach((s) => s.classList.remove("selected"));
    state.selectedColor = customSwatch.value;
  });
  swatchWrap.appendChild(customSwatch);

  $$('input[name="quality"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.quality = e.target.value;
    })
  );

  $("#btnProcess").addEventListener("click", runBackgroundRemoval);
}

// 依序嘗試多個 CDN 來源，任何一個能載入即可（增加離線/網路狀況不佳時的成功率）
const BG_REMOVAL_CDN_URLS = [
  "https://esm.sh/@imgly/background-removal@1.7.0",
  "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm",
  "https://cdn.skypack.dev/@imgly/background-removal@1.7.0",
];

let bgRemovalModulePromise = null;
async function loadBgRemovalModule() {
  if (bgRemovalModulePromise) return bgRemovalModulePromise;
  bgRemovalModulePromise = (async () => {
    let lastErr;
    for (const url of BG_REMOVAL_CDN_URLS) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        if (mod && (mod.default || mod.removeBackground)) return mod;
        lastErr = new Error("模組載入成功但找不到 removeBackground 函式：" + url);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("所有 CDN 來源都無法載入");
  })().catch((err) => {
    bgRemovalModulePromise = null; // 失敗時允許重試
    throw err;
  });
  return bgRemovalModulePromise;
}

async function runBackgroundRemoval() {
  if (!state.sourceCanvas) return;
  $("#processHint").textContent = "";
  showOverlay("正在下載並執行 AI 去背模型，第一次使用可能需要 10~30 秒…");
  try {
    const mod = await loadBgRemovalModule();
    const removeBackground = mod.default || mod.removeBackground;
    const srcBlob = await canvasToBlob(state.sourceCanvas, "image/png");
    const cutoutBlob = await removeBackground(srcBlob, {
      model: state.quality === "fast" ? "isnet_quant8" : "isnet_fp16",
      output: { format: "image/png", quality: 1, type: "foreground" },
    });
    const cutoutUrl = URL.createObjectURL(cutoutBlob);
    const cutoutImg = await loadImage(cutoutUrl);
    URL.revokeObjectURL(cutoutUrl);
    const cutoutCanvas = document.createElement("canvas");
    cutoutCanvas.width = state.sourceCanvas.width;
    cutoutCanvas.height = state.sourceCanvas.height;
    cutoutCanvas.getContext("2d").drawImage(cutoutImg, 0, 0, cutoutCanvas.width, cutoutCanvas.height);

    const canvas = document.createElement("canvas");
    canvas.width = state.sourceCanvas.width;
    canvas.height = state.sourceCanvas.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = state.selectedColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(cutoutCanvas, 0, 0);

    state.processedCanvas = canvas;
    invalidateRetouchCaches();
    resetCropState();
    hideOverlay();
    goToStep(3);
    renderCrop();
  } catch (err) {
    console.error(err);
    hideOverlay();
    $("#processHint").textContent =
      "去背失敗：" +
      (err && err.message ? err.message : "請確認網路連線後再試一次（AI 模型需要從網路下載）。");
  }
}

// ---------- Step 3：裁切 / 修圖 ----------

function resetCropState() {
  state.crop = { offsetX: 0, offsetY: 0, scale: 1 };
  state.adjust = { brightness: 0, contrast: 0, smooth: 0, whiten: 0, rosy: 0, sharpen: 0 };
}

function getTargetRatio() {
  const s = state.selectedSize;
  const w = s.w || 25,
    h = s.h || 35;
  return w / h;
}

let cropDrag = null;
function initCropTool() {
  const canvas = $("#cropCanvas");

  function pointerPos(e) {
    return { x: e.clientX, y: e.clientY };
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    cropDrag = { start: pointerPos(e), offsetX: state.crop.offsetX, offsetY: state.crop.offsetY };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!cropDrag) return;
    const p = pointerPos(e);
    const dx = p.x - cropDrag.start.x;
    const dy = p.y - cropDrag.start.y;
    const rect = canvas.getBoundingClientRect();
    state.crop.offsetX = cropDrag.offsetX + (dx / rect.width) * canvas.width;
    state.crop.offsetY = cropDrag.offsetY + (dy / rect.height) * canvas.height;
    renderCrop();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) =>
    canvas.addEventListener(ev, () => (cropDrag = null))
  );
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -5 : 5;
      const newZoom = clamp(Number($("#zoomRange").value) + delta, 50, 300);
      $("#zoomRange").value = newZoom;
      state.crop.scale = newZoom / 100;
      renderCrop();
    },
    { passive: false }
  );

  // 簡易雙指縮放
  let pinchStartDist = null;
  let pinchStartScale = 1;
  canvas.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [t1, t2] = e.touches;
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        if (pinchStartDist == null) {
          pinchStartDist = dist;
          pinchStartScale = state.crop.scale;
        } else {
          const ratio = dist / pinchStartDist;
          state.crop.scale = clamp(pinchStartScale * ratio, 0.5, 3);
          $("#zoomRange").value = Math.round(state.crop.scale * 100);
          renderCrop();
        }
      }
    },
    { passive: false }
  );
  canvas.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) pinchStartDist = null;
  });

  $("#zoomRange").addEventListener("input", (e) => {
    state.crop.scale = Number(e.target.value) / 100;
    renderCrop();
  });
  // 修圖滑桿：拖曳時只重繪預覽（用縮圖 proxy，反應即時）
  $("#brightRange").addEventListener("input", (e) => {
    state.adjust.brightness = Number(e.target.value);
    renderCrop();
  });
  $("#contrastRange").addEventListener("input", (e) => {
    state.adjust.contrast = Number(e.target.value);
    renderCrop();
  });
  $("#smoothRange").addEventListener("input", (e) => {
    state.adjust.smooth = Number(e.target.value);
    renderCrop();
  });
  $("#whitenRange").addEventListener("input", (e) => {
    state.adjust.whiten = Number(e.target.value);
    renderCrop();
  });
  $("#rosyRange").addEventListener("input", (e) => {
    state.adjust.rosy = Number(e.target.value);
    renderCrop();
  });
  $("#sharpenRange").addEventListener("input", (e) => {
    state.adjust.sharpen = Number(e.target.value);
    renderCrop();
  });
  $("#btnResetAdjust").addEventListener("click", () => {
    state.adjust = { brightness: 0, contrast: 0, smooth: 0, whiten: 0, rosy: 0, sharpen: 0 };
    state.crop = { offsetX: 0, offsetY: 0, scale: 1 };
    $("#brightRange").value = 0;
    $("#contrastRange").value = 0;
    $("#smoothRange").value = 0;
    $("#whitenRange").value = 0;
    $("#rosyRange").value = 0;
    $("#sharpenRange").value = 0;
    $("#zoomRange").value = 100;
    renderCrop();
  });

  $("#btnConfirmCrop").addEventListener("click", confirmCropAndProceed);
}

// ---------- 修圖引擎（像素級：智慧磨皮 / 美白 / 紅潤 / 亮度對比 / 銳化） ----------
//
// 設計參考「美圖秀秀」風格的美顏流程：
// - 智慧磨皮：邊緣保留式柔膚（先做低頻模糊，再依「細節/邊緣強度」決定混合比例），
//   平坦的皮膚會被柔化，眼睛、頭髮、嘴唇等高細節邊緣則保留清晰，不會整臉變模糊。
// - 美白 / 紅潤：用膚色遮罩（YCbCr）只作用在皮膚上，不會把背景或頭髮染色。
// - 銳化：最後用 unsharp mask 讓五官恢復銳利。
// 所有效果都在瀏覽器端對像素運算，照片不會上傳。

// 單通道可分離 box blur（水平＋垂直，滑動視窗），邊界以複製邊緣處理
function boxBlurChannel(src, w, h, r) {
  if (r < 1) {
    const copy = new Float32Array(src.length);
    copy.set(src);
    return copy;
  }
  const win = r * 2 + 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + clamp(k, 0, w - 1)];
    tmp[row] = sum / win;
    for (let x = 1; x < w; x++) {
      sum += src[row + clamp(x + r, 0, w - 1)] - src[row + clamp(x - r - 1, 0, w - 1)];
      tmp[row + x] = sum / win;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    out[x] = sum / win;
    for (let y = 1; y < h; y++) {
      sum += tmp[clamp(y + r, 0, h - 1) * w + x] - tmp[clamp(y - r - 1, 0, h - 1) * w + x];
      out[y * w + x] = sum / win;
    }
  }
  return out;
}

function applyRetouch(srcCanvas) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  octx.drawImage(srcCanvas, 0, 0);

  const a = state.adjust;
  const smooth = (a.smooth || 0) / 100;
  const whiten = (a.whiten || 0) / 100;
  const rosy = (a.rosy || 0) / 100;
  const sharpen = (a.sharpen || 0) / 100;
  const bright = a.brightness || 0;
  const contrast = a.contrast || 0;
  if (!smooth && !whiten && !rosy && !sharpen && !bright && !contrast) return out;

  const imgData = octx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const n = w * h;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    R[i] = data[p];
    G[i] = data[p + 1];
    B[i] = data[p + 2];
  }
  const minDim = Math.min(w, h);

  // 工作緩衝（後續就地修改）
  let WR = R;
  let WG = G;
  let WB = B;

  // 1) 智慧磨皮：邊緣保留式柔膚
  if (smooth > 0) {
    const r = Math.max(1, Math.round(minDim * 0.012));
    let bR = boxBlurChannel(R, w, h, r);
    bR = boxBlurChannel(bR, w, h, r);
    let bG = boxBlurChannel(G, w, h, r);
    bG = boxBlurChannel(bG, w, h, r);
    let bB = boxBlurChannel(B, w, h, r);
    bB = boxBlurChannel(bB, w, h, r);
    // 亮度細節 detail 小＝皮膚紋理/毛孔/斑點（要柔化）；大＝五官/頭髮邊緣（要保留）。
    // 用 smoothstep 從 EDGE_LO 到 EDGE_HI 過渡：低於 LO 幾乎全柔化，高於 HI 幾乎全保留。
    const EDGE_LO = 16;
    const EDGE_HI = 52;
    const nR = new Float32Array(n);
    const nG = new Float32Array(n);
    const nB = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lo = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
      const lb = 0.299 * bR[i] + 0.587 * bG[i] + 0.114 * bB[i];
      const detail = Math.abs(lo - lb);
      const edge = smoothstep(EDGE_LO, EDGE_HI, detail); // 0..1，越大越像邊緣
      const blend = smooth * (1 - edge) * 0.9; // 平坦皮膚才大幅柔化
      nR[i] = R[i] + (bR[i] - R[i]) * blend;
      nG[i] = G[i] + (bG[i] - G[i]) * blend;
      nB[i] = B[i] + (bB[i] - B[i]) * blend;
    }
    WR = nR;
    WG = nG;
    WB = nB;
  }

  // 2) 美白 / 紅潤：只作用在膚色像素（YCbCr 軟遮罩）
  if (whiten > 0 || rosy > 0) {
    for (let i = 0; i < n; i++) {
      const r0 = WR[i];
      const g0 = WG[i];
      const b0 = WB[i];
      const Y = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
      const Cb = -0.168736 * r0 - 0.331264 * g0 + 0.5 * b0 + 128;
      const Cr = 0.5 * r0 - 0.418688 * g0 - 0.081312 * b0 + 128;
      const sCr = smoothstep(133, 150, Cr) * (1 - smoothstep(173, 188, Cr));
      const sCb = smoothstep(77, 90, Cb) * (1 - smoothstep(127, 140, Cb));
      const sY = smoothstep(35, 60, Y);
      const skin = sCr * sCb * sY;
      if (skin <= 0) continue;
      if (whiten > 0) {
        const amt = whiten * skin * 0.5; // 提亮膚色（往白色柔和拉）
        WR[i] = r0 + (255 - r0) * amt;
        WG[i] = WG[i] + (255 - WG[i]) * amt;
        WB[i] = WB[i] + (255 - WB[i]) * amt;
      }
      if (rosy > 0) {
        const amt = rosy * skin; // 增加暖色調氣色
        WR[i] = WR[i] + amt * 20;
        WG[i] = WG[i] + amt * 4;
        WB[i] = WB[i] - amt * 8;
      }
    }
  }

  // 3) 亮度 / 對比（全域）
  if (bright !== 0 || contrast !== 0) {
    const bf = (100 + bright) / 100;
    const cf = (100 + contrast) / 100;
    for (let i = 0; i < n; i++) {
      WR[i] = (WR[i] * bf - 128) * cf + 128;
      WG[i] = (WG[i] * bf - 128) * cf + 128;
      WB[i] = (WB[i] * bf - 128) * cf + 128;
    }
  }

  // 4) 銳化（unsharp mask，全域，最後做，讓五官恢復銳利）
  if (sharpen > 0) {
    const rs = Math.max(1, Math.round(minDim * 0.004));
    const sbR = boxBlurChannel(WR, w, h, rs);
    const sbG = boxBlurChannel(WG, w, h, rs);
    const sbB = boxBlurChannel(WB, w, h, rs);
    const amt = sharpen * 1.1;
    for (let i = 0; i < n; i++) {
      WR[i] = WR[i] + (WR[i] - sbR[i]) * amt;
      WG[i] = WG[i] + (WG[i] - sbG[i]) * amt;
      WB[i] = WB[i] + (WB[i] - sbB[i]) * amt;
    }
  }

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    data[p] = clamp(Math.round(WR[i]), 0, 255);
    data[p + 1] = clamp(Math.round(WG[i]), 0, 255);
    data[p + 2] = clamp(Math.round(WB[i]), 0, 255);
    // alpha 不變（去背後已套底色，整張不透明）
  }
  octx.putImageData(imgData, 0, 0);
  return out;
}

// 修圖結果快取：預覽用縮圖 proxy（滑桿即時），輸出用全解析度
let _proxyBase = null;
let _previewCache = { sig: null, canvas: null };
let _fullCache = { sig: null, canvas: null };

function invalidateRetouchCaches() {
  _proxyBase = null;
  _previewCache = { sig: null, canvas: null };
  _fullCache = { sig: null, canvas: null };
}

function adjustSig() {
  const a = state.adjust;
  return [a.brightness, a.contrast, a.smooth, a.whiten, a.rosy, a.sharpen].join(",");
}

function getProxyBase() {
  if (_proxyBase) return _proxyBase;
  const src = state.processedCanvas;
  const sc = Math.min(1, PREVIEW_MAX_DIM / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * sc));
  const h = Math.max(1, Math.round(src.height * sc));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(src, 0, 0, w, h);
  _proxyBase = c;
  return c;
}

function getPreviewRetouched() {
  const sig = adjustSig();
  if (_previewCache.sig === sig && _previewCache.canvas) return _previewCache.canvas;
  const c = applyRetouch(getProxyBase());
  _previewCache = { sig, canvas: c };
  return c;
}

function getFullRetouched() {
  const sig = adjustSig();
  if (_fullCache.sig === sig && _fullCache.canvas) return _fullCache.canvas;
  const c = applyRetouch(state.processedCanvas);
  _fullCache = { sig, canvas: c };
  return c;
}

// 繪製裁切預覽：裁切框永遠是正方形容器，內容依目標比例置中顯示
function renderCrop() {
  const canvas = $("#cropCanvas");
  const wrap = $("#cropWrap");
  const size = wrap.clientWidth || 320;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  const ratio = getTargetRatio();
  let frameW, frameH;
  if (ratio >= 1) {
    frameW = size * 0.9;
    frameH = frameW / ratio;
  } else {
    frameH = size * 0.9;
    frameW = frameH * ratio;
  }
  const frameX = (size - frameW) / 2;
  const frameY = (size - frameH) / 2;

  if (!state.processedCanvas) return;
  const src = getPreviewRetouched(); // 已套用修圖的縮圖

  ctx.save();
  ctx.beginPath();
  ctx.rect(frameX, frameY, frameW, frameH);
  ctx.clip();

  // drawW/drawH 只取決於框大小與縮放，與 src 解析度無關（proxy 與全圖比例相同）
  const scale = state.crop.scale;
  const drawW = frameW * scale;
  const drawH = (frameW / (src.width / src.height)) * scale;
  const centerX = frameX + frameW / 2 + state.crop.offsetX;
  const centerY = frameY + frameH / 2 + state.crop.offsetY;

  ctx.drawImage(src, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);
  ctx.restore();

  // 畫出框線
  ctx.strokeStyle = "rgba(37,99,235,0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(frameX, frameY, frameW, frameH);

  // 畫出頭部對齊虛線參考框（僅為畫面上的對齊輔助，不會被存進最終輸出圖片）
  drawFaceGuide(ctx, frameX, frameY, frameW, frameH);

  // 存下這次算好的框資訊（比例式，供輸出使用）
  renderCrop._lastFrame = {
    frameX,
    frameY,
    frameW,
    frameH,
    centerX,
    centerY,
    drawW,
    drawH,
  };
}

// 取得目前尺寸的官方頭長規定（mm），查無官方規定時回傳估算值僅供參考
function getHeadGuideMm() {
  const s = state.selectedSize;
  if (s.headMin && s.headMax) {
    return { min: s.headMin, max: s.headMax, official: true };
  }
  const Hmm = s.h || 45;
  const est = Hmm * 0.7;
  return { min: est * 0.94, max: est * 1.06, official: false };
}

// 在裁切預覽上畫出白色虛線頭部對齊參考框：
// - 一條「頭頂」線
// - 兩條「下巴」允許範圍線（官方規定的頭長上下限各對應一條）
// - 一個橢圓形臉部輪廓參考
function drawFaceGuide(ctx, frameX, frameY, frameW, frameH) {
  const s = state.selectedSize;
  const Hmm = s.h || 45;
  const pxPerMm = frameH / Hmm;
  const guide = getHeadGuideMm();
  const headMidMm = (guide.min + guide.max) / 2;
  const remainMm = Math.max(0, Hmm - headMidMm);
  const topMarginMm = remainMm * 0.4; // 頭頂到相框上緣的留白比例（常見排版慣例）

  const crownMm = topMarginMm;
  const chinMinMm = topMarginMm + guide.min;
  const chinMaxMm = topMarginMm + guide.max;
  const chinMidMm = topMarginMm + headMidMm;

  const crownY = frameY + crownMm * pxPerMm;
  const chinMinY = frameY + chinMinMm * pxPerMm;
  const chinMaxY = frameY + chinMaxMm * pxPerMm;
  const chinMidY = frameY + chinMidMm * pxPerMm;

  const centerX = frameX + frameW / 2;
  const ovalHeight = chinMidY - crownY;
  const ovalWidth = ovalHeight * 0.74; // 臉部寬高比例約估

  ctx.save();
  ctx.strokeStyle = guide.official ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.65)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);

  // 臉部橢圓參考
  ctx.beginPath();
  ctx.ellipse(centerX, (crownY + chinMidY) / 2, ovalWidth / 2, ovalHeight / 2, 0, 0, Math.PI * 2);
  ctx.stroke();

  // 頭頂對齊線
  ctx.beginPath();
  ctx.moveTo(frameX + 4, crownY);
  ctx.lineTo(frameX + frameW - 4, crownY);
  ctx.stroke();

  // 下巴允許範圍（官方頭長下限～上限）
  ctx.beginPath();
  ctx.moveTo(frameX + 4, chinMinY);
  ctx.lineTo(frameX + frameW - 4, chinMinY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(frameX + 4, chinMaxY);
  ctx.lineTo(frameX + frameW - 4, chinMaxY);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "9px sans-serif";
  ctx.textBaseline = "bottom";
  ctx.fillText("頭頂", frameX + 4, crownY - 3);
  ctx.textBaseline = "top";
  ctx.fillText("下巴範圍", frameX + 4, chinMaxY + 3);
  ctx.restore();
}

function updateSizeSpecHint() {
  const s = state.selectedSize;
  const el = $("#sizeSpecHint");
  const colorHintEl = $("#colorHint");
  if (!el) return;
  if (s.headMin && s.headMax) {
    el.textContent = `台灣官方規定：頭頂至下顎需 ${(s.headMin / 10).toFixed(1)}〜${(s.headMax / 10).toFixed(
      1
    )}cm，臉部占照片面積 70%〜80%。`;
  } else if (s.custom) {
    el.textContent = "自訂尺寸，虛線對齊框為一般估算值，非官方規定。";
  } else {
    el.textContent = "此尺寸查無官方頭長規定，虛線對齊框僅供構圖參考。";
  }
  if (colorHintEl) {
    colorHintEl.textContent = s.officialWhiteBg ? "此規格依規定須使用白色背景。" : "";
  }
}

function confirmCropAndProceed() {
  const f = renderCrop._lastFrame;
  const s = state.selectedSize;
  const targetWmm = s.w || 25;
  const targetHmm = s.h || 35;
  const outW = mm2px(targetWmm);
  const outH = mm2px(targetHmm);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  const ctx = outCanvas.getContext("2d");

  const retouched = getFullRetouched(); // 全解析度修圖結果
  const scaleToOut = outW / f.frameW;
  const drawW = f.drawW * scaleToOut;
  const drawH = f.drawH * scaleToOut;
  const centerX = (f.centerX - f.frameX) * scaleToOut;
  const centerY = (f.centerY - f.frameY) * scaleToOut;

  ctx.drawImage(retouched, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);

  state.finalCanvas = outCanvas;

  const preview = $("#finalSingle");
  preview.width = outW;
  preview.height = outH;
  preview.getContext("2d").drawImage(outCanvas, 0, 0);

  goToStep(4);
}

// ---------- Step 4：排版輸出 ----------

function initLayoutStep() {
  const sel = $("#paperPreset");
  PAPER_PRESETS.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", () => {
    const preset = PAPER_PRESETS[Number(sel.value)];
    state.selectedPaper = preset;
    $("#customPaperWrap").classList.toggle("hidden", !preset.custom);
  });
  $("#customPaperW").addEventListener("input", updateCustomPaper);
  $("#customPaperH").addEventListener("input", updateCustomPaper);
  function updateCustomPaper() {
    const w = Number($("#customPaperW").value) || 0;
    const h = Number($("#customPaperH").value) || 0;
    state.selectedPaper = { label: "自訂", w, h, custom: true };
  }

  $("#btnDownloadSingle").addEventListener("click", () => {
    if (state.finalCanvas) downloadCanvas(state.finalCanvas, "證件照_單張.png");
  });

  $("#btnLayout").addEventListener("click", generateLayout);
  $("#btnDownloadLayout").addEventListener("click", () => {
    const c = $("#layoutCanvas");
    if (c.width) downloadCanvas(c, "證件照_排版相紙.png");
  });

  $("#btnStartOver").addEventListener("click", resetAll);
}

function generateLayout() {
  if (!state.finalCanvas) return;
  const paper = state.selectedPaper;
  const paperWmm = paper.w || 127;
  const paperHmm = paper.h || 89;
  const gapMm = Number($("#gapRange").value);
  const showCut = $("#cutLinesCheck").checked;

  const paperW = mm2px(paperWmm);
  const paperH = mm2px(paperHmm);
  const gap = mm2px(gapMm);

  const photoW = state.finalCanvas.width;
  const photoH = state.finalCanvas.height;

  const margin = mm2px(2); // 相紙邊緣留白，避免沖印裁邊切到照片
  const usableW = paperW - margin * 2;
  const usableH = paperH - margin * 2;

  const cols = Math.max(1, Math.floor((usableW + gap) / (photoW + gap)));
  const rows = Math.max(1, Math.floor((usableH + gap) / (photoH + gap)));

  if (cols * rows < 1) {
    $("#layoutHint").textContent = "相紙尺寸太小，無法放下這張證件照，請換一個較大的相紙尺寸。";
    return;
  }

  const totalW = cols * photoW + (cols - 1) * gap;
  const totalH = rows * photoH + (rows - 1) * gap;
  const startX = (paperW - totalW) / 2;
  const startY = (paperH - totalH) / 2;

  const canvas = $("#layoutCanvas");
  canvas.width = paperW;
  canvas.height = paperH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, paperW, paperH);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = startX + c * (photoW + gap);
      const y = startY + r * (photoH + gap);
      ctx.drawImage(state.finalCanvas, x, y, photoW, photoH);
    }
  }

  if (showCut) {
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (let r = 0; r <= rows; r++) {
      const y = startY + r * (photoH + gap) - (r > 0 && r < rows ? gap / 2 : 0);
      ctx.beginPath();
      ctx.moveTo(startX - 6, y);
      ctx.lineTo(startX + totalW + 6, y);
      ctx.stroke();
    }
    for (let c = 0; c <= cols; c++) {
      const x = startX + c * (photoW + gap) - (c > 0 && c < cols ? gap / 2 : 0);
      ctx.beginPath();
      ctx.moveTo(x, startY - 6);
      ctx.lineTo(x, startY + totalH + 6);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  $("#layoutHint").textContent = `已排入 ${cols * rows} 張（${cols} 欄 × ${rows} 列），可直接下載送洗。`;
  $("#btnDownloadLayout").hidden = false;
}

function resetAll() {
  state.sourceCanvas = null;
  state.processedCanvas = null;
  state.finalCanvas = null;
  state.crop = { offsetX: 0, offsetY: 0, scale: 1 };
  state.adjust = { brightness: 0, contrast: 0, smooth: 0, whiten: 0, rosy: 0, sharpen: 0 };
  invalidateRetouchCaches();
  $("#brightRange").value = 0;
  $("#contrastRange").value = 0;
  $("#smoothRange").value = 0;
  $("#whitenRange").value = 0;
  $("#rosyRange").value = 0;
  $("#sharpenRange").value = 0;
  $("#zoomRange").value = 100;
  $("#btnDownloadLayout").hidden = true;
  $("#layoutHint").textContent = "";
  goToStep(1);
}

// 視窗大小改變時重繪裁切框
window.addEventListener("resize", () => {
  if (state.step === 3) renderCrop();
});

// ---------- 初始化 ----------

function init() {
  initTabs();
  initCapture();
  initSizeAndColor();
  initCropTool();
  initLayoutStep();
  goToStep(1);
}

init();

// 供除錯/自動化測試使用，不影響一般使用（不會外洩任何照片資料到網路）
window.__app = {
  state,
  goToStep,
  renderCrop,
  runBackgroundRemoval,
  confirmCropAndProceed,
  generateLayout,
  applyRetouch,
  invalidateRetouchCaches,
};
