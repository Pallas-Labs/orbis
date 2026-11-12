import { GROUP_PASSCODE } from "@orbis/contracts";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { SubmitEvent, ReactNode } from "react";

import { ShownCode } from "@/components/code-field";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Problem } from "@/components/problem";
import { RouteProblem } from "@/components/route-problem";
import { SignInCode } from "@/components/sign-in-code";
import { Badge } from "@/components/ui/badge";
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
import { NativeSelect } from "@/components/ui/native-select";
import {
  closeJoining,
  createKey,
  loadAdmin,
  newPasscode,
  removePerson,
  revokeKey,
  signInCodeFor,
} from "@/lib/admin";
import type { AdminData, AdminKey, AdminPerson } from "@/lib/admin";
import { lastUsedText } from "@/lib/dates";
import { detach } from "@/lib/detach";
import { formField } from "@/lib/form";
import type { IssuedSignInCode } from "@/lib/sign-in";
import { useApiCall } from "@/lib/use-api-call";
import { useCopy } from "@/lib/use-copy";
import type { Session } from "@/routes/_app";
import { layout } from "@/styles/layout";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  actions: { display: "flex", gap: space[2] },
  createdKey: {
    backgroundColor: colors.muted,
    borderRadius: radii.xl2,
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    padding: space[4],
  },
  fields: { display: "flex", flexWrap: "wrap", gap: space[2] },
  key: {
    alignItems: "center",
    display: "flex",
    gap: space[2],
    paddingBlock: space[3],
  },
  keyName: {
    display: "flex",
    flexDirection: "column",
    marginRight: "auto",
    minWidth: 0,
  },
  labelField: {
    flexBasis: "0%",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: space[48],
  },
  passcode: {
    backgroundColor: colors.muted,
    borderRadius: radii.xl2,
    padding: space[4],
  },
  personHeader: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: space[2],
  },
  personName: { marginRight: "auto" },
  personRow: { paddingBlock: space[4] },
  token: {
    backgroundColor: colors.background,
    borderRadius: radii.lg,
    padding: space[2],
    userSelect: "all",
    wordBreak: "break-all",
  },
});

const Section = ({
  children,
  description,
  id,
  title,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly id: string;
  readonly title: string;
}) => (
  <Card aria-labelledby={id} role="region">
    <CardHeader>
      <CardTitle>
        <h2 id={id}>{title}</h2>
      </CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent xstyle={layout.stack4}>{children}</CardContent>
  </Card>
);

const OpenPasscode = ({
  busy,
  change,
  passcode,
  session,
}: {
  readonly busy: boolean;
  readonly change: ReturnType<typeof useApiCall>["change"];
  readonly passcode: string;
  readonly session: Session;
}) => {
  const router = useRouter();
  return (
    <>
      <div {...stylex.props(styles.passcode)}>
        <ShownCode
          code={passcode}
          copyLabel="Copy passcode"
          format={GROUP_PASSCODE}
          key={passcode}
          label="Group Passcode"
        />
      </div>
      <div {...stylex.props(styles.fields)}>
        <ConfirmDialog
          action="New passcode"
          call={async () => await newPasscode(session)}
          description="The passcode you shared stops working. People who joined stay signed in."
          label="New passcode"
          onDone={async () => {
            await router.invalidate();
          }}
          pendingAction="Making…"
          title="Make a new passcode?"
          trigger="New passcode"
        />
        <Button
          disabled={busy}
          onClick={detach(
            async () => await change(async () => await closeJoining(session))
          )}
          size="sm"
          variant="outline"
        >
          Close joining
        </Button>
      </div>
    </>
  );
};

const Passcode = ({
  passcode,
  session,
}: {
  readonly passcode: string | null;
  readonly session: Session;
}) => {
  const { busy, change, problem } = useApiCall();
  return (
    <Section
      description="Orbis makes a random passcode. Friends join with it. A new passcode does not sign anyone out."
      id="passcode-title"
      title="Group Passcode"
    >
      {passcode === null ? (
        <>
          <p>Joining is closed.</p>
          <Button
            xstyle={layout.selfStart}
            disabled={busy}
            onClick={detach(
              async () => await change(async () => await newPasscode(session))
            )}
          >
            Open joining
          </Button>
        </>
      ) : (
        <OpenPasscode
          busy={busy}
          change={change}
          passcode={passcode}
          session={session}
        />
      )}
      <Problem message={problem} />
    </Section>
  );
};

const PersonRow = ({
  person,
  session,
}: {
  readonly person: AdminPerson;
  readonly session: Session;
}) => {
  const router = useRouter();
  const { busy, problem, run } = useApiCall();
  const [code, setCode] = useState<IssuedSignInCode | null>(null);
  const isHost = person.id === session.person.id;
  const showCode = async () => {
    const issued = await run(
      async () => await signInCodeFor(session, person.id)
    );
    if (issued !== null) {
      setCode(issued);
    }
  };
  return (
    <li {...stylex.props(layout.stack3, styles.personRow, layout.divided)}>
      <div {...stylex.props(styles.personHeader)}>
        <h3 {...stylex.props(styles.personName, type.medium)}>
          {person.username}
        </h3>
        {isHost ? <Badge variant="secondary">You</Badge> : null}
        <Button
          aria-label={`Show Sign-in Code for ${person.username}`}
          disabled={busy}
          onClick={detach(showCode)}
          size="sm"
          variant="outline"
        >
          Show Sign-in Code
        </Button>
        {isHost ? null : (
          <ConfirmDialog
            action="Remove"
            call={async () => await removePerson(session, person.id)}
            description="This deletes their keys, Library, Playlists, Listening Queue, and Listen History. You cannot undo it."
            label={`Remove ${person.username}`}
            onDone={async () => {
              await router.invalidate();
            }}
            pendingAction="Removing…"
            title={`Remove ${person.username}?`}
            trigger={`Remove ${person.username}`}
          />
        )}
      </div>
      {code === null ? null : (
        <SignInCode
          issued={code}
          label={`Sign-in Code for ${person.username}`}
        />
      )}
      <Problem message={problem} />
    </li>
  );
};

