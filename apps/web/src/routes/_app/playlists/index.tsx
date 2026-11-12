import * as stylex from "@stylexjs/stylex";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Problem } from "@/components/problem";
import { RouteProblem } from "@/components/route-problem";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { detach } from "@/lib/detach";
import { formField } from "@/lib/form";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";
import {
  createPlaylist,
  listPlaylists,
  listSharedPlaylists,
} from "@/lib/playlists";
import type { Playlist, SharedPlaylist } from "@/lib/playlists";
import { layout } from "@/styles/layout";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  detail: { flexShrink: 0 },
  link: {
    alignItems: "baseline",
    backgroundColor: {
      ":hover": { "@media (hover: hover)": colors.muted, default: null },
      default: null,
    },
    borderRadius: radii.md,
    display: "flex",
    gap: space[4],
    justifyContent: "space-between",
    paddingBlock: space[3],
    paddingInline: space[2],
  },
});

const setCount = (count: number) => `${count} ${count === 1 ? "Set" : "Sets"}`;

const CreatePlaylistForm = ({
  credentials,
}: {
  readonly credentials: Credentials;
}) => {
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const create = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = formField(new FormData(event.currentTarget), "name");
    if (name === "") {
      setProblem("Enter a Playlist name.");
      return;
    }
    setPending(true);
    const created = await createPlaylist(credentials, name);
    setPending(false);
    if (!created.ok) {
      setProblem(
        created.failure === "conflict"
          ? "You already have a Playlist with this name."
          : FAILURE_MESSAGES[created.failure]
      );
      return;
    }
    await navigate({
      params: { id: created.value.id },
      to: "/playlists/$id",
    });
  };
  return (
    <form {...stylex.props(layout.stack2)} onSubmit={detach(create)}>
      <Label htmlFor="playlist-name">Playlist name</Label>
      <div {...stylex.props(layout.row2)}>
        <Input
          autoComplete="off"
          id="playlist-name"
          maxLength={100}
          name="name"
        />
        <Button disabled={pending} type="submit">
          Create Playlist
        </Button>
      </div>
      <Problem message={problem} />
    </form>
  );
};

const PlaylistLink = ({
  detail,
  playlist,
}: {
  readonly detail: string;
  readonly playlist: Playlist;
}) => (
  <li {...stylex.props(layout.divided)}>
    <Link
      {...stylex.props(styles.link, layout.focusOutline)}
      params={{ id: playlist.id }}
      to="/playlists/$id"
    >
      <span {...stylex.props(type.truncate, type.medium)}>{playlist.name}</span>
      <span {...stylex.props(type.muted, styles.detail, type.sm)}>
        {detail}
      </span>
    </Link>
  </li>
);

const Playlists = ({
  credentials,
  owned,
  shared,
}: {
  readonly credentials: Credentials;
  readonly owned: readonly Playlist[];
  readonly shared: readonly SharedPlaylist[];
}) => (
  <main {...stylex.props(layout.stack6, layout.main)}>
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 {...stylex.props(type.xl2)}>Playlists</h1>
        </CardTitle>
        <CardDescription>
          A Playlist is a named, ordered selection of Sets.
        </CardDescription>
      </CardHeader>
      <CardContent xstyle={layout.stack6}>
        <CreatePlaylistForm credentials={credentials} />
        {owned.length === 0 ? (
          <p {...stylex.props(type.muted, type.sm)}>
            You have no Playlists yet.
          </p>
        ) : (
          <ul aria-label="Your Playlists">
            {owned.map((playlist) => (
              <PlaylistLink
                detail={setCount(playlist.setCount)}
                key={playlist.id}
                playlist={playlist}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
    {shared.length === 0 ? null : (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 {...stylex.props(type.lg)}>Shared with you</h2>
          </CardTitle>
          <CardDescription>
            Collaborative Playlists where you can add, remove, and reorder Sets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul aria-label="Shared with you">
            {shared.map((playlist) => (
              <PlaylistLink
                detail={`${playlist.creator.username} · ${setCount(playlist.setCount)}`}
                key={playlist.id}
                playlist={playlist}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
    )}
  </main>
);

export const Route = createFileRoute("/_app/playlists/")({
  component: () => {
    const { session } = Route.useRouteContext();
    const { owned, shared } = Route.useLoaderData();
    return <Playlists credentials={session} owned={owned} shared={shared} />;
  },
  errorComponent: RouteProblem,
  loader: async ({ context }) => {
    const [owned, shared] = await Promise.all([
      listPlaylists(context.session),
      listSharedPlaylists(context.session),
    ]);
    if (!owned.ok) {
      throw new Error(FAILURE_MESSAGES[owned.failure]);
    }
    if (!shared.ok) {
      throw new Error(FAILURE_MESSAGES[shared.failure]);
    }
    return {
      owned: owned.value.playlists,
      shared: shared.value.playlists,
    };
  },
});
