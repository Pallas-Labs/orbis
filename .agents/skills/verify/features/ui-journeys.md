# Apple UI journeys

The XCUITest journeys drive the real Orbis app on a leased simulator against a temporary service and export screenshots. They do not gate `verify` yet (factory v2 spec §4.5, "later"); run them when a change alters the Apple UI.

## Sub-features

- `journey-class` runs one journey class, such as `OrbisUITests/PeopleUITests`.
- `journey-flags-on` runs a journey with every flag on, through `-flags all-on`.

## How to get to it (user POV)

- `node scripts/native-lanes.mjs --journeys --only <class>` on a Mac, through `factory lease run --needs simulator`.

## Driving it with factory lease

Preconditions:

- The baseline in [README.md](./README.md), with the change committed.

- **One class.** Run `~/.local/share/factory/bin/factory lease run --needs simulator --device "iPhone 17 Pro" --out <dir> -- sh -c 'bun install --frozen-lockfile && bun run --cwd packages/contracts build && node scripts/native-lanes.mjs --journeys --only OrbisUITests/PeopleUITests --udid "$LEASE_SIMULATOR_UDID"'`. Exit `0`; the screenshots come back to `<dir>`.
- **By hand.** Hold a lease and drive the app with the T3 device hub: [docs/agents/ui-verification.md](../../../../docs/agents/ui-verification.md).

## Gotchas

- On the 8 GB Cortex run one journey class at a time. The MacBook takes tests only from 23:00 to 09:00 America/Los_Angeles, or when Parth opens it.
- A journey with flags on needs `-flags all-on` in the test's launch arguments; no journey sets it yet.
