# The web app

The web app runs at <https://repotted.dev> on a Cloudflare Worker, `repotted`,
in `packages/web`, and a preview of it runs on the same Worker at
<https://main.preview.repotted.dev>. The Worker serves the app's static files
and handles the GitHub App's web sign-in on the same origin, so the sign-in
needs no cross-origin requests and the client secret stays on the server. The
page runs the [engine](#the-engine) itself and calls GitHub's API from the
browser. It signs in and lists the user's repositories.

## Layout

- `src/worker.ts`: the Worker. It answers only `/api/*`.
- `src/session.ts`: the page's access token, refreshed through the Worker, and its calls to GitHub, which skip the browser's cache so a read shows changes made elsewhere.
- `src/main.tsx`: the page's entry. It makes the session, the engine's GitHub
  client, and the account, and renders the app.
- `src/app/`: the app's state. Each part, such as `Account` and
  `Repositories`, is a class that keeps its state in
  [signals](https://github.com/preactjs/signals) and has no DOM in it, so the
  tests drive it against the in-memory GitHub.
- `src/views/`: [Preact](https://preactjs.com/) components that draw that
  state and call its methods. They hold no state of their own beyond what a
  control needs, such as an open menu.
- `src/engine/`: what the engine needs to run in the page: its files, and its
  GitHub client for the session.
- `aliases.ts`: the engine's Node modules and what stands in for each in the
  page. `build.ts` and the root `vitest.config.ts` both read it.
- `static/`: the HTML, the CSS, the fonts, and `_headers`, the headers
  Cloudflare adds to every static file.
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
the rules about what Repotted may write stay in one place. The only Node
modules the engine runs are `node:fs/promises` and `node:path`; everything else it uses,
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
`tests/engine.test.ts` runs its profile, staged apply, and batch flows on the
in-memory one, through the same aliases, in Vitest's `web` project. A Node module that the engine
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

## The app

`App` draws the sign-in page until `Account` reads who is signed in, and the
shell with its pages after. A 401 from GitHub anywhere in the app means the
sign-in no longer works, so the part that met it calls `Account.refused`, and
the app returns to the sign-in page with why.
[State machines](state-machines.md#web-account) lists the transitions.

The look follows the approved mock-ups: `static/app.css` holds their colors,
with a light and a dark value where the two differ, which the system's
setting picks, and the
Atkinson Hyperlegible fonts are served from `static/fonts/`. All text is in
sentence case: only the first word and proper names are capitalized.

Choices that belong to the browser, such as where profiles are kept, are in
`localStorage` through `Preferences`, under keys that start with `repotted:`.
They are not kept per account.

Choices that follow the user, such as the owners and repositories the list
hides and the user's folders, go through `SharedPreferences`
(`src/app/shared-preferences.ts`), which has the same `read` and `write`, and
`update`, which saves a change to a value, such as adding a name to a list,
rather than the value. While profiles are kept in a config repository, it
keeps them in `.repotted-preferences.json` beside the profiles and commits
each change there through the contents API; otherwise it passes them to the
browser's `Preferences`. The file is a JSON object keyed by preference key,
such as `hidden-repositories`, `hidden-repository-owners` and
`repository-folders`, with keys in order so a commit changes only the values
that did. It is a hidden file, so a profile sync and the profile list leave
it alone. Another list setting that should follow the user takes its own key
in the same file, and changes it through `update`, as folders do. A choice
that changes often and matters to one browser, such as which folders are
closed (`closed-repository-folders`), goes straight to the browser's
`Preferences` instead, so it never makes a commit. Nothing moves between the
browser and the file when the profiles move.
[State machines](state-machines.md#web-shared-preferences) lists the
transitions.

`Router` holds the page's address, and `Link` changes it without loading the
page again. The Worker's asset config answers every path with `index.html`,
so an address works when opened directly.

## Profiles

`Profiles` (`src/app/profiles.ts`) holds where the profiles are kept, how the
last sync went, and the list the sidebar draws. Profiles are files in the
engine's in-memory files, in one of three folders:

- `/profiles/browser`, for profiles kept in this browser only.
- `/profiles/folder`, the working copy of a folder on the user's computer,
  which `syncLocalFolder` keeps in line with the folder through the File
  System Access API. Only Chromium browsers have that API, so elsewhere
  Settings offers no folder. `src/engine/local-folders.ts` holds the API's
  calls and keeps the folder's handle in an IndexedDB database of its own;
  the browser asks the user again on each visit before the page may use it.
- `/profiles/github/<owner>/<name>/@<folder>`, a working copy of a folder in
  a config repository, with the engine's sync record in it. `syncFolder`
  brings it and the repository in line through GitHub's API, as it does a
  folder on disk for the CLI, so conflicts and first syncs follow
  [the same rules](state-machines.md#config-repository-sync).

Syncs, new profiles, deletions, and changes of where profiles are kept take
turns in one queue, so a sync never reads a folder that is being changed. A
capture reads GitHub with the engine's `captureProfile` before it takes its
turn, so a slow read holds nothing up.
[State machines](state-machines.md#web-profiles-source) lists the
transitions.

`ProfileEditor` (`src/app/profile-editor.ts`) is the open profile's settings
and its unsaved changes. `setting-fields.ts` lists the settings it offers,
tab by tab, with what each depends on; a test sets every one through the
engine, so a setting the engine doesn't take fails there. A change is
previewed with the engine's `previewProfile` and saved with `editProfile`,
which writes only the settings that changed and keeps the file's comments.
Rulesets, environments, and labels are written whole. `entry-forms.ts` has
the functions that change one thing in an entry and leave the rest of it as
the file has it, and `entry-edits.ts` holds each change with the saved entry
it was made on, so a save never writes an entry over one that has since
changed elsewhere. `views/entries.tsx` only draws them.

`comparison.ts` compares a repository with a profile: the engine's
`createPlan` over the resolved profile, shown as rows by section, with
`lockChanges` marking what the account's access can't change.

`apply.ts` applies a profile to a repository through the engine's staged
apply, a file the browser keeps, so that leaving changes out and picking an
apply up later are the engine's own. It reviews with `planStagedApply` and
writes with `applyPlan`, which plans again and refuses when the repository
has changed.
Its first step is the profile editor over the staged apply's file: an
`EditorStore` gives `ProfileEditor` the functions that read, preview, and
write its file, the engine's profile functions for a profile and its staged
apply functions for an apply.

`batch-apply.ts` does the same for several repositories through the engine's
batch, whose members are the staged applies of single applies, so one can
join the other.

`action-pattern-checks.ts` asks GitHub what each allowed action pattern
matches, with the engine's `checkActionPatterns`, and keeps the answers by
pattern text. `action-search.ts` searches GitHub for repositories to add to
the list, with the engine's `findActions`. `Profiles` gives each editor its
own of both.

`setting-search.ts` finds settings by the words typed: each must start a
word of the setting's label, key, note, choices, group, tab, or the other
names it lists, and a sub-option is also found by the setting it sits under.

The editor opens on the file's own [draft](architecture.md#drafts) and saves
two ways, as [the draft's table](state-machines.md#the-draft) lists. Each
row has what applies, the draft, and the change over them, and one function
for settings and one for entries turn how a row ends into the engine's
edits for each kind of save, so a preview, a save, and a save as a draft
agree on what a row means.

`keepFiles` (`src/app/kept-files.ts`) keeps the in-memory files across
visits: it loads what IndexedDB holds into memory before the app draws, then
writes each change there in order, by the file's path. So a working copy,
with saves that haven't reached GitHub, is there on the next visit. The
engine's temporary files are not kept. In a browser that gives the site no
storage, the files last for the visit, and Settings says so.

What is kept must be the files as they were at one moment, or a later sync
can take a profile the browser lost for one the user deleted. So one tab
keeps the files at a time, under a Web Lock that it holds until it closes,
and a second tab shows a page that says so. And the first change that can't
be kept, such as when storage is full, is the last one tried: a notice says
that changes last until the tab closes.
[State machines](state-machines.md#web-kept-files) lists the states.

The profiles belong to the browser, not to the signed-in account, as a
folder on disk does for the CLI.

## Headers

`static/_headers` sets a Content Security Policy on every static file: scripts,
styles, fonts, and requests come only from the site, plus requests to
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
