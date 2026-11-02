# 貓眠花下｜Render 部署版

1. 解壓 ZIP，將內部檔案上傳到 GitHub repository 根目錄（包含 `server.js`、`package.json`、`public/`）。
2. Render → New → Web Service → 連接 GitHub。不要選 Static Site。
3. Build Command: `npm install`，Start Command: `npm start`。Node 18+。
4. Environment 設定 `HOST_INVITE_CODE` 為只有主持人知道的強密碼。
5. 部署後測試 `/healthz` 顯示 `ok`，`/version` 版本為 `cat-mom-phase2-v1`。

## 玩法
第一階段沿用原有輪盤與獎池。所有鎖定名單玩家抽完後，主持人按「開始二階段」。貓媽媽破籠約 30 秒，進入全員點擊戰；依序觸發大夢、龍哥、幼幼班、CC、曜日，最後由主持人按下小旻大砲發射。接著漫畫、獎勵揭曉、片尾。主持人可以暫停、補集氣、跳過與重播。

## 正式活動前必讀
- 目前第二階段使用 HTML/CSS/emoji 演出，尚未取得六個團體的正式動畫、漫畫圖、照片與片尾音樂。
- 本版沿用 `data.json` 本地儲存。Render Free 的檔案系統非持久化，重啟或部署可能遺失抽獎及房間資料。**正式活動務必改用持久化資料庫，或使用 Render 支援持久化磁碟的方案並將 `DATA_FILE` 設定至該磁碟路徑。**
- 目前即時狀態放在單一 Node 進程記憶體中，只能部署單一實例；尚未做 90 人壓測。
- 在正式活動前請先用測試房間跑完整流程。
