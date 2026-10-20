# 🎡 大家一起抽!多人抽獎轉盤

打開網頁 → 輸入房間代碼與 ID → 依加入順序輪流按「開始轉盤」。所有人的畫面同步轉動,結果由伺服器決定並記錄。

## 玩法

1. 第一個進入房間的人是**主持人**,可以在右下角編輯獎項(一行一個)。
2. 其他人用「複製邀請連結」分享的網址,輸入自己的 ID 就能加入。
3. 輪到誰,誰的手機/電腦上的按鈕就會亮起,按下去全員同步轉動。
4. 抽獎紀錄會顯示在右側,主持人可清空。

## 本機測試

```bash
npm install
npm start
# 打開 http://localhost:3000
```

## 最簡單的部署:Render(免費、免信用卡)

1. 把這個資料夾推到 GitHub(新 repo 即可)。
   - 建議加一個 `.gitignore`,內容一行:`node_modules` 和 `data.json`
2. 到 https://render.com 註冊 → **New → Web Service** → 選你的 repo。
3. 設定:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. 按 Deploy,幾分鐘後會得到 `https://xxxx.onrender.com`,把網址分享給大家就能玩(WebSocket 已自動支援 wss)。

> 也可以用 Railway、Fly.io 等任何能跑 Node 的平台,不需要額外設定。

## 注意事項

- Render 免費方案閒置約 15 分鐘會休眠,第一次開啟要等 30~60 秒喚醒。活動前先自己打開一次即可。
- 抽獎紀錄存在伺服器的 `data.json`,免費方案重新部署或休眠後重啟可能會被清掉;重要紀錄請在活動結束時截圖或複製保存。
- 同一個 ID 在同一房間同時只能有一人使用;斷線後用**同一台手機/瀏覽器**、同一個 ID 重進即可馬上接回(就算伺服器還沒發現你斷線也可以)。換別台裝置的話,要等原本那台離線後才能用這個 ID。
- 抽中「再抽一次」的人不會換人,可以直接再轉一次(獎項名稱要完全是「再抽一次」四個字)。
- 玩家離線時會自動跳過,輪到下一位上線的人。

## 檔案結構

```
server.js          伺服器(HTTP + WebSocket,房間/輪流/抽獎邏輯)
public/index.html  前端頁面(轉盤、玩家列表、紀錄、主持人設定)
package.json       只依賴 ws
```
