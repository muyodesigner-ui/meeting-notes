# 會議記錄工具

上傳會議錄音檔，自動產出繁體中文會議記錄（出席者報告重點 / 待辦 / 決議）。

## 第一次使用（5 分鐘設定）

### 1. 申請 Gemini API Key（免費）

1. 打開 https://aistudio.google.com/apikey
2. 用 Google 帳號登入
3. 點「Create API key」→ 複製產生的金鑰

> 免費額度：每天 1500 次請求、每分鐘 15 次，小團隊完全夠用。

### 2. 設定金鑰

在這個資料夾下建立 `.env` 檔案（可以複製 `.env.example` 改名），內容填：

```
GEMINI_API_KEY=你剛剛複製的金鑰
```

### 3. 啟動服務

在 Git Bash 裡執行：

```bash
cd /d/claude-code/meeting-notes
npm start
```

看到以下訊息表示成功：

```
✨ 會議記錄工具已啟動
   請打開瀏覽器前往 http://localhost:3000
```

### 4. 使用

1. 打開瀏覽器 → `http://localhost:3000`
2. 拖曳或選擇會議錄音檔（.mp3 / .m4a / .wav 等）
3. 按「產生會議記錄」→ 等 1–4 分鐘
4. 結果可直接複製或下載成 Markdown

## 以後每天使用

只要開 Git Bash 跑：

```bash
cd /d/claude-code/meeting-notes
npm start
```

然後打開 http://localhost:3000 即可。

想關掉：在 Git Bash 按 `Ctrl + C`。

## 輸出格式

```markdown
# 會議記錄

## 出席者報告重點
### 講者 A / 王小明
- 本週進度
- 遇到的問題

### 講者 B / 李小華
- 本週進度
...

## 待辦事項
- [ ] 待辦（負責人）

## 決議事項
- 決議內容
```

## 常見問題

**Q：音檔很大會怎樣？**
目前限制 200 MB。1 小時的 m4a 通常 30–60 MB，沒問題。

**Q：可以辨識每個人的聲音嗎？**
Gemini 會盡力從「自我介紹」或「他人稱呼」推斷名字；聽不出來就用「講者 A / B / C」代稱。建議會議一開始請大家自報姓名，效果最佳。

**Q：錄音檔會被上傳到哪裡？**
會暫存在本機 `uploads/` 資料夾，並傳到 Google Gemini 處理，結束後本機檔案會自動刪除。Google 的資料政策見：https://ai.google.dev/gemini-api/terms

**Q：想要團隊其他人也能用，不用只在我電腦跑？**
可以部署到內網伺服器或 Vercel / Render，這部分之後再擴充。
