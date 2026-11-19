import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

import type { GitHubAppLookup } from '../../app/profile-editor/bypass-actors.js';
import type { EntryField, EntryList, EntryRow } from '../../app/profile-editor/entry-edits.js';
import {
  branchPolicies,
  deploymentBranches,
  type DeploymentBranches,
  type Entry,
  hexColor,
  isEntry,
  parseWholeNumberUpTo,
  uniqueTrimmedNonBlankLines,
  allRefsTarget,
  defaultBranchTarget,
  namedRefTargetsProblem,
  refNames,
  refPatterns,
  refPatternsProblem,
  type RefSide,
  ruleOf,
  rulesetTarget,
  statusChecks,
  workflowPaths,
  withWorkflowPaths,
  withBranchPolicies,
  withDeploymentBranches,
  withKey,
  withNamedRefTarget,
  withRefPatterns,
  withRule,
  withRuleParameter,
  withStatusChecks,
} from '../../app/profile-editor/entry-forms.js';
import type { EntryListBatch, ProfileEditor } from '../../app/profile-editor/profile-editor.js';
import { sameValue } from '../../app/profile-editor/same-value.js';
import { run } from '../layout/run.js';
import { type BatchAction, BatchActions, describeEntriesDone } from './batch-actions.js';
import { BypassList } from './bypass-list.js';
import { MissingPermissionsNote } from './missing-permissions-note.js';
import { ReusableDefinitionOption } from './reusable-definition.js';

const nouns: Readonly<Record<EntryList, { readonly one: string; readonly many: string; readonly title: string }>> = {
  actions_policies: { one: 'Actions policy', many: 'Actions policies', title: 'Actions policy' },
  rulesets: { one: 'ruleset', many: 'rulesets', title: 'Ruleset' },
  environments: { one: 'environment', many: 'environments', title: 'Environment' },
  labels: { one: 'label', many: 'labels', title: 'Label' },
};

/** GitHub's own label colors, as its color picker offers them. */
const palette: readonly (readonly [string, string])[] = [
  ['b60205', 'Dark red'],
  ['d93f0b', 'Orange'],
  ['fbca04', 'Yellow'],
  ['0e8a16', 'Green'],
  ['006b75', 'Teal'],
  ['1d76db', 'Blue'],
  ['0052cc', 'Dark blue'],
  ['5319e7', 'Purple'],
  ['e99695', 'Pink'],
  ['f9d0c4', 'Peach'],
  ['fef2c0', 'Light yellow'],
  ['c2e0c6', 'Light green'],
  ['bfdadc', 'Light teal'],
  ['c5def5', 'Light blue'],
  ['bfd4f2', 'Pale blue'],
  ['d4c5f9', 'Lavender'],
];

const ruleKinds: readonly (readonly [string, string, string])[] = [
  ['deletion', 'Restrict deletions', 'Only people who can bypass the ruleset can delete matching refs.'],
  ['non_fast_forward', 'Block force pushes', 'Nobody can force push to matching refs.'],
  ['creation', 'Restrict creations', 'Only people who can bypass the ruleset can create matching refs.'],
  ['update', 'Restrict updates', 'Only people who can bypass the ruleset can push to matching refs.'],
  ['required_linear_history', 'Require linear history', 'Merge commits cannot be pushed to matching refs.'],
  ['required_signatures', 'Require signed commits', 'Commits pushed to matching refs must be signed.'],
  [
    'pull_request',
    'Require a pull request before merging',
    'Changes reach matching branches only through a pull request.',
  ],
  [
    'required_status_checks',
    'Require status checks to pass',
    'The checks below must pass before a change reaches matching refs.',
  ],
];

const pullRequestFlags: readonly (readonly [string, string])[] = [
  ['dismiss_stale_reviews_on_push', 'Dismiss approvals when new commits are pushed'],
  ['require_code_owner_review', 'Require review from code owners'],
  ['require_last_push_approval', 'Require approval of the most recent push'],
  ['required_review_thread_resolution', 'Require conversations to be resolved'],
];

