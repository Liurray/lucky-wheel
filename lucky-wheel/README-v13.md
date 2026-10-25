# v13 登入背景更新

- 登入畫面使用使用者提供的雪白城堡圖片 `public/login-background.png`。
- 三欄進房資料、邀請碼與主持人權限邏輯不變。
- 背景採 `cover` 自適應電腦及手機；表單以半透明深色玻璃卡呈現。
- 成功進房後恢復原本 BOSS Dashboard 背景，不會把登入圖片套到討伐頁面。
- 部署時使用完整專案，`npm install` 然後 `npm start`。
