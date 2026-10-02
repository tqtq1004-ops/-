const sharp = require("sharp");

function cors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = ["https://tqtq1004-ops.github.io", "https://rho-eight-83.vercel.app"];
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Dashboard-Key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function parseImage(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) throw new Error("사진 형식을 확인할 수 없습니다.");
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "지원하지 않는 요청입니다." });
  if (req.headers["x-dashboard-key"] !== process.env.DASHBOARD_SYNC_KEY) return res.status(401).json({ error: "관리 비밀번호가 맞지 않습니다." });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "사진 자동 인식을 사용하려면 Vercel 환경 변수 OPENAI_API_KEY를 설정하세요." });

  try {
    let { mime, buffer } = parseImage(req.body?.image);
    if (buffer.length > 7 * 1024 * 1024) return res.status(413).json({ error: "사진 용량이 너무 큽니다. 사진을 조금 작게 저장해 다시 올려주세요." });
    if (/heic|heif/i.test(mime)) { buffer = await sharp(buffer).jpeg({ quality: 84 }).toBuffer(); mime = "image/jpeg"; }
    const prompt = `Read this Korean purchase transaction statement. Extract only text that is visibly present. Return JSON with date (YYYY-MM-DD), vendor, phone, and items. Each item needs product, qty as a positive integer, and amount as the final line amount including VAT if that is the amount shown for the item. If a quantity is handwritten, blurred, or uncertain, omit that item instead of guessing. Do not invent supplier names, phone numbers, products, quantities, or amounts. If a total exists but item amounts do not, use 0 for the item amount and let the user review it.`;
    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4.1-mini", response_format: { type: "json_object" }, messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${mime};base64,${buffer.toString("base64")}`, detail: "high" } }] }] })
    });
    const aiBody = await ai.json();
    if (!ai.ok) throw new Error(aiBody?.error?.message || "사진 인식 서비스에 연결하지 못했습니다.");
    const raw = JSON.parse(aiBody?.choices?.[0]?.message?.content || "{}");
    const receipt = { date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || "") ? raw.date : "", vendor: String(raw.vendor || "").trim(), phone: String(raw.phone || "").trim(), items: Array.isArray(raw.items) ? raw.items.map(x => ({ product: String(x.product || "").trim(), qty: Math.round(Number(x.qty)), amount: Math.max(0, Math.round(Number(x.amount) || 0)) })).filter(x => x.product && Number.isFinite(x.qty) && x.qty > 0) : [] };
    if (!receipt.items.length) return res.status(422).json({ error: "사진에서 확실하게 읽힌 제품·수량이 없습니다. 더 선명한 사진으로 다시 올려주세요." });
    return res.status(200).json({ receipt });
  } catch (error) {
    return res.status(500).json({ error: error.message || "사진을 읽지 못했습니다." });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: "8mb" } } };
