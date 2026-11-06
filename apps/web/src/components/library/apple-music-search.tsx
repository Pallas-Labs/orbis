import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { duration } from "@/components/library/set-row";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { detach } from "@/lib/detach";
import { formText } from "@/lib/form";
import { saveSet, searchAppleMusic } from "@/lib/library";
import type { AppleMusicAlbum } from "@/lib/library";
import { FAILURE_MESSAGES, problemFor } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";

/** "Seth Troxler · 2015 · 18 songs · 1h 19m", with only the parts Apple gave. */
const albumDetails = (album: AppleMusicAlbum): string =>
  [
    album.creator,
    album.releasedAt?.slice(0, 4) ?? null,
    album.songCount === 1 ? "1 song" : `${album.songCount} songs`,
    duration(album.durationSeconds),
  ]
    .filter((part) => part !== null)
    .join(" · ");

// The search answers 503 with its own sentence when the server has no MusicKit key.
const searchProblem = (
  result: Extract<ApiResult<unknown>, { ok: false }>
): string =>
  result.status === 503
    ? (result.message ?? FAILURE_MESSAGES.failed)
    : problemFor(result);

const AlbumRow = ({
  album,
  onSave,
  saving,
}: {
  readonly album: AppleMusicAlbum;
  readonly onSave: () => void;
  readonly saving: boolean;
}) => (
  <li className="flex items-center gap-3 py-2">
    {album.artworkUrl === null ? (
      <div className="bg-muted size-12 shrink-0 rounded-md" />
    ) : (
      <img
        alt=""
        className="size-12 shrink-0 rounded-md object-cover"
        src={album.artworkUrl}
      />
    )}
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-medium">{album.title}</span>
      <span className="text-muted-foreground truncate text-sm">
        {albumDetails(album)}
      </span>
    </div>
    {album.inLibrary ? (
      <span className="text-muted-foreground shrink-0 text-sm">In Library</span>
    ) : (
      <Button
        aria-label={`Add ${album.title}`}
        disabled={saving}
        onClick={onSave}
        size="sm"
        variant="outline"
      >
        Add
      </Button>
    )}
  </li>
);

/** Add Set's Find on Apple Music: search the US catalog and save a result as a Set. */
export const AppleMusicSearch = ({
  credentials,
}: {
  readonly credentials: Credentials;
}) => {
  const router = useRouter();
  const [albums, setAlbums] = useState<readonly AppleMusicAlbum[] | null>(null);
  const [allAlbums, setAllAlbums] = useState(false);
  const [pending, setPending] = useState(false);
  // Each album being saved, so one save finishing leaves another's button disabled.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  const search = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const words = formText(new FormData(event.currentTarget), "q");
    if (words.trim() === "") {
      setProblem("Type what to find on Apple Music.");
      setAlbums(null);
      return;
    }
    setPending(true);
    const result = await searchAppleMusic(credentials, words);
    setPending(false);
    if (result.ok) {
      setProblem(null);
      setAlbums(result.value.albums);
    } else {
      setProblem(searchProblem(result));
      setAlbums(null);
    }
  };

  const save = async (album: AppleMusicAlbum) => {
    setSaving((current) => new Set(current).add(album.url));
    const result = await saveSet(credentials, album.url);
    setSaving((current) => {
      const next = new Set(current);
      next.delete(album.url);
      return next;
    });
    // A Set already in the Library is saved all the same.
    if (result.ok || result.failure === "conflict") {
      setProblem(null);
      setAlbums(
        (current) =>
          current?.map((found) =>
            found.url === album.url ? { ...found, inLibrary: true } : found
          ) ?? null
      );
      if (result.ok) {
        await router.invalidate();
      }
      return;
    }
    setProblem(problemFor(result));
  };

  const shown =
    albums === null || allAlbums
      ? albums
      : albums.filter((album) => album.djMix);
  let empty: string | null = null;
  if (albums?.length === 0) {
    empty = "Apple Music has no albums for these words.";
  } else if (albums !== null && shown?.length === 0) {
    empty = `No DJ mixes. Turn on All Albums to see the other ${albums.length}.`;
  }

  return (
    <section
      aria-labelledby="apple-music-heading"
      className="flex flex-col gap-2"
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={detach(search)}
        role="search"
      >
        <Label htmlFor="apple-music-search" id="apple-music-heading">
          Find on Apple Music
        </Label>
        <div className="flex gap-2">
          <Input
            autoComplete="off"
            id="apple-music-search"
            maxLength={200}
            name="q"
            placeholder="DJ, mix series, or label"
            type="search"
          />
          <Button disabled={pending} type="submit" variant="outline">
            Find
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          Searches Apple Music in the US. DJ mixes come first. Add one to save
          it as a Set.
        </p>
      </form>
      {pending ? (
        <p className="text-muted-foreground text-sm" role="status">
          Searching Apple Music…
        </p>
      ) : null}
      <Problem message={problem} />
      {albums === null || albums.length === 0 ? null : (
        <div className="flex items-center gap-3">
          <Switch
            aria-label="All Albums"
            checked={allAlbums}
            onCheckedChange={setAllAlbums}
          />
          <span aria-hidden>All Albums</span>
        </div>
      )}
      {empty === null ? null : (
        <p className="text-muted-foreground text-sm">{empty}</p>
      )}
      {shown === null || shown.length === 0 ? null : (
        <ul aria-label="Apple Music albums" className="divide-y">
          {shown.map((album) => (
            <AlbumRow
              album={album}
              key={album.url}
              onSave={() => {
                void save(album);
              }}
              saving={saving.has(album.url)}
            />
          ))}
        </ul>
      )}
    </section>
  );
};
