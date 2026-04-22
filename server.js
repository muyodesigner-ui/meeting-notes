import express from 'express';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.GEMINI_API_KEY) {
  console.error('缺少 GEMINI_API_KEY，請在 .env 檔案內設定');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.use(express.static('public'));

const PROMPT = `你是專業的會議記錄助理。請根據這個會議錄音，產出繁體中文會議記錄。

請嚴格依照以下 Markdown 格式輸出：

# 會議記錄

**日期**：（如錄音中有提到則填寫，否則留空）
**會議長度**：約 X 分鐘

## 出席者報告重點

### 出席者 A（若能辨識姓名則使用姓名，否則用「講者 A、B、C…」）
- 報告重點 1
- 報告重點 2
- 報告重點 3

### 出席者 B
- 報告重點 1
- 報告重點 2

（依此類推，為每位出席者整理他們各自的發言重點）

## 待辦事項
- [ ] 待辦內容（負責人：XXX，期限：若有提及）
- [ ] 待辦內容（負責人：XXX）

## 決議事項
- 決議 1
- 決議 2

---

規則：
1. 盡力辨識每位說話者的名字（從自我介紹、他人稱呼中推斷），若真的無法辨識就用「講者 A / B / C」
2. 整理每位出席者的「報告重點」，不是逐字稿，要濃縮成關鍵要點
3. 用繁體中文（台灣用語）
4. 若錄音中沒有明確決議或待辦，那些區塊可以留空或寫「無」`;

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '沒有收到音檔' });
  }

  const filePath = req.file.path;
  const mimeType = req.file.mimetype;

  try {
    console.log(`[${new Date().toISOString()}] 開始處理：${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    const uploaded = await ai.files.upload({
      file: filePath,
      config: { mimeType },
    });

    console.log(`檔案已上傳到 Gemini：${uploaded.uri}`);

    let fileInfo = uploaded;
    while (fileInfo.state === 'PROCESSING') {
      await new Promise((r) => setTimeout(r, 2000));
      fileInfo = await ai.files.get({ name: uploaded.name });
    }

    if (fileInfo.state === 'FAILED') {
      throw new Error('Gemini 無法處理此音檔');
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { mimeType: uploaded.mimeType, fileUri: uploaded.uri } },
            { text: PROMPT },
          ],
        },
      ],
    });

    const notes = response.text;
    console.log(`完成，產出會議記錄 ${notes.length} 字`);

    res.json({ notes });
  } catch (err) {
    console.error('處理失敗：', err);
    res.status(500).json({ error: err.message || '處理失敗' });
  } finally {
    fs.unlink(filePath, () => {});
  }
});

app.listen(PORT, () => {
  console.log(`\n✨ 會議記錄工具已啟動`);
  console.log(`   請打開瀏覽器前往 http://localhost:${PORT}\n`);
});
