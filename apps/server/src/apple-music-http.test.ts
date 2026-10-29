import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SOURCE_URL_MESSAGE } from "@orbis/contracts";
import { REJECTED_SOURCE_URLS } from "@orbis/contracts/source-url-cases";
import { Effect } from "effect";

import { appleMusicRecordings, musicKitPem } from "./apple-music-recordings.js";
import { hashToken } from "./identity.js";
import { Metadata } from "./metadata.js";
import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";
import { messageIn, setsInLibrary } from "./test-library.js";
import { Versos } from "./versos.js";

const evidence = path.resolve(import.meta.dir, "../../../.cache/apple-music");
const failures = [
  "a storefront or song link saves a second Set for the same album",
  "a playlist, artist, station, or bare song link is saved, or asks Apple",
  "the read asks a storefront other than us, or asks without a token signed by the Host's MusicKit key",
  "an album missing from the US catalog makes a Set",
  "a music video in the album becomes a Cue",
  "Cue start times drift from the sum of the song lengths",
  "Versos, yt-dlp, or the title reviser is asked about an Apple Music Set",
  "a Download or Auto Download is queued for DRM audio, or the audio node claims one",
  "the Listening Queue refuses a mix because it has no Retained Audio",
  "a refused or timed-out read fails the save instead of keeping a temporary title",
  "a metadata or Tracklist retry does not read the album again",
  "removing and saving the mix again loses its Tracklist",
  "a Group without the key calls Apple at all",
  "a search misses a DJ mix Apple labels, or marks a studio album, EP, or single as one",
  "a search shows DJ mixes after other albums, or reorders Apple's results within a group",
  "the same album appears twice, or the DJ Mix search adds albums that are not DJ mixes",
  "a search reads albums one at a time, or from a storefront other than us",
  "a result's Source Link is not the album link, so choosing it saves a second Set",
  "an album in the Person's Library is not marked, or a friend's Set marks it",
  "a Group without the key answers a search with anything but the not-set-up message",
  "Apple refusing a search fails with a 500 instead of asking to try again",
  "a series search does not name its series as the Top Result, or a near match does",
  "a group's count differs from the albums the search marks with it, or counts albums that are not DJ mixes",
  "a narrowed search answers albums outside the group, other albums, or not newest first",
  "a song's start is not the sum of the lengths before it, or the starts drift from the album's length",
  "a song after one Apple gives no length for has a start",
  "Various Artists is offered as a DJ",
  "the same words, or words that differ only in case or spaces, ask Apple again within 10 minutes",
  "a refused search is kept, so trying again cannot succeed",
];

const record = async <Result>(name: string, result: Result) => {
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, `${name}.json`),
    JSON.stringify({ failures, ...result }, null, 2)
  );
};

interface Recording {
  readonly body: {
    readonly data?: {
      readonly id: string;
      readonly relationships: {
        readonly tracks: {
          readonly data: {
            readonly attributes?: {
              readonly artistName?: string;
              readonly durationInMillis?: number;
              readonly name?: string;
            };
            readonly id?: string;
            readonly type: string;
          }[];
        };
      };
    }[];
    readonly results?: {
      readonly albums?: { readonly data: { readonly id: string }[] };
    };
  };
  readonly status: number;
  readonly url: string;
}

/** Apple's answers as `bun run record:apple-music` recorded them with the Host's MusicKit key. */
const recordings = await appleMusicRecordings<Recording>();

const ALBUM_URL = "https://music.apple.com/album/1046502556";
const ALBUM_READ =
  "https://api.music.apple.com/v1/catalog/us/albums/1046502556?include=tracks";
const NOT_IN_US_READ =
  "https://api.music.apple.com/v1/catalog/us/albums/1016775152?include=tracks";
const ARTWORK =
  "https://is1-ssl.mzstatic.com/image/thumb/Music6/v4/cf/da/f3/cfdaf3eb-1944-e868-1feb-cedeef541eb6/0730003732423_1448.jpg/{w}x{h}bb.jpg";

/** Start times are the song lengths before each song, summed unrounded, then rounded. */
const EXPECTED_CUES = (
  [
    ["1046502558", 0, "Would It Be (Mixed)", "Niki Nakazawa"],
    [
      "1046502562",
      181,
      "Suddenly (Phil Parnell's Pianissimo Play Through) [Mixed]",
      "Matthew Herbert",
    ],
    ["1046502567", 375, "Bodenweich (Mixed)", "DJ Koze"],
    ["1046502568", 610, "Northern Lights (Mixed)", "Cobblestone Jazz"],
    [
      "1046502569",
      1042,
      "Melodia Del Viento (Ricardo Villalobos & Max Loderbauer Meloopdia Remix) [Mixed]",
      "Wolfgang Haffner",
    ],
    [
      "1046502844",
      1283,
      "De Natte Cel (DJ-Kicks) [Mixed]",
      "Seth Troxler, Tom Trago & T&T Music Factory",
    ],
    ["1046502893", 1631, "XK (Mixed)", "Hauke Freer"],
    ["1046502897", 1913, "Dope (Mixed)", "Butch"],
    ["1046502898", 2262, "Stick Together (Mixed)", "Session Victim"],
    [
      "1046502899",
      2517,
      'Sweet Chariot (Kerri "Kaoz 6:23" Chandler Dramatic Dub) [Mixed]',
      "Club Artists United",
    ],
    [
      "1046502900",
      2771,
      "Reach (Basement Sessions Main Vocal Mix) [Mixed]",
      "Jasper St Company",
    ],
    ["1046502902", 3128, "Sex-N-R-001 (Vocal Mixx) [Mixed]", "K-Alexi"],
    ["1046502903", 3267, "Ohh (Mixed) [feat. John Ciafone]", "Mood II Swing"],
    ["1046502904", 3554, "Dreaming Again (Mixed)", "Derrick L. Carter"],
    [
      "1046502965",
      3888,
      "Why Can't You Be Real (Danny's 12\" Version) [Mixed]",
      "Byron Stingily",
    ],
    ["1046502966", 4110, "Stay With Me (Kevin O Remix)", "Vanessa McMillian"],
    [
      "1046502967",
      4395,
      "The Credit Card (Original Tribe Mix) [feat. Sweet P***y Pauline]",
      "Dean Street Crew",
    ],
    [
      "1046502968",
      4642,
      "Enlightenment (Mixed)",
      "Sun Ra & Sun Ra and His Arkestra",
    ],
  ] as const
).map(([appleMusicId, startSeconds, title, artist], position) => ({
  appleMusicId,
  artist,
  artworkUrl: ARTWORK.replace("{w}x{h}", "300x300"),
  position,
  startSeconds,
  title,
}));

