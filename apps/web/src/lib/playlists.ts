import { callOrbis } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";

/** The caller's own Playlists. */
export const listPlaylists = async (credentials: Credentials) =>
  await callOrbis(credentials, (client) => client.playlists.list());

/** Collaborative Playlists another Person made the caller an editor of. */
export const listSharedPlaylists = async (credentials: Credentials) =>
  await callOrbis(credentials, (client) => client.playlists.shared());

/** One Playlist, its members in order, and whether the caller created it. */
export const readPlaylist = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.playlists.read({ params: { id } })
  );

export const createPlaylist = async (credentials: Credentials, name: string) =>
  await callOrbis(credentials, (client) =>
    client.playlists.create({ payload: { name } })
  );

export const renamePlaylist = async (
  credentials: Credentials,
  id: string,
  name: string
) =>
  await callOrbis(credentials, (client) =>
    client.playlists.rename({ params: { id }, payload: { name } })
  );

export const deletePlaylist = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.playlists.remove({ params: { id } })
  );

/** Replaces the members, in order; adding, removing, and reordering all use it. */
export const replaceMembers = async (
  credentials: Credentials,
  id: string,
  setIds: readonly string[]
) =>
  await callOrbis(credentials, (client) =>
    client.playlists.replaceMembers({
      params: { id },
      payload: { setIds: [...setIds] },
    })
  );

/** Puts one Set in exactly these of the caller's own Playlists. */
export const replaceSetPlaylists = async (
  credentials: Credentials,
  setId: string,
  playlistIds: readonly string[]
) =>
  await callOrbis(credentials, (client) =>
    client.playlists.replaceSetPlaylists({
      params: { id: setId },
      payload: { playlistIds: [...playlistIds] },
    })
  );

export const readCollaboration = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.playlists.collaboration({ params: { id } })
  );

export const setCollaborative = async (
  credentials: Credentials,
  id: string,
  collaborative: boolean
) =>
  await callOrbis(credentials, (client) =>
    client.playlists.setCollaboration({
      params: { id },
      payload: { collaborative },
    })
  );

export const setEditors = async (
  credentials: Credentials,
  id: string,
  editorIds: readonly string[]
) =>
  await callOrbis(credentials, (client) =>
    client.playlists.setEditors({
      params: { id },
      payload: { editorIds: [...editorIds] },
    })
  );

/** The People the caller can see, who are the only possible editors. */
export const listPeople = async (credentials: Credentials) =>
  await callOrbis(credentials, (client) => client.people.list());

type Value<T> = Awaited<T> extends ApiResult<infer A> ? A : never;

export type Playlist = Value<
  ReturnType<typeof listPlaylists>
>["playlists"][number];
export type SharedPlaylist = Value<
  ReturnType<typeof listSharedPlaylists>
>["playlists"][number];
export type PlaylistDetail = Value<ReturnType<typeof readPlaylist>>;
export type Collaboration = Value<ReturnType<typeof readCollaboration>>;
export type VisiblePerson = Value<
  ReturnType<typeof listPeople>
>["people"][number];
