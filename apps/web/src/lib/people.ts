import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

/** Turns the Person's Social switch on or off (ADR 0009). */
export const setSocial = async (credentials: Credentials, social: boolean) =>
  await callOrbis(credentials, (client) =>
    client.people.updateMe({ payload: { social } })
  );

/** The People the caller could see, with the caller's See and Appear for each. */
export const listPeopleFilters = async (credentials: Credentials) =>
  await callOrbis(credentials, (client) => client.people.socialFilters());

/** The People who pass the social gate now. */
export const listVisiblePeople = async (credentials: Credentials) =>
  await callOrbis(credentials, (client) => client.people.list());

export const setFilter = async (
  credentials: Credentials,
  id: string,
  filter: { readonly see: boolean } | { readonly appear: boolean }
) =>
  await callOrbis(credentials, (client) =>
    client.people.filters({ params: { id }, payload: filter })
  );

export const friendSets = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.people.sets({ params: { id } })
  );

export const friendPlaylists = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.people.friendPlaylists({ params: { id } })
  );

/** One page of a friend's Listen History; `before` is the last page's `nextCursor`. */
export const friendListens = async (
  credentials: Credentials,
  id: string,
  before?: string
) =>
  await callOrbis(credentials, (client) =>
    client.people.friendListens({
      params: { id },
      query: before === undefined ? {} : { before },
    })
  );

export type PersonFilters = Extract<
  Awaited<ReturnType<typeof listPeopleFilters>>,
  { ok: true }
>["value"]["people"][number];

export type FriendPlaylist = Extract<
  Awaited<ReturnType<typeof friendPlaylists>>,
  { ok: true }
>["value"]["playlists"][number];

export type Listen = Extract<
  Awaited<ReturnType<typeof friendListens>>,
  { ok: true }
>["value"]["listens"][number];
