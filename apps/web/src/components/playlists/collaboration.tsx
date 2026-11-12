import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { detach } from "@/lib/detach";
import { formText } from "@/lib/form";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";
import { setCollaborative, setEditors } from "@/lib/playlists";
import type { Collaboration, VisiblePerson } from "@/lib/playlists";
import { layout } from "@/styles/layout";
import { space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  editor: {
    alignItems: "center",
    display: "flex",
    gap: space[4],
    justifyContent: "space-between",
    paddingBlock: space[2],
  },
});

export const CollaborationCard = ({
  collaboration,
  credentials,
  people,
  playlistId,
}: {
  readonly collaboration: Collaboration;
  readonly credentials: Credentials;
  readonly people: readonly VisiblePerson[];
  readonly playlistId: string;
}) => {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const settle = async (
    call: Promise<ApiResult<unknown>>,
    notFound: string
  ) => {
    setPending(true);
    const result = await call;
    if (result.ok) {
      setProblem(null);
      await router.invalidate();
    } else {
      setProblem(
        result.status === 404 ? notFound : FAILURE_MESSAGES[result.failure]
      );
    }
    setPending(false);
  };
  const { editorIds } = collaboration;
  const nameOf = (id: string) =>
    people.find((person) => person.id === id)?.username ??
    "A Person you cannot see";
  const candidates = people.filter((person) => !editorIds.includes(person.id));
  const addEditor = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = formText(new FormData(event.currentTarget), "editor");
    if (id !== "") {
      void settle(
        setEditors(credentials, playlistId, [...editorIds, id]),
        "That Person must be able to see you, and you them, to edit."
      );
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 {...stylex.props(type.lg)}>Collaboration</h2>
        </CardTitle>
        <CardDescription>
          Editors can add, remove, and reorder Sets. Only you can rename or
          delete this Playlist and choose its editors.
        </CardDescription>
      </CardHeader>
      <CardContent xstyle={layout.stack4}>
        <Label>
          <Switch
            checked={collaboration.collaborative}
            disabled={pending}
            onCheckedChange={detach(async (checked) => {
              await settle(
                setCollaborative(credentials, playlistId, checked),
                FAILURE_MESSAGES.failed
              );
            })}
          />
          Collaborative
        </Label>
        {collaboration.collaborative ? (
          <>
            {editorIds.length === 0 ? (
              <p {...stylex.props(type.muted, type.sm)}>No editors yet.</p>
            ) : (
              <ul aria-label="Editors">
                {editorIds.map((id) => (
                  <li {...stylex.props(styles.editor, layout.divided)} key={id}>
                    <span {...stylex.props(type.sm)}>{nameOf(id)}</span>
                    <Button
                      aria-label={`Remove editor ${nameOf(id)}`}
                      disabled={pending}
                      onClick={detach(async () => {
                        await settle(
                          setEditors(
                            credentials,
                            playlistId,
                            editorIds.filter((editor) => editor !== id)
                          ),
                          FAILURE_MESSAGES.failed
                        );
                      })}
                      size="sm"
                      variant="outline"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {candidates.length === 0 ? (
              <p {...stylex.props(type.muted, type.sm)}>
                No one else can be an editor. An editor must have Social on, and
                you must be able to see each other.
              </p>
            ) : (
              <form {...stylex.props(layout.stack2)} onSubmit={addEditor}>
                <Label htmlFor="playlist-editor">Add editor</Label>
                <div {...stylex.props(layout.row2)}>
                  <NativeSelect id="playlist-editor" name="editor">
                    {candidates.map((person) => (
                      <NativeSelectOption key={person.id} value={person.id}>
                        {person.username}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button disabled={pending} type="submit" variant="outline">
                    Add editor
                  </Button>
                </div>
              </form>
            )}
          </>
        ) : null}
        <Problem message={problem} />
      </CardContent>
    </Card>
  );
};