/**
 * What each recorded search marks as a DJ mix, as "title / creator", in the order shown.
 * Checked by hand against the recordings on 2026-10-25; the rest of each search is other albums.
 */
const EXPECTED_DJ_MIXES = [
  [
    "Seth Troxler",
    [
      "Seth Troxler at Circoloco Thailand (DJ Mix) / Seth Troxler",
      "Seth Troxler at Circoloco Rio De Janeiro (DJ Mix) / Seth Troxler",
      "Mochakk b2b DJ Tennis b2b Seth Troxler at Circoloco Rio De Janeiro (DJ Mix) / Seth Troxler, Mochakk & DJ Tennis",
      "Beats In Space 099: Seth Troxler (DJ Mix) / Seth Troxler",
      "Seth Troxler at III Points Music Festival 2024 (DJ Mix) / Seth Troxler",
      "Seth Troxler at Kappa FuturFestival 2024 (DJ Mix) / Seth Troxler",
      "DJ-Kicks (DJ Mix) / Seth Troxler",
      "Seth Troxler & Derrick Carter at ARC Music Festival, 2021 (DJ Mix) / Seth Troxler & Derrick Carter",
      "Carl Craig b2b Seth Troxler at ARC Festival, 2022 (DJ Mix) / Carl Craig & Seth Troxler",
      "Shambhala 2023: Seth Troxler b2b Skream at the AMP Stage (DJ Mix) / Skream & Seth Troxler",
      "Seth Troxler at Time Warp DE, 2023 (DJ Mix) / Seth Troxler",
      "Seth Troxler b2b Skream at Kappa FuturFestival 2024 (DJ Mix) / Skream & Seth Troxler",
      "Seth Troxler at CRSSD Festival 2021: The Palms (DJ Mix) / Seth Troxler",
      "Boiler Room: Seth Troxler in Warsaw, Oct 10, 2017 (DJ Mix) / Seth Troxler",
      "Seth Troxler at Kappa FuturFestival 2023 (DJ Mix) / Seth Troxler",
      "Seth Troxler at Movement Detroit 2023 (DJ Mix) / Seth Troxler",
    ],
  ],
  [
    "DJ-Kicks",
    [
      "DJ - Kicks: Djrum (DJ Mix) / Djrum",
      "DJ-Kicks (Kruder & Dorfmeister) [DJ Mix] / Kruder & Dorfmeister",
      "DJ-Kicks (DJ Mix) / DJ Koze",
      "DJ-Kicks (DJ Mix) / Moodymann",
      "DJ-Kicks (Mount Kimbie) [DJ Mix] / Mount Kimbie",
      "DJ-Kicks (Matthew Dear) [DJ Mix] / Matthew Dear",
      "DJ-Kicks (DJ Mix) / Mr. Scruff",
      "DJ-Kicks (DJ Mix) / Actress",
      "DJ-Kicks: Jayda G (DJ Mix) / Jayda G",
      "DJ-Kicks (Laurel Halo) [DJ Mix] / Laurel Halo",
      "DJ-Kicks (Deetron) [Mixed Tracks] / Deetron",
      "DJ-Kicks (DJ Mix) / Gold Panda",
      "DJ-Kicks (Maya Jane Coles) [DJ Mix] / Maya Jane Coles",
      "DJ-Kicks (DJ Mix) / Motor City Drum Ensemble",
      "DJ-Kicks (DJ Mix) / Peggy Gou",
      "DJ-Kicks / Kemistry & Storm",
      "DJ-Kicks (DJ Mix) / Scuba",
      "DJ-Kicks (DJ Mix) / Special Request",
      "DJ - Kicks: Sofia Kourtesis (DJ Mix) / Sofia Kourtesis",
      "DJ-Kicks (DJ Mix) / Robert Hood",
      "DJ-Kicks (DJ Mix) / Daniel Avery",
      "DJ-Kicks (Avalon Emerson) [DJ Mix] / Avalon Emerson",
      "DJ-Kicks (DJ Mix) / DJ Seinfeld",
      "DJ-Kicks (DJ Mix) / Michael Mayer",
      "DJ-Kicks (DJ Mix) / Nina Kraviz",
      "DJ-Kicks (DJ Mix) / Seth Troxler",
      "DJ-Kicks (DJ Mix) / Leon Vynehall",
      "DJ-Kicks (DJ Mix) / Forest Swords",
      "DJ-Kicks (DJ Mix) / James Holden",
      "DJ-Kicks (DJ Mix) / Wolf + Lamb & Soul Clap",
      "DJ-Kicks (DJ Mix) / DJ Tennis",
      "DJ-Kicks: Theo Parrish (DJ Mix) / Theo Parrish",
      "Boiler Room: Nightmares On Wax in London, Aug 28, 2013 (DJ Mix) / Nightmares On Wax",
    ],
  ],
  [
    "Defected",
    [
      "Defected: John Summit, We Dance As One, 2020 (DJ Mix) / John Summit",
      "Defected: Dom Dolla, We Dance As One, NYE 2021 (DJ Mix) / Dom Dolla",
      "Defected: Dennis Ferrer, We Dance As One, 2020 (DJ Mix) / Dennis Ferrer",
      "Defected Malta: Groove Armada, Oct 7, 2023 (DJ Mix) / Groove Armada",
      "Defected: Louie Vega, We Dance As One, Glitterbox Love Stream, 2020 (DJ Mix) / Louie Vega",
      "Defected: Eats Everything, We Dance As One, NYE 2021 (DJ Mix) / Eats Everything",
      "Defected: Vintage Culture, We Dance As One, 2020 (DJ Mix) / Vintage Culture",
      "Defected: Jellybean Benitez at Glitterbox Virtual Festival, 2020 (DJ Mix) / Jellybean",
      "Defected: Purple Disco Machine at Glitterbox Virtual Festival, 2020 (DJ Mix) / Purple Disco Machine",
      "Defected: Roger Sanchez at Glitterbox Hï Ibiza, 2019 (DJ Mix) / Roger Sanchez",
      "Defected: CamelPhat, We Dance As One, 2020 (DJ Mix) / CamelPhat",
      "Defected: Purple Disco Machine, We Dance As One, 2020 (DJ Mix) / Purple Disco Machine",
      "Defected: Roger Sanchez, We Dance As One, NYE 2021 (DJ Mix) / Roger Sanchez",
      "Defected Presents TSHA In The House (DJ Mix) / TSHA",
      "Defected Malta: Horse Meat Disco, 2025 (DJ Mix) / Horse Meat Disco",
      "Defected: Gorgon City in Ibiza, May 26, 2019 (DJ Mix) / Gorgon City",
      "Defected: Armand Van Helden in London, Dec 31, 2023 (DJ Mix) / Armand Van Helden",
      "Gorgon City: Defected Pacha Ibiza, May 22, 2025 (DJ Mix) / Gorgon City",
      "Defected presents Frankie Knuckles In The House (DJ Mix) / Frankie Knuckles",
      "Defected: Dave Lee, We Dance As One, Glitterbox Love Stream, 2020 (DJ Mix) / Dave Lee",
      "Defected Worldwide (DJ Mix) / Gorgon City",
      "Defected: DJ Paulette, We Dance As One, Glitterbox Love Stream, 2020 (DJ Mix) / DJ Paulette",
      "Kevin Saunderson b2b Dantiez at Movement Detroit 2023: KMS Records & Defected (DJ Mix) / Dantiez & Kevin Saunderson",
      "Defected: Natasha Diggs, We Dance As One, 2020 (DJ Mix) / Natasha Diggs",
      "Defected: Disciples, We Dance As One, 2020 (DJ Mix) / Disciples",
      "Boys Noize at Defected Virtual Festival, 2020 (DJ Mix) / Boys Noize",
      "Defected: Sam Divine, We Dance As One, 2020 (DJ Mix) / Sam Divine",
      "Defected: Natasha Diggs at Glitterbox Virtual Festival, 2020 (DJ Mix) / Natasha Diggs",
      "Defected: Sef Kombo b2b Louie Dunmore, We Dance As One, 2020 (DJ Mix) / Sef Kombo & Louie Dunmore",
      "DJ Minx: Defected Broadcasting House (DJ Mix) / DJ Minx",
    ],
  ],
  [
    "Radiohead",
    [
      "Boiler Room: Thom Yorke in London, Oct 11, 2011 (DJ Mix) / Thom Yorke",
      "Tomorrowland Around The World 2020: Lost Frequencies (DJ Mix) / Lost Frequencies",
      "Tomorrowland Around The World 2020: Alan Walker (DJ Mix) / Alan Walker",
      "LXM Festival: Paul Kalkbrenner in Lisbon, Dec 14, 2019 (DJ Mix) / Paul Kalkbrenner",
    ],
  ],
  [
    "Carl Cox",
    [
      "Boiler Room: Carl Cox in Ibiza, Aug 15, 2013 (DJ Mix) / Carl Cox",
      "Carl Cox at Club Space, Miami, Nov 15, 2024 (DJ Mix) / Carl Cox",
      "Cercle: Carl Cox at Château de Chambord, France (DJ Mix) / Carl Cox",
      "Carl Cox at [UNVRS]: All Night Long, Jul 27, 2025 [DJ Mix] [DJ Mix] / Carl Cox",
      "Carl Cox b2b Green Velvet at ARC Music Festival, 2024 (DJ Mix) / Carl Cox & Green Velvet",
      "NYE 2021 (DJ Mix) / Carl Cox",
      "Carl Cox b2b Nicole Moudaber at Kappa FuturFestival 2023 (DJ Mix) / Nicole Moudaber & Carl Cox",
      "Carl Cox Mixes Awesome Soundwave (Mixed) / Carl Cox",
      "Pure Intec 2 (Mixed by Carl Cox & Jon Rundell) / Carl Cox & Jon Rundell",
      "Pure Intec 4 (Mixed by Carl Cox & Jon Rundell) / Carl Cox & Jon Rundell",
      "Carl Cox: DJsounds Show, Aug 5, 2013 (DJ Mix) / Carl Cox",
      "Tomorrowland 2018: Carl Cox (DJ Mix) / Carl Cox",
      "Asw Is Live Mixed by Carl Cox (DJ Mix) / Carl Cox",
      "Carl Cox at Kappa FuturFestival 2024 (DJ Mix) / Carl Cox",
      "Carl Cox at the Roundhouse, London, Sep 8, 2024 (DJ Mix) / Carl Cox",
      "Global Underground #38: Carl Cox - Black Rock Desert (DJ Mix) / Carl Cox",
    ],
  ],
  [
    "Essential Mix",
    [
      "Amapiano Essentials (DJ Mix) / DJ Phil",
      "Rxxistance Vol. 3: Essential, Mixed by Stoned Baby (Continuous Mix) / Various Artists",
      "Stellar Fountain's Essential Mix Volume I. (DJ Mix) / MiraculuM & Stellar Fountain",
      "Anjunabeats Volume 16 (DJ Mix) / Above & Beyond",
      "Today's Hits 2020 (DJ Mix) / Zedd",
      "Uncle Snoop’s “A Black Music Story” (DJ Mix) / Snoop Dogg",
      "Boiler Room: DJ Jazzy Jeff in London, Apr 18, 2014 (DJ Mix) / DJ Jazzy Jeff",
      "A State of Trance Year Mix 2018 (DJ Mix) / Armin van Buuren",
      "Boiler Room: Nightmares On Wax in London, Aug 28, 2013 (DJ Mix) / Nightmares On Wax",
      "Kitchen Raving, Vol. 1 (DJ Mix) / Fatboy Slim",
      "Big Beach Boutique (DJ Mix) / Fatboy Slim",
      "ASOT 1296 - A State of Trance Episode 1296 (Unfiltered 008) [DJ Mix] / Armin van Buuren",
      "Tomorrowland 2022: SOFI TUKKER at Crystal Garden, Weekend 1 (DJ Mix) / SOFI TUKKER",
      "DGTL: Hot Since 82 at DGTL Amsterdam, 2018 (DJ Mix) / Hot Since 82",
      "What Came Before: U.K. Garage (DJ Mix) / Chase & Status",
    ],
  ],
] as const;

