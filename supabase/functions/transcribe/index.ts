import { createClient } from 'npm:@supabase/supabase-js@2';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PROMPT = `你是專業的會議記錄助理。請根據這段會議錄音，產出繁體中文的結構化結果。

請輸出 JSON，包含兩個欄位：

1. "summary"：Markdown 格式的會議摘要，結構為：

# 會議記錄

**日期**：（如錄音中有提到）
**會議長度**：約 X 分鐘

## 出席者報告重點

### 出席者姓名（若能辨識；否則用「講者 A」「講者 B」）
- 報告重點 1
- 報告重點 2

## 待辦事項
- [ ] 內容（負責人：XXX，期限：若有）

## 決議事項
- 決議 1

2. "transcript"：逐字稿陣列，每個元素為 { "t": 秒數, "speaker": "姓名", "text": "完整發言" }。
   - 每個說話者換話就分一段
   - "t" 是這段開始的**秒數**（數字，不是字串）
   - "speaker" 盡量辨識姓名，無法辨識用「講者 A」「講者 B」
   - "text" 是精確轉錄的內容（不是逐字抄寫，而是清晰整理）

規則：
- 全部繁體中文（台灣用語）
- summary 中的姓名與 transcript 中的 speaker **必須一致**
- 若錄音很短或沒內容，summary 與 transcript 都盡力產出`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    transcript: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          t: { type: 'number' },
          speaker: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['t', 'speaker', 'text'],
      },
    },
  },
  required: ['summary', 'transcript'],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: '未登入' }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: '未登入或 token 無效', detail: authError?.message }, 401);

    // New flow: frontend uploads to Storage first, passes path here
    const body = await req.json();
    const audioPath = body?.audio_path as string | undefined;
    const title = (body?.title as string) || `會議記錄 ${new Date().toLocaleDateString('zh-TW')}`;
    const mimeType = (body?.mime_type as string) || 'audio/webm';
    const durationSeconds = body?.duration_seconds as number | undefined;

    if (!audioPath) return json({ error: '沒有收到音檔路徑' }, 400);

    // Download audio from Storage using user's client (RLS allows authenticated reads)
    const { data: blob, error: downloadError } = await supabase.storage
      .from('meeting-audio')
      .download(audioPath);

    if (downloadError || !blob) {
      return json({ error: '下載音檔失敗', detail: downloadError?.message }, 500);
    }

    const audioB64 = await blobToBase64(blob);

    const geminiBody = JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: audioB64 } },
          { text: PROMPT },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    async function callGemini(model: string) {
      return await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: geminiBody,
        },
      );
    }

    // Retry strategy: 2.5-flash x3 → 2.0-flash x2 → 2.5-flash-lite x1
    const attempts: Array<{ model: string; waitMs: number }> = [
      { model: 'gemini-2.5-flash', waitMs: 0 },
      { model: 'gemini-2.5-flash', waitMs: 3000 },
      { model: 'gemini-2.5-flash', waitMs: 7000 },
      { model: 'gemini-2.0-flash', waitMs: 3000 },
      { model: 'gemini-2.0-flash', waitMs: 7000 },
      { model: 'gemini-2.5-flash-lite', waitMs: 3000 },
    ];

    let geminiRes: Response | null = null;
    let lastErrText = '';
    let lastStatus = 0;
    for (const attempt of attempts) {
      if (attempt.waitMs > 0) {
        await new Promise((r) => setTimeout(r, attempt.waitMs));
      }
      const r = await callGemini(attempt.model);
      if (r.ok) { geminiRes = r; break; }
      lastStatus = r.status;
      lastErrText = await r.text();
      // Only retry on transient errors (503/429/500)
      if (![500, 503, 429].includes(r.status)) break;
    }

    if (!geminiRes) {
      return json({
        error: 'Gemini API 多次重試後仍失敗',
        status: lastStatus,
        detail: lastErrText,
      }, 500);
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!rawText) return json({ error: 'Gemini 回應沒有內容', raw: geminiData }, 500);

    let parsed: { summary: string; transcript: Array<{ t: number; speaker: string; text: string }> };
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      return json({
        error: 'Gemini 回應格式不正確',
        detail: (parseErr as Error).message,
        raw: rawText.slice(0, 500),
      }, 500);
    }

    const { data: saved, error: dbError } = await supabase
      .from('meeting_notes')
      .insert({
        title,
        content: parsed.summary,
        transcript: parsed.transcript,
        audio_path: audioPath,
        duration_seconds: durationSeconds ?? null,
        created_by: user.id,
      })
      .select()
      .single();

    if (dbError) {
      return json({
        notes: parsed.summary,
        transcript: parsed.transcript,
        warning: '產出成功但儲存失敗：' + dbError.message,
      });
    }

    return json({
      notes: parsed.summary,
      transcript: parsed.transcript,
      id: saved.id,
      title,
      audio_path: audioPath,
    });
  } catch (err) {
    console.error('Function error:', err);
    return json({ error: (err as Error).message || '未知錯誤', stack: (err as Error).stack }, 500);
  }
});
