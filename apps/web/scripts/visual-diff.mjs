// Proves a styling change draws the same pages: screenshots every page of two or more builds
// at a phone and a desktop width, in light and dark, and compares each build's pixels with the
// first build's.
//
//   node apps/web/scripts/visual-diff.mjs --out <dir> before=<dist> after=<dist> [name=<dist>...]
//
// Each <dist> is a copy of `apps/web/dist` from `bun run build`. One API, seeded once, serves
// every build, and the page clock is fixed, so each build shows the same data and the same
// relative dates. Builds run one at a time on the same port, so local storage and the API's
// allowed origin stay the same.
//
// Dark: the app has no switch for it. The picture adds the `dark` class to <html>, which turns
// on the Tailwind theme, and the class of every StyleX theme (`createTheme`) in the page's
// stylesheets, which turns on the StyleX one.
//
// It writes <dir>/<page>/<size>-<scheme>/<build>.png, a <build>-diff.png wherever a build's
// pixels differ from the first's, and <dir>/report.json. It exits 1 when any picture differs.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import {
  freePort,
  keyRecord,
  runInOrder,
  waitFor,
  waitUntil,
} from "../e2e/helpers.mjs";

const web = path.resolve(import.meta.dirname, "..");
const root = path.resolve(web, "../..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex === -1 ? undefined : args[outIndex + 1];
const onlyIndex = args.indexOf("--only");
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1].split(",");
const builds = args
  .filter(
    (_, index) =>
      ![outIndex, outIndex + 1, onlyIndex, onlyIndex + 1].includes(index)
  )
  .map((arg) => {
    const split = arg.indexOf("=");
    return {
      dist: path.resolve(arg.slice(split + 1)),
      name: arg.slice(0, split),
    };
  });
if (!out || builds.length === 0 || builds.some(({ name }) => !name)) {
  throw new Error(
    "Usage: visual-diff.mjs --out <dir> [--only page,...] name=<dist> ..."
  );
}

const apiPort = await freePort();
const webPort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const keys = {
  bob: randomBytes(24).toString("base64url"),
  host: randomBytes(24).toString("base64url"),
};
const now = new Date("2026-11-12T12:00:00Z");

const sizes = [
  { height: 844, name: "phone", width: 390 },
  { height: 900, name: "desktop", width: 1280 },
];
const schemes = ["light", "dark"];

const titles = [
  "Peggy Gou – Boiler Room Seoul",
  "Kölsch – Live at Café Mambo, Ibiza",
  "Âme b2b Dixon – Innervisions at Printworks London, a long title that wraps",
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

// A failed run must not leave a server holding the ports. Each server runs in its own process
// group, because `bun x vite` starts vite as a child.
const children = new Set();
process.on("exit", () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group has already exited.
    }
  }
});
// Node runs `exit` handlers on Ctrl-C only when the signal ends the process through `exit`.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => process.exit(130));
}
const start = (command, options) => {
  const child = spawn("bun", command, {
    ...options,
    detached: true,
    stdio: "ignore",
  });
  children.add(child);
  child.once("exit", () => {
    children.delete(child);
  });
  return child;
};
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

