import type { ComponentChildren, JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { type Entry, type EntryList, type EntryRow, type ProfileEditor, sameValue } from '../app/profile-editor.js';
import { run } from './run.js';

const nouns: Readonly<Record<EntryList, { readonly one: string; readonly many: string; readonly title: string }>> = {
  rulesets: { one: 'ruleset', many: 'rulesets', title: 'Rulesets' },
  environments: { one: 'environment', many: 'environments', title: 'Environments' },
  labels: { one: 'label', many: 'labels', title: 'Labels' },
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

const statusChecksProblem = 'Name at least one status check that must pass.';

const pullRequestFlags: readonly (readonly [string, string])[] = [
  ['dismiss_stale_reviews_on_push', 'Dismiss approvals when new commits are pushed'],
  ['require_code_owner_review', 'Require review from code owners'],
  ['require_last_push_approval', 'Require approval of the most recent push'],
  ['required_review_thread_resolution', 'Require conversations to be resolved'],
];

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A string or a number as text, and anything else as none. */
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** How light a color is, from 0 to 1, by the weights the eye gives red, green, and blue. */
function luminance(hex: string): number {
  const [red = 0, green = 0, blue = 0] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** An entry with one key set, or with undefined left out, so GitHub keeps its own. */
function withKey(entry: Entry, key: string, value: unknown): Entry {
  const { [key]: _old, ...rest } = entry;
  return value === undefined ? rest : { ...rest, [key]: value };
}

interface FormProps {
  readonly entry: Entry;
  readonly change: (entry: Entry) => void;
}

interface ChoiceProps extends FormProps {
  readonly name: string;
  readonly label: string;
  readonly options: readonly (readonly [string, unknown])[];
  /** Whether the choice can be cleared, so each repository keeps its own. */
  readonly optional?: boolean;
}

function Choice({ entry, change, name, label, options, optional = true }: ChoiceProps): JSX.Element {
  const value = entry[name];
  return (
    <div class="setting">
      <div class="setting-head">
        <div class="setting-text">
          <strong id={`entry-${name}`}>{label}</strong>
          {value === undefined && <span class="muted small">Not set here, so each repository keeps its own.</span>}
        </div>
        <div class="segments" role="radiogroup" aria-labelledby={`entry-${name}`}>
          {options.map(([text, option]) => (
            <label key={text}>
              <input
                type="radio"
                name={`entry-${name}`}
                checked={value !== undefined && sameValue(option, value)}
                onChange={() => {
                  change(withKey(entry, name, option));
                }}
              />
              <span>{text}</span>
            </label>
          ))}
        </div>
        <div class="setting-actions">
          {optional && value !== undefined && (
            <button
              class="button button-quiet button-small"
              type="button"
              aria-label={`Leave ${label} to GitHub`}
              onClick={() => {
                change(withKey(entry, name, undefined));
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
  readonly onText: (text: string) => void;
  readonly multiline?: boolean;
  readonly mono?: boolean;
  readonly placeholder?: string;
  readonly note?: string | undefined;
  readonly problem?: string | undefined;
}

/** A text box that keeps what is typed in it, as typed, while the entry it edits is redrawn. */
function TextBox({ label, value, onText, multiline, mono, placeholder, note, problem }: TextProps): JSX.Element {
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const shared = {
    class: `field${mono === true ? ' mono' : ''}${multiline === true ? ' field-lines' : ''}`,
    'aria-label': label,
    'aria-invalid': problem !== undefined,
    placeholder,
    value: typed ?? value,
    onBlur: (): void => {
      setTyped(undefined);
    },
  };
  const take = (text: string): void => {
    setTyped(text);
    onText(text);
  };
  return (
    <div class="setting">
      <div class="setting-head">
        <div class="setting-text">
          <strong>{label}</strong>
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
      {problem !== undefined && (
        <p class="problem small" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function Check({
  label,
  checked,
  onCheck,
  note,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheck: (checked: boolean) => void;
  readonly note?: string;
}): JSX.Element {
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

function Group({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ComponentChildren;
}): JSX.Element {
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

/** A list the editor shows as kept or cleared, since its items, such as reviewers by id, are set in the profile file. */
function Kept({
  entry,
  change,
  name,
  label,
  none,
  noun,
}: FormProps & {
  readonly name: string;
  readonly label: string;
  readonly none: string;
  readonly noun: string;
}): JSX.Element {
  const [kept] = useState(() => list(entry[name]));
  const options: (readonly [string, unknown])[] = [[none, []]];
  if (kept.length > 0) {
    options.push([`${kept.length} ${kept.length === 1 ? noun : `${noun}s`}, as in the profile file`, kept]);
  }
  return <Choice entry={entry} change={change} name={name} label={label} options={options} />;
}

function RulesetForm({ entry, change, pushes }: FormProps & { readonly pushes: boolean }): JSX.Element {
  const conditions = record(entry['conditions']) ?? {};
  const refName = record(conditions['ref_name']);
  const rules = list(entry['rules'])
    .map(record)
    .filter((rule) => rule !== undefined);
  const setRefs = (key: 'include' | 'exclude', text: string): void => {
    const next = { include: list(refName?.['include']), exclude: list(refName?.['exclude']), [key]: lines(text) };
    const { ref_name: _old, ...others } = conditions;
    const merged = next.include.length + next.exclude.length > 0 ? { ...others, ref_name: next } : others;
    change(withKey(entry, 'conditions', Object.keys(merged).length > 0 ? merged : undefined));
  };
  const setRule = (type: string, rule: Readonly<Record<string, unknown>> | undefined): void => {
    const has = rules.some((item) => item['type'] === type);
    const next =
      rule === undefined
        ? rules.filter((item) => item['type'] !== type)
        : has
          ? rules.map((item) => (item['type'] === type ? rule : item))
          : [...rules, rule];
    change(withKey(entry, 'rules', next));
  };
  const setParameter = (rule: Readonly<Record<string, unknown>>, key: string, value: unknown): void => {
    const parameters = withKey(record(rule['parameters']) ?? {}, key, value);
    setRule(
      String(rule['type']),
      Object.keys(parameters).length > 0 ? { ...rule, parameters } : withKey(rule, 'parameters', undefined),
    );
  };
  const known = new Set(ruleKinds.map(([type]) => type));
  const others = rules.map((rule) => String(rule['type'])).filter((type) => !known.has(type));
  const pullRequest = rules.find((rule) => rule['type'] === 'pull_request');
  const checks = rules.find((rule) => rule['type'] === 'required_status_checks');
  const pullParameters = record(pullRequest?.['parameters']) ?? {};
  const checkParameters = record(checks?.['parameters']) ?? {};
  const contexts = list(checkParameters['required_status_checks']).map((item) => text(record(item)?.['context']));
  return (
    <>
      <Group title="Target">
        <Choice
          entry={entry}
          change={change}
          name="target"
          label="Applies to"
          options={[['Branches', 'branch'], ['Tags', 'tag'], ...(pushes ? [['Pushes', 'push'] as const] : [])]}
        />
        <Choice
          entry={entry}
          change={change}
          name="enforcement"
          label="Enforcement"
          options={[
            ['Active', 'active'],
            ['Evaluate', 'evaluate'],
            ['Disabled', 'disabled'],
          ]}
        />
        <Kept entry={entry} change={change} name="bypass_actors" label="Bypass" none="Nobody" noun="actor" />
        <TextBox
          label="Include"
          mono
          multiline
          value={list(refName?.['include']).join('\n')}
          note="One pattern a line, such as ~DEFAULT_BRANCH, ~ALL, or refs/heads/release/*."
          onText={(text) => {
            setRefs('include', text);
          }}
        />
        <TextBox
          label="Exclude"
          mono
          multiline
          value={list(refName?.['exclude']).join('\n')}
          onText={(text) => {
            setRefs('exclude', text);
          }}
        />
      </Group>
      <Group
        title="Rules"
        description={
          entry['rules'] === undefined
            ? 'The profile sets no rules for it, so each repository keeps the rules its ruleset has.'
            : 'The rules it has on each repository. Every other rule of the ruleset is removed.'
        }
      >
        {ruleKinds.map(([type, label, description]) => {
          const rule = rules.find((item) => item['type'] === type);
          return (
            <div class="setting" key={type}>
              <Check
                label={label}
                note={description}
                checked={rule !== undefined}
                onCheck={(checked) => {
                  setRule(type, checked ? { type } : undefined);
                }}
              />
              {type === 'pull_request' && pullRequest !== undefined && (
                <div class="setting-nested rule-options">
                  <TextBox
                    label="Required approvals"
                    value={
                      pullParameters['required_approving_review_count'] === undefined
                        ? ''
                        : text(pullParameters['required_approving_review_count'])
                    }
                    placeholder="Each repository's own"
                    problem={undefined}
                    onText={(text) => {
                      const count = text.trim();
                      if (count === '' || /^\d+$/u.test(count)) {
                        setParameter(
                          pullRequest,
                          'required_approving_review_count',
                          count === '' ? undefined : Number(count),
                        );
                      }
                    }}
                  />
                  {pullRequestFlags.map(([key, text]) => (
                    <Check
                      key={key}
                      label={text}
                      checked={pullParameters[key] === true}
                      onCheck={(checked) => {
                        setParameter(pullRequest, key, checked);
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
                      setParameter(checks, 'strict_required_status_checks_policy', checked);
                    }}
                  />
                  <TextBox
                    label="Status checks"
                    mono
                    multiline
                    value={contexts.join('\n')}
                    note="One check a line, by the name it reports."
                    problem={contexts.length === 0 ? statusChecksProblem : undefined}
                    onText={(text) => {
                      const kept = list(checkParameters['required_status_checks']).map(record);
                      setParameter(
                        checks,
                        'required_status_checks',
                        lines(text).map((context) => kept.find((item) => item?.['context'] === context) ?? { context }),
                      );
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
        {others.length > 0 && (
          <p class="setting muted small">Also keeps these rules from the profile file: {others.join(', ')}.</p>
        )}
      </Group>
    </>
  );
}

function EnvironmentForm({ entry, change }: FormProps): JSX.Element {
  const policy = record(entry['deployment_branch_policy']);
  const custom = policy?.['custom_branch_policies'] === true;
  const policies = list(entry['branch_policies'])
    .map(record)
    .filter((item) => item !== undefined);
  const timer = entry['wait_timer'];
  const [timerProblem, setTimerProblem] = useState<string | undefined>(undefined);
  const setBranches = (value: unknown): void => {
    // The patterns belong to chosen branches and tags, and go with any other choice.
    const next = withKey(entry, 'deployment_branch_policy', value);
    change(record(value)?.['custom_branch_policies'] === true ? next : withKey(next, 'branch_policies', undefined));
  };
  return (
    <>
      <Group title="Protection rules">
        <TextBox
          label="Wait timer, in minutes"
          value={typeof timer === 'number' ? String(timer) : ''}
          placeholder="Each repository's own"
          problem={timerProblem}
          onText={(text) => {
            const minutes = text.trim();
            const valid = minutes === '' || (/^\d+$/u.test(minutes) && Number(minutes) <= 43_200);
            setTimerProblem(valid ? undefined : 'The wait timer is a whole number of minutes, from 0 to 43200.');
            if (valid) {
              change(withKey(entry, 'wait_timer', minutes === '' ? undefined : Number(minutes)));
            }
          }}
        />
        <Kept entry={entry} change={change} name="reviewers" label="Required reviewers" none="None" noun="reviewer" />
        <Choice
          entry={entry}
          change={change}
          name="prevent_self_review"
          label="Prevent self-review"
          options={[
            ['On', true],
            ['Off', false],
          ]}
        />
      </Group>
      <Group title="Deployment branches and tags">
        <Choice
          entry={{ deployment_branch_policy: entry['deployment_branch_policy'] }}
          change={(next) => {
            setBranches(next['deployment_branch_policy']);
          }}
          name="deployment_branch_policy"
          label="Deployment branches"
          options={[
            ['Any branch', null],
            ['Protected branches', { protected_branches: true, custom_branch_policies: false }],
            ['Chosen branches and tags', { protected_branches: false, custom_branch_policies: true }],
          ]}
        />
        {custom && (
          <TextBox
            label="Branch and tag patterns"
            mono
            multiline
            value={policies
              .map((item) => (item['type'] === 'tag' ? `tag: ${String(item['name'])}` : String(item['name'])))
              .join('\n')}
            note="One pattern a line, such as main or release/*. Start a line with tag: for a tag pattern."
            onText={(text) => {
              change(
                withKey(
                  entry,
                  'branch_policies',
                  lines(text).map((line) =>
                    line.startsWith('tag:') ? { name: line.slice(4).trim(), type: 'tag' } : { name: line },
                  ),
                ),
              );
            }}
          />
        )}
      </Group>
    </>
  );
}

function LabelForm({ entry, change, savedName }: FormProps & { readonly savedName: string | undefined }): JSX.Element {
  const color = typeof entry['color'] === 'string' ? entry['color'].replace(/^#/u, '').toLowerCase() : undefined;
  const description = entry['description'];
  const renamedFrom = list(entry['renamed_from']).map(String);
  const name = typeof entry['name'] === 'string' ? entry['name'].trim() : '';
  const renamed = savedName !== undefined && name !== '' && name !== savedName;
  const light = color !== undefined && /^[0-9a-f]{6}$/u.test(color) && luminance(color) > 0.6;
  return (
    <>
      <Group title="Look">
        <div class="setting">
          <div class="setting-head">
            <div class="setting-text">
              <strong id="label-color">Color</strong>
              <span class="muted small">
                {color === undefined
                  ? "Not set here, so each repository keeps the label's own."
                  : 'One of GitHub’s colors, or six hex digits.'}
              </span>
            </div>
            <span
              class="label-preview"
              style={
                color !== undefined && /^[0-9a-f]{6}$/u.test(color)
                  ? { background: `#${color}`, color: light ? '#14281a' : '#ffffff' }
                  : undefined
              }
            >
              {name === '' ? 'label' : name}
            </span>
          </div>
          <div class="swatches" role="radiogroup" aria-labelledby="label-color">
            {palette.map(([hex, text]) => (
              <label key={hex} title={text}>
                <input
                  type="radio"
                  name="label-color"
                  aria-label={text}
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
          value={color ?? ''}
          placeholder="Each repository's own"
          problem={
            color !== undefined && !/^[0-9a-f]{6}$/u.test(color)
              ? 'The color is six hex digits, such as a2eeef, with or without #.'
              : undefined
          }
          onText={(text) => {
            change(withKey(entry, 'color', text.trim() === '' ? undefined : text.trim()));
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
          onText={(text) => {
            change(withKey(entry, 'description', text));
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
          onText={(text) => {
            const names = lines(text);
            change(withKey(entry, 'renamed_from', names.length > 0 ? names : undefined));
          }}
        />
        {renamed && !renamedFrom.includes(savedName) && (
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
    const rules = list(entry['rules']).length;
    return [
      text(entry['target']),
      text(entry['enforcement']),
      entry['rules'] === undefined ? undefined : `${rules} ${rules === 1 ? 'rule' : 'rules'}`,
    ]
      .filter((part) => part !== undefined && part !== '')
      .join(', ');
  }
  if (row.list === 'labels') {
    return typeof entry['description'] === 'string' ? entry['description'] : '';
  }
  return typeof entry['wait_timer'] === 'number' ? `Waits ${entry['wait_timer']} minutes` : '';
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
  // A save gives a new or renamed entry the key of its saved name, so the open one is found by name then.
  const openName = useRef<string | undefined>(undefined);
  const open =
    rows.find((row) => row.key === openKey) ??
    (openKey === undefined ? undefined : rows.find((row) => row.savedName === openName.current));
  openName.current = typeof open?.entry?.['name'] === 'string' ? open.entry['name'].trim() : undefined;

  if (open?.entry !== undefined) {
    const entry = open.entry;
    const change = (next: Entry): void => {
      run(editor.changeEntry(open, next));
    };
    const absent = entry['absent'] === true;
    const renamable = open.source === 'here' || open.source === undefined;
    const name = typeof entry['name'] === 'string' ? entry['name'] : '';
    const renamed = open.savedName !== undefined && name.trim() !== '' && name.trim() !== open.savedName;
    return (
      <div class="groups">
        <div class="entry-bar">
          <button
            class="button button-quiet"
            type="button"
            onClick={() => {
              setOpenKey(undefined);
            }}
          >
            Back to {noun.many}
          </button>
          <span class="muted small">
            {open.source === undefined
              ? 'New, not saved yet.'
              : open.source === 'here'
                ? 'Set in this profile.'
                : `From ${open.source}. Changing it here overrides it.`}
          </span>
          {open.unsaved && open.savedName !== undefined && (
            <button
              class="button button-quiet button-small"
              type="button"
              onClick={() => {
                run(editor.resetEntry(open));
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
                run(editor.takeOut(open));
                setOpenKey(undefined);
              }}
            >
              Take out of profile
            </button>
          )}
        </div>
        <Group title={noun.title.slice(0, -1)}>
          <TextBox
            label="Name"
            value={name}
            problem={open.problem === statusChecksProblem ? undefined : open.problem}
            note={
              !renamable
                ? `It comes from ${open.source}, so it keeps its name.`
                : renamed && kind !== 'labels'
                  ? `GitHub knows each ${noun.one} by its name, so applying this profile creates ${name.trim()} and leaves ${open.savedName} on each repository as it is.`
                  : undefined
            }
            onText={(text) => {
              if (renamable) {
                change({ ...entry, name: text });
              }
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
                    change({ name });
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
                    change({ name, absent: true });
                  }}
                />
                <span>Remove it from the repository</span>
              </label>
            </div>
            {absent && <p class="muted small">Applying deletes it from each repository that follows the profile.</p>}
          </div>
        </Group>
        {!absent && kind === 'rulesets' && <RulesetForm key={open.key} entry={entry} change={change} pushes={pushes} />}
        {!absent && kind === 'environments' && <EnvironmentForm key={open.key} entry={entry} change={change} />}
        {!absent && kind === 'labels' && (
          <LabelForm key={open.key} entry={entry} change={change} savedName={open.savedName} />
        )}
      </div>
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
            const name =
              entry === undefined ? (row.savedName ?? '') : typeof entry['name'] === 'string' ? entry['name'] : '';
            const color = typeof entry?.['color'] === 'string' ? entry['color'].replace(/^#/u, '') : undefined;
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
                  {kind === 'labels' && color !== undefined && /^[0-9a-f]{6}$/iu.test(color) ? (
                    <span
                      class="label-preview"
                      style={{
                        background: `#${color}`,
                        color: luminance(color.toLowerCase()) > 0.6 ? '#14281a' : '#ffffff',
                      }}
                    >
                      {name}
                    </span>
                  ) : (
                    <span class={entry === undefined ? 'row-name struck' : 'row-name'}>
                      {name === '' ? `New ${noun.one}` : name}
                    </span>
                  )}
                  <span class="muted small entry-summary">{summary(row)}</span>
                  {row.problem !== undefined && <span class="pill pill-remove">Not finished</span>}
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
