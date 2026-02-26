import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  clearScreen: false,
  server: {
    strictPort: true,
    port: 5173
  },
  build: {
    target: 'esnext',
    outDir: 'build/frontend',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        splashscreen: resolve(__dirname, 'splashscreen.html'),
      },
    },
  }
})
