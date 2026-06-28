/**
 * TypeRip self-hosted CORS proxy — Cloudflare Worker
 * ==================================================
 *
 * TypeRip reads Adobe Fonts pages through a CORS proxy because Adobe doesn't
 * send CORS headers. The app ships with a list of public proxies, but those are
 * shared services that go down or rate-limit, which is the usual cause of the
 * "#007 All CORS proxies failed" error. Deploying your own proxy makes the app
 * rock solid because nobody else is using it.
 *
 * Deploy (takes ~2 minutes, free tier is plenty):
 *   1. Sign in at https://dash.cloudflare.com → Workers & Pages → Create → Worker.
 *   2. Replace the generated code with this file and click "Deploy".
 *   3. Copy your Worker URL, e.g. https://typerip-proxy.<you>.workers.dev
 *   4. On the TypeRip page, open the browser console and run:
 *        localStorage.setItem('typerip_custom_proxy', 'https://typerip-proxy.<you>.workers.dev/?url=')
 *      (keep the trailing `?url=` — TypeRip URL-encodes the target after it).
 *   5. Reload TypeRip. It now races your proxy first and almost never falls back.
 *
 * Prefer Deno Deploy / Vercel / Netlify? The same idea works anywhere you can run
 * a tiny function: read ?url=, fetch it, return the body with the three CORS
 * headers below.
 *
 * Note: this is an open proxy. To lock it to your own deployment, set
 * ALLOWED_ORIGIN to your Pages origin (e.g. "https://<user>.github.io") instead
 * of "*".
 */

const ALLOWED_ORIGIN = "*";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request) {
    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return new Response("Only GET is supported.", { status: 405, headers: CORS_HEADERS });
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url= parameter.", { status: 400, headers: CORS_HEADERS });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response("Invalid ?url= value.", { status: 400, headers: CORS_HEADERS });
    }

    // Only proxy http(s) to avoid being abused for other schemes.
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      return new Response("Only http(s) targets are allowed.", { status: 400, headers: CORS_HEADERS });
    }

    try {
      const upstream = await fetch(targetUrl.toString(), {
        method: "GET",
        headers: {
          // Present like a normal browser so Adobe serves the full page.
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });

      // Pass the upstream body straight through, but with our CORS headers.
      const headers = new Headers(CORS_HEADERS);
      const contentType = upstream.headers.get("content-type");
      if (contentType) {
        headers.set("content-type", contentType);
      }

      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return new Response("Upstream fetch failed: " + e.message, { status: 502, headers: CORS_HEADERS });
    }
  },
};
