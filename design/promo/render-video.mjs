// 把 video.html 逐格輸出成 MP4：用本機的 Chrome（DevTools Protocol）截圖，再交給 ffmpeg 合成。
// 不需要安裝任何套件（Node 22 內建 WebSocket）；需要網路載入 Google Fonts 與 QR code 函式庫。
// 用法：node design/promo/render-video.mjs        → design/promo/out/gold-daily-story.mp4
// 環境變數：CHROME（Chrome 路徑）、FFMPEG（ffmpeg 路徑）

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DURATION = 12;
const PORT = 9333;
const OUT = path.join(here, 'out', 'gold-daily-story.mp4');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(tmpdir(), 'gold-daily-video-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function pageSocketUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome 還沒準備好
    }
    await sleep(200);
  }
  throw new Error('Chrome 沒有啟動');
}

const ws = new WebSocket(await pageSocketUrl());
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  const waiter = msg.id !== undefined && pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(msg.error.message));
  else waiter.resolve(msg.result);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};

try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${pathToFileURL(path.join(here, 'video.html')).href}?render` });
  // 等字型載完、QR code 產生好
  for (let i = 0; !(await evaluate('window.__ready === true').catch(() => false)); i++) {
    if (i > 150) throw new Error('影片頁面沒有準備好（字型或 QR code 函式庫載入失敗？）');
    await sleep(200);
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  const ffmpeg = spawn(
    FFMPEG,
    ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', OUT],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const finished = new Promise((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 結束代碼 ${code}`))));
  });

  const frames = FPS * DURATION;
  for (let f = 0; f < frames; f++) {
    // 畫好這一格、等瀏覽器實際繪製完再截圖
    await evaluate(`new Promise((r) => { renderAt(${f / FPS}); requestAnimationFrame(() => requestAnimationFrame(r)); })`);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    if (!ffmpeg.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if (f % FPS === 0) process.stdout.write(`\r${f / FPS} / ${DURATION} 秒`);
  }
  ffmpeg.stdin.end();
  await finished;
  console.log(`\r完成：${path.relative(process.cwd(), OUT)}`);
} finally {
  ws.close();
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
