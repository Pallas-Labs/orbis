import {
  Link,
  createFileRoute,
  getRouteApi,
  useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { Problem } from "@/components/problem";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ageText } from "@/lib/dates";
import { approveSignInRequest, findSignInRequest } from "@/lib/devices";
import type { ApprovalRequest } from "@/lib/devices";
import { fetchMe, problemFor } from "@/lib/orbis";
import type { ApiResult, Credentials, Person } from "@/lib/orbis";
import { forgetKey, readKey } from "@/lib/stored-key";

const PLATFORMS: Readonly<
  Record<
    ApprovalRequest["platform"],
    { readonly name: string; readonly noun: string }
  >
> = {
  iOS: { name: "iPhone", noun: "iPhone" },
  macOS: { name: "Mac", noun: "Mac" },
  tvOS: { name: "Apple TV", noun: "TV" },
  web: { name: "Browser", noun: "browser" },
};

const EXPIRED = "This code has expired. Check the TV for a new one.";

/** What a lookup needs. It lives in memory only, so a retry still has the code. */
export interface Lookup {
  readonly code: string;
  readonly credentials: Credentials;
}

type Pairing =
  | { readonly kind: "signed-out" }
  | { readonly kind: "expired" }
  | {
      readonly kind: "failed";
      readonly lookup: Lookup;
      readonly message: string;
    }
  | {
      readonly kind: "asking";
      readonly credentials: Credentials;
      readonly person: Person;
      readonly request: ApprovalRequest;
    }
  | { readonly kind: "approved"; readonly request: ApprovalRequest };

/** A rejected key signs this browser out; a 404 means no device waits with the code. */
const refused = (
  result: Extract<ApiResult<unknown>, { ok: false }>,
  lookup: Lookup
): Pairing => {
  if (result.failure === "rejected") {
    forgetKey();
    return { kind: "signed-out" };
  }
  return result.status === 404
    ? { kind: "expired" }
    : { kind: "failed", lookup, message: problemFor(result) };
};

/**
 * The Approval Code rides in the fragment, which the browser never sends to the
 * Worker. Reading it also takes it out of the address bar and this history entry.
 */
const takeCode = (): string | null => {
  const code = window.location.hash.slice(1);
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname
  );
  return /^\d{6}$/u.test(code) ? code : null;
};

const lookUp = async (lookup: Lookup): Promise<Pairing> => {
  const { code, credentials } = lookup;
  const [me, found] = await Promise.all([
    fetchMe(credentials),
    findSignInRequest(credentials, code),
  ]);
  if (!me.ok) {
    return refused(me, lookup);
  }
  if (!found.ok) {
    return refused(found, lookup);
  }
  return {
    credentials,
    kind: "asking",
    person: me.value,
    request: found.value,
  };
};

const loadPairing = async (apiUrl: string): Promise<Pairing> => {
  const code = takeCode();
  const key = readKey();
  if (key === null) {
    return { kind: "signed-out" };
  }
  if (code === null) {
    return { kind: "expired" };
  }
  return await lookUp({ code, credentials: { apiUrl, key } });
};

const PairCard = ({
  children,
  description,
  title,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly title: string;
}) => (
  <main className="flex min-h-svh items-center justify-center p-6">
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1>{title}</h1>
        </CardTitle>
        {description === undefined ? null : (
          <CardDescription>{description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  </main>
);

const Approve = ({
  onDone,
  pairing: { credentials, person, request },
}: {
  readonly onDone: (next: Pairing) => void;
  readonly pairing: Extract<Pairing, { kind: "asking" }>;
}) => {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const platform = PLATFORMS[request.platform];
  const approve = async () => {
    setBusy(true);
    setProblem(null);
    const result = await approveSignInRequest(
      credentials,
      request.code
    ).finally(() => setBusy(false));
    if (result.ok) {
      onDone({ kind: "approved", request: result.value });
      return;
    }
    const next = refused(result, { code: request.code, credentials });
    if (next.kind === "failed") {
      setProblem(next.message);
    } else {
      onDone(next);
    }
  };
  return (
    <PairCard description={request.label} title={`Sign in ${platform.name}?`}>
      <p className="text-muted-foreground text-sm tabular-nums">
        Asked {ageText(request.requestedAt)} · code {request.code.slice(0, 3)}{" "}
        {request.code.slice(3)}
      </p>
      <p className="text-sm">
        Only sign in a {platform.noun} that is in front of you.
      </p>
      <Problem message={problem} />
      <div className="flex flex-col gap-2">
        <Button disabled={busy} onClick={approve}>
          {busy ? "Signing in…" : `Sign In as ${person.username}`}
        </Button>
        <Button
          disabled={busy}
          onClick={() => navigate({ to: "/" })}
          variant="outline"
        >
          Cancel
        </Button>
      </div>
    </PairCard>
  );
};

// Retries with the kept code: the loader would find the fragment already gone.
const Failed = ({
  onDone,
  pairing: { lookup, message },
}: {
  readonly onDone: (next: Pairing) => void;
  readonly pairing: Extract<Pairing, { kind: "failed" }>;
}) => {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    onDone(await lookUp(lookup).finally(() => setBusy(false)));
  };
  return (
    <PairCard title="Sign in a device">
      <Problem message={message} />
      <Button disabled={busy} onClick={retry} variant="outline">
        {busy ? "Trying again…" : "Try again"}
      </Button>
    </PairCard>
  );
};

const Pair = ({ loaded }: { readonly loaded: Pairing }) => {
  // The page starts at the loader's answer; approving or retrying moves it on.
  const [next, setPairing] = useState<Pairing | null>(null);
  const pairing = next ?? loaded;
  switch (pairing.kind) {
    case "asking": {
      return <Approve onDone={setPairing} pairing={pairing} />;
    }
    case "approved": {
      return (
        <PairCard
          title={`${PLATFORMS[pairing.request.platform].name} is signed in.`}
        >
          <Link
            className={buttonVariants({ variant: "outline" })}
            to="/devices"
          >
            Open Devices
          </Link>
        </PairCard>
      );
    }
    case "expired": {
      return (
        <PairCard title="Sign in a device">
          <Problem message={EXPIRED} />
        </PairCard>
      );
    }
    case "failed": {
      return <Failed onDone={setPairing} pairing={pairing} />;
    }
    case "signed-out": {
      return (
        <PairCard title="Sign in a device">
          <p className="text-sm">Sign in to approve this device.</p>
          <p className="text-muted-foreground text-sm">
            Or open this link on a device where you use Orbis.
          </p>
          <Link className={buttonVariants()} to="/sign-in">
            Sign in
          </Link>
        </PairCard>
      );
    }
    default: {
      const exhaustive: never = pairing;
      return exhaustive;
    }
  }
};

const pairRoute = getRouteApi("/_browser/pair");

const PairPage = () => <Pair loaded={pairRoute.useLoaderData()} />;

export const Route = createFileRoute("/_browser/pair")({
  component: PairPage,
  loader: ({ context }) => loadPairing(context.apiUrl),
});
