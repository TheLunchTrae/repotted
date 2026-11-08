# Context

- **Profile**: YAML that describes the setup a repository should have. It
  names only what it manages; anything it leaves out is unmanaged.
- **Base profile**: a profile that others build on with `extends`. A profile
  that extends it is an **override**.
- **Section**: one area of a repository's setup that a profile can manage:
  repository settings, merge methods, Actions settings, security settings,
  custom properties, GitHub Pages, autolinks, rulesets, or deployment
  environments. Each section has one adapter that reads it and plans its
  writes.
- **Config repository**: a GitHub repository that holds a folder of profiles.
  **Sync** brings a local folder and the config repository in line.
- **Capture**: reading a repository into a profile that describes it as it is.
- **Plan**: the changes, in order, that bring a repository in line with a
  profile, with the writes each one makes. Planning only reads.
- **Change**: one create, update, or delete of one target, such as the merge
  methods or a ruleset, with the fields it changes.
- **Apply**: making a reviewed plan's changes. Apply plans again first and
  writes only when that yields the same changes.
- **Stale plan**: a plan the repository has drifted from since it was made.
  Apply refuses it.
- **Staged apply**: one apply to one repository, prepared as a file: the
  profile it starts from, if any, **one-off edits** laid over that profile
  for this apply only, and **exclusions**, the values of the profile this apply
  leaves out. Its plan is reviewed and applied like any other, and the
  profile changes only when its edits are saved to it.
- **Drift**: a difference between a repository and its profile.
- **Draft**: an autolink, ruleset, environment, or setting saved in a
  profile but left out of plans until it is finished. It may be unfinished
  or invalid.
