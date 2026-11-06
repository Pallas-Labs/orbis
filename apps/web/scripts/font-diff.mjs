// Proves a font change draws the same pixels, and measures font bytes per page.
//
//   node apps/web/scripts/font-diff.mjs --out <dir> after=<dist> before=<dist> [name=<dist>...]
//
// Each <dist> is a copy of `apps/web/dist` from `bun run build`. The first one
// serves the pages. On each page it takes one screenshot per build, swapping in
// that build's stylesheet and fonts without reloading, so the content and state
// are the same in every picture. Then it loads each page fresh on every build
// and records the font files the page downloads and preloads.
//
// It writes <dir>/<page>/<build>.png, a <build>-diff.png wherever a build's
// pixels differ from the first's, and <dir>/report.json. It exits 1 when any
// picture differs.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { keyRecord, runInOrder, waitFor, waitUntil } from "../e2e/helpers.mjs";

const web = path.resolve(import.meta.dirname, "..");
const root = path.resolve(web, "../..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex === -1 ? undefined : args[outIndex + 1];
const builds = args
  .filter((_, index) => index !== outIndex && index !== outIndex + 1)
  .map((arg) => {
    const split = arg.indexOf("=");
    return {
      dist: path.resolve(arg.slice(split + 1)),
      name: arg.slice(0, split),
    };
  });
if (!out || builds.length === 0 || builds.some(({ name }) => !name)) {
  throw new Error("Usage: font-diff.mjs --out <dir> name=<dist> ...");
}

const apiPort = 4591;
const webPort = 3591;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const keys = {
  bob: randomBytes(24).toString("base64url"),
  host: randomBytes(24).toString("base64url"),
};

// Titles that reach every Inter file and the CJK system font, with the
// punctuation, figures and contextual forms that Inter shapes.
const titles = [
  "Peggy Gou -> Boiler Room 10:30, 1/2 'Live' \"Seoul\" (2019) #1 & more",
  "Kölsch – Live at Café Mambo, Ibiza (Sébastien Léger “Remix”)…",
  "Âme b2b Dixon · Innervisions — Ünter Tëst ÿ ß Æ Ø Å © ® ™ € £ ° ± × ½",
  "Łukasz Dvořák – Šumava Ŭ Œuvre Ğ ş İ",
  "Sơn Tùng M-TP – Đừng làm trái tim anh đau",
  "Ивана Купала — Ελληνικά νησιά Ἀθῆναι",
  "坂本龍一 – 戦場のメリークリスマス (東京 2023)",
];

const api = async (pathname, key, init = {}) => {
  const response = await fetch(`${apiUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${pathname} answered ${response.status}`);
  }
  return await response.json();
};

// A failed run must not leave a server holding the ports. Each server runs in
// its own process group, because `bun x vite` starts vite as a child.
const children = new Set();
process.on("exit", () => {
  for (const child of children) {
    process.kill(-child.pid, "SIGKILL");
  }
});
const start = (command, options) => {
  const child = spawn("bun", command, {
    ...options,
    detached: true,
    stdio: "ignore",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
};
// Stops a server's process group, and waits until its port refuses, because
// vite outlives the bun process that started it by a moment.
const stop = async (child, url) => {
  if (children.has(child)) {
    process.kill(-child.pid);
    await once(child, "exit");
  }
  await waitUntil(async () => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5000) });
      return false;
    } catch {
      return true;
    }
  }, `${url} kept answering`);
};

const startApi = async () => {
  const data = await mkdtemp(path.join(tmpdir(), "orbis-font-diff-"));
  await writeFile(
    path.join(data, "devices.json"),
    JSON.stringify({
      keys: Object.entries(keys).map(([personId, key]) =>
        keyRecord(`${personId}-key`, "Font diff", personId, key)
      ),
      people: ["host", "bob"].map((id) => ({
        autoDownload: false,
        id,
        removed: false,
        social: true,
        username: id,
      })),
      version: 2,
    })
  );
  const child = start(["apps/web/e2e/api-server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ORBIS_DATA_DIR: data,
      ORBIS_FIXTURE_ORIGIN: webUrl,
      ORBIS_FIXTURE_PORT: String(apiPort),
    },
  });
  await waitFor(`${apiUrl}/health`);
  return child;
};