const newData = async () => {
  const data = await mkdtemp(path.join(tmpdir(), "orbis-visual-diff-"));
  await writeFile(
    path.join(data, "devices.json"),
    JSON.stringify({
      keys: Object.entries(keys).map(([personId, key]) =>
        keyRecord(`${personId}-key`, "Visual diff", personId, key)
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
  return data;
};

const startApi = async (data) => {
  const child = start(["apps/web/e2e/api-server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ORBIS_DATA_DIR: data,
      ORBIS_FIXTURE_ORIGIN: webUrl,
      ORBIS_FIXTURE_PORT: String(apiPort),
    },
  });
  await waitFor(`${apiUrl}/health`, {
    exit: once(child, "exit").then(() => new Error("api server exited")),
    hasExited: () => child.exitCode !== null,
    listening: Promise.resolve(),
    name: "api server",
    port: apiPort,
  });
  return child;
};

// A dist's server bundle imports packages, so it needs this app's node_modules above it, and ES
// module syntax.
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
  await waitFor(webUrl, {
    exit: once(child, "exit").then(() => new Error("vite preview exited")),
    hasExited: () => child.exitCode !== null,
    listening: Promise.resolve(),
    name: "vite preview",
    port: webPort,
  });
  return child;
};

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
  // Every build copies the data, so the download must finish first.
  await waitUntil(async () => {
    const library = await api("/sets", keys.host);
    return library.sets.some(
      (set) => set.id === sets[0].id && set.downloadState === "ready"
    );
  }, "the seeded download did not finish");
  const playlist = await api("/playlists", keys.host, {
    body: JSON.stringify({ name: "Sunday morning" }),
    method: "POST",
  });
  await api(`/playlists/${playlist.id}/sets`, keys.host, {
    body: JSON.stringify({ setIds: sets.map((set) => set.id) }),
    method: "PUT",
  });
  return { playlist, sets };
};

const openMenu = async (page, title) => {
  await page.getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menu").waitFor();
};

// Each page is a URL, who opens it, a text its data draws, and what to do before the picture.
const pages = ({ playlist, sets }) => [
  { h1: true, name: "sign-in", path: "/sign-in", who: null },
  { h1: true, name: "join", path: "/join", who: null },
  { name: "not-found", path: "/no-such-page", text: "Page not found" },
  { h1: true, name: "pair-signed-out", path: "/pair#ABCDEFGH", who: null },
  { h1: true, name: "pair-unknown", path: "/pair#ABCDEFGH", who: "host" },
  { name: "library", path: "/", text: titles[2], who: "host" },
  {
    act: async (page) => {
      await openMenu(page, titles[0]);
    },
    name: "library-menu",
    path: "/",
    text: titles[0],
    who: "host",
  },
  {
    act: async (page) => {
      await openMenu(page, titles[1]);
      await page.getByRole("menuitem", { name: "Add to Playlist…" }).click();
      await page.getByRole("dialog").waitFor();
    },
    name: "library-dialog",
    path: "/",
    text: titles[1],
    who: "host",
  },
  {
    act: async (page) => {
      await openMenu(page, titles[1]);
      await page.getByRole("menuitem", { name: "Remove…" }).click();
      await page.getByRole("alertdialog").waitFor();
    },
    name: "library-alert",
    path: "/",
    text: titles[1],
    who: "host",
  },
  { h1: true, name: "library-empty", path: "/", who: "bob" },
  { h1: true, name: "set", path: `/sets/${sets[0].id}`, who: "host" },
  { h1: true, name: "set-waiting", path: `/sets/${sets[2].id}`, who: "host" },
  { h1: true, name: "playlists", path: "/playlists", who: "host" },
  {
    name: "playlist",
    path: `/playlists/${playlist.id}`,
    text: titles[2],
    who: "host",
  },
  { h1: true, name: "people", path: "/people", who: "host" },
  { name: "person", path: "/people/host", text: titles[2], who: "bob" },
  { h1: true, name: "devices", path: "/devices", who: "host" },
  {
    act: async (page) => {
      await page.getByLabel("Key label").fill("Laptop");
      await page.getByLabel("Key label").press("Enter");
      await page.locator("code").waitFor();
    },
    name: "admin",
    path: "/admin",
    who: "host",
  },
  { h1: true, name: "queue", path: "/queue", who: "host" },
  // Last: playing writes the Listen History, with the real time, that later pages show.
  {
    act: async (page) => {
      await openMenu(page, titles[0]);
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
];

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

// Adds `dark` and every StyleX theme class to <html>. StyleX writes a theme as a rule that sets
// only custom properties, on the selector `.x.x, .x.x:root` for theme class `x`.
const darken = (page) =>
  page.evaluate(() => {
    const themes = new Set();
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) {
          visit(rule.cssRules);
        }
        const match =
          /^\.(?<theme>[\w-]+)\.\k<theme>, \.\k<theme>\.\k<theme>:root$/u.exec(
            rule.selectorText ?? ""
          );
        if (match && [...rule.style].every((name) => name.startsWith("--"))) {
          themes.add(match.groups.theme);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      visit(sheet.cssRules);
    }
    document.documentElement.classList.add("dark", ...themes);
    return [...themes];
  });

const picture = async (browser, entry, size, scheme, fullPage) => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { height: size.height, width: size.width },
  });
  if (entry.who) {
    await context.addInitScript((key) => {
      localStorage.setItem("orbis.apiKey", key);
    }, keys[entry.who]);
  }
  const page = await context.newPage();
  await page.clock.setFixedTime(now);
  try {
    await page.goto(`${webUrl}${entry.path}`);
    if (entry.h1) {
      await page.locator("h1").first().waitFor();
    }
    if (entry.text) {
      await page.getByText(entry.text).first().waitFor();
    }
    const themes = scheme === "dark" ? await darken(page) : [];
    await entry.act?.(page);
    await settle(page);
    // The caret blinks.
    await page.evaluate(() => document.activeElement?.blur?.());
    await settle(page);
    return {
      png: await page.screenshot({ animations: "disabled", fullPage }),
      themes,
    };
  } finally {
    await context.close();
  }
};

