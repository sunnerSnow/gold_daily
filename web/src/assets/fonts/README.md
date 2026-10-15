# 走勢圖字型

`/api/chart/<日期>.png` 用的字型：Noto Sans TC（Medium 500、Bold 700）的子集，授權為 SIL Open Font License 1.1（見 `OFL.txt`）。

只收錄 ASCII 與 `src/lib/chart/daily-chart.ts` 的 `CHART_GLYPHS`（約 150 字，每個檔案約 31 KB）。圖上新增中文字時，要把字加進 `CHART_GLYPHS` 並重新產生字型，否則會顯示成方塊；`chart.test.ts` 會檢查。

重新產生：向 Google Fonts 要指定字元的子集（`https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@500&text=<字元>`，用舊版 Safari 的 User-Agent 會拿到 TrueType），再把 CSS 裡的字型網址下載下來。圖片產生器只支援 ttf／otf／woff，不支援 woff2。
