# Repotted

Capture a GitHub repository's setup as a YAML profile, plan the changes a
profile needs, and apply a reviewed plan. Repotted covers repository settings,
merge methods, Actions policy, rulesets, and deployment environments, from a
desktop app for macOS and Windows, the command line, or an agent over MCP.

```sh
npx repotted login
npx repotted capture octo-org/app --output app.yaml
npx repotted plan octo-org/app --profile app.yaml --out plan.json
npx repotted apply plan.json
```

- [User guide](https://github.com/TheLunchTrae/repotted/blob/main/docs/user/README.md): install and use the desktop app, the CLI,
  and the MCP server, and write profiles.
- [Developer guide](https://github.com/TheLunchTrae/repotted/blob/main/docs/developer/README.md): how Repotted works and why, and
  how to build, test, and release it.

Code is under the [MIT License](https://github.com/TheLunchTrae/repotted/blob/main/LICENSE).
