import type { SetSource, SharedSet } from "@orbis/contracts";

const SOURCE_ACTION: Record<SetSource, string> = {
  "apple-music": "Open in Apple Music",
  soundcloud: "Open on SoundCloud",
  youtube: "Open on YouTube",
};

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** The page carries no script and no inline style attribute, so this hash is its only style. */
const STYLE = `
:root{color-scheme:dark;--paper:#040405;--ink:#eeeaf7;--muted:#d6caee;--tint:#a54dff}
*{box-sizing:border-box;margin:0}
html,body{min-height:100%}
body{min-height:100vh;display:grid;place-items:center;padding:32px 20px;background:radial-gradient(120% 80% at 20% 0%,rgb(165 77 255/.22),rgb(165 77 255/.06) 50%,transparent),var(--paper);color:var(--ink);font:16px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
.glow{position:fixed;inset:-20%;width:140%;height:140%;object-fit:cover;filter:blur(80px) saturate(1.5);opacity:.45;z-index:-1}
main{width:min(100%,420px);display:grid;gap:20px;text-align:center}
.mark{display:inline-flex;align-items:center;justify-self:center;gap:8px;font-weight:700;font-size:15px;letter-spacing:-.01em}
.mark::before{content:"";width:12px;height:12px;border-radius:50%;background:var(--tint)}
.art{width:100%;height:auto;border-radius:16px;box-shadow:0 24px 48px rgb(0 0 0/.5),0 0 0 1px rgb(255 255 255/.1)}
.art.wide{aspect-ratio:16/9;object-fit:cover}
.art.square{aspect-ratio:1;object-fit:cover}
h1{font-size:clamp(24px,6vw,30px);line-height:1.15;font-weight:700;letter-spacing:-.02em;text-wrap:balance;overflow-wrap:anywhere}
.creator{color:var(--muted);font-weight:500;margin-top:-12px}
.actions{display:grid;gap:10px;margin-top:4px}
a{display:block;padding:14px 20px;border-radius:999px;font-weight:600;text-decoration:none;color:var(--ink);background:rgb(255 255 255/.1)}
a.primary{background:var(--tint);color:#fff}
a:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
`;

const hashStyle = async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(STYLE)
  );
  return btoa(String.fromCodePoint(...new Uint8Array(digest)));
};

/** The page's Content-Security-Policy: no script, no plugins, and only its own style. */
export const sharePagePolicy = async (): Promise<string> => {
  const styleHash = await hashStyle();
  return [
    "default-src 'none'",
    "img-src https: http:",
    `style-src 'sha256-${styleHash}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
};

/**
 * The small page an Orbis Link opens outside the app. Its Open Graph tags give iMessage and
 * other previews the title, the creator, and the 1200x630 image (ADR 0023).
 */
export const renderSharePage = (
  set: SharedSet,
  links: { readonly image: string; readonly orbisLink: string }
): string => {
  const title = escapeHtml(set.title);
  const description = escapeHtml(set.creator ?? "A set on Orbis");
  const image = escapeHtml(links.image);
  const orbisLink = escapeHtml(links.orbisLink);
  const artwork = set.artworkUrl ? escapeHtml(set.artworkUrl) : null;
  const frame = set.source === "youtube" ? "wide" : "square";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="theme-color" content="#040405">
<link rel="canonical" href="${orbisLink}">
<meta property="og:site_name" content="Orbis">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${orbisLink}">
<meta property="og:image" content="${image}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${title}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
<style>${STYLE}</style>
</head>
<body>
${artwork ? `<img class="glow" src="${artwork}" alt="" aria-hidden="true">` : ""}
<main>
<p class="mark">Orbis</p>
${artwork ? `<img class="art ${frame}" src="${artwork}" alt="">` : ""}
<h1>${title}</h1>
${set.creator ? `<p class="creator">${escapeHtml(set.creator)}</p>` : ""}
<div class="actions">
<a class="primary" href="orbis://s/${encodeURIComponent(set.id)}">Open in Orbis</a>
<a href="${escapeHtml(set.url)}" rel="noopener">${SOURCE_ACTION[set.source]}</a>
</div>
</main>
</body>
</html>
`;
};
