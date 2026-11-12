import * as stylex from "@stylexjs/stylex";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
} from "@tanstack/react-router";

import { LiveEventsProvider } from "@/components/live-events";
import { PlayerProvider } from "@/components/player/player";
import { RouteProblem } from "@/components/route-problem";
import { Button } from "@/components/ui/button";
import { detach } from "@/lib/detach";
import { NAV_ITEMS } from "@/lib/nav";
import { FAILURE_MESSAGES, fetchMe } from "@/lib/orbis";
import type { Credentials, Person } from "@/lib/orbis";
import { forgetKey, readKey } from "@/lib/stored-key";
import { layout } from "@/styles/layout";
import { colors, space } from "@/styles/tokens.stylex";
import { type } from "@/styles/type";

const styles = stylex.create({
  account: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: space[3],
    marginLeft: "auto",
    minWidth: 0,
  },
  header: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: space.px,
    columnGap: space[6],
    display: "flex",
    flexWrap: "wrap",
    paddingBlock: space[3],
    paddingInline: space[6],
    rowGap: space[3],
  },
  nav: {
    columnGap: space[4],
    display: "flex",
    flexWrap: "wrap",
    order: { "@media (min-width: 40rem)": 0, default: 3 },
    rowGap: space[2],
    width: { "@media (min-width: 40rem)": "auto", default: "100%" },
  },
  shell: { display: "flex", flexDirection: "column", minHeight: "100svh" },
});

const activeNavProps = {
  "aria-current": "page",
  ...stylex.props(type.medium),
} as const;

/** The signed-in Person, and what every call from their pages carries. */
export interface Session extends Credentials {
  readonly person: Person;
}

const AppShell = ({ session }: { readonly session: Session }) => {
  const navigate = useNavigate();
  const signOut = async () => {
    forgetKey();
    await navigate({ to: "/sign-in" });
  };
  return (
    <div {...stylex.props(styles.shell)}>
      <header {...stylex.props(styles.header)}>
        <Link {...stylex.props(type.medium, layout.focusOutline)} to="/">
          Orbis
        </Link>
        <nav aria-label="Main" {...stylex.props(styles.nav, type.sm)}>
          {NAV_ITEMS.filter(
            (item) => session.person.host || !item.hostOnly
          ).map((item) => (
            <Link
              activeOptions={{ exact: true }}
              activeProps={activeNavProps}
              {...stylex.props(type.muted, layout.focusOutline)}
              key={item.to}
              to={item.to}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div {...stylex.props(styles.account, type.sm)}>
          <span {...stylex.props(type.muted)}>
            Signed in as {session.person.username}
          </span>
          <Button onClick={detach(signOut)} size="sm" variant="outline">
            Sign out
          </Button>
        </div>
      </header>
      <LiveEventsProvider credentials={session}>
        <PlayerProvider credentials={session}>
          <Outlet />
        </PlayerProvider>
      </LiveEventsProvider>
    </div>
  );
};

// The session the shell shows. A reload while Orbis cannot be reached keeps it,
// so the shell and its live stream stay up and show that they are reconnecting.
// oxlint-disable-next-line orbis/no-module-level-mutable-state -- this route sets `ssr: false`, so the binding lives in one browser tab, never on the Worker.
let shown: Session | undefined;

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ cause, context }) => {
    const key = readKey();
    if (key === null) {
      throw redirect({ to: "/sign-in" });
    }
    const credentials = { apiUrl: context.apiUrl, key };
    const me = await fetchMe(credentials);
    if (me.ok) {
      const session: Session = { ...credentials, person: me.value };
      shown = session;
      return { session };
    }
    if (
      me.failure === "unreachable" &&
      cause === "stay" &&
      shown?.key === key
    ) {
      return { session: shown };
    }
    if (me.failure === "rejected") {
      forgetKey();
      throw redirect({ search: { notice: "expired" }, to: "/sign-in" });
    }
    throw new Error(FAILURE_MESSAGES[me.failure]);
  },
  // The route hands its own context down, which keeps the context's type exact.
  component: () => <AppShell session={Route.useRouteContext().session} />,
  errorComponent: RouteProblem,
  // The key lives in the browser, so signed-in pages never render on the Worker.
  ssr: false,
});
