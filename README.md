![TypeRip Logo](https://raw.githubusercontent.com/CodeZombie/TypeRip/master/src/assets/typerip_logo_small.png)
### The [Adobe Fonts](https://fonts.adobe.com/) ripper.

A browser-based tool that lets you preview and download the fonts Adobe Fonts
(formerly TypeKit) makes publicly available. Built with Vite + Vue 3 and hosted
as a static site on GitHub Pages.

### How to use it
  1. Enter an Adobe Fonts [font family](https://fonts.adobe.com/fonts) or [font collection](https://fonts.adobe.com/collections) URL into the address bar, then press enter.
  2. Browse the available fonts under this family, using the download button to save them to your machine.
  3. That's it.

### Terms
* Do not use any downloaded fonts for anything other than testing purposes. Think of it like a try-before-you-buy system. This tool merely saves a copy of what Adobe makes publicly available through their website, but this does not give you the _legal right_ to use the fonts as if you have purchased a license. If you want to publish any work using these fonts, or do _anything_ restricted to license-holders by said license, you _must_ purchase a license through Adobe.

---

## Running locally

```bash
npm install
npm run dev      # start the dev server
npm run build    # produce a production build in dist/
npm run preview  # serve the production build locally
```

## Deploying to GitHub Pages

This repo ships a GitHub Actions workflow ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml))
that builds the app and publishes `dist/` to GitHub Pages on every push to the
default branch.

**One-time setup:** in the repository, go to **Settings → Pages → Build and
deployment** and set **Source** to **GitHub Actions**. After the next push the
workflow runs and the site goes live at `https://<user>.github.io/<repo>/`.

The Vite `base` is set to `./` (relative paths), so the build works from that
project subpath as well as from a custom domain. You can also run
`npm run deploy` to publish to a `gh-pages` branch instead if you prefer that
flow.

## About CORS proxies (the "#007" error)

Adobe Fonts pages don't send CORS headers, so a browser can't read them
directly. TypeRip routes the page request through a **CORS proxy** that mirrors
the response with permissive headers. The error

> Request Failed — All CORS proxies failed. (#007)

means every proxy TypeRip tried was unavailable at that moment. This build
makes that error far less likely:

* **A refreshed, working proxy list.** Dead/blocked proxies were removed and
  `corsproxy.io` is tried first — its free tier allow-lists `*.github.io`
  origins, which is exactly where this app is hosted.
* **Correct request formatting.** Target URLs are now properly URL-encoded
  (several proxies silently failed without this).
* **Parallel racing with validation.** All proxies are tried at once and the
  first response that actually looks like an Adobe Fonts page wins. A single
  live proxy is enough to succeed, and one slow/dead proxy can no longer stall
  the request. Each proxy also has a 20-second timeout.

### Bullet-proofing it with your own proxy (optional)

Public proxies are shared and can still be rate limited. To never see `#007`
again, deploy the included [`cors-proxy-worker.js`](cors-proxy-worker.js) as a
free Cloudflare Worker (instructions are in that file), then tell TypeRip to use
it by running this once in your browser console on the TypeRip page:

```js
localStorage.setItem('typerip_custom_proxy', 'https://<your-worker>.workers.dev/?url=')
```

TypeRip races your proxy alongside the public ones, so a dedicated proxy will
almost always win. Remove it with
`localStorage.removeItem('typerip_custom_proxy')`.

---

### License
typerip.js is released under the WTFPL (http://www.wtfpl.net/)

Originally created by [Jeremy Clark / CodeZombie](https://github.com/CodeZombie/TypeRip).
