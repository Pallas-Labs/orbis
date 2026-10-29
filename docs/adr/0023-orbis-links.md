# Share a Set as an Orbis Link that the Group previews without a key

A Person shares a Set with an **Orbis Link**, `https://orbis.p11a.xyz/s/<set id>`. On a device with Orbis, the link opens the Set in the app. Anywhere else, it shows a small page, and iMessage shows a rich preview built from that page's Open Graph tags. The Share action on iPhone, Mac, and web offers the Orbis Link first and the Source Link second.

**What anyone with the link sees.** The Set's shared facts only: the provider title, the creator, the Artwork, the Source, and the Source Link (ADR 0013). Never a Library Entry's title override, Tags, Playlists, Listens, who saved it, or anything else from the Group. A Set id is a random UUID, so the link names one Set and cannot be guessed or walked. An unknown id answers 404.

**Who serves what.**

- The Group serves three open routes, with no key, in the typed API (ADR 0014): `GET /share/sets/:id` returns the shared facts as JSON, `GET /share/sets/:id/page` returns the HTML page, and `GET /share/sets/:id/image.png` returns the 1200×630 preview image. The Group already holds the Set, so it renders the page and the image itself. The image is drawn in plain TypeScript (JPEG decoding, glyph outlines from an embedded Inter, a scanline rasterizer, and a PNG encoder over `CompressionStream`), because WebAssembly renderers need different module loading in workerd and Bun.
- The page names the image by its content version, `image.png?v=<v>`, a short SHA-256 digest of what the image draws: the title, the creator, the Source, both Artwork addresses, and a drawing version that rises whenever the drawing changes. The Group answers a missing or stale `v` with a 302 to the current address, and draws each version at most once while it stays among the last 16 it drew. The API Worker keeps the current version's image in its Cloudflare cache, keyed by the Set id and `v` only, so repeat requests never reach the Group. Only an image drawn with its Artwork, or for a Set with no Artwork, is marked `immutable`; one whose Artwork failed to load is kept for an hour.
- The web Worker serves `/s/:id` as a redirect to the Group's page, and `/.well-known/apple-app-site-association` with `applinks` for `/s/*` and the app ID `JR398S689Z.app.orbis.client`.

The redirect exists because the web Worker cannot call the API: the API Worker answers on a route (`orbis.p11a.xyz/api/*`), and Cloudflare refuses a `fetch()` from one Worker to another Worker's route on the same zone without a service binding. A binding, or a route that sends `/s/*` to the API Worker, is a deploy change; either one would let `/s/:id` answer with the page directly. iMessage follows the redirect for its preview, and the app never sees it, because the system hands it `/s/:id` before any request.

**In the app.** The iPhone, Mac, and Apple TV builds carry the Associated Domains entitlement `applinks:orbis.p11a.xyz`, and the App ID `app.orbis.client` has the capability. The app also registers the `orbis` URL scheme, so the page's Open in Orbis button (`orbis://s/<id>`) works from Safari, which opens a same-domain link in the page instead of the app. Opening an Orbis Link shows the Set's page. A Set outside the Person's Library shows its shared facts with Save. A signed-out app keeps the link and opens the Set after sign-in.

Rejected alternatives:

- **Render the page in the web Worker.** The Worker would need the Set, and it cannot reach the API without a deploy change (above). A page rendered in the browser cannot set the tags iMessage reads, because iMessage runs no script.
- **Share the Source Link only.** The friend lands on YouTube or SoundCloud, not in Orbis.
- **A WebAssembly image renderer (satori and resvg).** Workerd refuses runtime WebAssembly compilation, so the Group and the Bun server would load the module differently, and the bundle grows by about 3 MB.
- **Show who shared the Set.** The page is public; the Group's membership stays private.
