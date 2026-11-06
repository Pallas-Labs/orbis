import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

export const getTracklist = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.sets.tracklist({ params: { id } })
  );

export const retryTracklist = async (credentials: Credentials, id: string) =>
  await callOrbis(credentials, (client) =>
    client.sets.retryTracklist({ params: { id } })
  );
