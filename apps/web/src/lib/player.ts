import type { PresenceAction } from "@orbis/contracts";

import { callOrbis } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";

/** Playback Position bounds the API accepts, in seconds (one week). */
const MAX_POSITION = 604_800;

export const playSet = async (credentials: Credentials, setId: string) =>
  await callOrbis(credentials, (client) =>
    client.queue.play({ payload: { setId } })
  );

export const playPlaylist = async (
  credentials: Credentials,
  playlistId: string
) =>
  await callOrbis(credentials, (client) =>
    client.queue.replaceWithPlaylist({ payload: { playlistId } })
  );

export const queueSet = async (
  credentials: Credentials,
  setId: string,
  placement: "next" | "end"
) =>
  await callOrbis(credentials, (client) =>
    client.queue.insert({ payload: { placement, setId } })
  );

export const completeSet = async (credentials: Credentials, setId: string) =>
  await callOrbis(credentials, (client) =>
    client.queue.complete({ payload: { setId } })
  );

export const sendPresence = async (
  credentials: Credentials,
  action: PresenceAction
) =>
  await callOrbis(credentials, (client) => {
    // The generated client types each payload member as its own request object,
    // so the action dispatches on its kind before the call.
    switch (action.kind) {
      case "play": {
        return client.presence.act({ payload: action });
      }
      case "pause": {
        return client.presence.act({ payload: action });
      }
      case "stop": {
        return client.presence.act({ payload: action });
      }
      case "renew": {
        return client.presence.act({ payload: action });
      }
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  });

export const reportPosition = async (
  credentials: Credentials,
  setId: string,
  seconds: number
) =>
  await callOrbis(credentials, (client) =>
    client.library.setPosition({
      params: { id: setId },
      payload: { seconds: Math.max(0, Math.min(MAX_POSITION, seconds)) },
    })
  );

/**
 * A stream grant's audio URL on the API. An `<audio>` element cannot send the key,
 * so the API signs one Set's audio route for a day (ADR 0007); the page accepts
 * only a grant for exactly that route.
 */
export const streamUrl = async (
  credentials: Credentials,
  setId: string
): Promise<ApiResult<string>> => {
  const grant = await callOrbis(credentials, (client) =>
    client.sets.audioGrant({ params: { id: setId } })
  );
  if (!grant.ok) {
    return grant;
  }
  const granted = new URL(grant.value.url, "http://grant.invalid");
  if (
    granted.origin !== "http://grant.invalid" ||
    granted.pathname !== `/sets/${encodeURIComponent(setId)}/audio`
  ) {
    return { failure: "failed", ok: false, status: undefined };
  }
  return {
    ok: true,
    value: `${credentials.apiUrl}${granted.pathname}${granted.search}`,
  };
};
