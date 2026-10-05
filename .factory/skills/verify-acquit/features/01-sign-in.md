# Sign in as a seeded user

Choose a seeded client or operator without a password. The control CLI can also create a Bearer session for read-only proof queries.

## Sub-features

- `signin-client` opens the client dashboard as `maya-client`.
- `signin-operator` opens the operator job list as `devon-ops`.
- `signin-switch` signs out and chooses the other role.
- `signin-cli` saves a session for authenticated API reads.

## How to get to it (user POV)

- Open `/` without a session and choose a seeded user.
- Choose `Sign out` from the top bar to return to the picker.
- Run the repo's control CLI `login --test-user <handle> --save`.

## Driving it with agent-browser

Preconditions:

- Doctor passes for the owned, seeded verification database.
- Use the `ab` function from the feature index.

- **Open the picker.** Run `ab open http://localhost:5173` and `ab wait --text 'Sign in as a seeded user'`. If already signed in, run `ab find role button click --name 'Sign out' --exact`.
- **Choose the client.** Run `ab find role button click --name maya-client` and `ab wait --text 'Your jobs'`. The top bar shows `maya-client` and `client`.
- **Switch roles.** Run `ab find role button click --name 'Sign out' --exact`, wait for the picker, and run `ab find role button click --name devon-ops`. Run `ab wait --text 'Open jobs'`. The top bar shows `devon-ops` and `operator`.
- **Create CLI evidence auth.** Set `$env:DATABASE_PATH='./data/verify/acquit.db'`. Capture `$login = node packages/ctl/src/main.ts login --test-user devon-ops --save | ConvertFrom-Json`. Require `$login.ok`, `$login.data.handle -eq 'devon-ops'`, and `$login.data.role -eq 'OPERATOR'`. Do not print `$login`.
- **Confirm CLI auth.** Read `data/ctl/sessions/devon-ops.json` in process. Send its token as a Bearer header to `GET http://localhost:4310/api/me/credits`. Require an authenticated response with `credits.available` equal to `30` at baseline. Never log the header.
- **Capture proof.** Run `ab screenshot --full data/evidence/verify-acquit/RUN_STAMP/signin-operator.png`. Save `ab snapshot` to `signin-operator.aria.txt` and a summary without the token.

## Gotchas

- Seed reset invalidates browser cookies and CLI tokens. Sign in after seeding.
- `login --save` prints a token in its JSON result. Always capture that result in memory.
- The picker is development auth, not GitHub OAuth or production sign-up.
- CLI login does not sign the verification browser in. Verify both entry points separately.
