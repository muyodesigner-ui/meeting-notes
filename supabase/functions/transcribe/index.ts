import { createClient } from 'npm:@supabase/supabase-js@2';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PROMPT = `你是專業的會議記錄助理。請根據這個會議錄音，產出繁體中文會議記錄。

請嚴格依照以下 Markdown 格式輸出：

# 會議記錄

**日期**：（如錄音中有提到則填寫，否則留空）
**會議長度**：約 X 分鐘

## 出席者報告重點

### 出席者 A（若能辨識姓名則使用姓名，否則用「講者 A、B、C…」）
- 報告重點 1
- 報告重點 2

### 出席者 B
- 報告重點 1

## 待辦事項
- [ ] 待辦內容（負責人：XXX，期限：若有提及）

## 決議事項
- 決議 1

---

規則：
1. 盡力辨識每位說話者的名字
2. 整理每位出席者的「報告重點」，不是逐字稿
3. 用繁體中文（台灣用語）
4. 若錄音中沒有明確決議或待辦，那些區塊可以留空`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
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

    // 白名單檢查暫時移除，靠 Google OAuth 測試使用者清單控管誰能登入
    // 之後需要時再加回：查 allowed_users 表 + RLS policy

    const formData = await req.formData();
    const audioFile = formData.get('audio') as File | null;
    if (!audioFile) return json({ error: '沒有收到音檔' }, 400);

    const title = (formData.get('title') as string) ||
      `會議記錄 ${new Date().toLocaleDateString('zh-TW')}`;

    // Call Gemini REST API directly (avoid SDK compat issues in Deno)
    const audioB64 = await fileToBase64(audioFile);

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType: audioFile.type, data: audioB64 } },
              { text: PROMPT },
            ],
          }],
        }),
      },
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return json({ error: 'Gemini API 失敗', status: geminiRes.status, detail: errText }, 500);
    }

    const geminiData = await geminiRes.json();
    const notes = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!notes) return json({ error: 'Gemini 回應沒有內容', raw: geminiData }, 500);

    const { data: saved, error: dbError } = await supabase
      .from('meeting_notes')
      .insert({ title, content: notes, created_by: user.id })
      .select()
      .single();

    if (dbError) {
      return json({ notes, warning: '產出成功但儲存失敗：' + dbError.message });
    }

    return json({ notes, id: saved.id, title });
  } catch (err) {
    console.error('Function error:', err);
    return json({ error: (err as Error).message || '未知錯誤', stack: (err as Error).stack }, 500);
  }
});
