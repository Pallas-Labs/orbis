# PAL-1042 evidence

Made by `node apps/web/e2e/pair.mjs` on Vanta (headless Chromium).

- `before-pair-failed.png`: origin/main `b22dd38` with the new journey step. The first `find` POST is aborted; the card has no action, and the run fails waiting for Try again.
- `after-pair-failed.png`: branch head `a2a65f4`, same step. The card shows Try again.
- `pair-red.log`: the failing run on origin/main.
- `result.json`: the passing run on the branch; the failed-lookup step records 2 `find` requests and an `approved` wait.
