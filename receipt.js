// Photo AI recognition has been retired. Never call a paid AI service here.
module.exports = function handler(req, res) {
  return res.status(410).json({ error: "사진 AI 인식 기능이 종료되었습니다. 거래명세서 직접 입력을 이용해 주세요." });
};
