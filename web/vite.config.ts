import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 打包成單一自包含 HTML：Desktop 瀏覽器面板實測只吃得下內嵌資產，
// 外部 <script src>/<link href> 資產檔不會被載入。
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7777',
    },
  },
})
