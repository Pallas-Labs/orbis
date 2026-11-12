// A real browser, API, and SQLite database verify Apple Music Sets on web (ADR 0021): the
// search with its All Albums switch, a search save, a pasted save, the Library row, and the
// Set page with its Tracklist and Open in Apple Music. Apple answers with recorded responses.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SOURCE_URL_MESSAGE } from "@orbis/contracts";
import { chromium } from "playwright";

import {
  freePort,
  keyRecord,
  signInWithKey,
  startApi,
  startPreview,
  submitForm,
  textOf,
  waitFor,
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-apple-music");
const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "orbis-apple-music-web-")
);
const ports = { device: await freePort(), web: await freePort() };
const apiUrl = `http://127.0.0.1:${ports.device}`;
const webUrl = `http://127.0.0.1:${ports.web}`;
const key = randomBytes(24).toString("base64url");
const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });

// A song link from the British storefront: it names the album, read from the US catalog.
// This album's own read is recorded in full, so its Cues carry their artists.
const PASTED_LINK =
  "https://music.apple.com/gb/album/dj-kicks-dj-mix/1046502556?i=1046502558";
const PASTED_TITLE = "DJ-Kicks (DJ Mix)";
const ARTWORK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#c2410c"/></svg>';
// Recorded as missing from the US catalog.
const NOT_IN_US_LINK = "https://music.apple.com/us/album/missing/1016775152";

await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("apple-music-web-key", "Apple Music web", "host", key)],
    people: [
      { autoDownload: true, id: "host", removed: false, username: "host" },
    ],
    version: 2,
  })
);

const api = startApi({
  dataDirectory,
  origin: webUrl,
  port: ports.device,
});
const web = startPreview({ apiUrl, port: ports.web });

const shot = async (page, name) => {
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.naturalWidth > 0)
  );
  await page.screenshot({ fullPage: true, path: path.join(artifacts, name) });
};

