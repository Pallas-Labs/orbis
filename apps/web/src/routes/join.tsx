import { GROUP_PASSCODE, codeFromText } from "@orbis/contracts";
import * as stylex from "@stylexjs/stylex";
import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Problem } from "@/components/problem";
import { JoinFields, SignInForm, checkJoin } from "@/components/sign-in-form";
import { buttonLook } from "@/components/ui/button";
import {
  cardSize,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formField } from "@/lib/form";
import { takeFragment } from "@/lib/fragment";
import { fetchMe, problemFor } from "@/lib/orbis";
import { joinGroup } from "@/lib/sign-in";
import { forgetKey, readKey } from "@/lib/stored-key";
import { layout } from "@/styles/layout";

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

/** What the page offers once it has read the link and this browser's key. */
type Visit =
  | { readonly kind: "join"; readonly passcode: string | null }
  | { readonly kind: "signed-in"; readonly username: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * A browser that holds a key already belongs to a Person, so it gets no join
 * form: joining would store a new Person's key over that one. The fragment is
 * read and removed either way.
 */
const visit = async (apiUrl: string): Promise<Visit> => {
  const passcode = takePasscode();
  const key = readKey();
  if (key === null) {
    return { kind: "join", passcode };
  }
  const me = await fetchMe({ apiUrl, key });
  if (me.ok) {
    return { kind: "signed-in", username: me.value.username };
  }
  // A rejected key signs no one in, so joining replaces nothing.
  if (me.failure === "rejected") {
    forgetKey();
    return { kind: "join", passcode };
  }
  return { kind: "failed", message: problemFor(me) };
};

const joinRoute = getRouteApi("/join");

const JoinCard = ({
  children,
  description,
}: {
  readonly children: ReactNode;
  readonly description: string;
}) => (
  <main className="flex min-h-svh items-center justify-center p-6">
    <Card xstyle={cardSize.narrow}>
      <CardHeader>
        <CardTitle>
          <h1>{TITLE}</h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent xstyle={layout.stack6}>{children}</CardContent>
    </Card>
  </main>
);

const JoinForm = ({
  apiUrl,
  linked,
}: {
  readonly apiUrl: string;
  readonly linked: string | null;
}) => (
  <SignInForm
    call={async (form) => {
      const passcode = formField(form, "passcode");
      const result = await joinGroup(
        apiUrl,
        formField(form, "username"),
        passcode
      );
      // Only the link's own passcode is the link's fault.
      return !result.ok && result.status === 403 && passcode === linked
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
      <JoinFields onComplete={submitWhenReady} passcode={linked ?? undefined} />
    )}
  </SignInForm>
);

const Join = () => {
  const { apiUrl } = joinRoute.useRouteContext();
  // Undefined on the Worker, which never sees the fragment or the key.
  const [read, setRead] = useState<Visit | undefined>();
  // A second run would find the fragment already gone, so it keeps the first read.
  const reading = useRef<Promise<Visit> | null>(null);
  useEffect(() => {
    let current = true;
    reading.current ??= visit(apiUrl);
    const settle = async (pending: Promise<Visit>) => {
      const next = await pending;
      if (current) {
        setRead(next);
      }
    };
    void settle(reading.current);
    return () => {
      current = false;
    };
  }, [apiUrl]);
  if (read?.kind === "signed-in") {
    return (
      <JoinCard description={`You are already signed in as ${read.username}.`}>
        <Link {...stylex.props(buttonLook())} to="/">
          Open Orbis
        </Link>
      </JoinCard>
    );
  }
  return (
    <JoinCard description="Your friend invited you to their Orbis Group.">
      <section className="flex flex-col gap-1" aria-label="Install Orbis">
        <h2 className="font-medium">Install Orbis first</h2>
        <p className="text-muted-foreground text-sm">
          Open the TestFlight email from Apple on this iPhone and install Orbis,
          then come back and tap your link again.
        </p>
      </section>
      {read?.kind === "join" ? (
        <JoinForm apiUrl={apiUrl} linked={read.passcode} />
      ) : null}
      <Problem message={read?.kind === "failed" ? read.message : null} />
    </JoinCard>
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
