import axios from 'axios';
import saveAs from 'file-saver';
// NOTE: wawoff2 (the WOFF2 -> TTF decompressor) is intentionally NOT imported at
// the top level. A static cross-origin import makes the whole app fail to boot
// (blank page) whenever the CDN is slow or unreachable. It is loaded lazily from
// the CDN only when a font is actually downloaded — see convertWoff2ToTTF below.

export default class TypeRip {
    // Adobe Fonts does not send CORS headers, so the browser cannot read its
    // pages directly. We route the request through a CORS proxy that mirrors the
    // response with permissive headers.
    //
    // Each proxy is described by an adapter so we can format the target URL the
    // way that proxy expects ("encode" => the target must be URL-encoded and
    // appended after the prefix; "raw" => appended verbatim) and pull the actual
    // body out of the response ("extract"). Public proxies come and go and rate
    // limit aggressively, so we keep several and race them in parallel (see
    // getNetworkResource): as long as *one* succeeds, the request works.
    //
    // The list is ordered best-first. corsproxy.io is first because its free tier
    // explicitly allow-lists `*.github.io` origins, which is exactly where this
    // app is hosted, so it works from the deployed page even when anonymous
    // server-side requests to it would be rejected.
    static CORSProxies = [
        { name: "corsproxy.io",     prefix: "https://corsproxy.io/?url=",                mode: "encode", extract: (d) => d },
        { name: "allorigins-raw",   prefix: "https://api.allorigins.win/raw?url=",       mode: "encode", extract: (d) => d },
        { name: "codetabs",         prefix: "https://api.codetabs.com/v1/proxy/?quest=", mode: "encode", extract: (d) => d },
        { name: "allorigins-get",   prefix: "https://api.allorigins.win/get?url=",       mode: "encode", extract: (d) => JSON.parse(d).contents },
        { name: "killcors",         prefix: "https://proxy.killcors.com/?url=",          mode: "encode", extract: (d) => d },
        { name: "thingproxy",       prefix: "https://thingproxy.freeboard.io/fetch/",    mode: "raw",    extract: (d) => d },
    ];

    // Per-proxy request timeout (ms). A hung/slow proxy must not stall the whole
    // race; if it does not answer in time we treat it as failed and rely on the
    // others.
    static ProxyTimeout = 20000;

    // Users can point TypeRip at their own proxy (e.g. a personal Cloudflare
    // Worker or Deno Deploy instance) without rebuilding by running this in the
    // browser console:
    //   localStorage.setItem('typerip_custom_proxy', 'https://my-worker.example/?url=')
    // It is tried alongside the public proxies and, being dedicated, will almost
    // always win the race. A trailing '=' (e.g. '?url=') means the target is
    // URL-encoded; otherwise it is appended verbatim (path-style, e.g. '/fetch/').
    static CustomProxyKey = "typerip_custom_proxy";

    static Messages = Object.freeze({
        RequestFailed: "Check that the Adobe Fonts URL is correct, then check your internet connection, and then try again.",
        MalformedFontResponse: "Unexpected Adobe Fonts page structure. Please check your URL and try again, otherwise open an issue on GitHub.",
        AllProxiesFailed: "All CORS proxies failed. They are public services and may be down or rate limited — wait a moment and try again. If it keeps failing you can set your own proxy (see the README), otherwise open an issue on GitHub."
    })

    static URLTypes = Object.freeze({
        Invalid: 0,
        FontFamily: 1,
        FontCollection: 2
    });

    static ResponseTypes = Object.freeze({
        Success: 0,
        Error: 1
    });

    static prependHttpsToURL(url) {
        if (!url.toLowerCase().startsWith("http://") && !url.toLowerCase().startsWith("https://")) {
            url = "https://" + url;
        }
        return url
    }

    static getURLType(url){
        if(url.indexOf("fonts.adobe.com/collections") != -1){
            return this.URLTypes.FontCollection;
        }else if(url.indexOf("fonts.adobe.com/fonts") != -1){
            return this.URLTypes.FontFamily;
        }else{
            return this.URLTypes.Invalid;
        }
    }

    // Read any custom proxy the user configured and turn it into an adapter.
    static getCustomProxy() {
        let custom;
        try {
            custom = localStorage.getItem(this.CustomProxyKey);
        } catch (e) {
            // localStorage can be unavailable (private mode / blocked cookies).
            custom = null;
        }
        if (!custom) {
            return null;
        }
        return {
            name: "custom",
            prefix: custom,
            mode: custom.trim().endsWith("=") ? "encode" : "raw",
            extract: (d) => d,
        };
    }

    // Build the full request URL for a given proxy adapter.
    static buildProxyURL(proxy, url_) {
        return proxy.prefix + (proxy.mode === "encode" ? encodeURIComponent(url_) : url_);
    }

