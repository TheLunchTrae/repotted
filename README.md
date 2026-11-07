# Repotted

Capture a GitHub repository's setup as a YAML profile, plan the changes a
profile needs, and apply a reviewed plan. Repotted covers repository settings,
merge methods, Actions policy, rulesets, and deployment environments, from the
command line or from an agent over MCP.

```sh
npx repotted login
npx repotted capture octo-org/app --output app.yaml
npx repotted plan octo-org/app --profile app.yaml --out plan.json
npx repotted apply plan.json
```

[docs/profiles.md](docs/profiles.md) describes profiles, plans, and the MCP
server. Developer docs start at [docs/development.md](docs/development.md).
Code is under the [MIT License](LICENSE).
