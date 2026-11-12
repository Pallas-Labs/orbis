import { randomBytes } from "node:crypto";

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { DEV_AUDIO_NODE_URL, devSecrets, usesLocalState } from "./infra/dev.ts";
import { stagePlan } from "./infra/stage.ts";

// `alchemy dev` runs both Workers on this machine with no Cloudflare login; see infra/dev.ts.
const dev = usesLocalState(process.env);
const audioNodeUrl = dev
  ? Config.String("AUDIO_NODE_URL").pipe(Config.withDefault(DEV_AUDIO_NODE_URL))
  : Config.String("AUDIO_NODE_URL");

const SECRETS = [
  "APPLE_MUSIC_KEY_ID",
  "APPLE_MUSIC_PRIVATE_KEY",
  "APPLE_MUSIC_TEAM_ID",
  "IMPORT_NODE_KEY_DIGEST",
  "OPENROUTER_API_KEY",
  "STREAM_GRANT_SECRET",
  "SIGNOZ_OTLP_ACCESS_CLIENT_ID",
  "SIGNOZ_OTLP_ACCESS_CLIENT_SECRET",
  "VERSOS_API_KEY",
  "YOUTUBE_API_KEY",
] as const;

const readSecret = Effect.fn(function* readSecret(name: string) {
  const value = yield* Config.option(Config.String(name));
  return value.pipe(Option.filter((text) => text !== ""));
});

export default Alchemy.Stack(
  "OrbisWeb",
  {
    providers: Cloudflare.providers(),
    state: dev ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* deployWeb() {
    const secrets: Record<string, Redacted.Redacted> = {};
    const kept: string[] = [];
    const made = devSecrets({
      dev,
      random: () => randomBytes(32).toString("hex"),
    });
    for (const name of SECRETS) {
      const value = Option.orElse(yield* readSecret(name), () =>
        Option.fromNullishOr(made[name])
      );
      if (Option.isSome(value)) {
        secrets[name] = Redacted.make(value.value);
      } else {
        kept.push(name);
      }
    }
    // Only prod claims the hostname and the zone route; see infra/stage.ts.
    const plan = stagePlan(yield* Alchemy.Stage);
    const api = yield* Cloudflare.Worker("Api", {
      compatibility: { date: "2026-07-30", flags: ["nodejs_compat"] },
      env: {
        AUDIO_NODE_URL: audioNodeUrl,
        GROUP: Cloudflare.DurableObject("Group", { className: "Group" }),
        SIGNOZ_OTLP_URL: Config.String("SIGNOZ_OTLP_URL").pipe(
          Config.withDefault("https://otlp.parthm.me/v1/logs")
        ),
        VERSOS_URL: Config.String("VERSOS_URL").pipe(
          Config.withDefault("https://versos.studio")
        ),
        ...secrets,
      },
      main: "../api/src/index.ts",
      // The Group writes one wide event per request to the console; persisted
      // Workers Logs keep them queryable after live tail ends.
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true, persist: true },
      },
      routes: [...plan.routes],
    });
    const web = yield* Cloudflare.Website.Vite("Web", {
      ...plan.web,
      env: {
        ORBIS_API_URL: plan.apiUrl ?? Output.interpolate`${api.url}/api`,
        ORBIS_AUDIO_URL: audioNodeUrl,
      },
    });
    // An unset secret keeps the value already on Cloudflare, so a deploy needs
    // only the secrets it changes. A dev run has no Worker on Cloudflare to keep
    // a value from, and the local runtime refuses an inherit binding.
    for (const name of dev ? [] : kept) {
      yield* api.bind`${name}`({ bindings: [{ name, type: "inherit" }] });
    }
    return {
      api: api.url,
      url: web.url,
    };
  })
);
