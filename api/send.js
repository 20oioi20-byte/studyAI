export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const KAKAO_REST = process.env.KAKAO_REST;
  const KAKAO_SECRET = process.env.KAKAO_SECRET;
  const KAKAO_REFRESH = process.env.KAKAO_REFRESH;

  try {
    const { question, image, mime } = req.body;

    // 1) Claude 답변 생성
    const content = [];
    if (image) {
      content.push({ type: "image", source: { type: "base64", media_type: mime || "image/jpeg", data: image } });
    }
    content.push({ type: "text", text: question || "이 문제를 풀어주세요. 한국어로 간결하게." });

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: "당신은 학습 도우미입니다. 문제의 답을 정확하고 간결하게 한국어로 설명하세요.",
        messages: [{ role: "user", content }]
      })
    });
    const claudeData = await claudeRes.json();
    const answer = claudeData.content?.[0]?.text || "답변 생성 실패";

    // 2) 카카오 토큰 갱신
    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: KAKAO_REST,
        client_secret: KAKAO_SECRET,
        refresh_token: KAKAO_REFRESH
      })
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return res.json({ ok: false, error: "카카오 토큰 실패", detail: tokenData });

    // 3) 카카오톡 전송
    const msg = "📚 StudyAI 답변\n━━━━━━━━━\n" + answer.slice(0, 800) + (answer.length > 800 ? "…" : "");
    await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        template_object: JSON.stringify({
          object_type: "text",
          text: msg,
          link: { web_url: "https://claude.ai", mobile_web_url: "https://claude.ai" },
          button_title: "확인"
        })
      })
    });

    return res.json({ ok: true, answer });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
