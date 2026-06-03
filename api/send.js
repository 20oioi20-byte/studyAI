export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const SOLAPI_KEY    = process.env.SOLAPI_KEY;
  const SOLAPI_SECRET = process.env.SOLAPI_SECRET;
  const MY_PHONE      = process.env.MY_PHONE;   // 수신번호 010XXXXXXXX
  const FROM_PHONE    = process.env.FROM_PHONE; // 발신번호 010XXXXXXXX

  try {
    const { question, image, mime } = req.body;

    // 1) Claude 답변 생성
    const content = [];
    if (image) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: mime || "image/jpeg", data: image }
      });
    }
    content.push({
      type: "text",
      text: question || "이 문제를 풀어주세요. 한국어로 간결하게."
    });

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

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(500).json({ ok: false, error: "Claude 호출 실패", detail: err });
    }

    const claudeData = await claudeRes.json();
    const answer = claudeData.content?.[0]?.text || "답변 생성 실패";

    // 2) 솔라피 SMS 발송
    const smsText = "📚 StudyAI 답변\n" + answer.slice(0, 80) + (answer.length > 80 ? "…" : "");
    // SMS는 90바이트 제한 → LMS(장문)로 자동 전환되려면 type: "LMS" 명시
    const msgType = answer.length > 80 ? "LMS" : "SMS";

    const timestamp = Date.now().toString();
    const salt = crypto.randomUUID();
    const hmacData = timestamp + salt;

    // HMAC-SHA256 서명 생성
    const encoder = new TextEncoder();
    const keyData = encoder.encode(SOLAPI_SECRET);
    const msgData = encoder.encode(hmacData);
    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const sigHex = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, "0")).join("");

    const solapiRes = await fetch("https://api.solapi.com/messages/v4/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `HMAC-SHA256 apiKey=${SOLAPI_KEY}, date=${timestamp}, salt=${salt}, signature=${sigHex}`
      },
      body: JSON.stringify({
        message: {
          to: MY_PHONE,
          from: FROM_PHONE,
          text: smsText,
          type: msgType
        }
      })
    });

    const solapiData = await solapiRes.json();
    if (!solapiRes.ok) {
      // SMS 실패해도 answer는 반환 (발송 실패 여부만 별도 표시)
      return res.json({ ok: true, answer, sms: "실패", smsDetail: solapiData });
    }

    return res.json({ ok: true, answer, sms: "발송완료" });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
