# The web app

The web app runs at <https://repotted.dev> on a Cloudflare Worker, `repotted`,
in `packages/web`, and a preview of it runs on the same Worker at
<https://main.preview.repotted.dev>. The Worker serves the app's static files
and handles the GitHub App's web sign-in on the same origin, so the sign-in
needs no cross-origin requests and the client secret stays on the server. The
page runs the [engine](#the-engine) itself and calls GitHub's API from the
browser. It is a placeholder that signs in and shows the signed-in user; the
app's UI moves to it later.

## Layout

- `src/worker.ts`: the Worker. It answers only `/api/*`.
- `src/session.ts`: the page's access token, refreshed through the Worker.
- `src/page.ts`: the placeholder page.
- `src/engine/`: what the engine needs to run in the page: its files, and its
  GitHub client for the session.
- `aliases.ts`: the engine's Node modules and what stands in for each in the
  page. `build.ts` and the root `vitest.config.ts` both read it.
- `static/`: the HTML, the CSS, and `_headers`, the headers Cloudflare adds to
  every static file.
- `build.ts`: copies `static/` into `dist/` and bundles the page into
  `dist/app.js`. Wrangler runs it before every deploy and dev session.
- `wrangler.jsonc`: the Worker's config. `assets.run_worker_first` sends only
  `/api/*` to the Worker; Cloudflare serves every other path from `dist/`, and a
  path with no file gets `index.html`, for the app's own routes. The Worker's
  `workers.dev` address and Version URLs are off, and its `previews` block
  holds what the [preview](#deploy) needs. The custom domains are set in the
  dashboard, not here; [Deploy](#deploy) says why.

The Worker and the page run on web platform APIs, so
`packages/web/tsconfig.json` checks them with the DOM library in place of
Node's types; `build.ts` runs under Node and the root config checks it.

## The engine

The page bundles `packages/core` and calls it directly, as the CLI does, so
the rules about what Repotted may write stay in one place. The engine's only
Node modules are `node:fs/promises` and `node:path`; everything else it uses,
such as hashing and base64, is on the web platform, which Node has too.
`aliases.ts` maps those two modules for the page's bundle:

- `node:fs/promises` to `src/engine/files.ts`, a tree of files in memory. It
  has the functions the engine calls, with Node's error codes, and no links
  or permissions. `watchFiles` reports each file written or removed, which is
  how a store keeps what the engine writes.
- `node:path` to `src/engine/path.ts`, POSIX paths under `/`.

So a profile, a staged apply, and a batch are files at absolute paths in the
page too, and the engine's functions take the same arguments there as under
Node. The engine's own tests run on Node's file system;
`tests/engine.test.ts` runs its file flows on the in-memory one, through the
same aliases, in Vitest's `web` project. A Node module that the engine
imports and `aliases.ts` doesn't map fails the build, which `ts:web:check`
runs.

`src/engine/github.ts` gives the engine a GitHub client that sends each
request with the session's current access token. A browser that isn't signed
in gets a 401, as a refused token does, so one check covers both.

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
lists `http://localhost:8787/api/auth/callback` as a callback URL, and a client
secret for it in `packages/web/.dev.vars`, which git ignores. For an App other
than the Repotted App, its client ID goes there too, in place of the one in
`wrangler.jsonc`:

```sh
REPOTTED_APP_CLIENT_SECRET=...
REPOTTED_APP_CLIENT_ID=Iv23...
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
changes the site by itself. It runs `ts:web:check` from the locked downloads,
then deploys the Worker.

Its **Publish** input picks where, as Publish picks a test build or a release
in the release workflows:

| Publish          | Command                            | Where it runs                       |
| ---------------- | ---------------------------------- | ----------------------------------- |
| Off, the default | `wrangler preview --name <branch>` | <https://main.preview.repotted.dev> |
| On               | `wrangler deploy`                  | <https://repotted.dev>              |

A preview deploys a Preview named for the run's branch, one of Cloudflare's
[Worker Previews](https://developers.cloudflare.com/workers/previews/), under
the same `repotted` Worker. The name is the branch made a DNS label: lowercase,
with each run of other characters turned into a hyphen and cut to 40
characters, so `feature/Sign-in` would be `feature-sign-in`. Deploy Web runs
only on main, so today that is the `main` Preview. Previews of other branches
would also need the branch rule loosened in the workflow and the environment,
and each Preview's callback URL added to the Repotted App.

repotted.dev keeps serving its own version, and
each preview replaces the last one at the same address, which the run's
summary and its environment link give. The Preview keeps its earlier
deployments, each at its own `<deployment id>-main.preview.repotted.dev`
address, until it reaches Cloudflare's limit of 100 and drops the oldest.

Previews take their address from the custom domain `preview.repotted.dev`,
attached to the Worker for Previews only, as
`<preview name>.preview.repotted.dev`. Cloudflare adds a wildcard DNS record
and certificate for `*.preview.repotted.dev`; the first certificate can take a
while to issue. The preview is public, as repotted.dev is, unless Cloudflare
Access is put in front of it.

The client ID is public, so it is a variable in `wrangler.jsonc`, the same ID as
`app.clientId` in `packages/cli/src/auth.ts`; a CLI test fails when they differ.
Previews take none of the production variables, so it is set again in the
`previews` block. The client secret is set once as the Worker secret
`REPOTTED_APP_CLIENT_SECRET`, in the dashboard or with `wrangler secret put`,
and once for Previews, as below. Wrangler never deletes a Worker's secrets:
every deploy keeps the ones the version before it had, and every preview
deployment the ones the Preview had, so the workflow never handles the secret.

A change to the Previews Base reaches only Previews created after it, so
rotating the secret sets it in three places: production, the Previews Base, and
the `main` Preview, with
`wrangler preview secret put REPOTTED_APP_CLIENT_SECRET --name main`.

The sign-in's cookies are named with `__Host-`, so the browser keeps them for
the one host that set them: a sign-in on the preview never reaches
repotted.dev, or the other way round. Each site keeps its own sign-in, and its
own browser storage.

The workflow takes its values from the `deploy-web` environment, which allows
only `main`:

| Name                    | Kind     | Value                                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Secret   | A Cloudflare API token with the permission below.                         |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | The Cloudflare account that holds the Worker and the `repotted.dev` zone. |

The API token needs one permission, from Cloudflare's
[Workers roles](https://developers.cloudflare.com/workers/authorization/workers/):
Workers, Editor, scoped to the `repotted` Worker. That covers deploying the
Worker and its Previews with their assets and variables, and setting the
Worker's `workers.dev` address and Version URLs. Editor can't create a Worker,
so the Worker is created once in the dashboard, named `repotted`, before the
first deploy replaces it.

The custom domains need zone permissions that a token scoped to Workers can't
have, so they are attached once in the dashboard rather than in
`wrangler.jsonc`. Wrangler changes a Worker's custom domains only for those its
config lists; with none listed, a deploy leaves the dashboard's domains as they
are. Had the config listed them, every deploy would set them again, and in CI
would replace any other DNS record on the names without asking.

A custom domain sends every path on its host to the Worker, and the asset
config answers the app's own paths with `index.html`, so the app needs no
Cloudflare Route. A Route such as `*.repotted.dev/` matches `/`, with no query
string, on every subdomain of the zone, the preview's hosts included. A Route
takes precedence over a custom domain on the same host and always runs the
production version, so the preview's `/`, where sign-in returns, would get
production's page. Add no Route, and delete any that exists.

`preview_urls` is set to `false`, though that follows from `workers_dev`,
because Wrangler leaves the Worker's Version URLs as they were when it is
unset. The next publish turns them off.

The Worker keeps nothing on the server between requests, so it needs no KV,
R2, or D1, and the token no permission for them.

Before the first deploy:

1. Add `repotted.dev` to the Cloudflare account and point its nameservers at
   Cloudflare, so the zone is active.
2. Create the `repotted` Worker in the dashboard. In its **Settings**, under
   **Domains & Routes**, add the custom domain `repotted.dev`, enabled for
   production, and `preview.repotted.dev`, enabled for Preview. Add no
   Route.
3. Create the API token above.
4. In the Repotted App's settings, add the callback URLs
   `https://repotted.dev/api/auth/callback` and
   `https://main.preview.repotted.dev/api/auth/callback`, keep **Expire user
   authorization tokens** on, and generate a client secret.
5. In the Worker's **Settings**, add the client secret as the secret
   `REPOTTED_APP_CLIENT_SECRET` under both **Production** and **Previews
   Base**. A new Preview copies the base secrets when it is created, so set it
   before the first preview; for a Preview that already exists, run
   `wrangler preview secret put REPOTTED_APP_CLIENT_SECRET --name main`.
6. Create the `deploy-web` environment with the values above, limited to
   `main`.
