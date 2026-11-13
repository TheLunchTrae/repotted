# The GitHub App

Repotted signs in with its own GitHub App, the Repotted App. A GitHub App
reaches only the repositories it is installed on, with only the permissions it
asks for. The user-facing steps are
in [Sign in](../user/sign-in.md).

## Sign-in

`packages/cli/src/device-flow.ts` runs GitHub's device flow: it requests a
code, polls at the interval GitHub asks for, including `slow_down`, and
refreshes tokens. Device-flow tokens refresh without a client secret, so the
published package holds nothing secret.

`packages/cli/src/auth.ts` keeps the token in the OS keychain through
`@napi-rs/keyring`, loaded on first use so that commands given `GITHUB_TOKEN`
still run where the native module or a keychain is missing. On Linux the token
goes only to the Secret Service: the library's fallback, the kernel keyring,
forgets the token at reboot and isn't shared between sessions, so Repotted
fails instead and the user turns to `GITHUB_TOKEN` or the GitHub CLI.

A user token expires after eight hours, and each refresh lasts six months.
Repotted refreshes a token that is within five minutes of expiry before using
it, so it can't lapse partway through an apply. A refresh token works once, so
when a refresh fails, Repotted first takes a token that another run refreshed
and stored in the meantime.

`REPOTTED_GITHUB_CLIENT_ID` signs in with another GitHub App, given its client
ID.

## Where the token comes from

`resolveToken` in `auth.ts` takes the first token it finds, in the order
[Sign in](../user/sign-in.md#use-a-token-instead) lists. The environment
variables come first so CI and scripts can override a sign-in. The GitHub CLI's
token is read with `gh auth token --hostname github.com`, since requests go to
api.github.com. Apart from the keychain entry, a token is only ever held in
memory.

`repos` lists the Repotted App's installations, which GitHub only gives to a
token from that App. Any other token lists every repository the account
administers, though the token itself may not be allowed to change them.

## Register the App

The Repotted App is owned by the project's owner. Its client ID and slug are
`app.clientId` and `app.slug` in `packages/cli/src/auth.ts`. The client ID is
public; the device flow needs no client secret or private key, so the CLI and
the desktop app hold none. The gate fails if `app.clientId` is empty.

The [web app](web-app.md) signs in with the App's web flow, whose code
exchange needs a client secret. Only its Worker holds one, as a Worker secret
set once in Cloudflare; Deploy Web never sees it.

Its settings, which a replacement App, registered under Settings, Developer
settings, GitHub Apps, New GitHub App, uses too:

- Name: Repotted App. Its slug, the name as GitHub writes it in URLs, must
  match `app.slug`. Homepage: the repository's URL.
- Callback URLs: `https://repotted.dev/api/auth/callback` and
  `https://main.preview.repotted.dev/api/auth/callback`, for the web app and
  its preview.
  Leave **Request user authorization (OAuth) during installation** off, turn
  on **Enable Device Flow**, and leave **Expire user authorization tokens**
  on; the web app can't keep a sign-in without the refresh token that
  expiring tokens bring.
- Client secret: one, for the web app's Worker. To rotate it, generate a new
  one, set it as the `repotted` Worker's `REPOTTED_APP_CLIENT_SECRET` for
  production and for its `main` Preview, then delete the old one.
- Webhook: clear **Active**.
- Repository permissions: Administration, Actions, Contents, Pages,
  Custom properties and Issues, read and write; Code scanning alerts, read; and
  Metadata, read, which GitHub requires. No other permissions and no events.
  [Settings coverage](settings-coverage.md#permissions-the-repotted-app-needs)
  says what needs each one.
- Where it can be installed: any account.

Then copy the client ID, not the App ID, into `app.clientId`.

The App's permissions can change later in its settings. GitHub asks each
installation's owner to accept added permissions, and until they do, the App
keeps the old ones on that installation. Removed permissions take effect at
once, so older Repotted versions that still need them stop working.
