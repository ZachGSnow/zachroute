import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

// Shown in About so it's obvious which build a phone is running.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  root: 'src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  plugins: [
    // Generates dist/sw.js at build time with a revision-hashed precache
    // manifest, so every deploy that changes any file produces a new sw.js
    // and installed PWAs update themselves (see ARCHITECTURE.md "Service
    // Worker & Install" for why the old hand-written sw.js never updated).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      // Keep the hand-maintained public/manifest.json + icons (linked from index.html).
      manifest: false,
      workbox: {
        // Activate a new worker as soon as it's downloaded instead of waiting
        // for every window to close. Without these, this config's generated
        // sw.js only skipped waiting on a SKIP_WAITING message, which the
        // injected registerSW.js never sends. The next launch runs the new build.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,png,svg,ico,json}'],
        // World airspace (~1,400 cell files) and route traffic (~900 airport files) load on demand: not precached.
        globIgnores: ['data/airspace/**', 'data/t100/**'],
        // public/data/airports.json is ~18 MB and must be precached for
        // offline use; Workbox's default per-file cap is 2 MiB. 25 MiB matches
        // Cloudflare Pages' own per-file limit.
        maximumFileSizeToCacheInBytes: 25 * 1024 * 1024,
        // Never answer API or Cloudflare Access (/cdn-cgi/) navigations with
        // the cached app shell -- matters if Cloudflare Access is ever added.
        navigateFallbackDenylist: [/^\/api\//, /^\/cdn-cgi\//],
        runtimeCaching: [
          {
            // Same as before: prefer fresh lore/weather, fall back to the
            // last-seen response when offline.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && (url.pathname.startsWith('/api/lore') || url.pathname.startsWith('/api/weather')),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'zachroute-api',
              expiration: { maxEntries: 300 },
            },
          },
          {
            // Leaflet JS/CSS/marker images load from unpkg (pinned version),
            // so they're safe to cache permanently -- needed for offline boot.
            urlPattern: /^https:\/\/unpkg\.com\/leaflet@/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'zachroute-leaflet',
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