/**
 * Real DJ mixes that Apple names like any album, so the rule cannot see them. All Albums shows
 * them (ADR 0021).
 */
const UNLABELLED_MIXES = [
  ["Seth Troxler", "Seth Troxler - The Lab 03 / Various Artists"],
  [
    "Seth Troxler",
    "Mixmag Presents Jamie Jones vs. Seth Troxler / Jamie Jones & Seth Troxler",
  ],
  ["DJ-Kicks", "DJ-Kicks / Photek"],
] as const;

const fromBase64Url = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.codePointAt(0) ?? 0
  );

/** A MusicKit-shaped key made for this run, and a check that a token was signed with it. */
const musicKitKey = async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateKey = musicKitPem(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey)
  );
  const verify = async (token: string) => {
    const [header = "", payload = "", signature = ""] = token.split(".");
    const valid = await crypto.subtle.verify(
      { hash: "SHA-256", name: "ECDSA" },
      pair.publicKey,
      fromBase64Url(signature),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    return {
      claims: JSON.parse(new TextDecoder().decode(fromBase64Url(payload))),
      header: JSON.parse(new TextDecoder().decode(fromBase64Url(header))),
      valid,
    };
  };
  return { privateKey, verify };
};

/** A music video placed second in the recorded album, as Apple lists one among the songs. */
const withMusicVideo = (recording: Recording) => {
  const body = structuredClone(recording.body);
  body.data?.[0]?.relationships.tracks.data.splice(1, 0, {
    attributes: {
      artistName: "Seth Troxler",
      durationInMillis: 200_000,
      name: "DJ-Kicks (Video)",
    },
    id: "1046509999",
    type: "music-videos",
  });
  return body;
};