const CreatedKey = ({
  onDone,
  token,
}: {
  readonly onDone: () => void;
  readonly token: string;
}) => {
  const { copy, copyText: copyKey } = useCopy(token);
  return (
    <div {...stylex.props(styles.createdKey)} role="status">
      <p {...stylex.props(type.sm)}>
        Copy this key now. Orbis will not show it again.
      </p>
      <code {...stylex.props(styles.token, type.xs)}>{token}</code>
      {copy === "failed" ? (
        <p {...stylex.props(type.error, type.sm)}>
          Could not copy the key. Select and copy it instead.
        </p>
      ) : null}
      <div {...stylex.props(styles.actions)}>
        <Button onClick={detach(copyKey)} size="sm">
          {copy === "copied" ? "Copied" : "Copy key"}
        </Button>
        <Button onClick={onDone} size="sm" variant="outline">
          Done
        </Button>
      </div>
    </div>
  );
};

const Keys = ({
  keys,
  people,
  session,
}: {
  readonly keys: readonly AdminKey[];
  readonly people: readonly AdminPerson[];
  readonly session: Session;
}) => {
  const router = useRouter();
  const { busy, change, problem, refuse } = useApiCall();
  const [token, setToken] = useState<string | null>(null);
  const usernames = new Map(
    people.map((person) => [person.id, person.username])
  );
  const create = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const personId = formField(data, "personId");
    const label = formField(data, "label");
    if (label === "") {
      refuse("Name the key, such as Raycast.");
      return;
    }
    const created = await change(
      async () => await createKey(session, personId, label)
    );
    if (created !== null) {
      form.reset();
      setToken(created.token);
    }
  };
  return (
    <Section
      description="Every signed-in device has a key. Create one by hand only for a client that cannot sign in with a code, such as Raycast."
      id="keys-title"
      title="Keys"
    >
      <ul aria-label="Keys">
        {keys.map((key) => {
          const owner = usernames.get(key.personId) ?? key.personId;
          return (
            <li {...stylex.props(styles.key, layout.divided)} key={key.id}>
              <div {...stylex.props(styles.keyName)}>
                <span {...stylex.props(type.truncate, type.medium)}>
                  {key.label}
                </span>
                <span {...stylex.props(type.muted, type.xs)}>
                  {key.scope === "node" ? "Audio node" : owner} ·{" "}
                  {lastUsedText(key.lastUsedAt)}
                </span>
              </div>
              {/* Vanta's audio node stops serving audio without its key. */}
              {key.scope === "node" ? null : (
                <ConfirmDialog
                  action="Revoke"
                  call={async () => await revokeKey(session, key.id)}
                  description={`Whatever uses this key is signed out as ${owner} the next time it contacts Orbis.`}
                  label={`Revoke ${key.label} for ${owner}`}
                  onDone={async () => {
                    await router.invalidate();
                  }}
                  pendingAction="Revoking…"
                  title={`Revoke ${key.label}?`}
                  trigger="Revoke"
                />
              )}
            </li>
          );
        })}
      </ul>
      <form {...stylex.props(layout.stack2)} onSubmit={detach(create)}>
        <div {...stylex.props(styles.fields)}>
          <div {...stylex.props(layout.stack2)}>
            <Label htmlFor="key-person">Person</Label>
            <NativeSelect id="key-person" name="personId">
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.username}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div {...stylex.props(layout.stack2, styles.labelField)}>
            <Label htmlFor="key-label">Key label</Label>
            <Input
              autoComplete="off"
              id="key-label"
              maxLength={100}
              name="label"
            />
          </div>
        </div>
        <Button xstyle={layout.selfStart} disabled={busy} type="submit">
          Create key
        </Button>
      </form>
      {token === null ? null : (
        <CreatedKey
          onDone={() => {
            setToken(null);
          }}
          token={token}
        />
      )}
      <Problem message={problem} />
    </Section>
  );
};

const AdminPage = ({
  data,
  session,
}: {
  readonly data: AdminData;
  readonly session: Session;
}) => (
  <main {...stylex.props(layout.stack6, layout.main)}>
    <h1 {...stylex.props(type.title)}>Admin</h1>
    <Passcode passcode={data.passcode} session={session} />
    <Section
      description="Show a Sign-in Code to sign in a device for any Person."
      id="people-title"
      title="People"
    >
      <ul aria-label="People in the Group">
        {data.people.map((person) => (
          <PersonRow key={person.id} person={person} session={session} />
        ))}
      </ul>
    </Section>
    <Keys keys={data.keys} people={data.people} session={session} />
  </main>
);

export const Route = createFileRoute("/_app/admin")({
  beforeLoad: ({ context }) => {
    if (!context.session.person.host) {
      throw redirect({ to: "/" });
    }
  },
  // The route hands its own context and data down, which keeps their types exact.
  component: () => (
    <AdminPage
      data={Route.useLoaderData()}
      session={Route.useRouteContext().session}
    />
  ),
  errorComponent: RouteProblem,
  loader: async ({ context }) => await loadAdmin(context.session),
});
