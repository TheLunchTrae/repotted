# The web app

The web app runs at <https://repotted.dev> on a Cloudflare Worker, in
`packages/web`, and a second copy of that Worker serves previews at
<https://preview.repotted.dev>. Each serves the app's static files and handles
the GitHub App's web sign-in on its own origin, so the sign-in needs no
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
  `workers.dev` address and Cloudflare's per-version preview URLs are off,
  since GitHub returns a sign-in only to the callback URLs the App lists. Its
  `preview` environment is the preview Worker. The custom domains are set in
  the dashboard, not here; [Deploy](#deploy) says why.

The Worker and the page run on web platform APIs, so
`packages/web/tsconfig.json` checks them with the DOM library in place of
Node's types; `build.ts` runs under Node and the root config checks it.

## Sign-in

The web app signs in with the Repotted App's web flow, with PKCE. The
[GitHub App](github-app.md) page covers the App itself.

| Endpoint                  | What it does                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/sign-in`   | Makes a state and a PKCE verifier, keeps both in a 10-minute cookie, and sends the browser to GitHub with the state and the verifier's S256 challenge.                                                          |
| `GET /api/auth/callback`  | Checks the state against the cookie, trades the code for tokens with the verifier and the client secret, keeps both tokens in cookies, and sends the browser to `/`. A failure goes to `/?sign-in=…`.           |
| `POST /api/auth/token`    | Returns the kept access token and its seconds left. When that token has 5 minutes or less left, or the request names it as one GitHub refused, it first trades the refresh token for new tokens and keeps both. |
| `POST /api/auth/sign-out` | Clears both tokens' cookies.                                                                                                                                                                                    |

The page calls GitHub's API directly with the access token; GitHub's API
allows cross-origin requests. Each tab holds the token in memory and asks the
Worker again when it is within 5 minutes of expiry, timed on the browser's own
clock from the seconds left the Worker returned.

GitHub revokes the old access token whenever a refresh token is used, so every
tab has to share one access token: a tab that refreshed for itself would cut
off the others. The Worker keeps the current access token in a cookie and hands
it to every tab while it has more than 5 minutes left, and refreshes only after
that. The page runs every request for a token, and sign-out, under one
[Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) across the
site's tabs, so no two refreshes send the same refresh token, which works only
once. When GitHub's API refuses a tab's token anyway, the tab names that token
to the Worker, which hands back a newer one if another tab already got it, or
refreshes otherwise, and the tab tries once more.

Both token cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, and named with
the `__Host-` prefix, so the page's scripts can't read them and no subdomain or
plain-HTTP page can set them. The refresh token's cookie lasts as long as the
refresh token, six months; the access token's as long as it, eight hours. The
sign-in's cookie is `SameSite=Lax`, since the browser returns from GitHub on a
cross-site navigation, which carries only Lax cookies.

The two `POST` endpoints refuse a request whose `Origin` isn't the site's own,
so another site's page can't fetch a token or sign the user out. Every API
response is `Cache-Control: no-store`. The Worker waits 10 seconds for GitHub's
token endpoint and the page 20 seconds for the Worker, and either reads a
timeout as GitHub being out of reach.

A refused refresh leaves the cookies alone, since clearing them could replace
newer tokens that another tab stored meanwhile. Sign-out ends the sign-in in
this browser; other open tabs keep the access token they hold until it
expires, and the authorization stays on the user's GitHub account until they
revoke it there. [State machines](state-machines.md#web-sign-in) lists each
transition.

## Headers

`static/_headers` sets a Content Security Policy on every static file: scripts,
styles, and requests come only from the site, plus requests to
`api.github.com` and images from `avatars.githubusercontent.com`. The page
loads no third-party script, and nothing may frame it. It also sends no
referrer, and tells browsers to use only HTTPS for repotted.dev for two years.

## Run it locally

Wrangler serves the Worker and the assets together at
`http://localhost:8787`, rebuilding on changes. Sign-in needs a GitHub App that
lists `http://localhost:8787/api/auth/callback` as a callback URL, and its
client ID and a client secret in `packages/web/.dev.vars`, which git ignores:

```sh
REPOTTED_APP_CLIENT_ID=Iv23...
REPOTTED_APP_CLIENT_SECRET=...
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

The Deploy Web workflow, `.github/workflows/deploy-web.yml`, deploys `main`.
Like the [release workflows](releasing.md), only the owner starts it, with
**Run workflow** on `main`; no push or other event does, so a merge never
changes either site by itself. It runs `ts:web:check` from the locked
downloads, then `wrangler deploy` with the client ID as a variable and the
client secret as a secret, uploaded with the code, so no version runs without
it.

Its **Publish** input picks the Worker, as Publish picks a test build or a
release in the release workflows:

| Publish          | Worker             | Site                           |
| ---------------- | ------------------ | ------------------------------ |
| Off, the default | `repotted-preview` | <https://preview.repotted.dev> |
| On               | `repotted`         | <https://repotted.dev>         |

A preview puts `main` live at its own address before it is published. The
preview Worker is `wrangler.jsonc`'s `preview` environment, which takes the
same config and names the Worker `repotted-preview`.

The sign-in's cookies are named with `__Host-`, so the browser keeps them for
the one host that set them: a sign-in on the preview never reaches
repotted.dev, or the other way round. Each site keeps its own sign-in, and its
own browser storage.

Both deploys take their values from the `deploy-web` environment, which allows
only `main`:

| Name                         | Kind     | Value                                                                             |
| ---------------------------- | -------- | --------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`       | Secret   | A Cloudflare API token with the permission below.                                 |
| `CLOUDFLARE_ACCOUNT_ID`      | Variable | The Cloudflare account that holds the Workers and the `repotted.dev` zone.        |
| `REPOTTED_APP_CLIENT_ID`     | Variable | The Repotted App's client ID, as in `app.clientId` in `packages/cli/src/auth.ts`. |
| `REPOTTED_APP_CLIENT_SECRET` | Secret   | A client secret generated in the Repotted App's settings.                         |

GitHub reserves names that start with `GITHUB_`, so the App's values use
`REPOTTED_APP_`, and the Workers read them under the same names.

The API token needs one permission, from Cloudflare's
[Workers roles](https://developers.cloudflare.com/workers/authorization/workers/):
Workers, Editor, scoped to the `repotted` and `repotted-preview` Workers. That
covers deploying new versions with their assets, variables, and secrets, and
turning off the `workers.dev` address and per-version preview URLs. Editor
can't create a Worker, so each Worker is created once in the dashboard, with
the name above, before the first deploy replaces it.

The custom domains need zone permissions that a token scoped to Workers can't
have, so each is attached once in the dashboard rather than in
`wrangler.jsonc`. Wrangler changes a Worker's custom domains only for those its
config lists; with none listed, a deploy leaves the dashboard's domain as it is.
Had the config listed them, every deploy would set them again, and in CI would
replace any other DNS record on the name without asking.

The Workers keep nothing on the server between requests, so they need no KV,
R2, or D1, and the token no permission for them.

Before the first deploy:

1. Add `repotted.dev` to the Cloudflare account and point its nameservers at
   Cloudflare, so the zone is active.
2. Create the `repotted` and `repotted-preview` Workers in the dashboard. In
   each one's **Settings**, under **Domains & Routes**, add its custom domain,
   `repotted.dev` or `preview.repotted.dev`.
3. Create the API token above, scoped to both Workers.
4. In the Repotted App's settings, add the callback URLs
   `https://repotted.dev/api/auth/callback` and
   `https://preview.repotted.dev/api/auth/callback`, keep **Expire user
   authorization tokens** on, and generate a client secret.
5. Create the `deploy-web` environment with the values above, limited to
   `main`.