    // A response only counts as a hit if it actually looks like an Adobe Fonts
    // page. Proxies frequently answer 200 with their own error JSON, a rate-limit
    // notice, or an empty body — accepting those would surface a confusing parse
    // error instead of letting the next proxy try.
    static looksLikeAdobeResponse(body) {
        return typeof body === "string" && body.length > 200 && body.toLowerCase().includes("adobe");
    }

    // Fetch the target through a single proxy. Resolves with the unwrapped body
    // on success; rejects (so the race skips it) on transport error, timeout,
    // unparseable wrapper, or a body that is not a real Adobe Fonts page.
    static fetchThroughProxy(proxy, url_) {
        return axios
            .get(this.buildProxyURL(proxy, url_), { responseType: "text", timeout: this.ProxyTimeout })
            .then((response) => {
                let body;
                try {
                    body = proxy.extract(response.data);
                } catch (e) {
                    throw new Error(proxy.name + ": could not read response");
                }
                if (!TypeRip.looksLikeAdobeResponse(body)) {
                    throw new Error(proxy.name + ": unexpected response");
                }
                return { data: body, proxyName: proxy.name };
            });
    }

    // Race every proxy in parallel and take the first that returns a valid Adobe
    // Fonts page. Racing (rather than trying one at a time) means a single live
    // proxy is enough to succeed and one slow/dead proxy can't hold up the rest —
    // this is what makes the dreaded "#007 All CORS proxies failed" rare. The
    // returned object exposes `.data` (the page HTML) so the parsers below are
    // unchanged.
    static getNetworkResource(url_) {
        const custom = this.getCustomProxy();
        const proxies = custom ? [custom, ...this.CORSProxies] : [...this.CORSProxies];

        const attempts = proxies.map((proxy) =>
            this.fetchThroughProxy(proxy, url_).then((result) => {
                console.log("Successful proxy: " + result.proxyName);
                return result;
            })
        );

        // Promise.any resolves with the first fulfilled attempt and only rejects
        // (AggregateError) if every proxy fails.
        return Promise.any(attempts).catch(() => {
            return Promise.reject({ message: TypeRip.Messages.AllProxiesFailed + " (#007)" });
        });
    }

    //TODO: refactor this so that it returns a Promise instead of manually specifying a 'callback_' method.
    // then we can have our promise provide a "resolve" and "reject" interface instead of using this stupid `ResponseTypes` enum system
    static getFontCollection(url_, callback_){
        this.getNetworkResource(url_)
        .then((response) => {
            let fontCollection = {
                name: "",
                designers: [],
                fonts: []
            }

            //search for the first part of the json
            let json_start = response.data.toString().search('{"fontpack":{"all_valid_slugs":');
		    if(json_start == -1) {
                // getNetworkResource only resolves with a validated Adobe Fonts
                // page, so a missing marker here means the URL is not a font
                // collection (wrong/typo'd URL, or Adobe returned a 404 page).
                callback_(this.ResponseTypes.Error, TypeRip.Messages.RequestFailed + " (#001)")
                return
            }

            //cut off everything before this point
            let data = response.data.substring(json_start)

            //find the stuff directly after the json, and use this as the anchor    
            let json_end = data.search('</script>') 
            if(json_end == -1) {
                callback_(this.ResponseTypes.Error, TypeRip.Messages.MalformedFontResponse + " (#002)")
                return
            }

            //parse the json blob
            let json;
            try {
                json = JSON.parse(data.substring(0, json_end)); 
            }catch(e){
                callback_(this.ResponseTypes.Error,  TypeRip.Messages.MalformedFontResponse + " (#003)")
                return
            }

            //find the default language of the first font in this collection.
            fontCollection.defaultLanguage = json.fontpack.font_variations[0].default_language;

            //grab the sample text data for this language
            fontCollection.sampleText = json.textSampleData.textSamples[fontCollection.defaultLanguage]["list"]; 
            
            //Font collection name
            fontCollection.name = json.fontpack.name

            //Find the contributor who curated this collection:
            fontCollection.designers.push({
                "name": json.fontpack.contributor_credit,
                "url": url_
            })
            
            //populate subfonts
            for (let i = 0; i < json.fontpack.font_variations.length; i++) {
                fontCollection.fonts.push({
                    url: "https://use.typekit.net/pf/tk/" + json.fontpack.font_variations[i].opaque_id + "/" + json.fontpack.font_variations[i].fvd + "/l?unicode=AAAAAQAAAAEAAAAB&features=ALL&v=3&ec_token=3bb2a6e53c9684ffdc9a9bf71d5b2a620e68abb153386c46ebe547292f11a96176a59ec4f0c7aacfef2663c08018dc100eedf850c284fb72392ba910777487b32ba21c08cc8c33d00bda49e7e2cc90baff01835518dde43e2e8d5ebf7b76545fc2687ab10bc2b0911a141f3cf7f04f3cac438a135f", 
                    name: json.fontpack.font_variations[i].full_display_name,
                    style: json.fontpack.font_variations[i].variation_name, 
                    familyName: json.fontpack.font_variations[i].family.name,
                    familyUrl: "https://fonts.adobe.com/fonts/" + json.fontpack.font_variations[i].family.slug
                });
            }	

            callback_(this.ResponseTypes.Success, fontCollection)
        })
        .catch( (error) => {
            callback_(this.ResponseTypes.Error, error.message)
        })
    }

