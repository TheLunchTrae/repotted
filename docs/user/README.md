# Repotted user guide

Repotted keeps GitHub repositories set up the way you want. You describe a
repository's settings, merge methods, Actions policy, rulesets, and deployment
environments in a YAML file called a profile. Repotted compares repositories
with the profile and changes only what you review and approve.

You can use Repotted in three ways:

- [The desktop app](desktop.md), for macOS and Windows, to edit profiles and
  compare them with your repositories.
- [The command line](cli.md), to capture, plan, and apply profiles from a
  terminal or a script.
- [An AI agent](cli.md#use-repotted-from-an-agent), through Repotted's MCP
  server.

All three sign in the same way; see [Sign in](sign-in.md). [Profiles](profiles.md)
describes what a profile can hold and how Repotted plans and applies it.
[JSON output](json-output.md) describes what the CLI prints for scripts.

To learn how Repotted works inside, or to change it, see the
[developer guide](../developer/README.md).
