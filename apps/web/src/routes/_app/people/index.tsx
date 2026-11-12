import * as stylex from "@stylexjs/stylex";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { useLiveEvents } from "@/components/live-events";
import { Problem } from "@/components/problem";
import { RouteProblem } from "@/components/route-problem";
import { buttonLook } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { detach } from "@/lib/detach";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";
import { listPeopleFilters, setFilter, setSocial } from "@/lib/people";
import type { PersonFilters } from "@/lib/people";
import type { Session } from "@/routes/_app";
import { layout } from "@/styles/layout";
import { space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  between: {
    alignItems: "center",
    display: "flex",
    gap: space[4],
    justifyContent: "space-between",
  },
  filters: { display: "flex", flexWrap: "wrap", gap: space[6] },
  row: { paddingBlock: space[4] },
  top: { alignItems: "flex-start", display: "flex", gap: space[4] },
});

/** Runs one change, shows its failure, and reloads the page's data on success. */
const useChange = () => {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const change = async (run: () => Promise<ApiResult<unknown>>) => {
    setPending(true);
    const result = await run();
    setPending(false);
    if (!result.ok) {
      setProblem(FAILURE_MESSAGES[result.failure]);
      return;
    }
    setProblem(null);
    // Re-runs the shell's `/me` too, so the Social switch shows the saved value.
    await router.invalidate();
  };
  return { change, pending, problem };
};

const SocialSwitch = ({ session }: { readonly session: Session }) => {
  const labelId = useId();
  const { change, pending, problem } = useChange();
  return (
    <div {...stylex.props(layout.stack2)}>
      <div {...stylex.props(styles.between)}>
        <div {...stylex.props(layout.stack1)}>
          <span {...stylex.props(type.medium)} id={labelId}>
            Social
          </span>
          <span {...stylex.props(type.muted, type.sm)}>
            When Social is off, nobody sees your Library, Playlists, or what you
            listen to, and you see nobody’s.
          </span>
        </div>
        <Switch
          aria-labelledby={labelId}
          checked={session.person.social}
          disabled={pending}
          onCheckedChange={detach(async (checked) => {
            await change(async () => await setSocial(session, checked));
          })}
        />
      </div>
      <Problem message={problem} />
    </div>
  );
};

const FilterSwitch = ({
  checked,
  disabled,
  label,
  name,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly name: string;
  readonly onChange: (checked: boolean) => void;
}) => (
  <span {...stylex.props(layout.rowCenter2, type.sm)}>
    <Switch
      aria-label={name}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      size="sm"
    />
    <span aria-hidden>{label}</span>
  </span>
);

const PersonRow = ({
  credentials,
  person,
}: {
  readonly credentials: Credentials;
  readonly person: PersonFilters;
}) => {
  const { presence } = useLiveEvents();
  const { change, pending, problem } = useChange();
  const listening = presence.find((entry) => entry.personId === person.id);
  return (
    <li {...stylex.props(layout.stack3, styles.row, layout.divided)}>
      <div {...stylex.props(styles.top)}>
        <div {...stylex.props(layout.stack1, layout.fill)}>
          <h2 {...stylex.props(type.truncate, type.medium)}>
            {person.username}
          </h2>
          {person.see ? (
            <p {...stylex.props(type.muted, type.sm)} role="status">
              {listening === undefined
                ? "Not listening right now"
                : `${person.username} is listening to ${listening.set.title}`}
            </p>
          ) : (
            <p {...stylex.props(type.muted, type.sm)}>
              Hidden from your People. Turn See on to see their Library.
            </p>
          )}
        </div>
        {person.see ? (
          <Link
            {...stylex.props(buttonLook({ size: "sm", variant: "outline" }))}
            params={{ id: person.id }}
            to="/people/$id"
          >
            Open {person.username}’s Library
          </Link>
        ) : null}
      </div>
      <div {...stylex.props(styles.filters)}>
        <FilterSwitch
          checked={person.see}
          disabled={pending}
          label="See"
          name={`See ${person.username}`}
          onChange={detach(async (see) => {
            await change(
              async () => await setFilter(credentials, person.id, { see })
            );
          })}
        />
        <FilterSwitch
          checked={person.appear}
          disabled={pending}
          label="Appear"
          name={`Appear to ${person.username}`}
          onChange={detach(async (appear) => {
            await change(
              async () => await setFilter(credentials, person.id, { appear })
            );
          })}
        />
      </div>
      <Problem message={problem} />
    </li>
  );
};

const People = ({
  people,
  session,
}: {
  readonly people: readonly PersonFilters[];
  readonly session: Session;
}) => {
  const renderPeople = () => {
    if (!session.person.social) {
      return (
        <p {...stylex.props(type.muted, type.sm)}>
          Turn Social on to see the People who turned it on too.
        </p>
      );
    }
    if (people.length === 0) {
      return (
        <p {...stylex.props(type.muted, type.sm)}>
          Nobody else has Social on yet.
        </p>
      );
    }
    return (
      <ul aria-label="People">
        {people.map((person) => (
          <PersonRow credentials={session} key={person.id} person={person} />
        ))}
      </ul>
    );
  };
  return (
    <main {...stylex.props(layout.main)}>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 {...stylex.props(type.xl2)}>People</h1>
          </CardTitle>
          <CardDescription>
            See decides whether a Person is in your People. Appear decides
            whether they see you.
          </CardDescription>
        </CardHeader>
        <CardContent xstyle={layout.stack6}>
          <SocialSwitch session={session} />
          {renderPeople()}
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/_app/people/")({
  component: () => (
    <People
      people={Route.useLoaderData()}
      session={Route.useRouteContext().session}
    />
  ),
  errorComponent: RouteProblem,
  loader: async ({ context }) => {
    const people = await listPeopleFilters(context.session);
    if (!people.ok) {
      throw new Error(FAILURE_MESSAGES[people.failure]);
    }
    return people.value.people;
  },
});