// Compares two screenshots in the browser, and draws the differing pixels red over a faded
// copy of the first.
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
      const width = Math.max(left.width, right.width);
      const height = Math.max(left.height, right.height);
      const diff = new ImageData(width, height);
      let differing = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const inside = (image) => x < image.width && y < image.height;
          const at = (image) => (y * image.width + x) * 4;
          const same =
            inside(left) &&
            inside(right) &&
            [0, 1, 2, 3].every(
              (channel) =>
                left.data[at(left) + channel] ===
                right.data[at(right) + channel]
            );
          differing += same ? 0 : 1;
          const faded = inside(left)
            ? 255 - (255 - left.data[at(left)]) / 4
            : 255;
          diff.data.set(
            same ? [faded, faded, faded, 255] : [255, 0, 0, 255],
            (y * width + x) * 4
          );
        }
      }
      const result = {
        differing,
        size:
          left.width === right.width && left.height === right.height
            ? undefined
            : `${left.width}x${left.height} vs ${right.width}x${right.height}`,
      };
      if (differing === 0) {
        return result;
      }
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d").putImageData(diff, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return {
        ...result,
        png: new Uint8Array(await blob.arrayBuffer()).toBase64(),
      };
    },
    [first.toString("base64"), second.toString("base64")]
  );

// Seeds one data directory, then gives each build its own copy, so a step that changes data,
// such as creating a key, finds the same data in every build.
const browser = await chromium.launch();
const seeded = await newData();
const copies = [];
try {
  const seedServer = await startApi(seeded);
  let seededData;
  try {
    seededData = await seed();
  } finally {
    await stop(seedServer, `${apiUrl}/health`);
  }
  const list = pages(seededData).filter(
    (entry) => !only || only.includes(entry.name)
  );
  const shots = new Map();
  await runInOrder(builds, async (build) => {
    const data = await mkdtemp(path.join(tmpdir(), "orbis-visual-diff-"));
    copies.push(data);
    await cp(seeded, data, { recursive: true });
    const apiServer = await startApi(data);
    const server = await startWeb(build.dist);
    try {
      await runInOrder(list, async (entry) => {
        await runInOrder(sizes, async (size) => {
          await runInOrder(schemes, async (scheme) => {
            const key = `${entry.name}/${size.name}-${scheme}`;
            const shot = await picture(
              browser,
              entry,
              size,
              scheme,
              !entry.act
            );
            const directory = path.join(out, key);
            await mkdir(directory, { recursive: true });
            await writeFile(
              path.join(directory, `${build.name}.png`),
              shot.png
            );
            shots.set(`${key}/${build.name}`, shot);
            console.log(`${build.name} ${key}`);
          });
        });
      });
    } finally {
      await stop(server, webUrl);
      await stop(apiServer, `${apiUrl}/health`);
    }
  });
  const page = await browser.newPage();
  const report = {};
  await runInOrder(list, async (entry) => {
    await runInOrder(sizes, async (size) => {
      await runInOrder(schemes, async (scheme) => {
        const key = `${entry.name}/${size.name}-${scheme}`;
        const first = shots.get(`${key}/${builds[0].name}`);
        report[key] = {};
        await runInOrder(builds.slice(1), async (build) => {
          const shot = shots.get(`${key}/${build.name}`);
          // Chromium encodes equal pixels to equal bytes, so only a changed picture needs the browser.
          const { png, ...result } = first.png.equals(shot.png)
            ? { differing: 0 }
            : await compare(page, first.png, shot.png);
          report[key][build.name] = { ...result, themes: shot.themes };
          if (png) {
            await writeFile(
              path.join(out, key, `${build.name}-diff.png`),
              Buffer.from(png, "base64")
            );
          }
        });
      });
    });
  });
  await writeFile(
    path.join(out, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  const differing = Object.entries(report).filter(([, results]) =>
    Object.values(results).some((result) => result.differing !== 0)
  );
  for (const [key, results] of differing) {
    console.log(`differs: ${key} ${JSON.stringify(results)}`);
  }
  console.log(
    `${Object.keys(report).length - differing.length} of ${Object.keys(report).length} pictures match`
  );
  process.exitCode = differing.length === 0 ? 0 : 1;
} finally {
  await browser.close();
  await runInOrder([seeded, ...copies], async (data) => {
    await rm(data, { force: true, recursive: true });
  });
}
