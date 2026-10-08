const { MongoClient } = require("mongodb");
const { createHash, timingSafeEqual } = require("node:crypto");

let client;
// Best-effort per-instance protection; edge/distributed limits are still required.
const failedAttempts = new Map();
const AUTH_WINDOW = 15 * 60 * 1000;
function authenticate(req, res) {
  const secret = process.env.DASHBOARD_SYNC_KEY;
  if (typeof secret !== "string" || !secret.trim()) {
    res.status(503).json({ error: "서버 인증 설정을 확인해 주세요.", stage: "configuration" });
    return false;
  }
  const now = Date.now();
  for (const [key, entry] of failedAttempts) if (entry.until <= now) failedAttempts.delete(key);
  const ip = String(req.headers["x-vercel-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const entry = failedAttempts.get(ip);
  if (entry?.count >= 10) {
    res.setHeader("Retry-After", String(Math.ceil((entry.until - now) / 1000)));
    res.status(429).json({ error: "인증 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", stage: "authentication" });
    return false;
  }
  const supplied = req.headers["x-dashboard-key"];
  const digest = value => createHash("sha256").update(value).digest();
  if (typeof supplied !== "string" || !timingSafeEqual(digest(supplied), digest(secret))) {
    if (entry) entry.count++;
    else if (failedAttempts.size < 10000) failedAttempts.set(ip, { count: 1, until: now + AUTH_WINDOW });
    res.status(401).json({ error: "비밀번호가 올바르지 않습니다.", stage: "authentication" });
    return false;
  }
  failedAttempts.delete(ip);
  return true;
}

async function collection() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  if (!client) client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  return client.db("nudif_dashboard").collection("state");
}

function cors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = ["https://tqtq1004-ops.github.io", "https://rho-eight-83.vercel.app"];
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Dashboard-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
}

function classifyStorageError(error) {
  const message = String(error?.message || "");
  if (/auth|authentication|bad auth/i.test(message)) return "database_authentication";
  if (/querySrv|ENOTFOUND|DNS/i.test(message)) return "database_dns";
  if (/timed out|timeout|server selection/i.test(message)) return "database_network";
  if (/MONGODB_URI is not configured/i.test(message)) return "missing_environment";
  return "database_connection";
}

module.exports = async function handler(req, res) {
  cors(req, res);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "PUT"].includes(req.method)) return res.status(405).json({ error: "지원하지 않는 요청입니다." });
  if (!authenticate(req, res)) return;

  try {
    const col = await collection();
    if (req.method === "GET") {
      const record = await col.findOne({ _id: "main" });
      return res.status(200).json({ state: record?.state || null });
    }
    if (req.method === "PUT") {
      const state = req.body?.state;
      if (!state || typeof state !== "object" || Array.isArray(state)) return res.status(400).json({ error: "저장할 데이터가 없습니다." });
      await col.updateOne({ _id: "main" }, { $set: { state, updatedAt: new Date() } }, { upsert: true });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "지원하지 않는 요청입니다." });
  } catch (error) {
    const reason = classifyStorageError(error);
    console.error("STATE_STORAGE_ERROR", JSON.stringify({
      stage: "storage",
      reason,
      name: error?.name || "Error",
      code: error?.code || null
    }));
    return res.status(503).json({ error: "저장소에 연결하지 못했습니다.", stage: "storage", reason });
  }
};