/** How light a color is, from 0 to 1, by the weights the eye gives red, green, and blue. */
function luminance(hex: string): number {
  const [red = 0, green = 0, blue = 0] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

interface FormProps {
  readonly entry: Entry;
  readonly saved: Entry | undefined;
  readonly change: (entry: Entry) => void;
  /** Why the field can't be saved, when the entry's problem is in it. */
  readonly problemIn: (field: EntryField) => string | undefined;
}

/** Asks the entries list to open an entry and put the keyboard in one of its fields. */
export interface EntryGoTo {
  readonly list: EntryList;
  readonly rowKey: string;
  readonly field: EntryField;
}

interface ChoiceProps {
  readonly label: string;
  readonly options: readonly (readonly [string, unknown])[];
  /** The value chosen, or undefined when each repository keeps its own. */
  readonly value: unknown;
  readonly onChoose: (value: unknown) => void;
}

function Choice({ label, options, value, onChoose }: ChoiceProps): JSX.Element {
  const id = useId();
  return (
    <div class="setting">
      <div class="setting-head">
        <div class="setting-text">
          <strong id={id}>{label}</strong>
          {value === undefined && <span class="muted small">Not set here, so each repository keeps its own.</span>}
        </div>
        <div class="segments" role="radiogroup" aria-labelledby={id}>
          {options.map(([name, option]) => (
            <label key={name}>
              <input
                type="radio"
                name={id}
                checked={value !== undefined && sameValue(option, value)}
                onChange={() => {
                  onChoose(option);
                }}
              />
              <span>{name}</span>
            </label>
          ))}
        </div>
        <div class="setting-actions">
          {value !== undefined && (
            <button
              class="button button-quiet button-small"
              type="button"
              aria-label={`Leave ${label} to GitHub`}
              onClick={() => {
                onChoose(undefined);
              }}
            >
              Leave it to GitHub
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface TextProps {
  readonly label: string;
  readonly value: string;
  /** Takes what is typed, and answers why it can't be a value when it can't. */
  readonly onText: (text: string) => string | undefined;
  readonly multiline?: boolean;
  readonly mono?: boolean;
  readonly placeholder?: string;
  readonly note?: string | undefined;
  readonly problem?: string | undefined;
  readonly disabled?: boolean;
  /** The field of the entry it edits, so going to a problem in it can find it. */
  readonly field?: EntryField;
  readonly nested?: boolean;
}

/**
 * A text box that keeps what is typed in it, as typed, while the entry it
 * edits is redrawn. Text that can't be a value stays with why until the box
 * is left, when it shows the entry's value again.
 */
function TextBox({
  label,
  value,
  onText,
  multiline,
  mono,
  placeholder,
  note,
  problem,
  disabled,
  field,
  nested,
}: TextProps): JSX.Element {
  const id = useId();
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const wrong = refused ?? problem;
  const shared = {
    id,
    class: `field${mono === true ? ' mono' : ''}${multiline === true ? ' field-lines' : ''}`,
    'aria-invalid': wrong !== undefined,
    'aria-describedby': `${id}-help`,
    'data-entry-field': field,
    placeholder,
    disabled,
    value: typed ?? value,
    onBlur: (): void => {
      setTyped(undefined);
      setRefused(undefined);
    },
  };
  const take = (next: string): void => {
    setTyped(next);
    setRefused(onText(next));
  };
  return (
    <div class={nested === true ? 'setting setting-nested' : 'setting'}>
      <div class="setting-head">
        <div class="setting-text">
          <label for={id}>
            <strong>{label}</strong>
          </label>
          {note !== undefined && <span class="muted small">{note}</span>}
        </div>
        {multiline === true ? (
          <textarea
            {...shared}
            rows={Math.max(3, (typed ?? value).split('\n').length + 1)}
            onInput={(event) => {
              take(event.currentTarget.value);
            }}
          />
        ) : (
          <input
            {...shared}
            onInput={(event) => {
              take(event.currentTarget.value);
            }}
          />
        )}
      </div>
      <p id={`${id}-help`} class="problem small" role={wrong === undefined ? undefined : 'alert'}>
        {wrong}
      </p>
    </div>
  );
}

interface CheckProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheck: (checked: boolean) => void;
  readonly note?: string | undefined;
}

function Check({ label, checked, onCheck, note }: CheckProps): JSX.Element {
  return (
    <label class="check check-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onCheck(event.currentTarget.checked);
        }}
      />
      <span>
        {label}
        {note !== undefined && <span class="muted small check-note">{note}</span>}
      </span>
    </label>
  );
}

interface GroupProps {
  readonly title: string;
  readonly description?: string;
  readonly children: ComponentChildren;
}

function Group({ title, description, children }: GroupProps): JSX.Element {
  return (
    <section class="settings-group" aria-label={title}>
      <div>
        <h2>{title}</h2>
        {description !== undefined && <p class="muted small">{description}</p>}
      </div>
      <div class="settings">{children}</div>
    </section>
  );
}

interface KeptProps extends Omit<FormProps, 'problemIn'> {
  readonly name: string;
  readonly label: string;
  readonly none: string;
  readonly noun: string;
}

/**
 * A list the form keeps or clears, since its items, such as reviewers by id,
 * are set in the profile file. The list to keep is the saved entry's, so it
 * can be chosen again after it was cleared.
 */
function Kept({ entry, saved, change, name, label, none, noun }: KeptProps): JSX.Element {
  const kept = items(saved?.[name]);
  const options: (readonly [string, unknown])[] = [[none, []]];
  if (kept.length > 0) {
    options.push([`${kept.length} ${kept.length === 1 ? noun : `${noun}s`}, as in the profile file`, kept]);
  }
  return (
    <Choice
      label={label}
      options={options}
      value={entry[name]}
      onChoose={(value) => {
        change(withKey(entry, name, value));
      }}
    />
  );
}

interface RefTargetsProps extends Omit<FormProps, 'problemIn'> {
  readonly side: RefSide;
}

/**
 * The named targets are options, and the patterns are typed only once their
 * option is selected. An option the target doesn't offer still shows while
 * the entry names it, so it can be deselected.
 */
function RefTargets({ entry, saved, change, side }: RefTargetsProps): JSX.Element | null {
  const target = rulesetTarget(entry);
  const names = refNames(entry, side);
  const patterns = refPatterns(entry, side);
  const [patternsOpened, setPatternsOpened] = useState(patterns.length > 0);
  const id = useId();
  const tags = target === 'tag';
  const offered = target !== 'push';
  const options: (readonly [string, string, string | undefined])[] = [];
  if ((offered && !tags) || names.includes(defaultBranchTarget)) {
    options.push([defaultBranchTarget, 'Default branch', "Each repository's own default, such as main."]);
  }
  if ((offered && side === 'include') || names.includes(allRefsTarget)) {
    options.push([allRefsTarget, tags ? 'All tags' : 'All branches', undefined]);
  }
  const patternsSelected = (offered && patternsOpened) || patterns.length > 0;
  if (options.length === 0 && !offered && !patternsSelected) {
    return side === 'include' ? (
      <div class="setting">
        <span class="muted small">
          A push ruleset covers every push to the repository, so it has no branch or tag targets.
        </span>
      </div>
    ) : null;
  }
  const label = side === 'include' ? 'Include' : 'Exclude';
  const noun = tags ? 'tags' : 'branches';
  const targetsProblem = namedRefTargetsProblem(entry, side);
  return (
    <>
      <div class="setting" role="group" aria-labelledby={id} data-entry-field={`${side}-targets`} tabIndex={-1}>
        <div class="setting-text">
          <strong id={id}>{label}</strong>
          <span class="muted small">
            {side === 'include' ? `The ${noun} the ruleset covers.` : `The ${noun} it skips, even when included.`}
          </span>
        </div>
        <div class="check-list">
          {options.map(([name, optionLabel, note]) => (
            <Check
              key={name}
              label={optionLabel}
              note={note}
              checked={names.includes(name)}
              onCheck={(checked) => {
                change(withNamedRefTarget(entry, side, name, checked, saved));
              }}
            />
          ))}
          {(offered || patterns.length > 0) && (
            <Check
              label={tags ? 'Tags by pattern' : 'Branches by pattern'}
              checked={patternsSelected}
              onCheck={(checked) => {
                setPatternsOpened(checked);
                if (!checked) {
                  change(withRefPatterns(entry, side, [], saved));
                }
              }}
            />
          )}
        </div>
        {targetsProblem !== undefined && (
          <p class="problem small" role="alert">
            {targetsProblem}
          </p>
        )}
      </div>
      {patternsSelected && (
        <TextBox
          nested
          field={`${side}-patterns`}
          label={tags ? 'Tag patterns' : 'Branch patterns'}
          mono
          multiline
          value={patterns.join('\n')}
          placeholder={tags ? 'refs/tags/v*' : 'refs/heads/release/*'}
          note={`One a line, such as ${tags ? 'refs/tags/v*' : 'refs/heads/release/*'}.`}
          problem={refPatternsProblem(entry, side)}
          onText={(typed) => {
            setPatternsOpened(true);
            change(withRefPatterns(entry, side, uniqueTrimmedNonBlankLines(typed), saved));
            return undefined;
          }}
        />
      )}
    </>
  );
}

function ActionPolicyForm({ entry, saved, change, problemIn }: FormProps): JSX.Element {
  const conditions = isEntry(entry['conditions']) ? entry['conditions'] : {};
  const include = workflowPaths(entry, 'include');
  const exclude = workflowPaths(entry, 'exclude');
  const targeting =
    conditions['workflow_path'] === undefined
      ? undefined
      : include.length === 1 && include[0] === '~ALL' && exclude.length === 0
        ? 'all'
        : 'selected';
  const events = ruleOf(entry, 'restrict_action_events');
  const eventParameters = isEntry(events?.['parameters']) ? events['parameters'] : {};
  const actors = ruleOf(entry, 'restrict_actions_actors');
  const actorParameters = isEntry(actors?.['parameters']) ? actors['parameters'] : {};
  const allowedActors = items(actorParameters['allowed_actors']).filter(isEntry);
  const setActors = (next: readonly Entry[]): void =>
    change(withRuleParameter(entry, 'restrict_actions_actors', 'allowed_actors', next));
  const toggleRule = (type: string, key: string, on: boolean): void => {
    const next = withRule(entry, type, on, saved);
    const parameters = ruleOf(next, type)?.['parameters'];
    change(
      on && ruleOf(saved, type) === undefined && (!isEntry(parameters) || parameters[key] === undefined)
        ? withRuleParameter(next, type, key, [])
        : next,
    );
  };
  const otherRules = items(entry['rules'])
    .filter(isEntry)
    .map((rule) => text(rule['type']))
    .filter((type) => type !== 'restrict_action_events' && type !== 'restrict_actions_actors');
  return (
    <>
      <Group
        title="Enforcement"
        description="Evaluate reports policy violations without blocking workflows and requires GitHub Enterprise."
      >
        <Choice
          label="Enforcement"
          options={[
            ['Active', 'active'],
            ['Evaluate', 'evaluate'],
            ['Disabled', 'disabled'],
          ]}
          value={entry['enforcement']}
          onChoose={(value) => change(withKey(entry, 'enforcement', value))}
        />
      </Group>
      <Group
        title="Target workflows"
        description="New policies without workflow targets apply to all workflows. Updates preserve targets left unset."
      >
        <Choice
          label="Workflow targeting"
          options={[
            ['All workflows', 'all'],
            ['Selected workflows', 'selected'],
          ]}
          value={targeting}
          onChoose={(value) =>
            change(withWorkflowPaths(entry, value === undefined ? undefined : value === 'all' ? ['~ALL'] : []))
          }
        />
        {targeting === 'selected' &&
          (['include', 'exclude'] as const).map((side) => (
            <TextBox
              key={side}
              label={side === 'include' ? 'Include workflow paths' : 'Exclude workflow paths'}
              field="workflow-paths"
              problem={problemIn('workflow-paths')}
              multiline
              mono
              value={workflowPaths(entry, side).join('\n')}
              note={
                side === 'include'
                  ? 'One path or glob per line, such as .github/workflows/release.yml. Empty includes all workflows except exclusions.'
                  : 'One path or glob per line. Excluded workflows are outside this policy.'
              }
              onText={(typed) => {
                const paths = uniqueTrimmedNonBlankLines(typed);
                change(
                  withWorkflowPaths(entry, side === 'include' ? paths : include, side === 'exclude' ? paths : exclude),
                );
                return undefined;
              }}
            />
          ))}
      </Group>
      <Group title="Rules" description="Control which events and actors can trigger matching workflows.">
        <div data-entry-field="policy-rules" role="region" aria-label="Workflow rules" tabIndex={-1}>
          <Check
            label="Restrict events"
            checked={events !== undefined}
            note="Only listed events may trigger workflows. An empty list blocks every event."
            onCheck={(on) => toggleRule('restrict_action_events', 'allowed_events', on)}
          />
          {events !== undefined && (
            <TextBox
              label="Allowed events"
              multiline
              mono
              field="policy-rules"
              problem={problemIn('policy-rules')}
              value={items(eventParameters['allowed_events']).map(String).join('\n')}
              note="One event per line, such as push, pull_request, release, or workflow_dispatch."
              onText={(typed) => {
                change(
                  withRuleParameter(
                    entry,
                    'restrict_action_events',
                    'allowed_events',
                    uniqueTrimmedNonBlankLines(typed),
                  ),
                );
                return undefined;
              }}
            />
          )}
          <Check
            label="Restrict actors"
            checked={actors !== undefined}
            note="Only listed actors may trigger workflows. An empty list blocks every actor."
            onCheck={(on) => toggleRule('restrict_actions_actors', 'allowed_actors', on)}
          />
          {actors !== undefined && (
            <>
              {allowedActors.map((actor, index) => (
                <fieldset class="settings-group" key={index} aria-label={`Actor ${index + 1}`}>
                  <legend>Actor {index + 1}</legend>
                  <label class="form-field">
                    <span>Actor type</span>
                    <select
                      class="field"
                      value={text(actor['type'])}
                      onChange={(event) =>
                        setActors(
                          allowedActors.map((item, at) =>
                            at === index ? { ...item, type: event.currentTarget.value } : item,
                          ),
                        )
                      }
                    >
                      {[
                        'User',
                        'Bot',
                        'Team',
                        'BusinessTeam',
                        'EnterpriseTeam',
                        'IntegrationInstallation',
                        'App',
                        'RepositoryRole',
                      ].map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TextBox
                    label="Actor ID"
                    value={text(actor['id'])}
                    field="policy-rules"
                    problem={problemIn('policy-rules')}
                    note="The actor’s numeric GitHub ID."
                    onText={(typed) => {
                      const id = /^-?\d+$/u.test(typed) ? Number(typed) : typed;
                      setActors(allowedActors.map((item, at) => (at === index ? { ...item, id } : item)));
                      return undefined;
                    }}
                  />
                  <button
                    class="button button-quiet button-small"
                    type="button"
                    onClick={() => setActors(allowedActors.filter((_, at) => at !== index))}
                  >
                    Remove actor {index + 1}
                  </button>
                </fieldset>
              ))}
              <button
                class="button button-small"
                type="button"
                onClick={() => setActors([...allowedActors, { type: 'User', id: '' }])}
              >
                Add actor
              </button>
            </>
          )}
          {otherRules.length > 0 && (
            <p class="muted small">
              Additional rules are kept as configured: {otherRules.join(', ')}. Edit them in the YAML file.
            </p>
          )}
        </div>
      </Group>
    </>
  );
}

function RulesetForm({
  entry,
  saved,
  change,
  problemIn,
  ownerTypeHasPushRulesets,
  appLookup,
}: FormProps & {
  readonly ownerTypeHasPushRulesets: boolean;
  readonly appLookup: GitHubAppLookup | undefined;
}): JSX.Element {
  const known = new Set(ruleKinds.map(([type]) => type));
  const others = items(entry['rules'])
    .filter(isEntry)
    .map((rule) => text(rule['type']))
    .filter((type) => !known.has(type));
  const pullRequest = ruleOf(entry, 'pull_request');
  const pullParameters = isEntry(pullRequest?.['parameters']) ? pullRequest['parameters'] : {};
  const checks = ruleOf(entry, 'required_status_checks');
  const checkParameters = isEntry(checks?.['parameters']) ? checks['parameters'] : {};
  return (
    <>
      <Group title="Target">
        <Choice
          label="Applies to"
          options={[
            ['Branches', 'branch'],
            ['Tags', 'tag'],
            ...(ownerTypeHasPushRulesets ? [['Pushes', 'push'] as const] : []),
          ]}
          value={entry['target']}
          onChoose={(value) => {
            change(withKey(entry, 'target', value));
          }}
        />
        <Choice
          label="Enforcement"
          options={[
            ['Active', 'active'],
            ['Evaluate', 'evaluate'],
            ['Disabled', 'disabled'],
          ]}
          value={entry['enforcement']}
          onChoose={(value) => {
            change(withKey(entry, 'enforcement', value));
          }}
        />
        <RefTargets entry={entry} saved={saved} change={change} side="include" />
        <RefTargets entry={entry} saved={saved} change={change} side="exclude" />
      </Group>
      <BypassList
        entry={entry}
        saved={saved}
        change={change}
        appLookup={appLookup}
        organizationActorsOffered={ownerTypeHasPushRulesets}
      />
      <Group
        title="Rules"
        description={
          entry['rules'] === undefined
            ? 'The profile sets no rules for it, so each repository keeps the rules its ruleset has.'
            : 'The ruleset has exactly these rules on each repository. Applying removes every other rule it has there.'
        }
      >
        {entry['rules'] !== undefined && (
          <div class="setting">
            <button
              class="button button-quiet button-small"
              type="button"
              onClick={() => {
                change(withKey(entry, 'rules', undefined));
              }}
            >
              Leave its rules to GitHub
            </button>
          </div>
        )}
        {ruleKinds.map(([type, label, description]) => (
          <div class="setting" key={type}>
            <Check
              label={label}
              note={description}
              checked={ruleOf(entry, type) !== undefined}
              onCheck={(checked) => {
                change(withRule(entry, type, checked, saved));
              }}
            />
            {type === 'pull_request' && pullRequest !== undefined && (
              <div class="setting-nested rule-options">
                <TextBox
                  label="Required approvals"
                  value={text(pullParameters['required_approving_review_count'])}
                  placeholder="Each repository's own"
                  onText={(typed) => {
                    const approvals = parseWholeNumberUpTo(typed, 10, 'Required approvals');
                    if (typeof approvals === 'string') {
                      return approvals;
                    }
                    change(withRuleParameter(entry, type, 'required_approving_review_count', approvals.value));
                    return undefined;
                  }}
                />
                {pullRequestFlags.map(([key, flag]) => (
                  <Check
                    key={key}
                    label={flag}
                    checked={pullParameters[key] === true}
                    onCheck={(checked) => {
                      change(withRuleParameter(entry, type, key, checked));
                    }}
                  />
                ))}
              </div>
            )}
            {type === 'required_status_checks' && checks !== undefined && (
              <div class="setting-nested rule-options">
                <Check
                  label="Require branches to be up to date before merging"
                  checked={checkParameters['strict_required_status_checks_policy'] === true}
                  onCheck={(checked) => {
                    change(withRuleParameter(entry, type, 'strict_required_status_checks_policy', checked));
                  }}
                />
                <TextBox
                  label="Status checks"
                  field="status-checks"
                  problem={problemIn('status-checks')}
                  mono
                  multiline
                  value={statusChecks(entry).join('\n')}
                  note="One check a line, by the name it reports."
                  onText={(typed) => {
                    change(withStatusChecks(entry, uniqueTrimmedNonBlankLines(typed)));
                    return undefined;
                  }}
                />
              </div>
            )}
          </div>
        ))}
        {others.length > 0 && (
          <p class="setting muted small">Also keeps these rules from the profile file: {others.join(', ')}.</p>
        )}
      </Group>
    </>
  );
}

const branchChoices: readonly (readonly [string, DeploymentBranches])[] = [
  ['Any branch', 'any'],
  ['Protected branches', 'protected'],
  ['Chosen branches and tags', 'chosen'],
];

function isDeploymentBranches(value: unknown): value is DeploymentBranches | undefined {
  return value === undefined || branchChoices.some(([, choice]) => choice === value);
}

function EnvironmentForm({ entry, saved, change, problemIn }: FormProps): JSX.Element {
  const branches = deploymentBranches(entry);
  const patterns = (type: 'branch' | 'tag'): JSX.Element => (
    <TextBox
      label={type === 'branch' ? 'Branch patterns' : 'Tag patterns'}
      field={`${type}-patterns`}
      problem={problemIn(`${type}-patterns`)}
      mono
      multiline
      value={branchPolicies(entry, type).join('\n')}
      note={type === 'branch' ? 'One pattern a line, such as main or release/*.' : 'One pattern a line, such as v*.'}
      onText={(typed) => {
        change(withBranchPolicies(entry, type, uniqueTrimmedNonBlankLines(typed)));
        return undefined;
      }}
    />
  );
  return (
    <>
      <Group title="Protection rules">
        <TextBox
          label="Wait timer, in minutes"
          value={text(entry['wait_timer'])}
          placeholder="Each repository's own"
          onText={(typed) => {
            const minutes = parseWholeNumberUpTo(typed, 43_200, 'The wait timer');
            if (typeof minutes === 'string') {
              return minutes;
            }
            change(withKey(entry, 'wait_timer', minutes.value));
            return undefined;
          }}
        />
        <Kept
          entry={entry}
          saved={saved}
          change={change}
          name="reviewers"
          label="Required reviewers"
          none="None"
          noun="reviewer"
        />
        <Choice
          label="Prevent self-review"
          options={[
            ['On', true],
            ['Off', false],
          ]}
          value={entry['prevent_self_review']}
          onChoose={(value) => {
            change(withKey(entry, 'prevent_self_review', value));
          }}
        />
      </Group>
      <Group title="Deployment branches and tags">
        <Choice
          label="Deployment branches"
          options={branchChoices}
          value={branches}
          onChoose={(value) => {
            if (isDeploymentBranches(value)) {
              change(withDeploymentBranches(entry, value, saved));
            }
          }}
        />
        {branches === 'chosen' && patterns('branch')}
        {branches === 'chosen' && patterns('tag')}
      </Group>
    </>
  );
}

function LabelForm({
  entry,
  change,
  problemIn,
  savedName,
}: FormProps & { readonly savedName: string | undefined }): JSX.Element {
  const id = useId();
  const color = hexColor(entry);
  const typedColor = typeof entry['color'] === 'string' ? entry['color'] : '';
  const description = entry['description'];
  const renamedFrom = items(entry['renamed_from']).map(String);
  const name = typeof entry['name'] === 'string' ? entry['name'].trim() : '';
  // A label is the same one in any case, so only another name is a rename.
  const renamed = savedName !== undefined && name !== '' && name.toLowerCase() !== savedName.toLowerCase();
  return (
    <>
      <Group title="Look">
        <div class="setting">
          <div class="setting-head">
            <div class="setting-text">
              <strong id={id}>Color</strong>
              <span class="muted small">
                {entry['color'] === undefined
                  ? "Not set here, so each repository keeps the label's own."
                  : 'One of GitHub’s colors, or six hex digits.'}
              </span>
            </div>
            <span
              class="label-preview"
              style={
                color === undefined
                  ? undefined
                  : { background: `#${color}`, color: luminance(color) > 0.6 ? '#14281a' : '#ffffff' }
              }
            >
              {name === '' ? 'label' : name}
            </span>
          </div>
          <div class="swatches" role="radiogroup" aria-labelledby={id}>
            {palette.map(([hex, swatch]) => (
              <label key={hex} title={swatch}>
                <input
                  type="radio"
                  name={id}
                  aria-label={swatch}
                  checked={color === hex}
                  onChange={() => {
                    change(withKey(entry, 'color', hex));
                  }}
                />
                <span style={{ background: `#${hex}` }} />
              </label>
            ))}
          </div>
        </div>
        <TextBox
          label="Hex color"
          field="color"
          mono
          value={typedColor}
          placeholder="Each repository's own"
          problem={problemIn('color')}
          onText={(typed) => {
            change(withKey(entry, 'color', typed.trim() === '' ? undefined : typed.trim()));
            return undefined;
          }}
        />
        <TextBox
          label="Description"
          value={typeof description === 'string' ? description : ''}
          note={
            description === undefined
              ? 'Each repository keeps its own description.'
              : 'An empty description clears each repository’s.'
          }
          onText={(typed) => {
            change(withKey(entry, 'description', typed));
            return undefined;
          }}
        />
        {description !== undefined && (
          <div class="setting">
            <button
              class="button button-quiet button-small"
              type="button"
              onClick={() => {
                change(withKey(entry, 'description', undefined));
              }}
            >
              Leave each repository's own description
            </button>
          </div>
        )}
      </Group>
      <Group
        title="Renames"
        description="A repository that has one of these names and not the label has it renamed, so issues and pull requests keep the label."
      >
        <TextBox
          label="Renamed from"
          field="renamed-from"
          problem={problemIn('renamed-from')}
          multiline
          value={renamedFrom.join('\n')}
          note="One old name a line."
          onText={(typed) => {
            const names = uniqueTrimmedNonBlankLines(typed);
            change(withKey(entry, 'renamed_from', names.length > 0 ? names : undefined));
            return undefined;
          }}
        />
        {renamed && !renamedFrom.some((old) => old.toLowerCase() === savedName.toLowerCase()) && (
          <div class="setting">
            <p class="muted small">
              Applying creates {name} and leaves {savedName} on each repository, unless Renamed from lists {savedName}.
            </p>
            <button
              class="button button-small"
              type="button"
              onClick={() => {
                change(withKey(entry, 'renamed_from', [...renamedFrom, savedName]));
              }}
            >
              Rename it on GitHub too
            </button>
          </div>
        )}
      </Group>
    </>
  );
}

function summary(row: EntryRow): string {
  const entry = row.entry;
  if (entry === undefined) {
    return 'Taken out of the profile.';
  }
  if (entry['absent'] === true) {
    return 'Removed from each repository.';
  }
  if (row.list === 'rulesets' || row.list === 'actions_policies') {
    const rules = items(entry['rules']).length;
    return [
      text(entry['target']),
      text(entry['enforcement']),
      entry['rules'] === undefined ? '' : `${rules} ${rules === 1 ? 'rule' : 'rules'}`,
    ]
      .filter((part) => part !== '')
      .join(', ');
  }
  if (row.list === 'labels') {
    return text(entry['description']);
  }
  return typeof entry['wait_timer'] === 'number' ? `Waits ${entry['wait_timer']} minutes` : '';
}

interface EntryFormProps {
  readonly single?: boolean;
  readonly editor: ProfileEditor;
  readonly row: EntryRow;
  readonly entry: Entry;
  readonly ownerTypeHasPushRulesets: boolean;
  readonly onBack: () => void;
  /** Set when the form opened to go to a problem in it. */
  readonly goTo: EntryGoTo | undefined;
}

function EntryForm({
  editor,
  row,
  entry,
  ownerTypeHasPushRulesets,
  onBack,
  goTo,
  single,
}: EntryFormProps): JSX.Element {
  const noun = nouns[row.list];
  const back = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLDivElement>(null);
  // The form takes the keyboard when it opens, since the row that opened it is gone, or the field it opened to go to.
  useEffect(() => {
    const field =
      goTo === undefined
        ? undefined
        : (form.current?.querySelector<HTMLElement>(`[data-entry-field="${goTo.field}"]`) ??
          form.current?.querySelector<HTMLElement>('[aria-invalid="true"]'));
    field?.scrollIntoView({ block: 'center' });
    (field ?? back.current)?.focus();
  }, [goTo]);
  const problemIn = (field: EntryField): string | undefined =>
    row.applyProblemField === field ? row.applyProblem : undefined;
  const change = (next: Entry): void => {
    run(editor.changeEntry(row, next));
  };
  const missingPermissions = editor.entryListMissingPermissions.value[row.list];
  const absent = entry['absent'] === true;
  const renamable = row.source === 'here' || row.source === undefined;
  const name = typeof entry['name'] === 'string' ? entry['name'] : '';
  // GitHub knows an environment by its name in any case, and a ruleset by its name as written.
  // A name only this profile's draft has is on no repository yet, so changing it leaves nothing behind.
  const appliedName = typeof row.applied?.['name'] === 'string' ? row.applied['name'] : undefined;
  const renamed =
    appliedName !== undefined &&
    name.trim() !== '' &&
    (row.list === 'rulesets' || row.list === 'actions_policies'
      ? name.trim() !== appliedName
      : name.trim().toLowerCase() !== appliedName.toLowerCase());
  return (
    <div class="groups" ref={form}>
      <div class="entry-bar">
        {single !== true && (
          <button class="button button-quiet" type="button" ref={back} onClick={onBack}>
            Back to {noun.many}
          </button>
        )}
        <span class="muted small">
          {row.source === undefined
            ? 'New, not saved yet.'
            : row.inDraft === 'new'
              ? 'New in the draft. It applies once you save.'
              : row.inDraft === 'changed'
                ? 'Changed in the draft. It applies once you save.'
                : row.source === 'here'
                  ? single === true
                    ? 'Set in this definition.'
                    : editor.canHoldDrafts
                      ? 'Set in this profile.'
                      : 'Set in this apply.'
                  : `From ${row.source}. Changing it here overrides it.`}
        </span>
        {row.unsaved && row.savedName !== undefined && (
          <button
            class="button button-quiet button-small"
            type="button"
            onClick={() => {
              run(editor.resetEntry(row));
            }}
          >
            Reset
          </button>
        )}
        {renamable && single !== true && (
          <button
            class="button button-quiet button-small"
            type="button"
            onClick={() => {
              run(editor.takeOut(row));
              onBack();
            }}
          >
            Take out of profile
          </button>
        )}
      </div>
      {row.outOfDate && (
        <div class="notice notice-drift" role="alert">
          <p>{row.applyProblem}</p>
          <div class="notice-actions">
            <button
              class="button"
              type="button"
              onClick={() => {
                run(editor.keepEntry(row));
              }}
            >
              Keep mine
            </button>
            <button
              class="button"
              type="button"
              onClick={() => {
                run(editor.resetEntry(row));
              }}
            >
              Reset
            </button>
          </div>
        </div>
      )}
      {missingPermissions.length > 0 && (
        <MissingPermissionsNote permissions={missingPermissions} settingsUrl={editor.installationSettingsUrl.value} />
      )}
      <fieldset class="entry-fields" disabled={missingPermissions.length > 0}>
        <Group title={noun.title}>
          <TextBox
            label="Name"
            field="name"
            value={name}
            disabled={!renamable}
            problem={problemIn('name')}
            note={
              !renamable
                ? `It comes from ${row.source}, so it keeps its name.`
                : renamed && row.list !== 'labels'
                  ? `GitHub knows each ${noun.one} by its name, so applying this profile creates ${name.trim()} and leaves ${appliedName} on each repository as it is.`
                  : undefined
            }
            onText={(typed) => {
              change({ ...entry, name: typed });
              return undefined;
            }}
          />
          <div class="setting">
            <div class="segments" role="radiogroup" aria-label={`What the profile does with the ${noun.one}`}>
              <label>
                <input
                  type="radio"
                  name="entry-state"
                  checked={!absent}
                  onChange={() => {
                    run(editor.setAbsent(row, false));
                  }}
                />
                <span>Manage it</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="entry-state"
                  checked={absent}
                  onChange={() => {
                    run(editor.setAbsent(row, true));
                  }}
                />
                <span>Remove it from the repository</span>
              </label>
            </div>
            {absent && <p class="muted small">Applying deletes it from each repository that follows the profile.</p>}
          </div>
        </Group>
        {!absent && row.list === 'actions_policies' && (
          <ActionPolicyForm entry={entry} saved={row.saved} change={change} problemIn={problemIn} />
        )}
        {!absent && row.list === 'rulesets' && (
          <RulesetForm
            entry={entry}
            saved={row.saved}
            change={change}
            problemIn={problemIn}
            ownerTypeHasPushRulesets={ownerTypeHasPushRulesets}
            appLookup={editor.appLookup}
          />
        )}
        {!absent && row.list === 'environments' && (
          <EnvironmentForm entry={entry} saved={row.saved} change={change} problemIn={problemIn} />
        )}
        {!absent && row.list === 'labels' && (
          <LabelForm entry={entry} saved={row.saved} change={change} problemIn={problemIn} savedName={appliedName} />
        )}
      </fieldset>
      {single !== true &&
        row.source === undefined &&
        !absent &&
        (row.list === 'actions_policies' || row.list === 'environments' || row.list === 'rulesets') && (
          <ReusableDefinitionOption editor={editor} section={row.list} entryKey={row.key} defaultName={name} />
        )}
    </div>
  );
}

/** With entries selected, the actions change only those, and their labels drop "all". */
function entryBatchActions(
  editor: ProfileEditor,
  list: EntryList,
  batch: EntryListBatch,
  noun: { readonly one: string; readonly many: string },
): readonly BatchAction[] {
  const selecting = batch.selected > 0;
  const counted = (count: number): string => `${selecting ? 'selected ' : ''}${count === 1 ? noun.one : noun.many}`;
  return [
    {
      label: selecting ? 'Reset' : 'Reset all',
      count: batch.unsaved,
      counted: counted(batch.unsaved),
      act: () => editor.resetAllEntriesIn(list),
    },
    {
      label: selecting ? 'Take out' : 'Take out all',
      count: batch.canBeTakenOut,
      counted: counted(batch.canBeTakenOut),
      act: () => editor.takeOutAllIn(list),
    },
    {
      label: selecting ? 'Put back' : 'Put all back',
      count: batch.canBePutBack,
      counted: counted(batch.canBePutBack),
      act: () => editor.putAllBackIn(list),
    },
  ];
}

interface EntriesProps {
  readonly single?: boolean;
  readonly editor: ProfileEditor;
  readonly list: EntryList;
  readonly ownerTypeHasPushRulesets: boolean;
  readonly goTo?: EntryGoTo | undefined;
}

export function Entries({ editor, list: kind, ownerTypeHasPushRulesets, goTo, single }: EntriesProps): JSX.Element {
  const [openKey, setOpenKey] = useState<string | undefined>(goTo?.rowKey);
  // Only the form a go-to opened puts the keyboard in its field; one opened from the list again starts at the top.
  const [goingTo, setGoingTo] = useState<EntryGoTo | undefined>(goTo);
  useEffect(() => {
    if (goTo !== undefined) {
      setOpenKey(goTo.rowKey);
      setGoingTo(goTo);
    }
  }, [goTo]);
  const rows = editor.entries.value[kind];
  const noun = nouns[kind];
  const batch = editor.entryListBatches.value[kind];
  const missingPermissions = editor.entryListMissingPermissions.value[kind];
  const turnedOff = missingPermissions.length > 0;
  const previewingReferences = editor.previewingReferences.value;
  // A save gives a new or renamed entry the key of its saved name, so the open one is found by that name then.
  const openName = useRef<string | undefined>(undefined);
  const open =
    (single === true ? rows[0] : rows.find((row) => row.key === openKey)) ??
    (openKey === undefined || openName.current === undefined
      ? undefined
      : rows.find((row) => row.savedName === openName.current));
  openName.current = typeof open?.entry?.['name'] === 'string' ? open.entry['name'].trim() : undefined;
  const add = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const shown = open?.entry === undefined ? undefined : open;
  // Once the open entry is gone, as after a reset of a new one, the list shows.
  useEffect(() => {
    if (openKey !== undefined && shown === undefined) {
      setOpenKey(undefined);
    }
  }, [openKey, shown]);
  // The list takes the keyboard back whenever a form closes, since the button that closed it is gone.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && shown === undefined) {
      if (add.current?.disabled === false) {
        add.current.focus();
      } else {
        list.current?.querySelector<HTMLButtonElement>('button.row:not(:disabled)')?.focus();
      }
    }
    wasOpen.current = shown !== undefined;
  }, [shown]);

  const referenceNote = editor.referencesChanged.value ? (
    <p class="muted small" role="status">
      {previewingReferences
        ? 'This previews the changed references. Save reference changes before editing these entries.'
        : 'Fix the profile configuration to preview shared definition changes. These entries use the saved references.'}
    </p>
  ) : null;

  if (shown?.entry !== undefined && !previewingReferences) {
    return (
      <>
        {referenceNote}
        <EntryForm
          key={openKey}
          editor={editor}
          row={shown}
          entry={shown.entry}
          ownerTypeHasPushRulesets={ownerTypeHasPushRulesets}
          goTo={goingTo?.rowKey === shown.key ? goingTo : undefined}
          single={single === true}
          onBack={() => {
            setOpenKey(undefined);
            setGoingTo(undefined);
          }}
        />
      </>
    );
  }

  return (
    <div class="groups">
      {referenceNote}
      {turnedOff && (
        <MissingPermissionsNote permissions={missingPermissions} settingsUrl={editor.installationSettingsUrl.value} />
      )}
      <div class="entry-bar">
        <p class="muted small">
          {rows.length === 0
            ? `The profile manages no ${noun.many}, so each repository keeps its own.`
            : `The profile manages only the ${noun.many} it names. Each repository keeps its others.`}
        </p>
        <button
          class="button"
          type="button"
          ref={add}
          disabled={turnedOff || previewingReferences}
          onClick={() => {
            run(editor.addEntry(kind, { name: '' }).then(setOpenKey));
          }}
        >
          New {noun.one}
        </button>
      </div>
      {rows.length > 0 && !previewingReferences && (
        <div class="selection-bar">
          {batch.selected > 0 && <span class="small">{batch.selected} selected</span>}
          <button
            class="button button-quiet button-small"
            type="button"
            aria-label={`${batch.selected === rows.length ? 'Deselect' : 'Select'} all ${noun.many}`}
            onClick={() => {
              if (batch.selected === rows.length) {
                editor.deselectAllEntriesIn(kind);
              } else {
                editor.selectAllEntriesIn(kind);
              }
            }}
          >
            {batch.selected === rows.length ? 'Deselect all' : 'Select all'}
          </button>
          {batch.selected > 0 && batch.selected < rows.length && (
            <button
              class="button button-quiet button-small"
              type="button"
              aria-label={`Deselect all ${noun.many}`}
              onClick={() => {
                editor.deselectAllEntriesIn(kind);
              }}
            >
              Deselect all
            </button>
          )}
          <BatchActions
            editor={editor}
            scope={kind}
            describeDone={describeEntriesDone(noun.one, noun.many)}
            actions={entryBatchActions(editor, kind, batch, noun)}
          />
        </div>
      )}
      {rows.length > 0 && (
        <ul class="rows" ref={list}>
          {rows.map((row) => {
            const entry = row.entry;
            const name = entry === undefined ? (row.savedName ?? '') : text(entry['name']);
            const color = entry === undefined ? undefined : hexColor(entry);
            return (
              <li key={row.key} class="selectable-row entry-row">
                <input
                  class="select-box"
                  type="checkbox"
                  aria-label={`Select ${name === '' ? `new ${noun.one}` : name}`}
                  checked={editor.isEntrySelected(row)}
                  disabled={previewingReferences}
                  onChange={(event) => {
                    editor.selectEntry(row, event.currentTarget.checked);
                  }}
                />
                <button
                  class="row"
                  type="button"
                  disabled={entry === undefined || previewingReferences}
                  onClick={() => {
                    setOpenKey(row.key);
                  }}
                >
                  {kind === 'labels' && color !== undefined ? (
                    <span
                      class="label-preview"
                      style={{ background: `#${color}`, color: luminance(color) > 0.6 ? '#14281a' : '#ffffff' }}
                    >
                      {name}
                    </span>
                  ) : (
                    <span class={entry === undefined ? 'row-name struck' : 'row-name'}>
                      {name === '' ? `New ${noun.one}` : name}
                    </span>
                  )}
                  <span class="muted small entry-summary">{summary(row)}</span>
                  {row.outOfDate ? (
                    <span class="pill pill-remove">Changed elsewhere</span>
                  ) : (
                    row.applyProblem !== undefined && <span class="pill pill-remove">Not finished</span>
                  )}
                  {row.unsaved && <span class="pill pill-drift">Not saved</span>}
                  {row.inDraft !== undefined && (
                    <span class="pill pill-draft">
                      {row.inDraft === 'taken-out' ? 'Taken out in the draft' : 'Draft'}
                    </span>
                  )}
                  {row.source !== 'here' && row.source !== undefined && (
                    <span class="muted small">From {row.source}</span>
                  )}
                </button>
                {entry === undefined && (
                  <button
                    class="button button-quiet button-small"
                    type="button"
                    disabled={previewingReferences}
                    onClick={() => {
                      run(editor.putBack(row));
                    }}
                  >
                    Put it back
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
