import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 読む画面。ビルドした dist/ を、外では Cloudflare の Worker（worker.ts）が、手元では viewer-local.ts が配る。
// 画面を直しながら見るときは、先に `npm run web` を立てておき `npm run dev --workspace @yaritori/web`（api を 8770 に回す）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: { '/api': 'http://127.0.0.1:8770' },
  },
})
