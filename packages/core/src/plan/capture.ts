import type { z } from 'zod';

import type { GitHub, RepoRef } from '../github/client.js';
import { type OwnerConflict, partOwnerTypeCannotHold, withoutOwnerConflicts } from '../profiles/owner.js';
import {
  actionsSettings,
  actionPolicy,
  commitPairs,
  environment,
  identifyingRepositoryFields,
  label,
  mergeSettings,
  type Profile,
  repositorySettings,
  ruleset,
  securityAndAnalysis,
  securitySettings,
} from '../profiles/schema.js';
import { activeProfileSettings } from '../profiles/setting-dependencies.js';
import { sections, type Warning } from './change.js';
import { captureEndpoints, loadable, readEndpoints, unloadableReason, warningForUnavailable } from './endpoints.js';
import { describeActionPolicy, readActionPolicies } from './sections/action-policies.js';
import { actionsEndpoints, readActions } from './sections/actions.js';
import { describeAutolink, readAutolinks } from './sections/autolinks.js';
import { describeEnvironment, readEnvironments } from './sections/environments.js';
import { describeLabel, readLabels } from './sections/labels.js';
import { describePages, readPages } from './sections/pages.js';
import { captureCustomProperties, readCustomProperties } from './sections/properties.js';
import { readRepository, repositoryEndpoints } from './sections/repository.js';
import { readRulesets } from './sections/rulesets.js';
import { liveSecurityAndAnalysis, securityEndpoints } from './sections/security.js';

/**
 * An entry that fails its schema is left out whole, with a warning: a ruleset
 * without one of its rules would have that rule removed on apply, while a
 * profile leaves a ruleset it does not name alone.
 */
function loadableEntries<Entry extends { readonly name: string }>(
  section: 'actions_policies' | 'rulesets' | 'environments' | 'labels',
  schema: z.ZodType,
  entries: readonly Entry[],
  warnings: Warning[],
): Entry[] {
  const kept: Entry[] = [];
  for (const entry of entries) {
    const problem = unloadableReason(schema, entry);
    if (problem === undefined) {
      kept.push(entry);
    } else {
      warnings.push({ section, key: entry.name, cause: 'unloadable', message: problem });
    }
  }
  return kept;
}

function conflictWarning({ edit }: OwnerConflict): Pick<Warning, 'section' | 'key' | 'field'> {
  if ('list' in edit) {
    return { section: edit.list, key: edit.name };
  }
  const [section, key, field] = edit.path;
  const known = sections.find((each) => each === section);
  return {
    ...(known === undefined ? {} : { section: known }),
    ...(key === undefined ? {} : { key }),
    ...(field === undefined ? {} : { field }),
  };
}

/**
 * Settings that name the repository, such as its description, stay out, so the
 * profile can describe other repositories too.
 */
