import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 家目錄有一個無關的 package-lock.json，明確指定專案根目錄避免 Turbopack 誤判
  turbopack: { root: path.join(__dirname) },
  poweredByHeader: false,
  // 走勢圖用 readFile 讀字型，明確列出讓部署時一起打包
  outputFileTracingIncludes: { '/api/chart/*': ['./src/assets/fonts/*.ttf'] },
};

export default nextConfig;