    static getFontFamily(url_, callback_) {
        this.getNetworkResource(url_)
        .then((response) => {
            let fontFamily = {
                name: "",
                designers: [],
                fonts: []
            }

            //search for the first part of the json
            let json_start = response.data.toString().search('{"family":{"slug":"');
		    if(json_start == -1) {
                // getNetworkResource only resolves with a validated Adobe Fonts
                // page, so a missing marker here means the URL is not a font
                // family (wrong/typo'd URL, or Adobe returned a 404 page).
                callback_(this.ResponseTypes.Error, TypeRip.Messages.RequestFailed + " (#004)")
                return
            }

            //cut off everything before this point
            let data = response.data.substring(json_start)

            //find the stuff directly after the json, and use this as the anchor    
            let json_end = data.search('</script>') 
            if(json_end == -1) {
                callback_(this.ResponseTypes.Error, TypeRip.Messages.MalformedFontResponse + " (#005)")
                return
            }

            //parse the json blob
            let json;
            try {
                json = JSON.parse(data.substring(0, json_end));
            }catch(e){
                callback_(this.ResponseTypes.Error,  TypeRip.Messages.MalformedFontResponse + " (#006)")
                return
            }

            //find the default language of this font
            fontFamily.defaultLanguage = json.family.display_font.default_language;

            //grab the sample text data for this language
            fontFamily.sampleText = json.textSampleData.textSamples[fontFamily.defaultLanguage]["list"]; 
            
            //family/foundry names
            fontFamily.foundryName = json.family.foundry.name;
            fontFamily.name = json.family.name
            fontFamily.slug = json.family.slug

            //designers
            for(let i = 0; i < json.family.designers.length; i++) {
                let designer = {}
                designer["name"] = json.family.designers[i].name

                if(json.designer_info[json.family.designers[i].slug] != null){
                    designer["url"] = "https://fonts.adobe.com" + json.designer_info[json.family.designers[i].slug].url
                }

                fontFamily.designers.push(designer)
            }

            //populate subfonts
            for (let i = 0; i < json.family.fonts.length; i++) {
                fontFamily.fonts.push({
                    url: "https://use.typekit.net/pf/tk/" + json.family.fonts[i].family.web_id + "/" + json.family.fonts[i].font.web.fvd + "/l?unicode=AAAAAQAAAAEAAAAB&features=ALL&v=3&ec_token=3bb2a6e53c9684ffdc9a9bf71d5b2a620e68abb153386c46ebe547292f11a96176a59ec4f0c7aacfef2663c08018dc100eedf850c284fb72392ba910777487b32ba21c08cc8c33d00bda49e7e2cc90baff01835518dde43e2e8d5ebf7b76545fc2687ab10bc2b0911a141f3cf7f04f3cac438a135f", 
                    name: json.family.fonts[i].name,
                    style: json.family.fonts[i].variation_name, 
                    familyName: json.family.fonts[i].preferred_family_name,
                    familyUrl: "https://fonts.adobe.com/fonts/" + json.family.slug
                });
            }	
            callback_(this.ResponseTypes.Success, fontFamily)
        })
        .catch((error) => {
            callback_(this.ResponseTypes.Error, error.message)
        })
    }

    static async downloadFontsAsZip(fonts, zipfile_name){
        for(var i = 0; i < fonts.length; i++) {
            var file = await this.getFontFile(fonts[i])
            saveAs(new Blob([file]), fonts[i].name + ".ttf");
        }
    }

    static async convertWoff2ToTTF(woff2Uint8Array) {
        const loadScript = (src) => new Promise((onload) => document.documentElement.append(
            Object.assign(document.createElement('script'), {src, onload})
          ));
        if (!window.Module) {
            const path = 'https://unpkg.com/wawoff2@2.0.1/build/decompress_binding.js'
            const init = new Promise((done) => window.Module = { onRuntimeInitialized: done});
            await loadScript(path).then(() => init);
        }

        return Module.decompress(woff2Uint8Array)
    }

    static async getFontFile(font) {
        let response = await axios.get(font.url, {responseType: 'arraybuffer'})
        return this.convertWoff2ToTTF(new Uint8Array(response.data));
    }
}