type AppleAnswer =
  | "recorded"
  | "music-video"
  | "refuse"
  | "hang"
  | "rate-limit";

const start = async (options: { configured?: boolean } = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-apple-music-"));
  const key = await musicKitKey();
  const asked: string[] = [];
  const reads: { readonly token: string | undefined; readonly url: string }[] =
    [];
  let answer: AppleAnswer = "recorded";
  let downloadJobs = 0;
  const devicesPath = path.join(directory, "devices.json");
  const friendToken = "apple-music-friend-token";
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: [
        {
          addedAt: "2026-01-01T00:00:00.000Z",
          id: "friend",
          label: "friend",
          lastUsedAt: null,
          personId: "friend",
          scope: "daily",
          tokenHash: hashToken(friendToken),
        },
      ],
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "friend", removed: false, username: "friend" },
      ],
      version: 2,
    })
  );
  const app = createApp({
    audio: {
      audioDir: path.join(directory, "audio"),
      cobaltApiKey: "test",
      cobaltUrl: "http://cobalt.test/",
      fetch: () => {
        downloadJobs += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      },
      startWorker: true,
    },
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
    logging: { silent: true },
    metadata: Metadata.layer({
      appleMusic:
        options.configured === false
          ? undefined
          : {
              keyId: "TESTKEY123",
              privateKey: key.privateKey,
              teamId: "TEAM123",
            },
      fetch: (url, signal, headers) => {
        reads.push({ token: headers?.authorization, url });
        if (answer === "refuse") {
          return Promise.resolve(new Response("{}", { status: 401 }));
        }
        if (answer === "rate-limit") {
          return Promise.resolve(new Response("{}", { status: 429 }));
        }
        if (answer === "hang") {
          const silence = Promise.withResolvers<Response>();
          signal.addEventListener("abort", () => silence.reject(signal.reason));
          return silence.promise;
        }
        const recording = recordings.get(url);
        if (!recording) {
          return Promise.reject(
            new Error(`No recorded Apple Music answer for ${url}`)
          );
        }
        return Promise.resolve(
          Response.json(
            answer === "music-video"
              ? withMusicVideo(recording)
              : recording.body,
            { status: recording.status }
          )
        );
      },
      ytDlp: {
        read: () => {
          asked.push("yt-dlp");
          return Effect.die("yt-dlp is not asked about Apple Music Sets");
        },
      },
    }),
    versos: Versos.layerOf({
      poll: () => {
        asked.push("versos poll");
        return Effect.die("Versos is not asked about Apple Music Sets");
      },
      request: () => {
        asked.push("versos request");
        return Effect.die("Versos is not asked about Apple Music Sets");
      },
    }),
  });
  return {
    answer: (next: AppleAnswer) => {
      answer = next;
    },
    app,
    asked,
    dispose: async () => {
      await app.dispose();
      await rm(directory, { force: true, recursive: true });
    },
    downloadJobs: () => downloadJobs,
    friend: { authorization: `Bearer ${friendToken}` },
    reads,
    verify: key.verify,
  };
};

