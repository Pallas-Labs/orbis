import * as stylex from "@stylexjs/stylex";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  DownloadBadge,
  canDownload,
  setDetails,
} from "@/components/library/set-row";
import { useDownloadProgress } from "@/components/library/use-download-progress";
import { useLiveEvents } from "@/components/live-events";
import { usePlayer } from "@/components/player/player";
import { Problem } from "@/components/problem";
import { RouteProblem } from "@/components/route-problem";
import { Button, buttonLook } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { flags } from "@/flags.gen";
import { detach } from "@/lib/detach";
import { listSets, requestDownload, saveSet } from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";
import {
  friendListens,
  friendPlaylists,
  friendSets,
  listVisiblePeople,
} from "@/lib/people";
import type { FriendPlaylist, Listen } from "@/lib/people";
import { layout } from "@/styles/layout";
import { colors, radii, space, widths } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  actions: { display: "flex", flexShrink: 0, gap: space[2] },
  artwork: {
    borderRadius: radii.md,
    flexShrink: 0,
    height: space[16],
    width: space[16],
  },
  artworkImage: { objectFit: "cover" },
  artworkPlaceholder: { backgroundColor: colors.muted },
  badges: { display: "flex", flexWrap: "wrap", gap: space[1] },
  listen: {
    display: "flex",
    gap: space[4],
    justifyContent: "space-between",
    paddingBlock: space[2],
  },
  notVisible: {
    marginInline: "auto",
    maxWidth: widths.md,
    padding: space[6],
    width: "100%",
  },
  numbered: { listStyleType: "decimal", paddingLeft: space[5] },
  setRow: {
    alignItems: "flex-start",
    display: "flex",
    gap: space[4],
    paddingBlock: space[4],
  },
  shrink0: { flexShrink: 0 },
});

const RECENT_SETS = 3;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export interface Profile {
  readonly id: string;
  /** The newest page of the friend's Listen History. */
  readonly listens: readonly Listen[];
  /** The ids of the Sets in the viewer's own Library. */
  readonly mine: readonly string[];
  /** Reads the page of Listens older than `listens`; `null` when there is none. */
  readonly nextCursor: string | null;
  readonly playlists: readonly FriendPlaylist[];
  readonly sets: readonly SavedSet[];
  readonly username: string;
}

/** Why saving or downloading a friend's Set did not do what the Person asked. */
const actionProblem = (result: ApiResult<unknown>): string | null => {
  if (result.ok) {
    return null;
  }
  if (result.failure === "limited") {
    return "The Download queue is full. Try again later.";
  }
  return FAILURE_MESSAGES[result.failure];
};

const FriendSetRow = ({
  credentials,
  progress,
  saved,
  set,
}: {
  readonly credentials: Credentials;
  readonly progress: number | undefined;
  readonly saved: boolean;
  readonly set: SavedSet;
}) => {
  const router = useRouter();
  const player = usePlayer();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const act = async (run: () => Promise<ApiResult<unknown>>) => {
    setPending(true);
    const result = await run();
    setPending(false);
    // Saving a Set already in the Library is a conflict, and the result is the same.
    const settled =
      result.ok || result.failure === "conflict" ? null : actionProblem(result);
    setProblem(settled);
    if (settled === null) {
      await router.invalidate();
    }
  };
  const downloadable = canDownload(set);
  return (
    <li {...stylex.props(styles.setRow, layout.divided)}>
      {set.artworkUrl === null ? (
        <div {...stylex.props(styles.artworkPlaceholder, styles.artwork)} />
      ) : (
        <img
          alt=""
          {...stylex.props(styles.artwork, styles.artworkImage)}
          src={set.artworkUrl}
        />
      )}
      <div {...stylex.props(layout.stack1, layout.fill)}>
        <h3 {...stylex.props(type.truncate, type.medium)}>{set.title}</h3>
        <p {...stylex.props(type.muted, type.sm)}>{setDetails(set)}</p>
        <div {...stylex.props(styles.badges)}>
          <DownloadBadge progress={progress} set={set} />
        </div>
        <Problem message={problem} />
      </div>
      <div {...stylex.props(styles.actions)}>
        {set.downloadState === "ready" ? (
          <Button
            aria-label={`Play ${set.title}`}
            disabled={pending}
            onClick={detach(async () => {
              await act(async () => await player.play(set));
            })}
            size="sm"
            variant="outline"
          >
            Play
          </Button>
        ) : null}
        {downloadable ? (
          <Button
            aria-label={`Download ${set.title}`}
            disabled={pending}
            onClick={detach(async () => {
              await act(async () => await requestDownload(credentials, set.id));
            })}
            size="sm"
            variant="outline"
          >
            Download
          </Button>
        ) : null}
        {saved ? (
          <Button disabled size="sm" variant="secondary">
            Saved
          </Button>
        ) : (
          <Button
            aria-label={`Save ${set.title}`}
            disabled={pending}
            onClick={detach(async () => {
              await act(async () => await saveSet(credentials, set.url));
            })}
            size="sm"
          >
            Save
          </Button>
        )}
      </div>
    </li>
  );
};

