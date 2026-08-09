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
  engine: "local", // "local"（瀏覽器內WASM模型，免費）或 "gemini"（呼叫 /api/segment，需自行部署+API金鑰）
  crop": { offsetX: 0, offsetY: 0, scale: 1 }, // 相對於 processedCanvas 的裁切狀態
  adjust: { brightness: 0, contrast: 0, smooth: 0 },
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

  $$('input[name="engine"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.engine = e.target.value;
      updateEngineHint();
    })
  );
  updateEngineHint();

  $("#btnProcess").addEventListener("click", runBackgroundRemoval);
}

function updateEngineHint() {
  const hint = $("#engineHint");
  const localWrap = $("#localQualityWrap");
  if (!hint) return;
  const isGemini = state.engine === "gemini";
  localWrap.classList.toggle("hidden", isGemini);
  hint.textContent = isGemini
    ? "會呼叫你自己部署的 /api/segment（Cloudflare Pages Function），只用 Gemini 產生去背「遮罩」，實際照片像素完全來自你的原圖、不經 AI 重繪，臉部不會被改動。需要先部署 functions/api/segment.js 並在後台設定 GEMINI_API_KEY，詳見 README。"
    : "完全在你的手機/電腦瀏覽器內處理，不需要任何設定，免費、離線可用。";
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

// ---------- Gemini API 去背（呼叫自架的 /api/segment，只取「遮罩」，像素完全來自原圖） ----------

async function runGeminiSegmentation(srcCanvas) {
  const blob = await canvasToBlob(srcCanvas, "image/jpeg", 0.92);
  const form = new FormData();
  form.append("image", blob, "photo.jpg");

  let res;
  try {
    res = await fetch("/api/segment", { method: "POST", body: form });
  } catch (err) {
    throw new Error(
      "無法連線到 /api/segment，請確認已經把 functions/api/segment.js 跟著網站一起部署到 Cloudflare Pages。"
    );
  }
  if (!res.ok) {
    const contentType = res.headers.get("content-type") || "";
    let msg = "";
    if (contentType.includes("application/json")) {
      try {
        msg = (await res.json()).error || "";
      } catch (_) {
        msg = "";
      }
    }
    if (!msg) {
      // 非 JSON 回應（例如 404/501 或其他錯誤頁）通常代表這個環境根本沒有 /api/segment 這個後端函式
      throw new Error(
        `找不到可用的 /api/segment（HTTP ${res.status}）。這通常代表目前的部署環境不支援後端函式（例如純靜態的 GitHub Pages / Netlify Drop，或本機測試伺服器），請改用「本機瀏覽器 AI」，或依 README 部署到 Cloudflare Pages 並設定 GEMINI_API_KEY。`
      );
    }
    throw new Error(`Gemini 去背服務錯誤（HTTP ${res.status}）：${msg}`);
  }
  const data = await res.json();
  if (!data || !data.box_2d || !data.mask) {
    throw new Error("Gemini 沒有辨識出人像遮罩，請換一張正面、背景單純、光線充足的照片再試一次。");
  }
  return buildCutoutFromMask(srcCanvas, data.box_2d, data.mask);
}

// 用 Gemini 回傳的分割遮罩，去裁切「原始未經修改」的像素：
// 只有透明度（要保留/去除哪些區域）來自 AI，顏色/五官等實際像素值 100% 來自使用者原圖，
// 不會有任何 AI 重繪，因此臉部絕對不會被改動。
async function buildCutoutFromMask(srcCanvas, box_2d, maskDataUrl) {
  const W = srcCanvas.width;
  const H = srcCanvas.height;
  const maskImg = await loadImage(maskDataUrl);

  const [y0n, x0n, y1n, x1n] = box_2d;
  const x0 = clamp(Math.round((x0n / 1000) * W), 0, W);
  const y0 = clamp(Math.round((y0n / 1000) * H), 0, H);
  const x1 = clamp(Math.round((x1n / 1000) * W), 0, W);
  const y1 = clamp(Math.round((y1n / 1000) * H), 0, H);
  const boxW = Math.max(1, x1 - x0);
  const boxH = Math.max(1, y1 - y0);

  const maskFull = document.createElement("canvas");
  maskFull.width = W;
  maskFull.height = H;
  const mctx = maskFull.getContext("2d");
  mctx.drawImage(maskImg, x0, y0, boxW, boxH);

  // Gemini 回傳的遮罩是灰階圖，灰階亮度＝該像素的保留程度，這裡把亮度轉成 alpha 透明度
  const imgData = mctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i]; // alpha = R 通道亮度
  }
  mctx.putImageData(imgData, 0, 0);

  const cutout = document.createElement("canvas");
  cutout.width = W;
  cutout.height = H;
  const cctx = cutout.getContext("2d");
  cctx.drawImage(srcCanvas, 0, 0); // 完整保留原圖像素，未經任何 AI 重繪
  cctx.globalCompositeOperation = "destination-in";
  cctx.drawImage(maskFull, 0, 0);
  cctx.globalCompositeOperation = "source-over";
  return cutout;
}

