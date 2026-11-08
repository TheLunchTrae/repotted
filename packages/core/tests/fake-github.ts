import { type GitHub, GitHubError, type Method, responseError } from '../src/github.js';

interface StoredRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions?: unknown;
  rules: { type: string; parameters?: Record<string, unknown> }[];
}

interface StoredEnvironment {
  name: string;
  wait_timer: number;
  prevent_self_review: boolean;
  reviewers: { type: string; id: number }[];
  deployment_branch_policy: { protected_branches: boolean; custom_branch_policies: boolean } | null;
  branch_policies: { id: number; name: string; type: string }[];
}

interface StoredLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
  default: boolean;
}

export interface FakeState {
  repository: Record<string, unknown>;
  actions: { enabled: boolean; allowed_actions?: string; sha_pinning_required?: boolean };
  selected: Record<string, unknown>;
  workflow: Record<string, unknown>;
  rulesets: StoredRuleset[];
  environments: StoredEnvironment[];
  /**
   * Settings at endpoints of their own, by path under the repository, as
   * GitHub sends them. A path left out is one GitHub does not offer on the
   * repository. Dependabot alerts are a boolean, and the Pages site is null
   * when the repository has none.
   */
  settings: Record<string, unknown>;
  autolinks: { id: number; key_prefix: string; url_template: string; is_alphanumeric: boolean }[];
  /** Labels as GitHub stores them, where an empty description is null. */
  labels: StoredLabel[];
  account: FakeAccount;
  /** The signed-in account's `permissions` flags on the repository. */
  viewer: { admin: boolean; maintain: boolean; push: boolean; triage: boolean; pull: boolean };
}

export interface FakeRepository {
  full_name: string;
  private: boolean;
  archived?: boolean;
  permissions?: { admin: boolean };
}

/** The signed-in account. `installations` is undefined for a token GitHub refuses the installation list to. */
export interface FakeAccount {
  login: string;
  name: string | null;
  installations?: FakeInstallation[];
  repositories: FakeRepository[];
}

/**
 * An installation of the App. `account` defaults to the owner of its first
 * repository, `selection` to `selected`, and `permissions` to none.
 */
export interface FakeInstallation {
  id: number;
  account?: string;
  selection?: 'all' | 'selected';
  permissions?: Record<string, string>;
  repositories: FakeRepository[];
}

export interface Call {
  readonly method: Method;
  readonly path: string;
  readonly body?: unknown;
}

// GitHub requires these pull_request parameters and fills in the merge methods.
const requiredPullRequestParameters = [
  'dismiss_stale_reviews_on_push',
  'require_code_owner_review',
  'require_last_push_approval',
  'required_approving_review_count',
  'required_review_thread_resolution',
];

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubError(422, 'Body must be an object');
  }
  return Object.fromEntries(Object.entries(value));
}

/**
 * Checks and fills rule parameters the way GitHub does: required parameters
 * must be sent, and the defaults it adds must not read as drift.
 */
function storedRules(value: unknown): StoredRuleset['rules'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item: unknown) => {
    const rule = record(item);
    const type = String(rule['type']);
    const parameters = rule['parameters'] === undefined ? undefined : record(rule['parameters']);
    if (type === 'pull_request') {
      const missing = requiredPullRequestParameters.filter((key) => parameters?.[key] === undefined);
      if (missing.length > 0) {
        throw new GitHubError(422, `Invalid request: pull_request is missing ${missing.join(', ')}`);
      }
      return { type, parameters: { allowed_merge_methods: ['merge', 'squash', 'rebase'], ...parameters } };
    }
    return parameters === undefined ? { type } : { type, parameters };
  });
}

/** An error as GitHub sends it, with a link to its docs, read as `createGitHub` reads one. */
export function answered(status: number, message: string): GitHubError {
  return responseError(status, { message, documentation_url: 'https://docs.github.com/rest', status: String(status) });
}

const unhandled = Symbol('unhandled');

interface Failure {
  readonly match: string | RegExp;
  readonly error: Error;
  remaining: number;
}

