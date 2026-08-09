// Cloudflare Pages Function：POST /api/models
//
// 用途：接收前端傳來的 Gemini API 金鑰，代為呼叫 Google 的 models.list，
// 篩選出「支援 generateContent（可以拿來做圖片去背分割）」的模型，回傳精簡後的清單給前端。
// 金鑰只會用來轉送這一次請求，這支函式不會儲存金鑰。

export async function onRequestPost(context) {
  const { request } = context;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "請以 JSON 格式傳送 { apiKey }。");
  }

  const apiKey = (body && body.apiKey ? String(body.apiKey) : "").trim();
  if (!apiKey) {
    return jsonError(400, "請提供 Gemini API 金鑰。");
  }

  let listRes;
  try {
    listRes = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": apiKey },
    });
  } catch (err) {
    return jsonError(502, "呼叫 Gemini API 失敗：" + (err && err.message ? err.message : String(err)));
  }

  if (!listRes.ok) {
    const errText = await listRes.text().catch(() => "");
    const hint = listRes.status === 400 || listRes.status === 403 ? "（金鑰可能無效，請確認金鑰正確）" : "";
    return jsonError(listRes.status, `無法讀取模型清單${hint}：` + errText.slice(0, 500));
  }

  const data = await listRes.json().catch(() => null);
  const rawModels = (data && data.models) || [];

  // 只保留支援 generateContent、且看起來是一般文字/圖片模型的項目
  // （排除 embedding、tts、live、image-only 生圖等跟「圖片分割遮罩」任務無關的模型）
  const EXCLUDE_PATTERN = /embedding|tts|live|image-preview|-image$|imagen|veo|lyria|aqa/i;
  const models = rawModels
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => ({
      id: (m.name || "").replace(/^models\//, ""),
      displayName: m.displayName || (m.name || "").replace(/^models\//, ""),
    }))
    .filter((m) => m.id && !EXCLUDE_PATTERN.test(m.id));

  return new Response(JSON.stringify({ models }), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
