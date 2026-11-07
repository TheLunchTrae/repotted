import { type GitHub, GitHubError, type Method } from '../src/github.js';

interface StoredRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions?: unknown;
  rules: { type: string; parameters?: Record<string, unknown> }[];
}

export interface FakeState {
  repository: Record<string, unknown>;
  actions: { enabled: boolean; allowed_actions?: string; sha_pinning_required?: boolean };
  selected: Record<string, unknown>;
  workflow: Record<string, unknown>;
  rulesets: StoredRuleset[];
  rulesetsUnavailable: boolean;
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

/**
 * An in-memory GitHub that serves the endpoints Repotted uses for one
 * repository, `lunch/app`, and records every write.
 */
export class FakeGitHub implements GitHub {
  readonly state: FakeState;
  readonly calls: Call[] = [];
  private nextId = 100;

  constructor(state: Partial<FakeState> = {}) {
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
      },
      actions: { enabled: true, allowed_actions: 'all', sha_pinning_required: false },
      selected: {},
      workflow: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: false },
      rulesets: [],
      rulesetsUnavailable: false,
      ...state,
    };
  }

  get writes(): Call[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  request(method: Method, path: string, body?: unknown): Promise<unknown> {
    this.calls.push(body === undefined ? { method, path } : { method, path, body });
    return Promise.resolve(this.handle(method, path, body));
  }

  private handle(method: Method, path: string, body: unknown): unknown {
    const [route = '', query = ''] = path.split('?');
    const base = '/repos/lunch/app';
    const permissions = `${base}/actions/permissions`;
    const rulesetId = new RegExp(`^${base}/rulesets/(\\d+)$`, 'u').exec(route)?.[1];
    const key = `${method} ${rulesetId === undefined ? route : `${base}/rulesets/:id`}`;

    switch (key) {
      case `GET ${base}`:
        return { id: 1, full_name: 'lunch/app', visibility: 'public', ...this.state.repository };
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
      case `DELETE ${base}/rulesets/:id`:
        this.findRuleset(Number(rulesetId));
        this.state.rulesets = this.state.rulesets.filter((item) => item.id !== Number(rulesetId));
        return undefined;
      default:
        throw new GitHubError(404, `Not Found: ${method} ${path}`);
    }
  }

  private listRulesets(query: URLSearchParams): unknown {
    if (this.state.rulesetsUnavailable) {
      throw new GitHubError(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.');
    }
    const perPage = Number(query.get('per_page') ?? '30');
    const page = Number(query.get('page') ?? '1');
    return this.state.rulesets
      .slice((page - 1) * perPage, page * perPage)
      .map((item) => ({ id: item.id, name: item.name, source_type: 'Repository', source: 'lunch/app' }));
  }

  private findRuleset(id: number): StoredRuleset & Record<string, unknown> {
    const found = this.state.rulesets.find((item) => item.id === id);
    if (found === undefined) {
      throw new GitHubError(404, 'Not Found');
    }
    return { ...found, source_type: 'Repository', source: 'lunch/app', node_id: `RRS_${id}` };
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
