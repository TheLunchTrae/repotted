# Sign in

Repotted reads and changes repositories through the Repotted GitHub App,
named Repotted App on GitHub. The desktop app, the CLI, and the MCP server
share one sign-in, so signing in with one signs in all three.

## Sign in with GitHub

1. Start the sign-in:
   - In the desktop app, click **Sign in with GitHub**.
   - On the command line, run `npx repotted login`.
   - From an agent, ask it to use any Repotted tool. With no sign-in, the tool
     replies with a code.
2. Repotted shows a code. Open [github.com/login/device](https://github.com/login/device),
   or click **Open GitHub** in the desktop app, and enter the code.
3. Authorize the Repotted App. Repotted finishes signing in on its own.

Repotted keeps the sign-in in your system keychain: Keychain on macOS,
Credential Manager on Windows, and the Secret Service, such as GNOME Keyring
or KWallet, on Linux. The sign-in lasts as long as you use Repotted at least
once every six months.

To sign out, run `npx repotted logout`. Without Node, run the copy of the CLI
that comes with the desktop app instead:

- macOS: `/Applications/Repotted.app/Contents/MacOS/repotted-cli logout`
- Windows: `%LOCALAPPDATA%\Programs\Repotted\repotted-cli.exe logout`

To take away the App's access completely, revoke it in your GitHub settings
under **Applications**.

## Give the App your repositories

The Repotted App reaches only the repositories it is installed on. Install it
on each repository, or each account or organization, that you want Repotted
to manage. In the desktop app, **Add repositories** opens the App's install
page. On an organization, an owner installs the App or approves your request.

The App asks for these repository permissions:

- **Administration**, read and write: to read repository settings and
  rulesets, and to change them when you apply a plan.
- **Actions**, read: to list deployment environments.
- **Metadata**, read: required by GitHub for every App.

Repotted can only do what your own GitHub account may do on a repository. To
change a repository's settings, you need to be an administrator of it.

## Use a token instead

Repotted takes the first sign-in it finds, in this order:

1. The `GITHUB_TOKEN` or `GH_TOKEN` environment variable, for CI and scripts.
2. The `repotted login` sign-in.
3. The GitHub CLI's sign-in for github.com, from `gh auth login`.

A fine-grained personal access token needs the **Administration** permission,
read to capture and plan and write to apply, and **Actions** read to list
environments. A classic token needs the `repo` scope.

On Linux without a Secret Service, use a token or the GitHub CLI.

If GitHub rejects a token in `GITHUB_TOKEN` or `GH_TOKEN`, the desktop app
says so. Replace or remove the variable, then reopen the app, since it reads
the variable only when it starts.
