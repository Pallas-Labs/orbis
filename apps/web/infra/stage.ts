/** The stage that serves friends. `bun run deploy` names it. */
export const PROD_STAGE = "prod";

const HOST = "orbis.p11a.xyz";

/** What a stage may claim outside its own Workers. */
export interface StagePlan {
  /** The API address the page calls. Unset: the stage's own API Worker. */
  readonly apiUrl: string | undefined;
  /** The API Worker's zone routes. */
  readonly routes: readonly { pattern: string; zoneName: string }[];
  /** The web Worker's hostname. Absent: its workers.dev address only. */
  readonly web: { readonly domain?: string };
}

/**
 * Only `prod` owns `orbis.p11a.xyz` and its `/api/*` route. A hostname has one Worker, so any other
 * stage that named it would take it from production. Every other stage, such as `pr-12` or a
 * personal `dev_*` stage, keeps to its own workers.dev addresses and its own API.
 */
export const stagePlan = (stage: string): StagePlan =>
  stage === PROD_STAGE
    ? {
        apiUrl: `https://${HOST}/api`,
        routes: [{ pattern: `${HOST}/api/*`, zoneName: "p11a.xyz" }],
        web: { domain: HOST },
      }
    : { apiUrl: undefined, routes: [], web: {} };
