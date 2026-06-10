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
    // ★ 변경: image(단일) → images(배열) 추가 수신. 기존 image 필드도 호환 유지
    const { question, image, mime, images, materials } = req.body;

    // 1) 시스템 프롬프트
    const systemPrompt = `당신은 학습 도우미입니다. 아래 규칙을 반드시 따르세요.

규칙:
- 형식: 1번: (답) 형태로만 작성. 번호 없으면 답만.
- 단답형(단어/숫자): 답만. 풀이 없음.
- 계산형: 최종 답만. 풀이 없음.
- 주관식/서술형: 핵심 키워드 중심으로 1문장 이내. 최대한 짧게.
- 여는말/닫는말/설명 절대 금지.
- 문제가 여러 개이면 반드시 1번부터 순서대로 모든 문제에 답하세요.
- 첨부된 자료가 있으면 자료에서 먼저 답을 찾고, 자료에 없을 경우에만 AI 지식으로 답하세요.`;

    // 2) 메시지 content 구성
    const content = [];

    // ★ 참고자료 (라이브러리) 먼저 삽입
    if (materials && materials.length > 0) {
      content.push({ type: "text", text: "=== 참고자료 ===" });
      for (const mat of materials) {
        if (mat.type === "text" || !mat.mime) {
          content.push({ type: "text", text: `[${mat.name || "자료"}]\n${mat.data}` });
        } else if (mat.mime === "application/pdf") {
          // PDF 자료: document 타입으로 전달
          content.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: mat.data }
          });
        } else {
          // 이미지 자료
          content.push({
            type: "image",
            source: { type: "base64", media_type: mat.mime, data: mat.data }
          });
        }
      }
      content.push({ type: "text", text: "=== 문제 ===" });
    }

    // ★ 문제 이미지/PDF — 여러 장 지원 (images 배열 우선, 없으면 기존 image 단일 필드 호환)
    const problemFiles = [];
    if (images && images.length > 0) {
      // 새 방식: 배열로 전달된 경우
      problemFiles.push(...images);
    } else if (image) {
      // 구 방식: 단일 image 필드 (하위 호환)
      problemFiles.push({ data: image, mime: mime || "image/jpeg" });
    }

    for (const f of problemFiles) {
      if (f.mime === "application/pdf") {
        content.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: f.data }
        });
      } else {
        content.push({
          type: "image",
          source: { type: "base64", media_type: f.mime || "image/jpeg", data: f.data }
        });
      }
    }

    content.push({
      type: "text",
      text: question || "이 문제를 풀어주세요. 문제가 여러 개이면 1번부터 순서대로 모두 답해주세요."
    });

    // 3) Claude 호출 ── 이하 원본과 동일 ──────────────────────────────────
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

    // 4) 글자수 기준 분할
    const CHUNK_SIZE = 60;
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

    // 5) HMAC-SHA256 서명
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

    // 6) SMS 순서대로 발송
    const smsResults = [];
    for (let i = 0; i < chunks.length; i++) {
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
            text: chunks[i],
            type: "LMS",
            subject: "AI답변"
          }
        })
      });

      const solapiData = await solapiRes.json();
      smsResults.push(solapiRes.ok ? "발송완료" : solapiData.errorMessage);

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
