import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{css,html,js,png,svg,webmanifest}'],
      },
      injectRegister: 'script',
      manifest: {
        name: '小厨：新手食谱与 AI 助手',
        short_name: '小厨',
        description: '面向做饭新手的本地食谱与独立语音助手',
        start_url: '/',
        display: 'standalone',
        background_color: '#fffaf2',
        theme_color: '#e85d3f',
        lang: 'zh-CN',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      registerType: 'autoUpdate',
      srcDir: 'src',
      strategies: 'injectManifest',
    }),
  ],
  server: {
    host: 'localhost',
    port: 5_173,
    strictPort: true,
    proxy: {
      '/api': {
        changeOrigin: true,
        target: 'http://127.0.0.1:4173',
      },
    },
  },
})
