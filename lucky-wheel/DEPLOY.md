# BOSS 討伐版部署說明

此 ZIP **根目錄** 就是 Node.js 專案，包含 package.json、server.js、public/index.html。

1. 將全部檔案上傳到部署平台指定的專案根目錄；不要只替換 server.js。
2. 使用 Node.js 18+，Build command：`npm install`；Start command：`npm start`。
3. 必須支援 WebSocket，不能只使用靜態網頁託管。
4. 設定 `HOST_INVITE_CODE` 環境變數，預設邀請碼已公開。可設定 `PROBABILITY_FACTOR`（預設 0.80）。
5. 部署後打開 `https://你的網址/version`，應顯示 `boss-deploy-20261025-v3`。
6. 以 Ctrl+Shift+R 強制重整，畫面標題旁會顯示 `BOSS UI v3`。
7. 若仍看到「全服幸運輪盤 / 目前總獎池」，代表部署的分支、根目錄、服務或網址仍指向舊版。

主輪盤固定傷害 60、300、980、1980、3280、6480，依登記人數動態調整抽中機率。特殊事件獨立 15% 觸發。BOSS 扣血與階段獎勵位於上方，沒有重複的舊背景 UI。

注意：data.json 為本地資料，正式部署需要持久化儲存；重新部署前先備份。尚未在你的實際雲端環境測試。

## 舊版 UI 排查

- 若畫面仍出現「目前總獎池」大型數字，表示平台仍在服務舊版 `public/index.html`，不是這份套件。
- **部署根目錄**應直接看到 `server.js`、`package.json` 和 `public/`，不要多包一層資料夾。
- 在部署平台重新部署最新上傳版本並清除 CDN/瀏覽器快取。
- 打開 `/version` 檢查版本，若不是 v3，請檢查部署分支、Root Directory、Start Command、服務網址。
- 不要直接刪除正式環境的 `data.json`，它保存玩家與抽獎紀錄。
