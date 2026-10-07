const { MongoClient } = require("mongodb");

let client;

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
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-dashboard-key"] !== process.env.DASHBOARD_SYNC_KEY) {
    return res.status(401).json({ error: "비밀번호가 올바르지 않습니다.", stage: "authentication" });
  }

  try {
    const col = await collection();
    if (req.method === "GET") {
      const record = await col.findOne({ _id: "main" });
      return res.status(200).json({ state: record?.state || null });
    }
    if (req.method === "PUT") {
      const state = req.body?.state;
      if (!state || typeof state !== "object") return res.status(400).json({ error: "저장할 데이터가 없습니다." });
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