const Section = ({
  children,
  description,
  title,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly title: string;
}) => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2 {...stylex.props(type.lg)}>{title}</h2>
      </CardTitle>
      {description === undefined ? null : (
        <CardDescription>{description}</CardDescription>
      )}
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

const Empty = ({ children }: { readonly children: string }) => (
  <p {...stylex.props(type.muted, type.sm)}>{children}</p>
);

/** The friend's Listens, newest first; "Show older" appends the next page. */
const ListenHistory = ({
  credentials,
  profile,
}: {
  readonly credentials: Credentials;
  readonly profile: Profile;
}) => {
  const [older, setOlder] = useState<readonly Listen[]>([]);
  const [cursor, setCursor] = useState(profile.nextCursor);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const listens = [...profile.listens, ...older];
  const showOlder = async (before: string) => {
    setPending(true);
    const page = await friendListens(credentials, profile.id, before);
    setPending(false);
    if (!page.ok) {
      setProblem(FAILURE_MESSAGES[page.failure]);
      return;
    }
    setProblem(null);
    setOlder((shown) => [...shown, ...page.value.listens]);
    setCursor(page.value.nextCursor);
  };
  return (
    <Section title="Listen History">
      {listens.length === 0 ? (
        <Empty>No Listens yet.</Empty>
      ) : (
        <div {...stylex.props(layout.stack4)}>
          <ol aria-label="Listen History" {...stylex.props(type.sm)}>
            {listens.map((listen) => (
              <li
                {...stylex.props(styles.listen, layout.divided)}
                key={`${listen.startedAt}-${listen.set.id}`}
              >
                <span>
                  {listen.finishedAt === null ? "Listened to" : "Finished"}{" "}
                  {listen.set.title}
                </span>
                <time
                  {...stylex.props(type.muted, styles.shrink0)}
                  dateTime={listen.startedAt}
                >
                  {timeFormat.format(new Date(listen.startedAt))}
                </time>
              </li>
            ))}
          </ol>
          {flags.listenHistoryPaging() && cursor !== null ? (
            <div>
              <Button
                disabled={pending}
                onClick={detach(async () => {
                  await showOlder(cursor);
                })}
                size="sm"
                variant="outline"
              >
                Show older
              </Button>
            </div>
          ) : null}
          <Problem message={problem} />
        </div>
      )}
    </Section>
  );
};