async function runBackgroundRemoval() {
  if (!state.sourceCanvas) return;
  $("#processHint").textContent = "";
  showOverlay(
    state.engine === "gemini"
      ? "正在呼叫 Gemini 產生去背遮罩，請稍候…"
      : "正在下載並執行 AI 去背模型，第一次使用可能需要 10~30 秒…"
  );
  try {
    let cutoutCanvas;

    if (state.engine === "gemini") {
      cutoutCanvas = await runGeminiSegmentation(state.sourceCanvas);
    } else {
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
      cutoutCanvas = document.createElement("canvas");
      cutoutCanvas.width = state.sourceCanvas.width;
      cutoutCanvas.height = state.sourceCanvas.height;
      cutoutCanvas.getContext("2d").drawImage(cutoutImg, 0, 0, cutoutCanvas.width, cutoutCanvas.height);
    }

    const canvas = document.createElement("canvas");
    canvas.width = state.sourceCanvas.width;
    canvas.height = state.sourceCanvas.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = state.selectedColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(cutoutCanvas, 0, 0);

    state.processedCanvas = canvas;
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
  state.adjust = { brightness: 0, contrast: 0, smooth: 0 };
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
  $("#btnResetAdjust").addEventListener("click", () => {
    state.adjust = { brightness: 0, contrast: 0, smooth: 0 };
    state.crop = { offsetX: 0, offsetY: 0, scale: 1 };
    $("#brightRange").value = 0;
    $("#contrastRange").value = 0;
    $("#smoothRange").value = 0;
    $("#zoomRange").value = 100;
    renderCrop();
  });

  $("#btnConfirmCrop").addEventListener("click", confirmCropAndProceed);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function buildFilterString() {
  const b = 100 + state.adjust.brightness; // %
  const c = 100 + state.adjust.contrast; // %
  return `brightness(${b}%) contrast(${c}%)`;
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

  const src = state.processedCanvas;
  if (!src) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(frameX, frameY, frameW, frameH);
  ctx.clip();
  ctx.filter = buildFilterString();

  const baseScale = Math.max(frameW / src.width, frameH / src.height);
  const scale = baseScale * state.crop.scale;
  const drawW = src.width * scale;
  const drawH = src.height * scale;
  // 中心點 = 框中心 + 使用者拖曳位移（畫面座標，像素對像素）
  const centerX = frameX + frameW / 2 + state.crop.offsetX;
  const centerY = frameY + frameH / 2 + state.crop.offsetY;

  ctx.drawImage(src, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);

  // 磨皮：疊加一層模糊、降低不透明度做簡易柔膚效果
  if (state.adjust.smooth > 0) {
    ctx.filter = `blur(${(state.adjust.smooth / 100) * 4}px) ${buildFilterString()}`;
    ctx.globalAlpha = clamp(state.adjust.smooth / 100, 0, 0.6);
    ctx.drawImage(src, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // 畫出框線
  ctx.filter = "none";
  ctx.strokeStyle = "rgba(37,99,235,0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(frameX, frameY, frameW, frameH);

  // 畫出頭部對齊虛線參考框（僅為畫面上的對齊輔助，不會被存進最終輸出圖片）
  drawFaceGuide(ctx, frameX, frameY, frameW, frameH);

  // 存下這次算好的框資訊，供輸出使用
  renderCrop._lastFrame = { frameX, frameY, frameW, frameH, centerX, centerY, drawW, drawH, scale };
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
  ctx.filter = buildFilterString();

  const scaleToOut = outW / f.frameW;
  const drawW = f.drawW * scaleToOut;
  const drawH = f.drawH * scaleToOut;
  const centerX = (f.centerX - f.frameX) * scaleToOut;
  const centerY = (f.centerY - f.frameY) * scaleToOut;

  ctx.drawImage(state.processedCanvas, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);

  if (state.adjust.smooth > 0) {
    ctx.filter = `blur(${(state.adjust.smooth / 100) * (4 * scaleToOut)}px) ${buildFilterString()}`;
    ctx.globalAlpha = clamp(state.adjust.smooth / 100, 0, 0.6);
    ctx.drawImage(state.processedCanvas, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);
    ctx.globalAlpha = 1;
  }
  ctx.filter = "none";

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
  state.adjust = { brightness: 0, contrast: 0, smooth: 0 };
  $("#brightRange").value = 0;
  $("#contrastRange").value = 0;
  $("#smoothRange").value = 0;
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
window.__app = { state, goToStep, renderCrop, runBackgroundRemoval, confirmCropAndProceed, generateLayout };