// A dist's server bundle imports packages, so it needs this app's node_modules
// above it, and ES module syntax.
const startWeb = async (dist) => {
  if (!existsSync(path.join(dist, "node_modules"))) {
    await symlink(
      path.join(web, "node_modules"),
      path.join(dist, "node_modules")
    );
    await writeFile(path.join(dist, "package.json"), '{"type":"module"}\n');
  }
  const child = start(
    [
      "x",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
      "--outDir",
      dist,
    ],
    { cwd: web, env: { ...process.env, ORBIS_API_URL: apiUrl } }
  );
  await waitFor(webUrl);
  return child;
};

const stylesheet = async (dist) => {
  const files = await readdir(path.join(dist, "client/assets"));
  return `/assets/${files.find((file) => /^styles-.+\.css$/u.test(file))}`;
};

// Waits until no font is loading, then for two drawn frames.
const settle = async (page) => {
  await page.evaluate(async () => await document.fonts.ready);
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers();
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
    return promise;
  });
};

// The live events stream keeps the network busy, so wait for the page's
// heading and, where the page names one, a text its data draws.
const shown = async (page, text) => {
  await page.locator("h1").first().waitFor();
  if (text) {
    await page.getByText(text).first().waitFor();
  }
};

/** What the page asks of its fonts: each font setting, with its characters. */
const fontUse = (page) =>
  page.evaluate(() => {
    const uses = new Map();
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.data.trim() !== "") {
          const style = getComputedStyle(child.parentElement);
          const key = [
            style.fontFamily.split(",")[0],
            style.fontWeight,
            style.fontStyle,
            style.fontVariantNumeric,
            style.fontFeatureSettings,
            style.fontVariationSettings,
            style.hyphens,
          ].join(" | ");
          uses.set(key, `${uses.get(key) ?? ""}${child.data}`);
        }
        if (child.nodeType === Node.ELEMENT_NODE) {
          visit(child);
          if (child.shadowRoot) {
            visit(child.shadowRoot);
          }
        }
      }
    };
    visit(document.body);
    return Object.fromEntries(
      [...uses].map(([key, text]) => [
        key,
        [...new Set(text)].toSorted((a, b) => a.localeCompare(b)).join(""),
      ])
    );
  });

// Compares two screenshots in the browser, and draws the differing pixels red
// over a faded copy of the first.
const compare = (page, first, second) =>
  page.evaluate(
    async (pictures) => {
      // oxlint-disable-next-line orbis/bounded-concurrency -- decodes the two screenshots it compares.
      const [left, right] = await Promise.all(
        pictures.map(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = new OffscreenCanvas(image.width, image.height);
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height);
        })
      );
      if (left.width !== right.width || left.height !== right.height) {
        return {
          differing: -1,
          size: `${left.width}x${left.height} vs ${right.width}x${right.height}`,
        };
      }
      const diff = new ImageData(left.width, left.height);
      let differing = 0;
      for (let index = 0; index < left.data.length; index += 4) {
        const same = [0, 1, 2, 3].every(
          (channel) =>
            left.data[index + channel] === right.data[index + channel]
        );
        differing += same ? 0 : 1;
        const faded = 255 - (255 - left.data[index]) / 4;
        diff.data.set(
          same ? [faded, faded, faded, 255] : [255, 0, 0, 255],
          index
        );
      }
      if (differing === 0) {
        return { differing };
      }
      const canvas = new OffscreenCanvas(left.width, left.height);
      canvas.getContext("2d").putImageData(diff, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return {
        differing,
        png: new Uint8Array(await blob.arrayBuffer()).toBase64(),
      };
    },
    [first.toString("base64"), second.toString("base64")]
  );