export async function captureProfile(
  github: GitHub,
  repo: RepoRef,
): Promise<{ profile: Profile; warnings: Warning[] }> {
  const warnings: Warning[] = [];
  const live = await readRepository(github, repo);
  const repositoryEndpointSettings = captureEndpoints('repository', repositoryEndpoints, live.endpoints);
  warnings.push(...repositoryEndpointSettings.warnings);
  const repository = loadable(
    { section: 'repository' },
    repositorySettings,
    Object.fromEntries(
      Object.entries({ ...live.repository, ...repositoryEndpointSettings.settings }).filter(
        ([key]) => !identifyingRepositoryFields.has(key),
      ),
    ),
    warnings,
  );
  const loadableMerge = loadable({ section: 'merge' }, mergeSettings, live.merge, warnings);
  // GitHub takes a commit message setting only with its title setting, so
  // when one of a pair is left out, the other goes too.
  const merge: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(loadableMerge)) {
    const pair = commitPairs.find(({ title, message }) => key === title || key === message);
    const other = pair === undefined ? undefined : key === pair.title ? pair.message : pair.title;
    if (other !== undefined && other in live.merge && !(other in loadableMerge)) {
      warnings.push({
        section: 'merge',
        key,
        cause: 'unloadable',
        message: `GitHub takes it only with ${other}, which is left out`,
      });
    } else {
      merge[key] = value;
    }
  }

  const securityEndpointSettings = captureEndpoints(
    'security',
    securityEndpoints,
    await readEndpoints(github, repo, securityEndpoints),
  );
  warnings.push(...securityEndpointSettings.warnings);
  const reported = liveSecurityAndAnalysis(live.securityAndAnalysis);
  const securityAndAnalysisSettings =
    reported === undefined
      ? {}
      : loadable({ section: 'security', key: 'security_and_analysis' }, securityAndAnalysis, reported, warnings);
  const security = loadable(
    { section: 'security' },
    securitySettings,
    {
      ...(Object.keys(securityAndAnalysisSettings).length === 0
        ? {}
        : { security_and_analysis: securityAndAnalysisSettings }),
      ...securityEndpointSettings.settings,
    },
    warnings,
  );

  const actionsEndpointSettings = captureEndpoints(
    'actions',
    actionsEndpoints,
    await readEndpoints(github, repo, actionsEndpoints),
  );
  warnings.push(...actionsEndpointSettings.warnings);
  const actions = loadable(
    { section: 'actions' },
    actionsSettings,
    { ...(await readActions(github, repo)), ...actionsEndpointSettings.settings },
    warnings,
  );

  const properties = await readCustomProperties(github, repo);
  const pages = await readPages(github, repo);
  const autolinks = await readAutolinks(github, repo);
  const policies = await readActionPolicies(github, repo);
  const rulesets = await readRulesets(github, repo);
  const environments = await readEnvironments(github, repo);
  const labels = await readLabels(github, repo);
  // A section the repository does not have is no news; one GitHub hides is.
  for (const [section, read] of [
    ['custom_properties', properties],
    ['pages', pages],
    ['autolinks', autolinks],
    ['actions_policies', policies],
    ['rulesets', rulesets],
    ['environments', environments],
    ['labels', labels],
  ] as const) {
    if (!read.available && read.cause === 'refused') {
      warnings.push({ section, ...warningForUnavailable(read) });
    }
  }
  const customProperties = properties.available ? captureCustomProperties(properties.values) : {};
  const capturedPolicies = policies.available
    ? loadableEntries(
        'actions_policies',
        actionPolicy,
        policies.policies.map((entry) => describeActionPolicy(entry.policy)),
        warnings,
      )
    : undefined;
  const capturedRulesets = rulesets.available
    ? loadableEntries(
        'rulesets',
        ruleset,
        rulesets.rulesets.map((entry) => entry.ruleset),
        warnings,
      )
    : undefined;
  const capturedEnvironments = environments.available
    ? loadableEntries('environments', environment, environments.environments.map(describeEnvironment), warnings)
    : undefined;
  const capturedLabels = labels.available
    ? loadableEntries('labels', label, labels.labels.map(describeLabel), warnings)
    : undefined;
  const captured: Profile = {
    ...(live.owner === undefined ? {} : { owner_type: live.owner }),
    repository,
    merge,
    actions,
    ...(Object.keys(security).length > 0 ? { security } : {}),
    ...(Object.keys(customProperties).length > 0 ? { custom_properties: customProperties } : {}),
    ...(pages.available && pages.site !== null ? { pages: describePages(pages.site) } : {}),
    ...(autolinks.available && autolinks.autolinks.length > 0
      ? { autolinks: autolinks.autolinks.map(describeAutolink) }
      : {}),
    ...(capturedPolicies === undefined || capturedPolicies.length === 0 ? {} : { actions_policies: capturedPolicies }),
    ...(capturedRulesets === undefined ? {} : { rulesets: capturedRulesets }),
    ...(capturedEnvironments === undefined ? {} : { environments: capturedEnvironments }),
    ...(capturedLabels === undefined || capturedLabels.length === 0 ? {} : { labels: capturedLabels }),
  };
  // GitHub may report what the owner doesn't have, such as allow_forking for a personal account.
  const { value: profile, dropped } = withoutOwnerConflicts(activeProfileSettings(captured), live.owner);
  for (const conflict of dropped) {
    warnings.push({
      ...conflictWarning(conflict),
      cause: 'unloadable',
      message: `${conflict.message}, so it is left out`,
    });
  }
  return {
    profile,
    warnings: warnings.map((warning) => {
      const path = [warning.section, warning.key, warning.field].filter((part) => part !== undefined);
      const cannotHold = warning.cause === 'refused' ? partOwnerTypeCannotHold(path, live.owner) : undefined;
      if (cannotHold === undefined) {
        return warning;
      }
      const { remedy: _refusalRemedy, ...rest } = warning;
      return { ...rest, cause: 'unloadable', message: `${cannotHold}, so it is left out` };
    }),
  };
}
