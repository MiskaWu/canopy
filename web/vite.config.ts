import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// static 模式每 10 秒整頁重載一次，所以「重載後的第一次繪製」就是使用者實際看到的畫面。
// vite 預設輸出 type="module" 的 script，那等同 defer：瀏覽器必定先畫一次只有 placeholder
// 的空版面，等 JS 跑完才畫真畫面——那一幀就是使用者說的「閃一下」，而且第一幀高度不足
// 還會讓捲動位置恢復失敗、跳回頂端。
// 這個 plugin 在 singlefile 把程式碼 inline 進 HTML 之後接手，把 script 降成同步標籤
// 並搬到 #root 後面，讓 React 在第一次繪製前就掛載完成，首幀即完整畫面。
function blockingInlineScript(): Plugin {
  return {
    name: 'canopy:blocking-inline-script',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'asset' || !chunk.fileName.endsWith('.html')) continue
        const code: string[] = []
        let html = String(chunk.source).replace(
          /[ \t]*<script type="module"[^>]*>([\s\S]*?)<\/script>\n?/g,
          (_m, body: string) => {
            code.push(body)
            return ''
          },
        )
        if (!code.length) throw new Error('找不到 inline module script——singlefile 的輸出格式變了')
        if (!html.includes('</body>')) throw new Error('HTML 沒有 </body>，無法安置同步 script')
        html = html.replace('</body>', `  <script>${code.join('\n')}</script>\n  </body>`)
        chunk.source = html
      }
    },
  }
}

// 打包成單一自包含 HTML：Desktop 瀏覽器面板實測只吃得下內嵌資產，
// 外部 <script src>/<link href> 資產檔不會被載入。
export default defineConfig({
  plugins: [react(), viteSingleFile(), blockingInlineScript()],
  build: {
    // 同步 script 不能是 ESM，輸出壓成單一 IIFE；連帶不需要 modulePreload polyfill。
    modulePreload: false,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7777',
    },
  },
})