const seed = async () => {
  const sets = [];
  await runInOrder(titles.entries(), async ([index, title]) => {
    const url = `https://www.youtube.com/watch?v=${String(index).repeat(11)}`;
    sets.push(
      await api("/sets", keys.host, {
        body: JSON.stringify({ title, url }),
        method: "POST",
      })
    );
  });
  await api(`/sets/${sets[0].id}/audio/download`, keys.host, {
    method: "POST",
  });
  const playlist = await api("/playlists", keys.host, {
    body: JSON.stringify({ name: "Ünïcode “Mix” – 東京" }),
    method: "POST",
  });
  await api(`/playlists/${playlist.id}/sets`, keys.host, {
    body: JSON.stringify({ setIds: sets.map((set) => set.id) }),
    method: "PUT",
  });
  return { playlist, sets };
};

// Each page is a URL, who opens it, and what to do before the pictures.
const pages = ({ playlist, sets }) => [
  { name: "sign-in", path: "/sign-in", who: null },
  { name: "library", path: "/", text: titles[6], who: "host" },
  {
    // The player: media-chrome's own font settings and tabular figures.
    act: async (page) => {
      await page
        .getByRole("button", { name: `Actions for ${titles[0]}` })
        .click();
      await page.getByRole("menuitem", { exact: true, name: "Play" }).click();
      await page.waitForFunction(
        () => document.querySelector("audio")?.currentTime > 0
      );
      await page.evaluate(() => {
        const audio = document.querySelector("audio");
        audio.pause();
        audio.currentTime = 7;
      });
      await page.waitForFunction(() => {
        const audio = document.querySelector("audio");
        return !audio.seeking && audio.currentTime === 7;
      });
    },
    name: "player",
    path: "/",
    text: titles[0],
    who: "host",
  },
  { name: "library-empty", path: "/", who: "bob" },
  { name: "set-cjk", path: `/sets/${sets[6].id}`, who: "host" },
  { name: "set-accents", path: `/sets/${sets[1].id}`, who: "host" },
  { name: "playlists", path: "/playlists", who: "host" },
  {
    name: "playlist",
    path: `/playlists/${playlist.id}`,
    text: titles[6],
    who: "host",
  },
  { name: "people", path: "/people", who: "host" },
  { name: "person", path: "/people/host", text: titles[6], who: "bob" },
  { name: "devices", path: "/devices", who: "host" },
  {
    // A new key shows in a <code>, which draws in the system monospace font.
    act: async (page) => {
      await page.getByLabel("Key label").fill("Café laptop");
      await page.getByLabel("Key label").press("Enter");
      await page.locator("code").waitFor();
    },
    name: "admin",
    path: "/admin",
    who: "host",
  },
  { name: "queue", path: "/queue", who: "host" },
];

const open = async (browser, entry) => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { height: 900, width: 1280 },
  });
  if (entry.who) {
    await context.addInitScript(
      (key) => localStorage.setItem("orbis.apiKey", key),
      keys[entry.who]
    );
  }
  const page = await context.newPage();
  return { context, page };
};

const show = async (page, entry) => {
  await page.goto(`${webUrl}${entry.path}`);
  await shown(page, entry.text);
  await entry.act?.(page);
  await settle(page);
};

const fetchedFonts = (page) =>
  page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((font) => font.name.endsWith(".woff2"))
      .map((font) => ({
        bytes: font.encodedBodySize,
        file: new URL(font.name).pathname.split("/").pop(),
      }))
  );

