import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

/** The Library filters, as the URL carries them. */
export interface LibraryFilters {
  readonly q?: string;
  readonly source?: SavedSet["source"];
  readonly tag?: string;
}

/** The query `GET /sets` accepts. */
interface SetsQuery {
  q?: string;
  source?: string;
  tag?: string[];
}

export const listSets = async (
  credentials: Credentials,
  filters: LibraryFilters
) => {
  const query: SetsQuery = {};
  if (filters.q !== undefined) {
    query.q = filters.q;
  }
  if (filters.source !== undefined) {
    query.source = filters.source;
  }
  if (filters.tag !== undefined) {
    query.tag = [filters.tag];
  }
  return await callOrbis(credentials, (client) => client.sets.list({ query }));
};

/** Albums in the US Apple Music catalog for these words, DJ mixes first (ADR 0021). */
export const searchAppleMusic = async (credentials: Credentials, q: string) =>
  await callOrbis(credentials, (client) =>
    client.appleMusic.search({ query: { q } })
  );

export type AppleMusicAlbum = Extract<
  Awaited<ReturnType<typeof searchAppleMusic>>,
  { ok: true }
>["value"]["albums"][number];

export const listTags = async (credentials: Credentials) =>
  await callOrbis(credentials, (client) => client.library.tags());

export const saveSet = async (credentials: Credentials, url: string) =>
  await callOrbis(credentials, (client) =>
    client.sets.save({ payload: { url } })
  );

export const renameSet = async (
  credentials: Credentials,
  id: string,
  title: string
) =>
  await callOrbis(credentials, (client) =>
    client.sets.updateTitle({ params: { id }, payload: { title } })
  );

export const updateTags = async (
  credentials: Credentials,
  id: string,
  tags: readonly string[]
) =>
  await callOrbis(credentials, (client) =>
    client.library.updateTags({ params: { id }, payload: { tags: [...tags] } })
  );

export const removeSet = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.sets.remove({ params: { id } })
  );

export const requestDownload = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.sets.requestDownload({ params: { id } })
  );

export const cancelDownload = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.sets.cancelDownload({ params: { id } })
  );

export const audioState = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.sets.audioState({ params: { id } })
  );

export type SavedSet = Extract<
  Awaited<ReturnType<typeof listSets>>,
  { ok: true }
>["value"]["sets"][number];

export type AutoDownloadResult = Extract<
  Awaited<ReturnType<typeof saveSet>>,
  { ok: true }
>["value"]["autoDownloadResult"];

export const setAutoDownload = async (
  credentials: Credentials,
  autoDownload: boolean
) =>
  await callOrbis(credentials, (client) =>
    client.people.updateMe({ payload: { autoDownload } })
  );
