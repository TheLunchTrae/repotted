# Repotted

Keep GitHub repositories set up the way you want.

Repotted captures a repository's setup as a YAML profile: its settings, merge
methods, Actions and security settings, Pages site, custom properties,
autolinks, rulesets, deployment environments, and labels. A profile manages
only what it names, so it can describe one repository or a standard that many
share.

## Use it

Open [repotted.dev](https://repotted.dev) and sign in with GitHub. From there
you can:

- Choose the repositories the Repotted App can reach.
- Make profiles from scratch or by capturing a repository, then edit them.
- Keep profiles in the browser, in a GitHub repository so they follow you to
  any browser, or, where the browser allows it, in a folder on your computer.
- Compare a repository with a profile, review what would change, and apply it
  to one repository or several.

### Preview

[main.preview.repotted.dev](https://main.preview.repotted.dev) runs a build of
the `main` branch that may not be on repotted.dev yet. It's there to preview
changes while they're tested, so some features may be broken or not work as
expected. It still works on your real repositories, so review changes there as
carefully as on repotted.dev. It's a separate site: you sign in there on its
own, and profiles kept in the browser on repotted.dev don't show up there.

## Documentation

- [The web app](docs/user/web-app.md): sign in, find repositories, make and
  edit profiles, and compare and apply them.
- [The command line](docs/user/cli.md): capture, plan, and apply profiles
  from a terminal, a script, or an agent over MCP.
- [Profiles](docs/user/profiles.md): what a profile can hold.
- [Developer guide](docs/developer/README.md): how Repotted works and why, and
  how to build, test, and release it.

## License

Code is under the [MIT License](LICENSE).
