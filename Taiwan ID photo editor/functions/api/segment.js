// Cloudflare Pages Function：POST /api/segment
//
// 用途：接收前端傳來的照片，呼叫 Gemini API 取得「人像分割遮罩」，回傳給前端。
// 重點：這支函式只回傳遮罩（哪些像素屬於人、哪些屬於背景），完全不回傳 Gemini 重新產生的圖片內容，
// 實際照片像素永遠是使用者原圖，前端會用這個遮罩去裁切原圖，所以臉部、膚色、五官不會被 AI 改動。
//
// 金鑰／模型來源（兩種方式擇一即可）：
//   A) 網頁上直接設定（推薦，操作簡單）：在畫面「去背引擎」選 Gemini API 後，貼上金鑰按「儲存」，
//      金鑰只會存在你自己瀏覽器的 localStorage，每次去背時才會連同這次請求一起送到這支函式，
//      再由這支函式轉送給 Google，不會經過任何第三方伺服器。
//   B) 部署端設定（適合多人共用同一個部署、不想讓每個使用者各自輸入金鑰）：
//      到 Cloudflare Pages 專案 → Settings → Environment variables，新增一個
//      名為 GEMINI_API_KEY 的「Secret」，重新部署一次讓環境變數生效；
//      前端沒有另外輸入金鑰時，會自動使用這個伺服器端金鑰。
// 若前端有傳 apiKey / model 欄位，優先使用前端傳來的值；否則退回使用伺服器端的環境變數與預設模型。

const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash"; // 找不到前端指定模型時的預設值

const SEGMENT_PROMPT = `這張照片中有一位人物。請針對「這個人」（包含頭髮、耳朵、五官、脖子、肩膀，不含背景）給出精確的分割遮罩。
規則：
- 只回傳一個人，如果照片中有多人，選畫面中最大、最靠近中間的那一位。
- 遮罩邊緣要盡量貼合真實輪廓，尤其是頭髮絲、耳朵、下巴邊緣，不要把背景誤判進遮罩，也不要把人的邊緣誤判成背景。
- 絕對不要修改、重繪或美化這個人的長相、五官、膚色、髮型，你只需要判斷「哪裡是人、哪裡是背景」。
只回傳以下格式的 JSON 陣列，不要加上任何說明文字、不要使用 markdown code fence：
[{"box_2d": [y0, x0, y1, x1], "mask": "<base64 png data url>", "label": "person"}]
box_2d 是正規化到 0-1000 的 [ymin, xmin, ymax, xmax]。`;

export async function onRequestPost(context) {
  const { request, env } = context;

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return jsonError(400, "請以 multipart/form-data 上傳照片（欄位名稱 image）。");
  }

  const clientApiKey = (form.get("apiKey") || "").toString().trim();
  const apiKey = clientApiKey || env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonError(
      500,
      "尚未設定 Gemini API 金鑰：請在網頁「去背引擎」選 Gemini API 後直接貼上金鑰並儲存，或請部署者到 Cloudflare Pages 專案設定加入 GEMINI_API_KEY 這個環境變數（Secret）。"
    );
  }

  const clientModel = (form.get("model") || "").toString().trim();
  const model = clientModel || DEFAULT_GEMINI_MODEL;
  const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const file = form.get("image");
  if (!file || typeof file.arrayBuffer !== "function") {
    return jsonError(400, "找不到上傳的照片（欄位名稱需為 image）。");
  }

  const arrayBuffer = await file.arrayBuffer();
  const mimeType = file.type || "image/jpeg";
  const base64 = arrayBufferToBase64(arrayBuffer);

  const geminiBody = {
    contents: [
      {
        parts: [{ text: SEGMENT_PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }],
      },
    ],
    generationConfig: {
      response_mime_type: "application/json",
      temperature: 0,
    },
  };

  let geminiRes;
  try {
    geminiRes = await fetch(geminiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(geminiBody),
    });
  } catch (err) {
    return jsonError(502, "呼叫 Gemini API 失敗：" + (err && err.message ? err.message : String(err)));
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => "");
    const hint =
      geminiRes.status === 400 || geminiRes.status === 404
        ? "（請確認金鑰正確，或換一個模型再試一次）"
        : geminiRes.status === 403
        ? "（金鑰可能無效或沒有權限，請確認金鑰正確）"
        : "";
    return jsonError(geminiRes.status, `Gemini API 回傳錯誤${hint}：` + errText.slice(0, 500));
  }

  const geminiJson = await geminiRes.json().catch(() => null);
  const rawText = geminiJson?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

  if (!rawText) {
    return jsonError(502, "Gemini 沒有回傳任何內容，請換一張照片再試一次。");
  }

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch (err) {
    return jsonError(502, "無法解析 Gemini 回傳的 JSON，請再試一次。");
  }

  const results = Array.isArray(parsed) ? parsed : parsed?.masks || [];
  const first = results.find((r) => r && r.box_2d && r.mask);

  if (!first) {
    return jsonError(422, "Gemini 沒有辨識出人像遮罩，請換一張正面、背景單純、光線充足的照片再試一次。");
  }

  return new Response(JSON.stringify({ box_2d: first.box_2d, mask: first.mask, label: first.label || "person" }), {
    headers: { "Content-Type": "application/json" },
  });
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
