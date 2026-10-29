import { GROUP_PASSCODE, codeFromText } from "@orbis/contracts";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { JoinFields, SignInForm, checkJoin } from "@/components/sign-in-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formField } from "@/lib/form";
import { takeFragment } from "@/lib/fragment";
import { joinGroup } from "@/lib/sign-in";

const SITE = "https://orbis.p11a.xyz";
const TITLE = "Join the Orbis Group";
const DESCRIPTION = "Install Orbis from TestFlight, then join with this link.";
// A picture with no words, as Apple's TN3156 advises, 1200x630 so Messages
// shows a large card.
const IMAGE = `${SITE}/join-preview.png`;
const GONE = "This invite link no longer works. Ask your Host for a new one.";

/**
 * The Group Passcode the link's fragment carried, which `takeFragment`
 * removes. Anything short of a whole passcode reads as no passcode.
 */
const takePasscode = (): string | null => {
  const passcode = codeFromText(GROUP_PASSCODE, takeFragment());
  return passcode.length === GROUP_PASSCODE.length ? passcode : null;
};

const joinRoute = getRouteApi("/join");

const Join = () => {
  const { apiUrl } = joinRoute.useRouteContext();
  // Unread on the Worker, which never sees the fragment; null once read with
  // no passcode in it.
  const [linked, setLinked] = useState<string | null | undefined>();
  useEffect(() => {
    const passcode = takePasscode();
    // A second run finds the fragment already gone, so it keeps the first read.
    setLinked((read) => read ?? passcode);
  }, []);
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{TITLE}</h1>
          </CardTitle>
          <CardDescription>
            Your friend invited you to their Orbis Group.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <section className="flex flex-col gap-1" aria-label="Install Orbis">
            <h2 className="font-medium">Install Orbis first</h2>
            <p className="text-muted-foreground text-sm">
              Open the TestFlight email from Apple on this iPhone and install
              Orbis, then come back and tap your link again.
            </p>
          </section>
          {linked === undefined ? null : (
            <SignInForm
              call={async (form) => {
                const passcode = formField(form, "passcode");
                const result = await joinGroup(
                  apiUrl,
                  formField(form, "username"),
                  passcode
                );
                // Only the link's own passcode is the link's fault.
                return !result.ok &&
                  result.status === 403 &&
                  passcode === linked
                  ? { ...result, message: GONE }
                  : result;
              }}
              check={checkJoin}
              description="Or join here and use Orbis in this browser."
              pendingLabel="Joining…"
              submitLabel="Join on the Web"
              title="Join on the web"
            >
              {(submitWhenReady) => (
                <JoinFields
                  onComplete={submitWhenReady}
                  passcode={linked ?? undefined}
                />
              )}
            </SignInForm>
          )}
        </CardContent>
      </Card>
    </main>
  );
};

// Top-level and rendered on the Worker, so a link preview, which runs no
// JavaScript, reads these tags from the HTML. A child of `_browser` would never
// reach `head()` on the Worker.
export const Route = createFileRoute("/join")({
  component: Join,
  head: () => ({
    links: [{ href: `${SITE}/join`, rel: "canonical" }],
    meta: [
      { title: TITLE },
      { content: DESCRIPTION, name: "description" },
      { content: "Orbis", property: "og:site_name" },
      { content: "website", property: "og:type" },
      { content: TITLE, property: "og:title" },
      { content: DESCRIPTION, property: "og:description" },
      { content: `${SITE}/join`, property: "og:url" },
      { content: IMAGE, property: "og:image" },
      { content: "image/png", property: "og:image:type" },
      { content: "1200", property: "og:image:width" },
      { content: "630", property: "og:image:height" },
      { content: "The Orbis orb", property: "og:image:alt" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: TITLE, name: "twitter:title" },
      { content: DESCRIPTION, name: "twitter:description" },
      { content: IMAGE, name: "twitter:image" },
    ],
  }),
});