test("an Apple Music album link saves once, read from the US catalog with the Host's key, with its songs as the Tracklist", async () => {
  const server = await start();
  try {
    const autoDownload = await request(server.app, {
      method: "PATCH",
      payload: { autoDownload: true },
      url: "/me",
    });
    expect(autoDownload.statusCode).toBe(200);

    const refusedLinks = REJECTED_SOURCE_URLS.filter((url) =>
      url.startsWith("https://music.apple.com/")
    );
    expect(refusedLinks.some((url) => url.includes("/playlist/"))).toBe(true);
    expect(refusedLinks.some((url) => url.includes("/artist/"))).toBe(true);
    expect(refusedLinks.some((url) => url.includes("/station/"))).toBe(true);
    expect(refusedLinks.some((url) => url.includes("/song/"))).toBe(true);
    for (const url of refusedLinks) {
      // oxlint-disable-next-line no-await-in-loop -- Each refusal is one save, in order.
      const refused = await request(server.app, {
        method: "POST",
        payload: { url },
        url: "/sets",
      });
      expect(refused.statusCode).toBe(400);
      expect(messageIn(refused)).toBe(SOURCE_URL_MESSAGE);
    }
    expect(server.reads).toEqual([]);

    const saved = await request(server.app, {
      method: "POST",
      payload: {
        url: "https://music.apple.com/gb/album/dj-kicks-dj-mix/1046502556?i=1046502562",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    const set = saved.json();
    expect(set).toMatchObject({
      artworkLargeUrl: ARTWORK.replace("{w}x{h}", "1200x1200"),
      artworkUrl: ARTWORK.replace("{w}x{h}", "300x300"),
      autoDownloadResult: "unavailable",
      creator: "Seth Troxler",
      downloadState: "none",
      durationSeconds: 4778,
      metadataState: "enriched",
      releasedAt: "2015-10-16",
      source: "apple-music",
      title: "DJ-Kicks (DJ Mix)",
      titleEditedByUser: false,
      tracklistState: "ready",
      url: ALBUM_URL,
    });
    const id = String(set.id);

    expect(server.reads.map((read) => read.url)).toEqual([ALBUM_READ]);
    const [read] = server.reads;
    const token = await server.verify(
      read?.token?.replace("Bearer ", "") ?? ""
    );
    expect(token.valid).toBe(true);
    expect(token.header).toEqual({ alg: "ES256", kid: "TESTKEY123" });
    expect(token.claims.iss).toBe("TEAM123");
    expect(token.claims.exp - token.claims.iat).toBe(3600);

    const tracklist = await request(server.app, {
      method: "GET",
      url: `/sets/${id}/tracklist`,
    });
    expect(tracklist.json()).toEqual({ cues: EXPECTED_CUES, state: "ready" });

    const again = await request(server.app, {
      method: "POST",
      payload: { url: "https://music.apple.com/us/album/1046502556" },
      url: "/sets",
    });
    expect(again.statusCode).toBe(409);

    const friend = await request(server.app, {
      headers: server.friend,
      method: "POST",
      payload: { url: "https://music.apple.com/album/dj-kicks/1046502556" },
      url: "/sets",
    });
    expect(friend.statusCode).toBe(201);
    expect(friend.json()).toMatchObject({ id, tracklistState: "ready" });
    expect(server.reads).toHaveLength(1);

    const download = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/audio/download`,
    });
    expect(download.statusCode).toBe(400);
    expect(messageIn(download)).toBe(
      "Apple Music audio plays through Apple Music and is never downloaded."
    );

    const queued = await request(server.app, {
      method: "PUT",
      payload: { setId: id },
      url: "/queue/active",
    });
    expect(queued.statusCode).toBe(200);
    expect(queued.json().queue.activeSetId).toBe(id);

    const filtered = await request(server.app, {
      method: "GET",
      url: "/sets?source=apple-music",
    });
    expect(
      filtered.json().sets.map((entry: { id: string }) => entry.id)
    ).toEqual([id]);

    const finished = await request(server.app, {
      method: "POST",
      payload: { setId: id },
      url: "/queue/completion",
    });
    expect(finished.json().queue.entries).toEqual([]);
    const removed = await request(server.app, {
      method: "DELETE",
      url: `/sets/${id}`,
    });
    expect(removed.statusCode).toBe(200);
    const friendRemoved = await request(server.app, {
      headers: server.friend,
      method: "DELETE",
      url: `/sets/${id}`,
    });
    expect(friendRemoved.statusCode).toBe(200);
    const resaved = await request(server.app, {
      method: "POST",
      payload: { url: ALBUM_URL },
      url: "/sets",
    });
    expect(resaved.statusCode).toBe(201);
    expect(resaved.json()).toMatchObject({ id, tracklistState: "ready" });
    // The last saver's removal let the Cues go, so the save read the album again.
    expect(server.reads).toHaveLength(2);
    const restored = await request(server.app, {
      method: "GET",
      url: `/sets/${id}/tracklist`,
    });
    expect(restored.json()).toEqual({ cues: EXPECTED_CUES, state: "ready" });

    const audio = await request(server.app, {
      method: "GET",
      url: `/sets/${id}/audio/state`,
    });
    expect(audio.json().state).toBe("none");
    expect(server.downloadJobs()).toBe(0);
    expect(server.asked).toEqual([]);
    await record("save-read-and-play-rules", {
      appleReads: server.reads.map((entry) => entry.url),
      download: download.json(),
      downloadJobs: server.downloadJobs(),
      refusedLinks,
      saved: set,
      tokenClaims: token.claims,
      tracklist: tracklist.json(),
    });
  } finally {
    await server.dispose();
  }
});

test("an album missing from the US catalog is refused and makes no Set", async () => {
  const server = await start();
  try {
    const link =
      "https://music.apple.com/jp/album/exit-trance-01-mixed-by-dj-uto/1016775152";
    const refused = await request(server.app, {
      method: "POST",
      payload: { url: link },
      url: "/sets",
    });
    expect(refused.statusCode).toBe(400);
    expect(messageIn(refused)).toBe(
      "This album is not in the US Apple Music catalog."
    );
    const library = await setsInLibrary(server.app);
    expect(library).toEqual([]);
    const friendLibrary = await request(server.app, {
      headers: server.friend,
      method: "GET",
      url: "/sets",
    });
    expect(friendLibrary.json().sets).toEqual([]);

    // No Set holds the refusal, so a later save asks Apple again.
    const again = await request(server.app, {
      headers: server.friend,
      method: "POST",
      payload: { url: link },
      url: "/sets",
    });
    expect(again.statusCode).toBe(400);
    expect(server.reads.map((read) => read.url)).toEqual([
      NOT_IN_US_READ,
      NOT_IN_US_READ,
    ]);
    await record("not-in-us-catalog", {
      appleAnswer: recordings.get(NOT_IN_US_READ),
      library,
      refused: refused.json(),
    });
  } finally {
    await server.dispose();
  }
});

test("a music video in the album is not a Cue and adds nothing to the length", async () => {
  const server = await start();
  try {
    server.answer("music-video");
    const saved = await request(server.app, {
      method: "POST",
      payload: { url: ALBUM_URL },
      url: "/sets",
    });
    expect(saved.json()).toMatchObject({
      durationSeconds: 4778,
      tracklistState: "ready",
    });
    const tracklist = await request(server.app, {
      method: "GET",
      url: `/sets/${String(saved.json().id)}/tracklist`,
    });
    expect(tracklist.json()).toEqual({ cues: EXPECTED_CUES, state: "ready" });
  } finally {
    await server.dispose();
  }
});

test("a refused or silent Apple Music read keeps the save, and both retries read the album again", async () => {
  const server = await start();
  try {
    server.answer("refuse");
    const refused = await request(server.app, {
      method: "POST",
      payload: { url: ALBUM_URL },
      url: "/sets",
    });
    expect(refused.statusCode).toBe(201);
    expect(refused.json()).toMatchObject({
      metadataState: "failed",
      title: "Apple Music mix",
      tracklistState: "pending",
    });
    const id = String(refused.json().id);

    server.answer("hang");
    const silent = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/metadata`,
    });
    expect(silent.statusCode).toBe(200);
    expect(silent.json()).toMatchObject({
      metadataState: "failed",
      title: "Apple Music mix",
    });

    server.answer("recorded");
    const retried = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(retried.json()).toEqual({ cues: EXPECTED_CUES, state: "ready" });
    const [afterRetry] = await setsInLibrary(server.app);
    expect(afterRetry).toMatchObject({
      metadataState: "enriched",
      title: "DJ-Kicks (DJ Mix)",
    });

    const metadataRetry = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/metadata`,
    });
    expect(metadataRetry.json()).toMatchObject({
      metadataState: "enriched",
      title: "DJ-Kicks (DJ Mix)",
      tracklistState: "ready",
    });
    expect(server.reads.map((read) => read.url)).toEqual([
      ALBUM_READ,
      ALBUM_READ,
      ALBUM_READ,
      ALBUM_READ,
    ]);
    expect(server.asked).toEqual([]);
    await record("failed-read-and-retry", {
      afterRetry,
      refused: refused.json(),
    });
  } finally {
    await server.dispose();
  }
});

test("a Group without the MusicKit key saves the Set with failed metadata and never calls Apple", async () => {
  const server = await start({ configured: false });
  try {
    const saved = await request(server.app, {
      method: "POST",
      payload: { url: ALBUM_URL },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      metadataState: "failed",
      source: "apple-music",
      title: "Apple Music mix",
    });
    expect(server.reads).toEqual([]);
    expect(server.asked).toEqual([]);

    const search = await request(server.app, {
      method: "GET",
      url: "/apple-music/search?q=Seth%20Troxler",
    });
    expect(search.statusCode).toBe(503);
    expect(messageIn(search)).toBe(
      "Apple Music search is not set up on this server."
    );
    expect(server.reads).toEqual([]);
    await record("search-not-configured", {
      response: { body: search.json(), status: search.statusCode },
    });
  } finally {
    await server.dispose();
  }
});

interface FoundAlbum {
  readonly creator: string | null;
  readonly djMix: boolean;
  readonly durationSeconds: number | null;
  readonly id: string;
  readonly inLibrary: boolean;
  readonly recordLabel: string | null;
  readonly releasedAt: string | null;
  readonly series: string | null;
  readonly songCount: number;
  readonly songs: {
    readonly artist: string;
    readonly startSeconds: number | null;
    readonly title: string;
  }[];
  readonly title: string;
  readonly url: string;
}

interface FoundGroup {
  readonly albumCount: number;
  readonly artworkUrl: string | null;
  readonly name: string;
}

interface Answer {
  readonly albums: FoundAlbum[];
  readonly groups: {
    readonly djs: FoundGroup[];
    readonly labels: FoundGroup[];
    readonly series: FoundGroup[];
  };
  readonly top: { readonly kind: string; readonly name: string } | null;
}

const answer = async (
  server: Awaited<ReturnType<typeof start>>,
  query: Record<string, string>,
  headers?: Record<string, string>
): Promise<Answer> => {
  const url = `/apple-music/search?${new URLSearchParams(query)}`;
  const response = await request(
    server.app,
    headers ? { headers, method: "GET", url } : { method: "GET", url }
  );
  expect(response.statusCode).toBe(200);
  return response.json();
};

const search = async (
  server: Awaited<ReturnType<typeof start>>,
  words: string,
  headers?: Record<string, string>
) => {
  const { albums } = await answer(server, { q: words }, headers);
  return albums;
};

const named = (album: FoundAlbum) => `${album.title} / ${album.creator}`;

test("each recorded search shows Apple's labelled DJ mixes first, in Apple's order, from two US searches and one album read", async () => {
  const server = await start();
  try {
    for (const [words, mixes] of EXPECTED_DJ_MIXES) {
      const before = server.reads.length;
      // oxlint-disable-next-line no-await-in-loop -- Each search is checked against its own reads.
      const albums = await search(server, words);
      const reads = server.reads.slice(before).map((read) => new URL(read.url));
      expect(reads.map((url) => url.pathname)).toEqual([
        "/v1/catalog/us/search",
        "/v1/catalog/us/search",
        "/v1/catalog/us/albums",
      ]);
      expect(reads.map((url) => url.searchParams.get("term"))).toEqual([
        words,
        `${words} DJ Mix`,
        null,
      ]);
      expect(albums.filter((album) => album.djMix).map(named)).toEqual([
        ...mixes,
      ]);
      const firstOther = albums.findIndex((album) => !album.djMix);
      expect(albums.slice(firstOther).every((album) => !album.djMix)).toBe(
        true
      );
      const urls = albums.map((album) => album.url);
      expect(new Set(urls).size).toBe(urls.length);
      for (const url of urls) {
        expect(url).toMatch(/^https:\/\/music\.apple\.com\/album\/\d+$/u);
      }
      // The DJ Mix search adds only mixes: none of its strangers' singles reach All Albums.
      const typed = new Set(
        recordings
          .get(server.reads[before]?.url ?? "")
          ?.body.results?.albums?.data.map(({ id }) => id)
      );
      for (const album of albums) {
        expect(
          album.djMix || typed.has(album.url.split("/").at(-1) ?? "")
        ).toBe(true);
      }
      // oxlint-disable-next-line no-await-in-loop -- One evidence file per search.
      await record(`search-${words.toLowerCase().replaceAll(/\W+/gu, "-")}`, {
        albums: albums.map((album) => ({
          djMix: album.djMix,
          name: named(album),
          url: album.url,
        })),
        reads: reads.map(String),
      });
    }
    for (const [words, mix] of UNLABELLED_MIXES) {
      // oxlint-disable-next-line no-await-in-loop -- Each known miss is read from its search.
      const albums = await search(server, words);
      expect(albums.find((album) => named(album) === mix)?.djMix).toBe(false);
    }
  } finally {
    await server.dispose();
  }
});

test("a search marks the albums in the Person's Library, and choosing a result saves the same Set a shared link names", async () => {
  const server = await start();
  try {
    const before = await search(server, "Seth Troxler");
    expect(before.some((album) => album.inLibrary)).toBe(false);
    const chosen = before.find(
      (album) => named(album) === "DJ-Kicks (DJ Mix) / Seth Troxler"
    );
    expect(chosen?.url).toBe(ALBUM_URL);

    const saved = await request(server.app, {
      method: "POST",
      payload: { url: chosen?.url },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      metadataState: "enriched",
      title: "DJ-Kicks (DJ Mix)",
      url: ALBUM_URL,
    });
    const shared = await request(server.app, {
      method: "POST",
      payload: {
        url: "https://music.apple.com/us/album/dj-kicks-dj-mix/1046502556",
      },
      url: "/sets",
    });
    expect(shared.statusCode).toBe(409);

    const after = await search(server, "Seth Troxler");
    expect(
      after.filter((album) => album.inLibrary).map((album) => album.url)
    ).toEqual([ALBUM_URL]);
    const friendSees = await search(server, "Seth Troxler", server.friend);
    expect(friendSees.some((album) => album.inLibrary)).toBe(false);
    await record("search-in-library", {
      friend: friendSees.filter((album) => album.inLibrary).map(named),
      host: after.filter((album) => album.inLibrary).map(named),
    });
  } finally {
    await server.dispose();
  }
});

test("a blank search is refused before Apple is asked, and a refused search asks to try again", async () => {
  const server = await start();
  try {
    const blank = await request(server.app, {
      method: "GET",
      url: "/apple-music/search?q=%20%20",
    });
    expect(blank.statusCode).toBe(400);
    expect(messageIn(blank)).toBe("Type what to find on Apple Music.");
    expect(server.reads).toEqual([]);

    server.answer("rate-limit");
    const limited = await request(server.app, {
      method: "GET",
      url: "/apple-music/search?q=Carl%20Cox",
    });
    expect(limited.statusCode).toBe(503);
    expect(messageIn(limited)).toBe(
      "Apple Music is not answering. Try the search again."
    );
  } finally {
    await server.dispose();
  }
});

test("a series search names its series as the Top Result, and each group counts the DJ mixes the search marks with it", async () => {
  const server = await start();
  try {
    const kicks = await answer(server, { q: "DJ-Kicks" });
    expect(kicks.top).toEqual({ kind: "series", name: "DJ-Kicks" });
    const marked = kicks.albums.filter((album) => album.series === "DJ-Kicks");
    expect(
      kicks.groups.series.find((group) => group.name === "DJ-Kicks")?.albumCount
    ).toBe(marked.length);
    // "DJ - Kicks: Djrum" is in the series; the studio "DJ - Kicks: Disclosure - EP" is no mix.
    expect(marked.map(named)).toContain("DJ - Kicks: Djrum (DJ Mix) / Djrum");
    expect(
      kicks.albums.find(
        (album) => album.title === "DJ - Kicks: Disclosure - EP"
      )?.series
    ).toBeNull();

    const tops = new Map<string, Answer["top"]>();
    const groups = new Map<string, Answer["groups"]>();
    for (const [words] of EXPECTED_DJ_MIXES) {
      // oxlint-disable-next-line no-await-in-loop -- Each search is checked on its own answer.
      const found = await answer(server, { q: words });
      const mixes = found.albums.filter((album) => album.djMix);
      expect(found.albums.every((album) => album.djMix || !album.series)).toBe(
        true
      );
      const kinds = [
        [found.groups.djs, (album: FoundAlbum) => album.creator],
        [found.groups.labels, (album: FoundAlbum) => album.recordLabel],
        [found.groups.series, (album: FoundAlbum) => album.series],
      ] as const;
      for (const [list, nameOf] of kinds) {
        for (const group of list) {
          expect(
            mixes.filter((album) => nameOf(album) === group.name).length
          ).toBe(group.albumCount);
        }
      }
      expect(
        found.groups.djs.map((group) => group.name.toLowerCase())
      ).not.toContain("various artists");
      tops.set(words, found.top);
      groups.set(words, found.groups);
    }
    // The check above is not empty: Essential Mix finds a Various Artists DJ mix.
    const essential = await search(server, "Essential Mix");
    expect(
      essential.some(
        (album) => album.djMix && album.creator === "Various Artists"
      )
    ).toBe(true);
    expect(tops.get("Seth Troxler")).toEqual({
      kind: "dj",
      name: "Seth Troxler",
    });
    expect(tops.get("Radiohead")).toBeNull();
    await record("search-groups", {
      groups: Object.fromEntries(groups),
      tops: Object.fromEntries(tops),
    });
  } finally {
    await server.dispose();
  }
});

test("a search narrowed to a series, DJ, or label answers only that group's DJ mixes, newest first", async () => {
  const server = await start();
  try {
    const whole = await answer(server, { q: "DJ-Kicks" });
    const narrowed = await answer(server, {
      q: "DJ-Kicks",
      series: "DJ-Kicks",
    });
    const series = whole.groups.series.find(
      (group) => group.name === "DJ-Kicks"
    );
    expect(narrowed.albums.length).toBe(series?.albumCount ?? -1);
    expect(
      narrowed.albums.every(
        (album) => album.djMix && album.series === "DJ-Kicks"
      )
    ).toBe(true);
    const released = narrowed.albums.map((album) => album.releasedAt ?? "");
    const newestFirst = [...released];
    newestFirst.sort((a, b) => b.localeCompare(a));
    expect(released).toEqual(newestFirst);
    expect(narrowed.groups).toEqual(whole.groups);
    const blank = await answer(server, { q: "DJ-Kicks", series: " " });
    expect(blank.albums).toEqual(whole.albums);
    expect(narrowed.top).toEqual(whole.top);

    const byLabel = await answer(server, {
      label: "!k7 records",
      q: "DJ-Kicks",
    });
    expect(byLabel.albums.length).toBe(
      whole.groups.labels.find((group) => group.name === "!K7 Records")
        ?.albumCount ?? -1
    );
    const byDj = await answer(server, {
      creator: "Seth Troxler",
      q: "Seth Troxler",
    });
    expect(byDj.albums.length).toBeGreaterThan(0);
    expect(
      byDj.albums.every(
        (album) => album.djMix && album.creator === "Seth Troxler"
      )
    ).toBe(true);
    await record("search-narrowed", {
      byDj: byDj.albums.map(named),
      byLabel: byLabel.albums.map(named),
      series: narrowed.albums.map(
        (album) => `${album.releasedAt} ${named(album)}`
      ),
    });
  } finally {
    await server.dispose();
  }
});

test("each found song starts at the sum of the song lengths before it, and the last song ends at the album's length", async () => {
  const server = await start();
  try {
    const lengths = new Map(
      [...recordings.values()].flatMap((recording) =>
        (recording.body.data ?? []).map(
          (album) =>
            [
              album.id,
              album.relationships.tracks.data
                .filter((track) => track.type === "songs")
                .map((track) =>
                  track.attributes?.durationInMillis === undefined
                    ? null
                    : track.attributes.durationInMillis / 1000
                ),
            ] as const
        )
      )
    );
    let checked = 0;
    let unknown = 0;
    for (const [words] of EXPECTED_DJ_MIXES) {
      // oxlint-disable-next-line no-await-in-loop -- Each search is checked on its own answer.
      for (const album of await search(server, words)) {
        const songLengths = lengths.get(album.id) ?? [];
        expect(album.songs.length).toBe(album.songCount);
        expect(album.songs.length).toBe(songLengths.length);
        let before: number | null = 0;
        for (const [index, song] of album.songs.entries()) {
          expect(song.startSeconds).toBe(
            before === null ? null : Math.round(before)
          );
          const length = songLengths[index] ?? null;
          before = before === null || length === null ? null : before + length;
        }
        if (before === null) {
          unknown += 1;
          expect(album.durationSeconds).toBeNull();
        } else {
          const last = album.songs.at(-1)?.startSeconds ?? 0;
          const lastLength = songLengths.at(-1) ?? 0;
          expect(
            Math.abs(last + lastLength - (album.durationSeconds ?? 0))
          ).toBeLessThan(1);
          expect(Math.round(before)).toBe(album.durationSeconds ?? -1);
        }
        checked += 1;
      }
    }
    // Essential Mix finds albums Apple gives a song no length for.
    expect(unknown).toBeGreaterThan(0);
    const troxlers = await search(server, "Seth Troxler");
    const troxler = troxlers.find((album) => album.url === ALBUM_URL);
    expect(
      troxler?.songs.map(({ artist, startSeconds, title }) => ({
        artist,
        startSeconds,
        title,
      }))
    ).toEqual(
      EXPECTED_CUES.map(({ artist, startSeconds, title }) => ({
        artist,
        startSeconds,
        title,
      }))
    );
    await record("search-song-starts", {
      albums: checked,
      withoutLength: unknown,
    });
  } finally {
    await server.dispose();
  }
});

test("the same words within 10 minutes, or words that differ only in case or spaces, ask Apple once", async () => {
  const server = await start();
  try {
    await search(server, "DJ-Kicks");
    const asked = server.reads.length;
    expect(asked).toBe(3);
    await search(server, "DJ-Kicks");
    await search(server, "  dj-kicks ");
    await search(server, "DJ-KICKS");
    await answer(server, { q: "dj-Kicks", series: "DJ-Kicks" });
    expect(server.reads.length).toBe(asked);
    await search(server, "Carl Cox");
    expect(server.reads.length).toBe(asked + 3);

    // A refused search is not kept: once Apple answers again, the same words find albums.
    server.answer("rate-limit");
    const limited = await request(server.app, {
      method: "GET",
      url: "/apple-music/search?q=Defected",
    });
    expect(limited.statusCode).toBe(503);
    server.answer("recorded");
    const defected = await search(server, "Defected");
    expect(defected.length).toBeGreaterThan(0);
    await record("search-kept", {
      reads: server.reads.map((read) => read.url),
    });
  } finally {
    await server.dispose();
  }
});
