export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const SOLAPI_KEY    = process.env.SOLAPI_KEY;
  const SOLAPI_SECRET = process.env.SOLAPI_SECRET;
  const MY_PHONE      = process.env.MY_PHONE;
  const FROM_PHONE    = process.env.FROM_PHONE;

  try {
    const { question, image, mime, mode } = req.body;
    // mode: "basic"(기본) | "summary"(기본+핵심요약)

    // 1) 시스템 프롬프트 분기
    const systemPrompt = mode === "summary"
      ? `당신은 학습 도우미입니다. 문제의 답을 아래 형식으로만 답하세요.
[답변]
1번: (모범답)
2번: (모범답)
...

[핵심요약]
- 핵심 개념 1~3가지를 한 줄씩 간결하게`
      : `당신은 학습 도우미입니다. 문제의 답을 아래 형식으로만 답하세요. 다른 설명 없이 번호와 답만 작성하세요.
1번: (모범답)
2번: (모범답)
...`;

    // 2) Claude 답변 생성
    const content = [];
    if (image) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: mime || "image/jpeg", data: image }
      });
    }
    content.push({
      type: "text",
      text: question || "이 문제를 풀어주세요."
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
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(500).json({ ok: false, error: "Claude 호출 실패", detail: err });
    }

    const claudeData = await claudeRes.json();
    const answer = claudeData.content?.[0]?.text || "답변 생성 실패";

    // 3) 80글자 기준으로 메시지 분할
    const CHUNK_SIZE = 70;
    const chunks = [];
    let current = "";
    const lines = answer.split("\n");

    for (const line of lines) {
      if ((current + "\n" + line).trim().length > CHUNK_SIZE) {
        if (current.trim()) chunks.push(current.trim());
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    // 4) HMAC-SHA256 서명 생성 함수
    async function makeAuthHeader() {
      const timestamp = new Date().toISOString();
      const salt = crypto.randomUUID();
      const encoder = new TextEncoder();
      const keyData = encoder.encode(SOLAPI_SECRET);
      const msgData = encoder.encode(timestamp + salt);
      const cryptoKey = await crypto.subtle.importKey(
        "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
      const sigHex = Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, "0")).join("");
      return `HMAC-SHA256 apiKey=${SOLAPI_KEY}, date=${timestamp}, salt=${salt}, signature=${sigHex}`;
    }

    // 5) 분할된 메시지 순서대로 발송
    const smsResults = [];
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i];

      const auth = await makeAuthHeader();
      const solapiRes = await fetch("https://api.solapi.com/messages/v4/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": auth
        },
        body: JSON.stringify({
          message: {
            to: MY_PHONE,
            from: FROM_PHONE,
            text: text,
            type: "LMS",
            subject: "AI답변"
          }
        })
      });

      const solapiData = await solapiRes.json();
      smsResults.push(solapiRes.ok ? "발송완료" : solapiData.errorMessage);

      // 메시지 간 0.5초 간격 (순서 보장)
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    return res.json({
      ok: true,
      answer,
      sms: smsResults.every(r => r === "발송완료") ? "발송완료" : "일부실패",
      smsCount: chunks.length,
      smsResults
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
