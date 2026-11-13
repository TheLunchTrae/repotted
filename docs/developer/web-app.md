# The web app

The web app runs at <https://repotted.dev> on one Cloudflare Worker, in
`packages/web`. The Worker serves the app's static files and handles the
GitHub App's web sign-in on the same origin, so the sign-in needs no
cross-origin requests and the client secret stays on the server. The page is a
placeholder that signs in and shows the signed-in user; the app's UI moves to
it later.

## Layout

- `src/worker.ts`: the Worker. It answers only `/api/*`.
- `src/session.ts`: the page's access token, refreshed through the Worker.
- `src/page.ts`: the placeholder page.
- `static/`: the HTML, the CSS, and `_headers`, the headers Cloudflare adds to
  every static file.
- `build.ts`: copies `static/` into `dist/` and bundles the page into
  `dist/app.js`. Wrangler runs it before every deploy and dev session.
- `wrangler.jsonc`: the Worker's config. `assets.run_worker_first` sends only
  `/api/*` to the Worker; Cloudflare serves every other path from `dist/`, and a
  path with no file gets `index.html`, for the app's own routes. The Worker's
  custom domain is `repotted.dev`, and its `workers.dev` and preview URLs are
  off, since GitHub returns a sign-in only to the callback URLs the App lists.

The Worker and the page run on web platform APIs, so
`packages/web/tsconfig.json` checks them with the DOM library in place of
Node's types; `build.ts` runs under Node and the root config checks it.

## Sign-in

The web app signs in with the Repotted App's web flow, with PKCE. The
[GitHub App](github-app.md) page covers the App itself.

| Endpoint                  | What it does                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/auth/sign-in`   | Makes a state and a PKCE verifier, keeps both in a 10-minute cookie, and sends the browser to GitHub with the state and the verifier's S256 challenge.                                                       |
| `GET /api/auth/callback`  | Checks the state against the cookie, trades the code for tokens with the verifier and the client secret, keeps the refresh token in a cookie, and sends the browser to `/`. A failure goes to `/?sign-in=…`. |
| `POST /api/auth/token`    | Trades the refresh token for an access token, which it returns with its expiry, and keeps the new refresh token GitHub issues with it.                                                                       |
| `POST /api/auth/sign-out` | Clears the refresh token's cookie.                                                                                                                                                                           |

The page holds only the access token, in memory, and calls GitHub's API with
it directly; GitHub's API allows cross-origin requests. Each tab refreshes when
its token is within five minutes of expiry, as the CLI does.

Both cookies are `HttpOnly`, `Secure`, and named with the `__Host-` prefix, so
the page's scripts can't read them and no subdomain or plain-HTTP page can set
them. The refresh token's cookie is `SameSite=Strict` and lasts as long as the
refresh token, six months. The sign-in's cookie is `SameSite=Lax`, since the
browser returns from GitHub on a cross-site navigation, which carries only Lax
cookies.

The two `POST` endpoints refuse a request whose `Origin` isn't the site's own,
so another site's page can't refresh or sign the user out. Every API response
is `Cache-Control: no-store`.

GitHub spends a refresh token when it issues the next one, so two refreshes
with the same cookie leave one of them refused. The page runs refreshes and
sign-out under one [Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API)
across the site's tabs, so each refresh sends the cookie the one before it
stored. A refused refresh leaves the cookie alone, since clearing it could
replace a newer token that another tab stored meanwhile. Sign-out ends the
sign-in in this browser; other open tabs keep their access token until it
expires, and the authorization stays on the user's GitHub account until they
revoke it there. [State machines](state-machines.md#web-sign-in) lists each
transition.

## Headers

`static/_headers` sets a Content Security Policy on every static file: scripts,
styles, and requests come only from the site, plus requests to
`api.github.com` and images from `avatars.githubusercontent.com`. The page
loads no third-party script, and nothing may frame it. It also sends no
referrer.

## Run it locally

Wrangler serves the Worker and the assets together at
`http://localhost:8787`, rebuilding on changes. Sign-in needs a GitHub App that
lists `http://localhost:8787/api/auth/callback` as a callback URL, and its
client ID and a client secret in `packages/web/.dev.vars`, which git ignores:

```sh
REPOTTED_CLIENT_ID=Iv23...
REPOTTED_CLIENT_SECRET=...
```

```sh
mise run ts:install
cd packages/web
pnpm run dev
```

Browsers keep `Secure` cookies on `localhost`, though some, such as Safari,
don't, and sign-in there fails.

`mise run ts:web:check` builds the site and runs `wrangler deploy --dry-run`,
which bundles the Worker and reads the assets as a deploy does and uploads
nothing. The gate runs it, and Vitest runs `packages/web/tests`.

## Deploy

The Deploy Web workflow, `.github/workflows/deploy-web.yml`, deploys `main` to
repotted.dev. Like the [release workflows](releasing.md), only the owner starts
it, with **Run workflow** on `main`; no push or other event does, so a merge
never changes the live site by itself. It runs `ts:web:check` from the locked
downloads, then `wrangler deploy` with the client ID as a variable and the
client secret as a secret, uploaded with the code, so no version runs without
it. The first deploy replaces the Worker created in the dashboard and attaches
its custom domain.

A run takes everything from the `deploy-web` environment, which allows only
`main`:

| Name                     | Kind     | Value                                                                             |
| ------------------------ | -------- | --------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`   | Secret   | A Cloudflare API token with the permissions below.                                |
| `CLOUDFLARE_ACCOUNT_ID`  | Variable | The Cloudflare account that holds the `repotted.dev` zone.                        |
| `REPOTTED_CLIENT_ID`     | Variable | The Repotted App's client ID, as in `app.clientId` in `packages/cli/src/auth.ts`. |
| `REPOTTED_CLIENT_SECRET` | Secret   | A client secret generated in the Repotted App's settings.                         |

GitHub reserves names that start with `GITHUB_`, so the App's values use
`REPOTTED_`, and the Worker reads them under the same names.

The API token uses Cloudflare's
[Workers roles](https://developers.cloudflare.com/workers/authorization/workers/)
and needs, and is given only:

- Workers, Editor, scoped to the `repotted` Worker: deploys new versions of
  it, with their assets, variables, and secrets. Editor can't create a
  Worker, so the Worker is created once in the dashboard, named `repotted` as
  in `wrangler.jsonc`, before the first deploy replaces it.
- Zone `repotted.dev`, Workers Routes, Write: attaches the custom domain.
  Cloudflare creates the domain's DNS record itself, so the token needs no DNS
  permission.

Cloudflare's page notes that custom domains don't yet support per-Worker
roles. If a deploy fails at the custom domain, attach `repotted.dev` to the
Worker once in the dashboard, under the Worker's **Domains & Routes**, and run
the deploy again; a deploy that leaves the domain as it is needs only Editor
on the Worker. If it still fails there, the token needs Workers Editor for
the whole account instead of the one Worker.

The Worker keeps nothing between requests, so it needs no KV, R2, or D1, and
the token no permission for them.

Before the first deploy:

1. Add `repotted.dev` to the Cloudflare account and point its nameservers at
   Cloudflare, so the zone is active.
2. Create a Worker named `repotted` in the dashboard, and the API token above.
3. In the Repotted App's settings, add the callback URL
   `https://repotted.dev/api/auth/callback`, keep **Expire user authorization
   tokens** on, and generate a client secret.
4. Create the `deploy-web` environment with the values above, limited to
   `main`.
