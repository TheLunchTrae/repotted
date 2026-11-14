# Sign in

Repotted reads and changes repositories through the Repotted GitHub App,
named Repotted App on GitHub. The CLI and the MCP server share one sign-in,
so signing in with one signs in both. The [web app](web-app.md#sign-in)
signs in with the same App from the browser, and keeps that sign-in in the
browser alone.

## Sign in with GitHub

1. Start the sign-in:
   - On the command line, run `npx repotted login`.
   - From an agent, ask it to use any Repotted tool. With no sign-in, the tool
     replies with a code.
2. Repotted shows a code. Open [github.com/login/device](https://github.com/login/device)
   and enter the code.
3. Authorize the Repotted App. Repotted finishes signing in on its own.

Repotted keeps the sign-in in your system keychain: Keychain on macOS,
Credential Manager on Windows, and the Secret Service, such as GNOME Keyring
or KWallet, on Linux. The sign-in lasts as long as you use Repotted at least
once every six months.

To sign out, run `npx repotted logout`.

Signing out removes only the Repotted sign-in. With a token in
`GITHUB_TOKEN` or `GH_TOKEN`, or a GitHub CLI sign-in, Repotted goes on using
that token.

To take away the App's access completely, revoke it in your GitHub settings
under **Applications**.

## Give the App your repositories

The Repotted App reaches only the repositories it is installed on. Install it
on each repository, or each account or organization, that you want Repotted
to manage. On an organization, an owner installs the App or approves your request.

The App asks for these repository permissions:

- **Administration**, read and write: to read repository settings and
  rulesets, and to change them when you apply a plan.
- **Actions**, read: to list deployment environments.
- **Contents**, read and write: to keep profiles in a GitHub repository and
  commit your changes to them. Repotted reads and writes only YAML profiles
  there.
- **Metadata**, read: required by GitHub for every App.

Repotted can only do what your own GitHub account may do on a repository. To
change a repository's settings, you need to be an administrator of it.

## Use a token instead

Repotted takes the first sign-in it finds, in this order:

1. The `GITHUB_TOKEN` or `GH_TOKEN` environment variable, for CI and scripts.
2. The `repotted login` sign-in.
3. The GitHub CLI's sign-in for github.com, from `gh auth login`.

A fine-grained personal access token needs the **Administration** permission,
read to capture and plan and write to apply, **Actions** read to list
environments, and **Contents** read and write to sync profiles with a GitHub
repository. A classic token needs the `repo` scope.

On Linux without a Secret Service, use a token or the GitHub CLI.