try {
  await Promise.all([waitFor(`${apiUrl}/health`, api), waitFor(webUrl, web)]);
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Recorded Artwork points at Apple's image servers; a local square stands in, so the
    // journey runs offline and every screenshot shows loaded Artwork.
    await page.route("https://*.mzstatic.com/**", (route) =>
      route.fulfill({ body: ARTWORK, contentType: "image/svg+xml" })
    );
    await signInWithKey(page, webUrl, key);
    await page.getByRole("heading", { name: "Library" }).waitFor();

    const search = page.getByRole("search");
    await search.getByLabel("Find on Apple Music").fill("Seth Troxler");
    const searched = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/apple-music/search"
    );
    await search.getByRole("button", { name: "Find" }).click();
    const searchAnswer = await searched;
    const found = await searchAnswer.json();
    const mixes = found.albums.filter((album) => album.djMix);
    assert.ok(mixes.length > 0, "the recorded search finds DJ mixes");
    assert.ok(
      mixes.length < found.albums.length,
      "the recorded search also finds other albums"
    );
    const results = page.getByRole("list", { name: "Apple Music albums" });
    await results.waitFor();
    assert.equal(await results.getByRole("listitem").count(), mixes.length);
    await shot(page, "search-dj-mixes.png");
    step("a search shows only DJ mixes by default", {
      albums: found.albums.length,
      djMixes: mixes.length,
    });

    await page.getByRole("switch", { name: "All Albums" }).click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('ul[aria-label="Apple Music albums"] > li')
          .length === count,
      found.albums.length
    );
    await shot(page, "search-all-albums.png");
    step("All Albums shows every album", { albums: found.albums.length });
    await page.getByRole("switch", { name: "All Albums" }).click();

    const [chosen] = mixes;
    const searchSave = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/sets" &&
        response.request().method() === "POST"
    );
    await results
      .getByRole("button", { exact: true, name: `Add ${chosen.title}` })
      .click();
    const searchSaved = await searchSave;
    assert.equal(searchSaved.status(), 201);
    assert.deepEqual(searchSaved.request().postDataJSON(), { url: chosen.url });
    const saved = await searchSaved.json();
    assert.equal(saved.source, "apple-music");
    assert.equal(saved.downloadState, "none");
    const chosenRow = results
      .getByRole("listitem")
      .filter({ hasText: chosen.title });
    await chosenRow.getByText("In Library").waitFor();
    step("adding a search result saves its Source Link", {
      title: saved.title,
      url: saved.url,
    });

    const sets = page.getByRole("list", { name: "Sets" });
    const row = sets.getByRole("listitem").filter({ hasText: chosen.title });
    await row.waitFor();
    const details = await textOf(row.locator("p").first());
    assert.match(details, / · Apple Music · (?:\d+h )?\d+m$/u);
    assert.equal(
      await row.locator("img").getAttribute("src"),
      saved.artworkUrl
    );
    await row
      .getByRole("button", { name: `Actions for ${saved.title}` })
      .click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const actions = await menu.getByRole("menuitem").allTextContents();
    assert.ok(!actions.includes("Play"), `row offers ${actions.join(", ")}`);
    assert.ok(
      !actions.includes("Download"),
      `row offers ${actions.join(", ")}`
    );
    await shot(page, "library-row-actions.png");
    await page.keyboard.press("Escape");
    step("the Library row shows Apple Music, Artwork, and length", {
      actions,
      details,
    });

    const saveForm = page
      .locator("form")
      .filter({ has: page.getByLabel("Source Link") });
    const pasted = await submitForm(saveForm, "/sets", {
      "Source Link": PASTED_LINK,
    });
    assert.equal(pasted.status, 201);
    assert.equal(
      pasted.body.url,
      "https://music.apple.com/album/1046502556",
      "the storefront and song are dropped"
    );
    assert.equal(pasted.body.title, PASTED_TITLE);
    await sets.getByRole("link", { name: PASTED_TITLE }).waitFor();
    // Auto Download is on, but an Apple Music Set has no audio to keep.
    assert.equal(
      await page
        .getByText("Downloads are unavailable", { exact: false })
        .count(),
      0
    );
    await shot(page, "library-pasted.png");
    step("a pasted Apple Music song link saves its album", {
      url: pasted.body.url,
    });

    const notInUs = await submitForm(saveForm, "/sets", {
      "Source Link": NOT_IN_US_LINK,
    });
    assert.equal(notInUs.status, 400);
    await page
      .getByRole("status")
      .filter({ hasText: "This album is not in the US Apple Music catalog." })
      .waitFor();
    const playlist = await submitForm(saveForm, "/sets", {
      "Source Link": "https://music.apple.com/us/playlist/house/pl.123",
    });
    assert.equal(playlist.status, 400);
    await page
      .getByRole("status")
      .filter({ hasText: SOURCE_URL_MESSAGE })
      .waitFor();
    await shot(page, "library-refused.png");
    step("refused links show the service's reason");

    await sets.getByRole("link", { name: saved.title }).click();
    await page.waitForURL(`${webUrl}/sets/${saved.id}`);
    await page.getByRole("heading", { level: 1, name: saved.title }).waitFor();
    const open = page.getByRole("link", { name: "Open in Apple Music" });
    assert.equal(await open.getAttribute("href"), saved.url);
    assert.equal(await page.getByRole("button", { name: "Play" }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: /Download|Keep audio/u }).count(),
      0
    );
    const pageDetails = await textOf(
      page.locator("header p", { hasText: " · Apple Music · " })
    );
    assert.match(pageDetails, / · Apple Music · (?:\d+h )?\d+m$/u);
    assert.equal(
      await page.locator("header img").getAttribute("src"),
      saved.artworkLargeUrl ?? saved.artworkUrl
    );
    const tracklist = page.getByRole("list", { name: "Tracklist" });
    await tracklist.waitFor();
    const cues = await tracklist.getByRole("listitem").count();
    assert.equal(cues, chosen.songCount);
    assert.equal(await tracklist.getByRole("button").count(), 0);
    assert.match(await textOf(tracklist.locator("li").first()), /^0:00/u);
    await shot(page, "set-page.png");
    step("the Set page shows the Tracklist and Open in Apple Music only", {
      cues,
      details: pageDetails,
    });

    await page.setViewportSize({ height: 812, width: 375 });
    await shot(page, "set-page-phone.png");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      true
    );
    step("the Set page fits phone width");

    await page.setViewportSize({ height: 720, width: 1280 });
    await page.goto(`${webUrl}/sets/${pasted.body.id}`);
    const pastedCues = page.getByRole("list", { name: "Tracklist" });
    await pastedCues.waitFor();
    assert.equal(await pastedCues.getByRole("listitem").count(), 18);
    const firstCue = await textOf(pastedCues.locator("li").first());
    assert.match(firstCue, /^0:00Would It Be \(Mixed\)Niki Nakazawa$/u);
    await shot(page, "set-page-pasted.png");
    step("the pasted Set's Cues carry their artists", { firstCue });
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify({ ok: true, steps }, null, 2)
  );
  console.log(
    `apple music journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill();
  web.kill();
  await rm(dataDirectory, { force: true, recursive: true });
}
