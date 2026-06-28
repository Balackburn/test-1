import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  // Relative base so the built site works from any path. GitHub Pages serves
  // project sites from a subpath (e.g. https://<user>.github.io/<repo>/), and
  // './' keeps every asset reference relative to index.html so it loads there
  // as well as from a custom domain or the repo root.
  base: './',
  build : {
    minify: false
  }
  // optimizeDeps: {
  //   include: ['woff2'],
  // },
  // define: {
  //   'process.env': {},
  //   'process.version': {},
  //   'process.versions.modules': {},
  //   'process.platform': {},
  // }
})