const FriendProfile = ({
  credentials,
  profile,
}: {
  readonly credentials: Credentials;
  readonly profile: Profile;
}) => {
  const { presence } = useLiveEvents();
  const progress = useDownloadProgress(credentials, profile.sets);
  const listening = presence.find((entry) => entry.personId === profile.id);
  const recent = [
    ...new Map(
      profile.listens.map((listen) => [listen.set.id, listen.set])
    ).values(),
  ].slice(0, RECENT_SETS);
  return (
    <main {...stylex.props(layout.stack6, layout.main)}>
      <div {...stylex.props(layout.stack1)}>
        <h1 {...stylex.props(type.title)}>{profile.username}</h1>
        <p {...stylex.props(type.muted, type.sm)} role="status">
          {listening === undefined
            ? "Not listening right now"
            : `${profile.username} is listening to ${listening.set.title}`}
        </p>
      </div>
      <Section
        description="Save a Set to add it to your own Library."
        title={`${profile.username}’s Library`}
      >
        {profile.sets.length === 0 ? (
          <Empty>No Sets yet.</Empty>
        ) : (
          <ul aria-label={`${profile.username}’s Sets`}>
            {profile.sets.map((set) => (
              <FriendSetRow
                credentials={credentials}
                key={set.id}
                progress={progress.get(set.id)}
                saved={profile.mine.includes(set.id)}
                set={set}
              />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Playlists">
        {profile.playlists.length === 0 ? (
          <Empty>No Playlists yet.</Empty>
        ) : (
          <div {...stylex.props(layout.stack4)}>
            {profile.playlists.map((playlist) => (
              <section aria-label={playlist.name} key={playlist.id}>
                <h3 {...stylex.props(type.medium)}>{playlist.name}</h3>
                <ol {...stylex.props(type.muted, styles.numbered, type.sm)}>
                  {playlist.sets.map((set) => (
                    <li key={set.id}>{set.title}</li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </Section>
      <Section title="Recent Sets">
        {recent.length === 0 ? (
          <Empty>No recent Sets.</Empty>
        ) : (
          <ul
            aria-label="Recent Sets"
            {...stylex.props(layout.stack1, type.sm)}
          >
            {recent.map((set) => (
              <li key={set.id}>{set.title}</li>
            ))}
          </ul>
        )}
      </Section>
      {/* A reload that moves the first page's end starts the older pages again. */}
      <ListenHistory
        credentials={credentials}
        key={`${profile.id} ${profile.nextCursor}`}
        profile={profile}
      />
    </main>
  );
};

/** The API answers 404 for a Person the caller cannot see, whatever the reason. */
const NotVisible = () => (
  <main {...stylex.props(styles.notVisible)}>
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 {...stylex.props(type.xl2)}>Not visible</h1>
        </CardTitle>
        <CardDescription>
          This Person’s Library is not visible to you. One of you may have
          turned Social off, or changed See or Appear.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          {...stylex.props(buttonLook({ variant: "outline" }))}
          to="/people"
        >
          Back to People
        </Link>
      </CardContent>
    </Card>
  </main>
);

export const Route = createFileRoute("/_app/people/$id")({
  component: () => {
    const profile = Route.useLoaderData();
    const { session } = Route.useRouteContext();
    return profile === null ? (
      <NotVisible />
    ) : (
      <FriendProfile credentials={session} profile={profile} />
    );
  },
  errorComponent: RouteProblem,
  loader: async ({ context, params }): Promise<Profile | null> => {
    const { session } = context;
    const { id } = params;
    const [people, sets, playlists, listens, mine] = await Promise.all([
      listVisiblePeople(session),
      friendSets(session, id),
      friendPlaylists(session, id),
      friendListens(session, id),
      listSets(session, {}),
    ]);
    const results = [people, sets, playlists, listens, mine];
    if (results.some((result) => !result.ok && result.status === 404)) {
      return null;
    }
    if (!people.ok || !sets.ok || !playlists.ok || !listens.ok || !mine.ok) {
      const failed = results.find((result) => !result.ok);
      throw new Error(
        FAILURE_MESSAGES[failed?.ok === false ? failed.failure : "failed"]
      );
    }
    const person = people.value.people.find((item) => item.id === id);
    if (person === undefined) {
      return null;
    }
    return {
      id,
      listens: listens.value.listens,
      mine: mine.value.sets.map((set) => set.id),
      nextCursor: listens.value.nextCursor,
      playlists: playlists.value.playlists,
      sets: sets.value.sets,
      username: person.username,
    };
  },
});
