import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

export const getTracklist = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) => client.sets.tracklist({ params: { id } }));

export const retryTracklist = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.sets.retryTracklist({ params: { id } })
  );

export const pasteTracklist = (
  credentials: Credentials,
  id: string,
  text: string
) =>
  callOrbis(credentials, (client) =>
    client.sets.pasteTracklist({ params: { id }, payload: { text } })
  );