const pictures = async (browser, list, sheets) => {
  const results = {};
  // Each page is opened, dressed and pictured before the next, so the pictures
  // and the fonts they fetched describe the same page state.
  await runInOrder(list, async (entry) => {
    const { context, page } = await open(browser, entry);
    // Serve every build's files from disk, so the first build's server can
    // answer the others' stylesheets and fonts.
    await context.route("**/assets/**", async (request) => {
      const name = path.basename(new URL(request.request().url()).pathname);
      const build = builds.find(({ dist }) =>
        existsSync(path.join(dist, "client/assets", name))
      );
      await (build
        ? request.fulfill({
            path: path.join(build.dist, "client/assets", name),
          })
        : request.continue());
    });
    await show(page, entry);
    const shots = {};
    // Every font file the page has fetched by each picture, which shows the
    // swap reached that build's fonts.
    const fetched = {};
    // The first build twice, last again, shows whether the page itself moves.
    const names = builds.map((build) => build.name);
    await runInOrder([...names, `${names[0]}-again`], async (key) => {
      const name = key.replace(/-again$/u, "");
      await page.evaluate((href) => {
        document.querySelector('link[rel="stylesheet"]').href = href;
      }, sheets[name]);
      await page.waitForFunction(
        (href) =>
          [...document.styleSheets].some((sheet) => sheet.href?.endsWith(href)),
        sheets[name]
      );
      await settle(page);
      const fonts = await fetchedFonts(page);
      fetched[key] = fonts.map(({ file }) => file);
      shots[key] = await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(out, entry.name, `${key}.png`),
      });
    });
    const differences = {};
    await runInOrder(Object.keys(shots).slice(1), async (key) => {
      const { png, ...result } = await compare(
        page,
        shots[builds[0].name],
        shots[key]
      );
      differences[key] = result;
      if (png) {
        await writeFile(
          path.join(out, entry.name, `${key}-diff.png`),
          Buffer.from(png, "base64")
        );
      }
    });
    results[entry.name] = {
      differences,
      fetched,
      fontUse: await fontUse(page),
    };
    await context.close();
  });
  return results;
};

// Loads each page fresh, with an empty cache, and lists the fonts it fetched.
const fontBytes = async (browser, list) => {
  const results = {};
  await runInOrder(list, async (entry) => {
    const { context, page } = await open(browser, entry);
    await show(page, entry);
    const fonts = await fetchedFonts(page);
    results[entry.name] = {
      bytes: fonts.reduce((sum, font) => sum + font.bytes, 0),
      fonts,
      preloads: await page.evaluate(() =>
        [...document.querySelectorAll('link[rel="preload"][as="font"]')].map(
          (link) => new URL(link.href).pathname.split("/").pop()
        )
      ),
    };
    await context.close();
  });
  return results;
};

await mkdir(out, { recursive: true });
const apiServer = await startApi();
const browser = await chromium.launch({ headless: true });
const report = { bytes: {}, pages: {} };
try {
  const list = pages(await seed());
  const sheets = Object.fromEntries(
    // oxlint-disable-next-line orbis/bounded-concurrency -- reads one stylesheet for each of the two builds it compares.
    await Promise.all(
      builds.map(async ({ dist, name }) => [name, await stylesheet(dist)])
    )
  );
  await runInOrder(builds, async (build) => {
    const server = await startWeb(build.dist);
    try {
      report.bytes[build.name] = await fontBytes(browser, list);
    } finally {
      await stop(server, webUrl);
    }
  });
  const server = await startWeb(builds[0].dist);
  try {
    report.pages = await pictures(browser, list, sheets);
  } finally {
    await stop(server, webUrl);
  }
} finally {
  await browser.close();
  await stop(apiServer, `${apiUrl}/health`);
}
await writeFile(
  path.join(out, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`
);

const lines = [`Pictures and report in ${out}`, "", "Differing pixels:"];
for (const [name, { differences }] of Object.entries(report.pages)) {
  const text = Object.entries(differences)
    .map(([key, { differing, size }]) => `${key} ${size ?? differing}`)
    .join(", ");
  lines.push(`${name}: ${text}`);
}
lines.push("", "Font bytes per page:");
for (const name of Object.keys(report.pages)) {
  const text = builds
    .map((build) => `${build.name} ${report.bytes[build.name][name].bytes}`)
    .join(", ");
  lines.push(`${name}: ${text}`);
}
console.log(lines.join("\n"));
const moved = Object.values(report.pages).some(({ differences }) =>
  Object.values(differences).some(({ differing }) => differing !== 0)
);
process.exitCode = moved ? 1 : 0;