function paging(query: URLSearchParams): { perPage: number; page: number } {
  return { perPage: Number(query.get('per_page') ?? '30'), page: Number(query.get('page') ?? '1') };
}

/**
 * An in-memory GitHub that serves the endpoints Repotted uses for one
 * repository, `lunch/app` unless it names another, and records every write.
 */
export class FakeGitHub implements GitHub {
  readonly state: FakeState;
  readonly calls: Call[] = [];
  private readonly failures: Failure[] = [];
  private nextId = 100;

  /** The repository it serves, `lunch/app` by default. */
  readonly fullName: string;

  constructor(state: Partial<FakeState> = {}, fullName = 'lunch/app') {
    this.fullName = fullName;
    this.state = {
      repository: {
        has_issues: true,
        has_projects: true,
        has_wiki: true,
        has_discussions: false,
        allow_auto_merge: false,
        allow_update_branch: false,
        delete_branch_on_merge: false,
        web_commit_signoff_required: false,
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
        merge_commit_title: 'MERGE_MESSAGE',
        merge_commit_message: 'PR_TITLE',
        squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
        squash_merge_commit_message: 'COMMIT_MESSAGES',
        topics: [],
      },
      actions: { enabled: true, allowed_actions: 'all', sha_pinning_required: false },
      selected: {},
      workflow: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: false },
      rulesets: [],
      environments: [],
      settings: {},
      autolinks: [],
      labels: [],
      account: { login: 'lunch', name: null, repositories: [] },
      viewer: { admin: true, maintain: true, push: true, triage: true, pull: true },
      ...state,
    };
  }

  get writes(): Call[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  /**
   * Fails the requests `match` names with `error`, before the fake serves
   * them: the next `times` of them, or every one. A string names a request
   * as `GET /repos/lunch/app/pages`, without its query; a pattern is tested
   * against the method and the whole path. The first failure that matches
   * wins.
   */
  fail(match: string | RegExp, error: Error, times = Infinity): this {
    this.failures.push({ match, error, remaining: times });
    return this;
  }

  request(method: Method, path: string, body?: unknown): Promise<unknown> {
    this.calls.push(body === undefined ? { method, path } : { method, path, body });
    const request = `${method} ${path}`;
    const failure = this.failures.find(
      (item) =>
        item.remaining > 0 &&
        (typeof item.match === 'string' ? item.match === request.split('?')[0] : item.match.test(request)),
    );
    if (failure !== undefined) {
      failure.remaining -= 1;
      return Promise.reject(failure.error);
    }
    return Promise.resolve(this.handle(method, path, body));
  }

  private handle(method: Method, path: string, body: unknown): unknown {
    const [route = '', query = ''] = path.split('?');
    const base = `/repos/${this.fullName}`;
    const permissions = `${base}/actions/permissions`;
    const rulesetId = new RegExp(`^${base}/rulesets/(\\d+)$`, 'u').exec(route)?.[1];
    const environment = new RegExp(
      `^${base}/environments/([^/]+)(/deployment-branch-policies(?:/(\\d+))?)?$`,
      'u',
    ).exec(route);
    if (environment !== null) {
      return this.handleEnvironment(method, decodeURIComponent(environment[1] ?? ''), environment, query, body);
    }
    const label = new RegExp(`^${base}/labels(?:/([^/]+))?$`, 'u').exec(route);
    if (label !== null) {
      return this.handleLabel(method, label[1] === undefined ? undefined : decodeURIComponent(label[1]), query, body);
    }
    const setting = this.handleSetting(method, route.slice(base.length), body);
    if (setting !== unhandled) {
      return setting;
    }
    const key = `${method} ${rulesetId === undefined ? route : `${base}/rulesets/:id`}`;

    switch (key) {
      case `GET ${base}`:
        return {
          id: 1,
          full_name: this.fullName,
          visibility: 'public',
          ...this.state.repository,
          permissions: this.state.viewer,
        };
      case `PATCH ${base}`: {
        const patch = record(body);
        for (const [title, message] of [
          ['merge_commit_title', 'merge_commit_message'],
          ['squash_merge_commit_title', 'squash_merge_commit_message'],
        ] as const) {
          if (message in patch && !(title in patch)) {
            throw new GitHubError(422, `Invalid request: ${message} needs ${title}`);
          }
        }
        const next = { ...this.state.repository, ...patch };
        // Security and analysis changes only the features the request names.
        if (patch['security_and_analysis'] !== undefined) {
          next['security_and_analysis'] = {
            ...record(this.state.repository['security_and_analysis'] ?? {}),
            ...record(patch['security_and_analysis']),
          };
        }
        if (
          next['allow_merge_commit'] === false &&
          next['allow_squash_merge'] === false &&
          next['allow_rebase_merge'] === false
        ) {
          throw new GitHubError(422, 'Invalid request: at least one merge method must be allowed');
        }
        if (next['merge_commit_title'] === 'MERGE_MESSAGE' && next['merge_commit_message'] !== 'PR_TITLE') {
          throw new GitHubError(422, 'Invalid request: merge commit title and message combination');
        }
        if (
          next['squash_merge_commit_title'] === 'COMMIT_OR_PR_TITLE' &&
          next['squash_merge_commit_message'] !== 'COMMIT_MESSAGES'
        ) {
          throw new GitHubError(422, 'Invalid request: squash merge commit title and message combination');
        }
        if (next['merge_commit_title'] === 'PR_TITLE' && next['merge_commit_message'] === 'PR_TITLE') {
          throw new GitHubError(422, 'Invalid request: merge commit title and message combination');
        }
        this.state.repository = next;
        return this.handle('GET', base, undefined);
      }
      case `GET ${permissions}`:
        return { ...this.state.actions, selected_actions_url: `https://api.github.com${permissions}/selected-actions` };
      case `PUT ${permissions}`: {
        const next = record(body);
        // A PUT replaces the policy: keys it leaves out go back to their defaults.
        this.state.actions = {
          enabled: next['enabled'] === true,
          ...(next['enabled'] === true && typeof next['allowed_actions'] === 'string'
            ? { allowed_actions: next['allowed_actions'] }
            : {}),
          sha_pinning_required: next['sha_pinning_required'] === true,
        };
        return undefined;
      }
      case `GET ${permissions}/selected-actions`:
        if (this.state.actions.allowed_actions !== 'selected') {
          throw new GitHubError(409, 'Actions policy is not selected');
        }
        return this.state.selected;
      case `PUT ${permissions}/selected-actions`:
        this.state.selected = record(body);
        return undefined;
      case `GET ${permissions}/workflow`:
        return this.state.workflow;
      case `PUT ${permissions}/workflow`:
        this.state.workflow = record(body);
        return undefined;
      case `GET ${base}/rulesets`:
        return this.listRulesets(new URLSearchParams(query));
      case `POST ${base}/rulesets`:
        return this.saveRuleset(this.nextId++, record(body));
      case `GET ${base}/rulesets/:id`:
        return this.findRuleset(Number(rulesetId));
      case `PUT ${base}/rulesets/:id`:
        return this.saveRuleset(Number(rulesetId), { ...this.findRuleset(Number(rulesetId)), ...record(body) });
      case `GET ${base}/environments`:
        return this.listEnvironments(new URLSearchParams(query));
      case `DELETE ${base}/rulesets/:id`:
        this.findRuleset(Number(rulesetId));
        this.state.rulesets = this.state.rulesets.filter((item) => item.id !== Number(rulesetId));
        return undefined;
      case 'GET /user':
        return { login: this.state.account.login, name: this.state.account.name, id: 7 };
      case 'GET /user/installations': {
        const { installations } = this.state.account;
        if (installations === undefined) {
          throw answered(403, 'You must authenticate with an access token authorized to a GitHub App');
        }
        const { perPage, page } = paging(new URLSearchParams(query));
        return {
          total_count: installations.length,
          installations: installations.slice((page - 1) * perPage, page * perPage).map((item) => ({
            id: item.id,
            account: { login: item.account ?? item.repositories[0]?.full_name.split('/')[0] ?? 'lunch' },
            repository_selection: item.selection ?? 'selected',
            permissions: item.permissions ?? {},
            html_url: `https://github.com/settings/installations/${item.id}`,
          })),
        };
      }
      case 'GET /user/repos': {
        const { perPage, page } = paging(new URLSearchParams(query));
        return this.state.account.repositories.slice((page - 1) * perPage, page * perPage);
      }
      default: {
        const installation = /^\/user\/installations\/(\d+)\/repositories$/u.exec(route)?.[1];
        const found = this.state.account.installations?.find((item) => String(item.id) === installation);
        if (method === 'GET' && found !== undefined) {
          const { perPage, page } = paging(new URLSearchParams(query));
          return {
            total_count: found.repositories.length,
            repositories: found.repositories.slice((page - 1) * perPage, page * perPage),
          };
        }
        throw new GitHubError(404, `Not Found: ${method} ${path}`);
      }
    }
  }

  /** Serves the settings at endpoints of their own, or says the path is not one. */
  private handleSetting(method: Method, relative: string, body: unknown): unknown {
    const { settings } = this.state;
    const stored = (): unknown => {
      if (!Object.hasOwn(settings, relative)) {
        throw answered(404, `Not Found: ${method} ${relative}`);
      }
      return settings[relative];
    };
    if (relative === '/topics') {
      if (method === 'PUT') {
        this.state.repository['topics'] = record(body)['names'];
      }
      return { names: this.state.repository['topics'] };
    }
    if (relative === '/vulnerability-alerts') {
      stored();
      if (method === 'GET' && settings[relative] !== true) {
        throw new GitHubError(404, 'Vulnerability alerts are disabled.');
      }
      if (method === 'DELETE') {
        settings[relative] = false;
        if (record(settings['/automated-security-fixes'] ?? {})['enabled'] === true) {
          settings['/automated-security-fixes'] = { enabled: false, paused: false };
        }
      } else if (method === 'PUT') {
        settings[relative] = true;
      }
      return undefined;
    }
    if (['/immutable-releases', '/automated-security-fixes', '/private-vulnerability-reporting'].includes(relative)) {
      const current = record(stored());
      if (method === 'PUT' || method === 'DELETE') {
        if (
          relative === '/automated-security-fixes' &&
          method === 'PUT' &&
          settings['/vulnerability-alerts'] !== true
        ) {
          throw new GitHubError(422, 'Dependabot alerts must be enabled first');
        }
        settings[relative] = { ...current, enabled: method === 'PUT' };
        return undefined;
      }
      // GitHub answers 404 while immutable releases are off, and for
      // security updates while Dependabot alerts are off.
      if (
        (relative === '/immutable-releases' && current['enabled'] !== true) ||
        (relative === '/automated-security-fixes' && settings['/vulnerability-alerts'] !== true)
      ) {
        throw new GitHubError(404, 'Not Found');
      }
      return current;
    }
    if (relative === '/properties/values') {
      const values = stored();
      if (!Array.isArray(values)) {
        throw new GitHubError(500, 'Bad fake state');
      }
      if (method === 'PATCH') {
        const properties: unknown = record(body)['properties'];
        for (const item of Array.isArray(properties) ? properties : []) {
          const { property_name: name, value } = record(item);
          const current: unknown = settings[relative];
          const list: unknown[] = Array.isArray(current) ? current : [];
          settings[relative] = [
            ...list.filter((entry) => record(entry)['property_name'] !== name),
            { property_name: name, value },
          ];
        }
        return undefined;
      }
      return values;
    }
    if (relative === '/autolinks' || relative.startsWith('/autolinks/')) {
      return this.handleAutolinks(method, relative, body);
    }
    if (relative === '/pages') {
      const site = stored();
      if (method === 'POST') {
        if (site !== null) {
          throw new GitHubError(409, 'GitHub Pages is already enabled.');
        }
        settings[relative] = { build_type: 'legacy', cname: null, https_enforced: true, ...record(body) };
        return settings[relative];
      }
      if (site === null) {
        throw new GitHubError(404, 'Not Found');
      }
      if (method === 'DELETE') {
        settings[relative] = null;
        return undefined;
      }
      if (method === 'PUT') {
        settings[relative] = { ...record(site), ...record(body) };
        return undefined;
      }
      return site;
    }
    if (!Object.hasOwn(settings, relative)) {
      return unhandled;
    }
    if (method === 'GET') {
      return settings[relative];
    }
    const next = record(body);
    if (
      relative === '/dependabot/runner-settings' &&
      next['runner_type'] === 'standard' &&
      Object.keys(next).length > 1
    ) {
      throw new GitHubError(422, 'runner_labels and runner_group are only for self-hosted and labeled runners');
    }
    // A PUT replaces the settings; a PATCH changes the fields it sends.
    const written = method === 'PUT' ? { ...next } : { ...record(settings[relative]), ...next };
    if (relative === '/code-scanning/default-setup' || relative === '/code-quality/setup') {
      if (written['state'] === 'not-configured') {
        // GitHub reports no runner while the setup is not configured.
        written['runner_type'] = null;
        written['runner_label'] = null;
      } else {
        // A configured setup runs on standard runners unless told otherwise.
        written['runner_type'] ??= 'standard';
        if (written['runner_type'] === 'labeled' && typeof written['runner_label'] !== 'string') {
          throw new GitHubError(422, 'labeled runners need a runner label');
        }
        // GitHub keeps no runner label with standard runners, reporting it as null.
        if (written['runner_type'] === 'standard') {
          written['runner_label'] = null;
        }
      }
    }
    settings[relative] = written;
    if (relative === '/dependabot/runner-settings') {
      // GitHub always reports the labels and group, empty when there are none.
      settings[relative] = { runner_labels: [], runner_group: '', ...record(settings[relative]) };
    }
    return undefined;
  }

  /**
   * Labels as GitHub serves them: found by name in any case, refused when a
   * write would give two labels one name, and written with a color without
   * `#`, as GitHub requires.
   */
  private handleLabel(method: Method, name: string | undefined, query: string, body: unknown): unknown {
    const find = (wanted: string): StoredLabel | undefined =>
      this.state.labels.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
    const color = (value: unknown): string => {
      if (typeof value !== 'string' || !/^[\da-f]{6}$/iu.test(value)) {
        throw answered(422, `Validation Failed: color is invalid: ${String(value)}`);
      }
      return value;
    };
    const description = (value: unknown): string | null => (value === '' ? null : String(value));
    if (name === undefined && method === 'GET') {
      const { perPage, page } = paging(new URLSearchParams(query));
      return this.state.labels.slice((page - 1) * perPage, page * perPage);
    }
    if (name === undefined && method === 'POST') {
      const next = record(body);
      const wanted = String(next['name']);
      if (find(wanted) !== undefined) {
        throw answered(422, 'Validation Failed: name already_exists');
      }
      const created: StoredLabel = {
        id: this.nextId++,
        name: wanted,
        color: next['color'] === undefined ? 'ededed' : color(next['color']),
        description: next['description'] === undefined ? null : description(next['description']),
        default: false,
      };
      this.state.labels.push(created);
      return created;
    }
    const current = name === undefined ? undefined : find(name);
    if (current === undefined) {
      throw answered(404, `Not Found: ${method} label ${name ?? ''}`);
    }
    if (method === 'GET') {
      return current;
    }
    if (method === 'DELETE') {
      this.state.labels = this.state.labels.filter((item) => item !== current);
      return undefined;
    }
    if (method === 'PATCH') {
      const next = record(body);
      const renamed = next['new_name'];
      if (typeof renamed === 'string') {
        const taken = find(renamed);
        if (taken !== undefined && taken !== current) {
          throw answered(422, 'Validation Failed: name already_exists');
        }
        current.name = renamed;
      }
      if (next['color'] !== undefined) {
        current.color = color(next['color']);
      }
      if (next['description'] !== undefined) {
        current.description = description(next['description']);
      }
      return current;
    }
    throw answered(404, `Not Found: ${method} label ${current.name}`);
  }

  private handleAutolinks(method: Method, relative: string, body: unknown): unknown {
    const id = relative.split('/')[2];
    if (method === 'GET' && id === undefined) {
      return this.state.autolinks;
    }
    if (method === 'POST' && id === undefined) {
      const next = record(body);
      const prefix = String(next['key_prefix']);
      if (this.state.autolinks.some((item) => item.key_prefix === prefix)) {
        throw new GitHubError(422, 'Validation Failed: key_prefix already exists');
      }
      const created = {
        id: this.nextId++,
        key_prefix: prefix,
        url_template: String(next['url_template']),
        is_alphanumeric: next['is_alphanumeric'] !== false,
      };
      this.state.autolinks.push(created);
      return created;
    }
    if (method === 'DELETE' && id !== undefined) {
      const before = this.state.autolinks.length;
      this.state.autolinks = this.state.autolinks.filter((item) => item.id !== Number(id));
      if (this.state.autolinks.length === before) {
        throw new GitHubError(404, 'Not Found');
      }
      return undefined;
    }
    throw answered(404, `Not Found: ${method} ${relative}`);
  }

  private listEnvironments(query: URLSearchParams): unknown {
    const { perPage, page } = paging(query);
    // GitHub reports settings as protection rules and leaves out a rule at its default.
    return {
      total_count: this.state.environments.length,
      environments: this.state.environments.slice((page - 1) * perPage, page * perPage).map((stored) => ({
        id: stored.name.length,
        name: stored.name,
        protection_rules: [
          ...(stored.wait_timer > 0 ? [{ id: 1, type: 'wait_timer', wait_timer: stored.wait_timer }] : []),
          ...(stored.reviewers.length > 0
            ? [
                {
                  id: 2,
                  type: 'required_reviewers',
                  prevent_self_review: stored.prevent_self_review,
                  reviewers: stored.reviewers.map((reviewer) => ({
                    type: reviewer.type,
                    reviewer: { id: reviewer.id, login: `user${reviewer.id}` },
                  })),
                },
              ]
            : []),
          ...(stored.deployment_branch_policy === null ? [] : [{ id: 3, type: 'branch_policy' }]),
        ],
        deployment_branch_policy: stored.deployment_branch_policy,
      })),
    };
  }

  private handleEnvironment(
    method: Method,
    name: string,
    match: RegExpExecArray,
    query: string,
    body: unknown,
  ): unknown {
    // GitHub matches environment names without case.
    const found = this.state.environments.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (match[2] === undefined) {
      if (method === 'PUT') {
        return this.saveEnvironment(name, found, body === undefined ? {} : record(body));
      }
      if (found === undefined) {
        throw new GitHubError(404, 'Not Found');
      }
      if (method === 'DELETE') {
        this.state.environments = this.state.environments.filter((item) => item !== found);
        return undefined;
      }
      throw new GitHubError(404, `Not Found: ${method} ${name}`);
    }
    if (found?.deployment_branch_policy?.custom_branch_policies !== true) {
      throw new GitHubError(404, 'Not Found');
    }
    const policyId = match[3];
    if (method === 'GET' && policyId === undefined) {
      const { perPage, page } = paging(new URLSearchParams(query));
      return {
        total_count: found.branch_policies.length,
        branch_policies: found.branch_policies.slice((page - 1) * perPage, page * perPage),
      };
    }
    if (method === 'POST' && policyId === undefined) {
      const next = record(body);
      const policy = { id: this.nextId++, name: String(next['name']), type: next['type'] === 'tag' ? 'tag' : 'branch' };
      if (found.branch_policies.some((item) => item.name === policy.name && item.type === policy.type)) {
        throw new GitHubError(422, 'Validation Failed: name already exists');
      }
      found.branch_policies.push(policy);
      return policy;
    }
    if (method === 'DELETE' && policyId !== undefined) {
      const before = found.branch_policies.length;
      found.branch_policies = found.branch_policies.filter((item) => item.id !== Number(policyId));
      if (found.branch_policies.length === before) {
        throw new GitHubError(404, 'Not Found');
      }
      return undefined;
    }
    throw new GitHubError(404, `Not Found: ${method} ${name} branch policies`);
  }

  /** A PUT replaces the environment's settings: keys it leaves out go back to their defaults. */
  private saveEnvironment(name: string, found: StoredEnvironment | undefined, body: Record<string, unknown>): unknown {
    const allowed = new Set(['wait_timer', 'prevent_self_review', 'reviewers', 'deployment_branch_policy']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new GitHubError(422, `Invalid request: ${unknown.join(', ')} is not a permitted key`);
    }
    const reviewers = Array.isArray(body['reviewers'])
      ? body['reviewers'].map((item: unknown) => {
          const reviewer = record(item);
          return { type: String(reviewer['type']), id: Number(reviewer['id']) };
        })
      : [];
    if (reviewers.length > 6) {
      throw new GitHubError(422, 'Invalid request: at most six reviewers');
    }
    const policy = body['deployment_branch_policy'] === undefined ? null : body['deployment_branch_policy'];
    let deploymentBranchPolicy: StoredEnvironment['deployment_branch_policy'] = null;
    if (policy !== null) {
      const settings = record(policy);
      if (settings['protected_branches'] === settings['custom_branch_policies']) {
        throw new GitHubError(422, 'Invalid request: set exactly one of protected_branches and custom_branch_policies');
      }
      deploymentBranchPolicy = {
        protected_branches: settings['protected_branches'] === true,
        custom_branch_policies: settings['custom_branch_policies'] === true,
      };
    }
    const stored: StoredEnvironment = {
      name: found?.name ?? name,
      wait_timer: typeof body['wait_timer'] === 'number' ? body['wait_timer'] : 0,
      prevent_self_review: body['prevent_self_review'] === true,
      reviewers,
      deployment_branch_policy: deploymentBranchPolicy,
      branch_policies: deploymentBranchPolicy?.custom_branch_policies === true ? (found?.branch_policies ?? []) : [],
    };
    this.state.environments = [...this.state.environments.filter((item) => item !== found), stored];
    return { name };
  }

  private listRulesets(query: URLSearchParams): unknown {
    const { perPage, page } = paging(query);
    return this.state.rulesets
      .slice((page - 1) * perPage, page * perPage)
      .map((item) => ({ id: item.id, name: item.name, source_type: 'Repository', source: this.fullName }));
  }

  private findRuleset(id: number): StoredRuleset & Record<string, unknown> {
    const found = this.state.rulesets.find((item) => item.id === id);
    if (found === undefined) {
      throw new GitHubError(404, 'Not Found');
    }
    return { ...found, source_type: 'Repository', source: this.fullName, node_id: `RRS_${id}` };
  }

  private saveRuleset(id: number, body: Record<string, unknown>): unknown {
    const stored: StoredRuleset = {
      id,
      name: String(body['name']),
      target: typeof body['target'] === 'string' ? body['target'] : 'branch',
      enforcement: String(body['enforcement']),
      bypass_actors: Array.isArray(body['bypass_actors']) ? body['bypass_actors'] : [],
      ...(body['conditions'] === undefined ? {} : { conditions: body['conditions'] }),
      rules: storedRules(body['rules']),
    };
    this.state.rulesets = [...this.state.rulesets.filter((item) => item.id !== id), stored];
    return stored;
  }
}

/**
 * Several fakes as one GitHub: a request about a repository goes to the fake
 * that serves it, and is not found when none does. Any other request goes
 * to the first fake.
 */
export class FakeFleet implements GitHub {
  readonly fakes: readonly FakeGitHub[];

  constructor(fakes: readonly FakeGitHub[]) {
    this.fakes = fakes;
  }

  request(method: Method, path: string, body?: unknown): Promise<unknown> {
    const named = /^\/repos\/([^/?]+\/[^/?]+)/u.exec(path)?.[1];
    const first = this.fakes[0];
    if (named === undefined && first !== undefined) {
      return first.request(method, path, body);
    }
    const fake = this.fakes.find((item) => item.fullName.toLowerCase() === named?.toLowerCase());
    return fake === undefined ? Promise.reject(answered(404, 'Not Found')) : fake.request(method, path, body);
  }
}
