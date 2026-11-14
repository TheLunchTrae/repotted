import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

import type { EntryList, EntryRow } from '../app/entry-edits.js';
import {
  branchPolicies,
  deploymentBranches,
  type DeploymentBranches,
  type Entry,
  hexColor,
  isEntry,
  linesOf,
  refNames,
  ruleOf,
  statusChecks,
  withBranchPolicies,
  withDeploymentBranches,
  withKey,
  withRefNames,
  withRule,
  withRuleParameter,
  withStatusChecks,
} from '../app/entry-forms.js';
import { type ProfileEditor, sameValue } from '../app/profile-editor.js';
import { run } from './run.js';

const nouns: Readonly<Record<EntryList, { readonly one: string; readonly many: string; readonly title: string }>> = {
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

/** A string or a number as text, and anything else as none. */
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

interface FormProps {
  readonly entry: Entry;
  /** The entry as the profile has it saved, when it does. */
  readonly saved: Entry | undefined;
  readonly change: (entry: Entry) => void;
}

interface ChoiceProps {
  readonly label: string;
  readonly options: readonly (readonly [string, unknown])[];
  /** The value chosen, or undefined when each repository keeps its own. */
  readonly value: unknown;
  /** Takes the choice, or undefined to leave it to GitHub. */
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
    <div class="setting">
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
  readonly note?: string;
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

interface KeptProps extends FormProps {
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

/** A whole number from 0 up to a limit, as typed, or why the text isn't one. */
function count(typed: string, most: number, what: string): { readonly value: number | undefined } | string {
  const digits = typed.trim();
  if (digits === '') {
    return { value: undefined };
  }
  return /^\d+$/u.test(digits) && Number(digits) <= most
    ? { value: Number(digits) }
    : `${what} is a whole number, from 0 to ${most}.`;
}

function RulesetForm({ entry, saved, change, pushes }: FormProps & { readonly pushes: boolean }): JSX.Element {
  const known = new Set(ruleKinds.map(([type]) => type));
  const others = items(entry['rules'])
    .filter(isEntry)
    .map((rule) => text(rule['type']))
    .filter((type) => !known.has(type));
  const pullRequest = ruleOf(entry, 'pull_request');
  const pullParameters = isEntry(pullRequest?.['parameters']) ? pullRequest['parameters'] : {};
  const checks = ruleOf(entry, 'required_status_checks');
  const checkParameters = isEntry(checks?.['parameters']) ? checks['parameters'] : {};
  const refs = (side: 'include' | 'exclude', note?: string): JSX.Element => (
    <TextBox
      label={side === 'include' ? 'Include' : 'Exclude'}
      mono
      multiline
      value={refNames(entry, side).join('\n')}
      note={note}
      onText={(typed) => {
        change(withRefNames(entry, side, linesOf(typed), saved));
        return undefined;
      }}
    />
  );
  return (
    <>
      <Group title="Target">
        <Choice
          label="Applies to"
          options={[['Branches', 'branch'], ['Tags', 'tag'], ...(pushes ? [['Pushes', 'push'] as const] : [])]}
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
        <Kept
          entry={entry}
          saved={saved}
          change={change}
          name="bypass_actors"
          label="Bypass"
          none="Nobody"
          noun="actor"
        />
        {refs('include', 'One pattern a line, such as ~DEFAULT_BRANCH, ~ALL, or refs/heads/release/*.')}
        {refs('exclude')}
      </Group>
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
                    const approvals = count(typed, 10, 'Required approvals');
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
                  mono
                  multiline
                  value={statusChecks(entry).join('\n')}
                  note="One check a line, by the name it reports."
                  onText={(typed) => {
                    change(withStatusChecks(entry, linesOf(typed)));
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

function EnvironmentForm({ entry, saved, change }: FormProps): JSX.Element {
  const branches = deploymentBranches(entry);
  const patterns = (type: 'branch' | 'tag'): JSX.Element => (
    <TextBox
      label={type === 'branch' ? 'Branch patterns' : 'Tag patterns'}
      mono
      multiline
      value={branchPolicies(entry, type).join('\n')}
      note={type === 'branch' ? 'One pattern a line, such as main or release/*.' : 'One pattern a line, such as v*.'}
      onText={(typed) => {
        change(withBranchPolicies(entry, type, linesOf(typed)));
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
            const minutes = count(typed, 43_200, 'The wait timer');
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

function LabelForm({ entry, change, savedName }: FormProps & { readonly savedName: string | undefined }): JSX.Element {
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
          mono
          value={typedColor}
          placeholder="Each repository's own"
          problem={
            typedColor !== '' && color === undefined
              ? 'The color is six hex digits, such as a2eeef, with or without #.'
              : undefined
          }
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
          multiline
          value={renamedFrom.join('\n')}
          note="One old name a line."
          onText={(typed) => {
            const names = linesOf(typed);
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
  if (row.list === 'rulesets') {
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
  readonly editor: ProfileEditor;
  readonly row: EntryRow;
  readonly entry: Entry;
  readonly pushes: boolean;
  readonly onBack: () => void;
}

function EntryForm({ editor, row, entry, pushes, onBack }: EntryFormProps): JSX.Element {
  const noun = nouns[row.list];
  const back = useRef<HTMLButtonElement>(null);
  // The form takes the keyboard when it opens, since the row that opened it is gone.
  useEffect(() => {
    back.current?.focus();
  }, []);
  const change = (next: Entry): void => {
    run(editor.changeEntry(row, next));
  };
  const absent = entry['absent'] === true;
  const renamable = row.source === 'here' || row.source === undefined;
  const name = typeof entry['name'] === 'string' ? entry['name'] : '';
  // GitHub knows an environment by its name in any case, and a ruleset by its name as written.
  const renamed =
    row.savedName !== undefined &&
    name.trim() !== '' &&
    (row.list === 'rulesets'
      ? name.trim() !== row.savedName
      : name.trim().toLowerCase() !== row.savedName.toLowerCase());
  return (
    <div class="groups">
      <div class="entry-bar">
        <button class="button button-quiet" type="button" ref={back} onClick={onBack}>
          Back to {noun.many}
        </button>
        <span class="muted small">
          {row.source === undefined
            ? 'New, not saved yet.'
            : row.source === 'here'
              ? 'Set in this profile.'
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
        {renamable && (
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
          <p>{row.problem}</p>
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
      <Group title={noun.title}>
        <TextBox
          label="Name"
          value={name}
          disabled={!renamable}
          problem={row.outOfDate ? undefined : row.problem}
          note={
            !renamable
              ? `It comes from ${row.source}, so it keeps its name.`
              : renamed && row.list !== 'labels'
                ? `GitHub knows each ${noun.one} by its name, so applying this profile creates ${name.trim()} and leaves ${row.savedName} on each repository as it is.`
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
      {!absent && row.list === 'rulesets' && (
        <RulesetForm entry={entry} saved={row.saved} change={change} pushes={pushes} />
      )}
      {!absent && row.list === 'environments' && <EnvironmentForm entry={entry} saved={row.saved} change={change} />}
      {!absent && row.list === 'labels' && (
        <LabelForm entry={entry} saved={row.saved} change={change} savedName={row.savedName} />
      )}
    </div>
  );
}

interface EntriesProps {
  readonly editor: ProfileEditor;
  readonly list: EntryList;
  /** Whether the profile's owner type has push rulesets. */
  readonly pushes: boolean;
}

/** One tab of rulesets, environments, or labels: the list, or the one that is open. */
export function Entries({ editor, list: kind, pushes }: EntriesProps): JSX.Element {
  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const rows = editor.entries.value[kind];
  const noun = nouns[kind];
  // A save gives a new or renamed entry the key of its saved name, so the open one is found by that name then.
  const openName = useRef<string | undefined>(undefined);
  const open =
    rows.find((row) => row.key === openKey) ??
    (openKey === undefined || openName.current === undefined
      ? undefined
      : rows.find((row) => row.savedName === openName.current));
  openName.current = typeof open?.entry?.['name'] === 'string' ? open.entry['name'].trim() : undefined;
  const add = useRef<HTMLButtonElement>(null);
  const shown = open?.entry === undefined ? undefined : open;
  // Once the open entry is gone, as after a reset of a new one, the list shows, with the keyboard on it.
  useEffect(() => {
    if (openKey !== undefined && shown === undefined) {
      setOpenKey(undefined);
      add.current?.focus();
    }
  }, [openKey, shown]);

  if (shown?.entry !== undefined) {
    return (
      <EntryForm
        key={shown.savedName ?? shown.key}
        editor={editor}
        row={shown}
        entry={shown.entry}
        pushes={pushes}
        onBack={() => {
          setOpenKey(undefined);
        }}
      />
    );
  }

  return (
    <div class="groups">
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
          onClick={() => {
            run(editor.addEntry(kind, { name: '' }).then(setOpenKey));
          }}
        >
          New {noun.one}
        </button>
      </div>
      {rows.length > 0 && (
        <ul class="rows">
          {rows.map((row) => {
            const entry = row.entry;
            const name = entry === undefined ? (row.savedName ?? '') : text(entry['name']);
            const color = entry === undefined ? undefined : hexColor(entry);
            return (
              <li key={row.key} class="entry-row">
                <button
                  class="row"
                  type="button"
                  disabled={entry === undefined}
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
                    row.problem !== undefined && <span class="pill pill-remove">Not finished</span>
                  )}
                  {row.unsaved && <span class="pill pill-drift">Not saved</span>}
                  {row.source !== 'here' && row.source !== undefined && (
                    <span class="muted small">From {row.source}</span>
                  )}
                </button>
                {entry === undefined && (
                  <button
                    class="button button-quiet button-small"
                    type="button"
                    onClick={() => {
                      run(editor.resetEntry(row));
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
