// Every screen of the web app fits a touch screen's width: the page doesn't
// scroll sideways, and nothing sticks out past either edge except inside
// something that scrolls or clips on its own, such as a code block.

import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Locator, type Page, test as base } from '@playwright/test';
import { build } from 'esbuild';

import { pageEsbuildOptions } from '../../aliases.ts';

interface Screen {
  readonly path: string;
  readonly reachFromPath?: (page: Page) => Promise<void>;
  readonly visibleOnceDrawn: (page: Page) => Locator;
  /**
   * Projects in playwright.config.ts where it is known to overflow. The test
   * is expected to fail there, so the change that fixes it removes the entry.
   */
  readonly overflowsAt?: readonly string[];
}

async function newRepositoryFolder(page: Page, name = 'Work'): Promise<void> {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
}

async function openFolderProfiles(page: Page): Promise<void> {
  await page.getByLabel('Edit Work', { exact: true }).click();
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
}

const screens: Readonly<Record<string, Screen>> = {
  'shared rulesets': {
    path: '/rulesets',
    visibleOnceDrawn: (page) => page.getByRole('link', { name: /Main Used by 2 profiles/u }),
  },
  'selected shared rulesets': {
    path: '/rulesets',
    reachFromPath: (page) =>
      page.getByRole('checkbox', { name: 'Select definitions/ruleset/Main', exact: true }).check(),
    visibleOnceDrawn: (page) => page.getByRole('heading', { name: '1 definition selected', exact: true }),
  },
  'shared ruleset editor': {
    path: '/rulesets?definition=definitions%2Fruleset%2FMain.yaml',
    visibleOnceDrawn: (page) => page.getByRole('textbox', { name: 'Name', exact: true }),
  },
  'shared Actions policy editor': {
    path: '/actions-policies?definition=definitions%2Factions-policy%2FApproved.yaml',
    visibleOnceDrawn: (page) => page.getByRole('radiogroup', { name: 'Enforcement', exact: true }),
  },
  'shared environment editor': {
    path: '/environments?definition=definitions%2Fenvironment%2Fproduction.yaml',
    visibleOnceDrawn: (page) => page.getByRole('textbox', { name: 'Name', exact: true }),
  },
  'new shared definition': {
    path: '/rulesets?new',
    visibleOnceDrawn: (page) => page.getByRole('button', { name: 'Create definition', exact: true }),
  },
  'profile with shared references': {
    path: '/profiles',
    reachFromPath: async (page) => {
      await page.getByText('shared-api', { exact: true }).click();
      await page.getByRole('tab', { name: 'Rulesets', exact: true }).click();
    },
    visibleOnceDrawn: (page) => page.getByRole('combobox', { name: 'Use a reusable ruleset', exact: true }),
  },
  'creating a reusable environment': {
    path: '/profiles',
    reachFromPath: async (page) => {
      await page.getByText('shared-api', { exact: true }).click();
      await page.getByRole('tab', { name: 'Environments', exact: true }).click();
      await page.getByRole('button', { name: 'New environment', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('staging');
      await page.getByRole('checkbox', { name: /^Also save as a reusable environment/u }).check();
    },
    visibleOnceDrawn: (page) => page.getByRole('textbox', { name: 'Reusable definition name', exact: true }),
  },
  'sign-in': {
    path: '/?signed-out',
    visibleOnceDrawn: (page) => page.getByRole('heading', { name: 'Set up every repository the same way' }),
  },
  repositories: {
    path: '/',
    visibleOnceDrawn: (page) =>
      page.getByRole('checkbox', { name: 'Select lunch/a_repository_name_with_no_hyphens_in_it_at_all' }),
  },
  'repositories after a refresh': {
    path: '/',
    reachFromPath: async (page) => {
      await page
        .getByRole('checkbox', { name: 'Select lunch/a_repository_name_with_no_hyphens_in_it_at_all' })
        .waitFor();
      await page.getByRole('button', { name: 'Refresh' }).click();
    },
    visibleOnceDrawn: (page) => page.getByText(/^\s*in \d+s$/u).filter({ visible: true }),
  },
  'selected panel': {
    path: '/',
    reachFromPath: (page) =>
      page.getByRole('checkbox', { name: 'Select lunch/a_repository_name_with_no_hyphens_in_it_at_all' }).check(),
    visibleOnceDrawn: (page) => page.getByRole('heading', { name: '1 repository selected' }),
  },
  'owner menu': {
    path: '/',
    reachFromPath: (page) => page.getByText('All owners').click(),
    visibleOnceDrawn: (page) => page.getByRole('button', { name: 'Only personal' }),
  },
  'filter menu': {
    path: '/',
    reachFromPath: (page) => page.locator('summary', { hasText: 'Filter' }).click(),
    visibleOnceDrawn: (page) => page.getByRole('checkbox', { name: /^an-unusually-long-github-topic/u }),
  },
  'filters on': {
    path: '/',
    reachFromPath: async (page) => {
      await page.locator('summary', { hasText: 'Filter' }).click();
      await page.getByRole('checkbox', { name: /^an-unusually-long-github-topic/u }).check();
      await page.getByRole('radio', { name: 'Private' }).check();
    },
    visibleOnceDrawn: (page) =>
      page.getByRole('button', {
        name: 'Remove the topic filter an-unusually-long-github-topic-of-fifty-characters',
      }),
  },
  'filter menu beside the selected panel': {
    path: '/',
    reachFromPath: async (page) => {
      await page.getByRole('checkbox', { name: 'Select lunch/api' }).check();
      await page.locator('summary', { hasText: 'Filter' }).click();
    },
    visibleOnceDrawn: (page) => page.getByRole('checkbox', { name: /^an-unusually-long-github-topic/u }),
  },
  'sort menu beside the selected panel': {
    path: '/',
    reachFromPath: async (page) => {
      await page.getByRole('checkbox', { name: 'Select lunch/api' }).check();
      await page.locator('summary', { hasText: 'Sort:' }).click();
    },
    visibleOnceDrawn: (page) => page.getByRole('radio', { name: 'Last pushed, oldest first' }),
  },
  'sort menu': {
    path: '/',
    reachFromPath: (page) => page.locator('summary', { hasText: 'Sort:' }).click(),
    visibleOnceDrawn: (page) => page.getByRole('radio', { name: 'Last pushed, oldest first' }),
  },
  'sorted by last push': {
    path: '/',
    reachFromPath: async (page) => {
      await page.locator('summary', { hasText: 'Sort:' }).click();
      await page.getByRole('radio', { name: 'Last pushed, newest first' }).check();
    },
    visibleOnceDrawn: (page) => page.getByText('Pushed 11 months ago'),
  },
  'account menu': {
    path: '/',
    reachFromPath: (page) => page.locator('.account-menu > summary').click(),
    visibleOnceDrawn: (page) => page.getByRole('button', { name: 'Sign out' }),
  },
  'repository details': {
    path: '/?repository=lunch/a_repository_name_with_no_hyphens_in_it_at_all',
    visibleOnceDrawn: (page) =>
      page.getByRole('heading', { name: 'a_repository_name_with_no_hyphens_in_it_at_all', exact: true }),
  },
  "a repository's profiles": {
    path: '/?repository=lunch/a_repository_name_with_no_hyphens_in_it_at_all',
    reachFromPath: (page) =>
      page
        .getByRole('button', { name: 'Edit the profiles of lunch/a_repository_name_with_no_hyphens_in_it_at_all' })
        .click(),
    visibleOnceDrawn: (page) => page.getByRole('button', { name: 'Move teams/website down' }),
  },
  'folder profiles': {
    path: '/',
    reachFromPath: async (page) => {
      await newRepositoryFolder(page);
      await openFolderProfiles(page);
      await page.getByRole('combobox', { name: 'Add a profile' }).selectOption('base.yaml');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('combobox', { name: 'Add a profile' }).selectOption('teams/website.yaml');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
    },
    visibleOnceDrawn: (page) => page.getByRole('checkbox', { name: 'Apply profiles to repositories moved here' }),
  },
  'apply edits': {
    path: '/?repository=lunch/api',
    reachFromPath: (page) => page.getByRole('button', { name: 'Apply', exact: true }).click(),
    visibleOnceDrawn: (page) => page.getByRole('button', { name: 'Review changes', exact: true }),
  },
  'apply review': {
    path: '/?repository=lunch/api',
    reachFromPath: async (page) => {
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    },
    visibleOnceDrawn: (page) => page.getByRole('button', { name: 'Leave out Wiki, repository.has_wiki', exact: true }),
  },
  'batch apply review': {
    path: '/',
    reachFromPath: async (page) => {
      await page.getByRole('checkbox', { name: 'Select lunch/api' }).check();
      await page.getByRole('button', { name: 'Review apply', exact: true }).click();
    },
    visibleOnceDrawn: (page) => page.getByRole('heading', { name: 'All repositories', exact: true }),
  },
  'found config repositories': {
    path: '/?config-repositories',
    reachFromPath: (page) =>
      page.getByRole('radio', { name: /^lunch\/a_repository_name_with_no_hyphens_in_it_at_all/u }).check(),
    visibleOnceDrawn: (page) =>
      page
        .getByRole('form', { name: 'Which config repository holds your profiles?' })
        .getByRole('textbox', { name: 'Folder in the repository' }),
  },
  settings: { path: '/settings', visibleOnceDrawn: (page) => page.getByRole('heading', { name: 'Account' }) },
  'settings with the protection offer': {
    path: '/settings',
    reachFromPath: async (page) => {
      await page.getByRole('button', { name: 'Use a GitHub repository…' }).click();
      await page.getByRole('combobox', { name: 'Repository' }).fill('trae/repotted-config');
      await page.getByRole('button', { name: 'Use this repository' }).click();
    },
    visibleOnceDrawn: (page) =>
      page
        .getByRole('region', { name: 'Protect trae/repotted-config?' })
        .getByRole('button', { name: 'Review protection…' }),
  },
  profiles: { path: '/profiles', visibleOnceDrawn: (page) => page.getByText('website', { exact: true }) },
  'invalid profile repair': {
    path: '/profiles',
    reachFromPath: (page) => page.getByText('invalid', { exact: true }).click(),
    visibleOnceDrawn: (page) => page.getByRole('textbox', { name: 'Profile YAML', exact: true }),
  },
  'profile editor with group actions': {
    path: '/profiles',
    reachFromPath: (page) => page.getByText('website', { exact: true }).click(),
    visibleOnceDrawn: (page) => page.getByRole('button', { name: 'Remove all: 2 settings in About' }),
  },
  'profile editor with save problems': {
    path: '/profiles',
    reachFromPath: async (page) => {
      await page.getByText('website', { exact: true }).click();
      await page.getByRole('textbox', { name: /^Default branch/u }).fill('main dev');
      await page.getByRole('button', { name: '1 thing to fix', exact: true }).click();
    },
    visibleOnceDrawn: (page) => page.getByRole('heading', { name: '1 thing to fix before you save' }),
  },
  'profile editor after a batch action': {
    path: '/profiles',
    reachFromPath: async (page) => {
      await page.getByText('website', { exact: true }).click();
      await page.getByRole('button', { name: 'Remove all: 1 setting in Features' }).click();
    },
    visibleOnceDrawn: (page) => page.getByRole('button', { name: 'Undo' }),
  },
  'settings a capture could not read': {
    path: '/profiles/new',
    reachFromPath: async (page) => {
      await page.getByRole('textbox', { name: 'Name' }).fill('dotfiles');
      await page.getByRole('radio', { name: /^A repository/u }).check();
      await page.getByRole('combobox', { name: 'Repository to capture' }).selectOption('trae/dotfiles');
      await page.getByRole('button', { name: 'Capture' }).click();
      await page.getByText("3 settings weren't captured").click();
    },
    visibleOnceDrawn: (page) => page.getByText('GitHub shows these only with a payment method on file.'),
  },
};

const origin = 'https://repotted.test';
const site = new URL('../../static/', import.meta.url);

const test = base.extend<object, { bundle: string }>({
  bundle: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from its first parameter, and this one has none
    async ({}, use) => {
      const result = await build({
        entryPoints: [fileURLToPath(new URL('harness.tsx', import.meta.url))],
        ...pageEsbuildOptions,
        write: false,
      });
      await use(result.outputFiles.map((file) => file.text).join(''));
    },
    { scope: 'worker' },
  ],
  // Serves static/ and the bundle, with index.html for the app's own routes, as
  // the Worker's assets do. Any other address, such as an avatar on GitHub, is refused.
  context: async ({ context, bundle }, use) => {
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        await route.abort();
      } else if (url.pathname === '/app.js') {
        await route.fulfill({ body: bundle, contentType: 'text/javascript' });
      } else {
        const file = extname(url.pathname) === '' ? 'index.html' : url.pathname.slice(1);
        await route.fulfill({ path: fileURLToPath(new URL(file, site)) });
      }
    });
    await use(context);
  },
});

test('creation confirms across navigation and closes after five seconds', async ({ page }) => {
  await page.clock.install();
  await page.goto('/profiles/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('confirmed');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const confirmation = page.locator('.toasts');
  await expect(confirmation.getByText('confirmed created.', { exact: true })).toBeVisible();
  await page.clock.runFor(5000);
  await expect(confirmation.getByRole('button', { name: 'Dismiss confirmation' })).toHaveCount(0);
});

test('ordinary creation confirms after the form closes while sync is pending', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Use a GitHub repository…', exact: true }).click();
  await page.getByRole('combobox', { name: /^Repository Any repository/u }).fill('trae/repotted-config');
  await page.getByRole('checkbox', { name: /^Add the .* from this browser/u }).check();
  await page.getByRole('button', { name: 'Use this repository', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Change repository…', exact: true })).toBeVisible();
  if (!(await page.getByRole('link', { name: 'Profiles', exact: true }).isVisible())) {
    await page.locator('.account-menu > summary').click();
  }
  await page.getByRole('link', { name: 'Profiles', exact: true }).click();
  await page.getByRole('link', { name: 'New profile', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('completed-later');
  await page.evaluate(() => window.dispatchEvent(new Event('hold-github')));
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL('/profiles');
  await page.evaluate(() => window.dispatchEvent(new Event('release-github')));
  await expect(page.locator('.toasts').getByText('completed-later created.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL('/profiles');
});

test('a save confirmation clears the current height of the save bar', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByText('website', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Draft description');
  if (await page.locator('.bar-more > summary').isVisible()) {
    await page.locator('.bar-more > summary').click();
  }
  await page.getByRole('button', { name: 'Save as draft', exact: true }).click();
  await expect(page.getByText('website saved as a draft.', { exact: true })).toBeVisible();
  await expect(page.locator('.bar-more[open]')).toHaveCount(0);
  await page.locator('.save-bar').scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const toast = document.querySelector('.toasts')?.getBoundingClientRect();
        const bar = document.querySelector('.save-bar')?.getBoundingClientRect();
        return toast !== undefined && bar !== undefined && toast.bottom <= bar.top;
      }),
    )
    .toBe(true);
});

test('a save bar above long YAML cannot push a confirmation above the viewport', async ({ page }) => {
  await page.goto('/profiles/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('long-profile');
  await page.getByLabel('Import YAML file').setInputFiles({
    name: 'long-profile.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from('repository: { has_wiki: true }\n' + '# A profile comment\n'.repeat(70)),
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('long-profile created.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show YAML', exact: true }).click();
  await page
    .locator('pre.code')
    .evaluate((element) => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 160));
  await expect
    .poll(() =>
      page.locator('.toasts').evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      }),
    )
    .toBe(true);
});

test('two saves of the same profile replace the live announcement', async ({ page }) => {
  await page.clock.install();
  await page.goto('/profiles');
  await page.getByText('website', { exact: true }).click();
  const description = page.getByRole('textbox', { name: 'Description', exact: true });
  await description.fill('First description');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const message = page.locator('.toasts [role="status"]');
  await expect(message).toHaveText('website saved.Available in this tab.');
  const first = await page.locator('.toast-copy').elementHandle();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await description.fill('Second description');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => first.evaluate((element) => element.isConnected)).toBe(false);
  await expect(message).toHaveText('website saved.Available in this tab.');
});

test('clearing a repository search keeps active filters and restores keyboard focus', async ({ page }) => {
  await page.goto('/');
  await page.locator('summary', { hasText: 'Filter' }).click();
  await page.getByRole('radio', { name: 'Private', exact: true }).check();
  await page.locator('summary', { hasText: 'Filter' }).click();
  const search = page.getByRole('searchbox', { name: 'Find a repository', exact: true });
  await search.fill('nothing-matches-this');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove the private filter', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select lunch/app', exact: true })).toBeVisible();
});

test('a profile search with no matches offers a focused reset', async ({ page }) => {
  await page.goto('/profiles');
  const search = page.getByRole('searchbox', { name: 'Find a profile', exact: true });
  await search.fill('nothing-matches-this');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(search).toBeFocused();
  await expect(page.getByRole('button', { name: /base For any owner/u })).toBeVisible();
});

test('an initial profile read cannot report that the list is empty', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'repotted:profiles-source',
      JSON.stringify({ kind: 'repository', repository: 'trae/repotted-config', path: '' }),
    );
    const observer = new MutationObserver(() => {
      if (document.querySelector('.empty') !== null) {
        document.documentElement.setAttribute('data-empty-seen', 'true');
      }
    });
    observer.observe(document, { childList: true, subtree: true });
    window.addEventListener('release-github', () => observer.disconnect(), { once: true });
  });
  await page.goto('/profiles?hold-github');
  await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-empty-seen', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('release-github')));
  await expect(page.getByRole('heading', { name: 'No profiles yet', exact: true })).toBeVisible();
});

test('an initial profile read shows loading rather than an empty list', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'repotted:profiles-source',
      JSON.stringify({ kind: 'repository', repository: 'trae/repotted-config', path: '' }),
    ),
  );
  await page.goto('/profiles?hold-github');
  await expect(page.getByText('Reading your profiles…', { exact: true })).toBeVisible();
  await expect(page.locator('.skeleton-list')).toBeVisible();
  await expect(page.locator('.empty')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('release-github')));
  await expect(page.locator('.skeleton-list')).toHaveCount(0);
  await expect(page.locator('.empty')).toBeVisible();
});

test('retrying a failed first sync keeps an empty cache in the loading state', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'repotted:profiles-source',
      JSON.stringify({ kind: 'repository', repository: 'trae/repotted-config', path: '' }),
    ),
  );
  await page.goto('/profiles?fail-first-sync');
  await expect(page.getByRole('alert').filter({ hasText: 'Config unavailable' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('hold-config')));
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(page.getByText('Reading your profiles…', { exact: true })).toBeVisible();
  await expect(page.locator('.empty')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('release-config')));
  await expect(page.locator('.empty')).toBeVisible();
});

test('a refresh keeps its label and size and centres idle text', async ({ page }) => {
  await page.goto('/');
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await page.getByRole('checkbox', { name: 'Select lunch/app', exact: true }).waitFor();
  const before = await refresh.boundingBox();
  const labelOffset = await refresh.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const label = document.createRange();
    label.selectNodeContents(button.querySelector('.pending-label > span')!);
    const text = label.getBoundingClientRect();
    return Math.abs(text.x + text.width / 2 - (bounds.x + bounds.width / 2));
  });
  expect(labelOffset).toBeLessThan(1);
  await page.evaluate(() => window.dispatchEvent(new Event('hold-github')));
  await refresh.focus();
  await refresh.press('Enter');
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await expect(refresh).toHaveAccessibleName('Refresh');
  await expect(refresh.locator('.pending-spinner')).toBeVisible();
  await expect(refresh).toBeFocused();
  expect(await refresh.boundingBox()).toMatchObject({ width: before?.width, height: before?.height });
  await refresh.press('Enter');
  await page.evaluate(() => window.dispatchEvent(new Event('release-github')));
  await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
  await expect(refresh).toBeFocused();
  await expect(refresh.locator('.pending-spinner')).toBeHidden();
});

test('an ordinary save does not mark an untouched owner-type action busy', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Use a GitHub repository…', exact: true }).click();
  await page.getByRole('combobox', { name: /^Repository Any repository/u }).fill('trae/repotted-config');
  await page.getByRole('checkbox', { name: /^Add the .* from this browser/u }).check();
  await page.getByRole('button', { name: 'Use this repository', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Change repository…', exact: true })).toBeVisible();
  if (!(await page.getByRole('link', { name: 'Profiles', exact: true }).isVisible())) {
    await page.locator('.account-menu > summary').click();
  }
  await page.getByRole('link', { name: 'Profiles', exact: true }).click();
  await page.getByText('website', { exact: true }).click();
  await page.getByRole('textbox', { name: /^Default branch/u }).fill('develop');
  await page.evaluate(() => window.dispatchEvent(new Event('hold-github')));
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const before = await save.boundingBox();
  await save.click();
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).toHaveAccessibleName('Save');
  await expect(save.locator('.pending-spinner')).toBeVisible();
  expect(await save.boundingBox()).toMatchObject({ width: before?.width, height: before?.height });
  await page.getByRole('button', { name: 'Change who the profile is for', exact: true }).click();
  const change = page.getByRole('dialog').getByRole('button', { name: 'Change to any owner', exact: true });
  await expect(change).toBeDisabled();
  await expect(change).not.toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('release-github')));
});

test('a batch keeps its reviewed action width while applying', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Select lunch/api', exact: true }).check();
  await page.getByRole('button', { name: 'Review apply', exact: true }).click();
  const apply = page.getByRole('button', { name: 'Apply to 1 repository', exact: true });
  await expect(apply).toBeVisible();
  const before = await apply.boundingBox();
  await apply.click();
  await page.evaluate(() => window.dispatchEvent(new Event('hold-github')));
  await page.getByRole('button', { name: 'Apply now', exact: true }).click();
  await expect(apply).toHaveAttribute('aria-busy', 'true');
  await expect(apply).toHaveAccessibleName('Apply to 1 repository');
  await expect(apply.locator('.pending-spinner')).toBeVisible();
  await expect(apply).toBeFocused();
  expect((await apply.boundingBox())?.width).toBe(before?.width);
  await page.evaluate(() => window.dispatchEvent(new Event('release-github')));
  await expect(page.getByText('Every repository is finished, and the batch has ended.')).toBeVisible();
});

function elementsPastViewportEdges(): string[] {
  const width = document.documentElement.clientWidth;
  const found: string[] = [];
  for (const element of document.body.querySelectorAll('*')) {
    const box = element.getBoundingClientRect();
    if (
      box.width === 0 ||
      (box.right <= width + 1 && box.left >= -1) ||
      !element.checkVisibility({ visibilityProperty: true })
    ) {
      continue;
    }
    // The page itself doesn't count: clipping it hides what sticks out rather than fitting it.
    let held = false;
    for (
      let parent = element.parentElement;
      parent !== document.body && parent !== null && !held;
      parent = parent.parentElement
    ) {
      held = getComputedStyle(parent).overflowX !== 'visible';
    }
    if (!held) {
      const name = (element.getAttribute('aria-label') ?? element.textContent).trim().slice(0, 40);
      found.push(
        `<${element.localName} class="${element.getAttribute('class') ?? ''}"> ${name} spans ${Math.round(box.left)} to ${Math.round(box.right)}`,
      );
    }
  }
  return found;
}

for (const [name, screen] of Object.entries(screens)) {
  test(`${name} fits the screen`, async ({ page }, testInfo) => {
    test.fail(screen.overflowsAt?.includes(testInfo.project.name) === true, 'Known to overflow here');
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    await page.goto(screen.path);
    await screen.reachFromPath?.(page);
    await expect(screen.visibleOnceDrawn(page)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const width = await page.evaluate(() => document.documentElement.clientWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'page width').toBeLessThanOrEqual(width);
    expect(await page.evaluate(elementsPastViewportEdges), 'elements past the edges').toEqual([]);
    expect(errors, 'page errors').toEqual([]);
  });
}

test('shared changes reach profile forms and related tabs save relative references', async ({ page }) => {
  await page.goto('/environments?definition=definitions%2Fenvironment%2Fproduction.yaml');
  const minutes = page.getByRole('textbox', { name: 'Wait timer, in minutes', exact: true });
  await minutes.fill('7');
  const save = page.getByRole('button', { name: 'Save definition', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  for (const name of ['shared-api', 'shared-web']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('tab', { name: 'Environments', exact: true }).click();
    await page.getByRole('button', { name: /production.*Waits 7 minutes/u }).click();
    await expect(minutes).toHaveValue('7');
    await page.getByRole('link', { name: 'Edit shared definition', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Used by 2 profiles', exact: true })).toBeVisible();
  }
  await page.getByText('shared-api', { exact: true }).click();
  await page.getByRole('button', { name: 'All profiles', exact: true }).click();
  await page.getByRole('link', { name: 'New profile', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('New service');
  await page.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('teams');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New service', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Rulesets', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Use a reusable ruleset', exact: true })
    .selectOption('../definitions/ruleset/Main.yaml');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Show YAML', exact: true }).click();
  await expect(page.getByRole('region', { name: 'New service as YAML', exact: true })).toContainText(
    '../definitions/ruleset/Main.yaml',
  );
});

test('moving a library definition updates consumers without moving selected profiles', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByRole('checkbox', { name: 'Select base', exact: true }).check();
  await page.locator('.account-menu > summary').click();
  await page.getByRole('link', { name: 'Rulesets', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select definitions/ruleset/Main', exact: true }).check();
  await expect(page.getByRole('heading', { name: '1 definition selected', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Move to a folder', exact: true }).selectOption('teams');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByRole('link', { name: /Main Used by 2 profiles/u })).toHaveAttribute(
    'href',
    '/rulesets?definition=teams%2FMain.yaml',
  );
  await page.locator('.account-menu > summary').click();
  await page.getByRole('link', { name: 'Profiles', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Select base', exact: true })).toBeChecked();
  await page.getByText('shared-api', { exact: true }).click();
  await page.getByRole('button', { name: 'Show YAML', exact: true }).click();
  await expect(page.getByRole('region', { name: 'shared-api as YAML', exact: true })).toContainText('teams/Main.yaml');
  await page.getByRole('tab', { name: 'Rulesets', exact: true }).click();
  await expect(page.getByRole('tabpanel').getByRole('button', { name: /^Main /u })).toBeEnabled();
});

test('unsaved reference changes preview their entries before saving', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByText('shared-api', { exact: true }).click();
  await page.getByRole('tab', { name: 'Environments', exact: true }).click();
  await page.getByRole('button', { name: 'Remove production reference', exact: true }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel).toContainText('The profile manages no environments');
  await expect(panel).toContainText('Save reference changes before editing these entries.');
  await expect(panel.getByRole('button', { name: 'New environment', exact: true })).toBeDisabled();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Use a reusable environment', exact: true })
    .selectOption('definitions/environment/production.yaml');
  const production = panel.getByRole('button', { name: /production.*Waits 15 minutes/u });
  await expect(production).toBeVisible();
  await expect(production).toBeDisabled();
  await save.click();
  await expect(production).toBeEnabled();
});

test('unknown keys can be previewed and saved away without another edit', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByText('unknown-keys', { exact: true }).click();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeEnabled();
  const previewButton = page.getByRole('button', { name: 'Preview', exact: true });
  if (!(await previewButton.isVisible())) {
    await page.locator('.bar-more > summary').click();
  }
  await previewButton.click();
  const preview = page.getByRole('dialog', { name: 'Preview changes to unknown-keys', exact: true });
  await expect(preview).toContainText('Saving removes unrecognized keys: mystery, repository.has_wikki.');
  await preview.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Show YAML', exact: true }).click();
  const yaml = page.getByRole('region', { name: 'unknown-keys as YAML', exact: true });
  await expect(yaml).toContainText('has_wiki: true');
  await expect(yaml).not.toContainText('mystery');
  await expect(yaml).not.toContainText('has_wikki');
});

test('configuration errors open in the forms and can be saved without editing YAML', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByText('configuration', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Profile YAML', exact: true })).toHaveCount(0);
  const wiki = page.getByRole('radiogroup', { name: 'Wiki', exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(wiki).toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();
  await wiki.getByRole('radio', { name: 'On', exact: true }).check();
  await page.getByRole('button', { name: 'Remove invalid configuration', exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(wiki).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('tab', { name: 'Labels', exact: true }).click();
  await expect(page.getByText('keep', { exact: true })).toBeVisible();
});

test('invalid profiles keep unsaved YAML across navigation and open the settings after repair', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByText('invalid', { exact: true }).click();
  const yaml = page.getByRole('textbox', { name: 'Profile YAML', exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(yaml).toHaveValue('repository: [\n');
  await expect(page.getByText('Reading the profile…', { exact: true })).toHaveCount(0);
  await expect(save).toBeDisabled();
  await yaml.fill('merge: [\n');
  await expect(save).toBeDisabled();
  await page.getByRole('link', { name: 'Repotted', exact: true }).click();
  const profiles = page.getByRole('link', { name: 'Profiles', exact: true });
  if (!(await profiles.isVisible())) {
    await page.locator('.account-menu > summary').click();
  }
  await profiles.click();
  await page.getByText('invalid', { exact: true }).click();
  await expect(yaml).toHaveValue('merge: [\n');
  await yaml.fill('# Repaired\nrepository:\n  has_wiki: true\n');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('tab', { name: 'Repository', exact: true })).toBeVisible();
  await expect(yaml).toHaveCount(0);
  await page.getByRole('button', { name: 'Show YAML', exact: true }).click();
  await expect(page.getByRole('region', { name: 'invalid as YAML' })).toContainText('# Repaired');
});

test('group actions sit beside the heading and above the description on phones', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 760, 'The desktop layout keeps its description beside the actions');
  await page.goto('/profiles');
  await page.getByText('website', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Features', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  for (const name of ['About', 'Features']) {
    const group = page.getByRole('region', { name, exact: true });
    await group.scrollIntoViewIfNeeded();
    const heading = await group.getByRole('heading', { name, exact: true }).boundingBox();
    const action = await group.getByRole('button', { name: /^Remove all:/u }).boundingBox();
    const description = await group.locator('p').first().boundingBox();
    if (heading === null || action === null || description === null) {
      throw new Error(`${name} needs a heading, action, and description`);
    }
    expect(action.x, `${name}: action beside heading`).toBeGreaterThanOrEqual(heading.x + heading.width);
    expect(heading.y, `${name}: heading within action's row`).toBeGreaterThanOrEqual(action.y);
    expect(heading.y + heading.height, `${name}: heading within action's row`).toBeLessThanOrEqual(
      action.y + action.height,
    );
    expect(description.y, `${name}: description below action`).toBeGreaterThanOrEqual(action.y + action.height);
    expect(description.x, `${name}: description aligned with heading`).toBe(heading.x);
    expect(action.height, `${name}: touch target`).toBeGreaterThanOrEqual(44);
  }
});

test('folder settings offer Save, Apply without edits, and Save and apply for all members', async ({ page }) => {
  await page.goto('/');
  for (const name of ['lunch/api', 'lunch/docs']) {
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  }
  await newRepositoryFolder(page);
  await openFolderProfiles(page);
  const dialog = page.getByRole('dialog', { name: 'Profiles for Work', exact: true });
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  const apply = dialog.getByRole('button', { name: 'Apply', exact: true });
  const both = dialog.getByRole('button', { name: 'Save and apply', exact: true });
  await dialog.getByRole('combobox', { name: 'Add a profile' }).selectOption('base.yaml');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(apply).toBeDisabled();
  await expect(both).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
  for (const button of [apply, save, both]) {
    const offset = await button.evaluate((element) => {
      const label = element.querySelector('.pending-label > span[aria-hidden="false"]') ?? element;
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      const control = element.getBoundingClientRect();
      return Math.abs((text.left + text.right) / 2 - (control.left + control.right) / 2);
    });
    expect(offset, 'button label centered').toBeLessThanOrEqual(1);
  }
  await save.click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/repotted\.test\/$/u);

  await openFolderProfiles(page);
  await expect(save).toBeDisabled();
  await expect(both).toBeDisabled();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page).toHaveURL(/\/batch$/u);
  for (const name of ['lunch/api', 'lunch/docs']) {
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  }

  await page.getByRole('link', { name: 'Repotted', exact: true }).click();
  await openFolderProfiles(page);
  await dialog.getByRole('combobox', { name: 'Add a profile' }).selectOption('teams/website.yaml');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await both.click();
  await expect(page).toHaveURL(/\/batch$/u);
  for (const name of ['lunch/api', 'lunch/docs']) {
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('link', { name: 'Repotted', exact: true }).click();
  await openFolderProfiles(page);
  await expect(dialog.getByRole('button', { name: 'Remove teams/website', exact: true })).toBeVisible();
});

test('folder profiles only open move reviews when enabled', async ({ page }) => {
  await page.goto('/');
  await newRepositoryFolder(page);
  await openFolderProfiles(page);
  const onMove = page.getByRole('checkbox', { name: 'Apply profiles to repositories moved here' });
  await expect(onMove).not.toBeChecked();
  await page.getByRole('combobox', { name: 'Add a profile' }).selectOption('base.yaml');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select lunch/api', exact: true }).check();
  await page.getByRole('combobox', { name: 'Move to a folder' }).selectOption('Work');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page).toHaveURL(/repotted\.test\/$/u);

  await openFolderProfiles(page);
  await onMove.check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/repotted\.test\/$/u);
  await page.getByRole('button', { name: /^infra /u }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('Work');
  await expect(page.getByRole('button', { name: 'Leave out Wiki, repository.has_wiki', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/apply$/u);

  await page.getByRole('link', { name: 'Repotted', exact: true }).click();
  // Only new arrivals are reviewed, even with an existing member selected.
  for (const name of ['lunch/api', 'lunch/docs', 'lunch/mobile']) {
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  }
  await page.getByRole('combobox', { name: 'Move to a folder' }).selectOption('Work');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All repositories', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/batch$/u);
  await expect(page.getByRole('region', { name: 'lunch/docs', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'lunch/mobile', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'lunch/api', exact: true })).toHaveCount(0);
});

test('folder tags add profiles immediately and reopen their ordered list', async ({ page }) => {
  await page.goto('/');
  await newRepositoryFolder(page);
  const folder = page.getByRole('region', { name: 'Work', exact: true });
  const add = folder.getByLabel('Add a profile to Work', { exact: true });
  await add.click();
  await expect(folder.getByRole('button', { name: /^definitions\//u })).toHaveCount(0);
  await folder.getByRole('button', { name: 'base', exact: true }).click();
  const tags = folder.getByRole('button', { name: 'Profiles for Work: base', exact: true });
  await expect(tags).toBeVisible();
  await expect(add).toBeFocused();
  await expect(page).toHaveURL(/repotted\.test\/$/u);

  await add.click();
  await expect(folder.getByRole('button', { name: 'base', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  await tags.click();
  const dialog = page.getByRole('dialog', { name: 'Profiles for Work', exact: true });
  await expect(dialog.getByRole('option', { name: /^definitions\//u })).toHaveCount(0);
  await expect(dialog.getByText('base', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save and apply' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(tags).toBeFocused();
  await page.reload();
  await expect(tags).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await tags.click();
  await dialog.getByRole('button', { name: 'Remove base', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(add).toBeFocused();
  await expect
    .poll(() =>
      folder
        .locator('.folder-profiles')
        .evaluate(
          (element) =>
            element.getBoundingClientRect().width -
            (element.querySelector('summary')?.getBoundingClientRect().width ?? 0),
        ),
    )
    .toBe(0);
});

test('folder profiles collapse and expand on resize while keeping one header row', async ({ page }) => {
  await page.goto('/');
  for (const name of ['lunch/docs', 'lunch/mobile']) {
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  }
  await newRepositoryFolder(page, 'Personal Configs');
  const folder = page.getByRole('region', { name: 'Personal Configs', exact: true });
  const add = folder.getByLabel('Add a profile to Personal Configs', { exact: true });
  for (const name of ['base', 'teams/website']) {
    await add.click();
    await folder.getByRole('button', { name, exact: true }).click();
  }
  const tags = folder.getByRole('button', { name: 'Profiles for Personal Configs: base, teams/website', exact: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(tags.getByText('2 profiles', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tags.getByText('base', { exact: true }))
    .toBeVisible()
    .catch(async (error: unknown) => {
      const sizes = await tags.evaluate((element) => ({
        viewport: innerWidth,
        tags: element.querySelector('.folder-profile-names')?.getBoundingClientRect().width,
        labels: element.querySelector('.folder-profile-names')?.textContent,
        group: element.parentElement?.getBoundingClientRect().width,
        picker: element.parentElement?.querySelector('.folder-profile-add')?.getBoundingClientRect().width,
        style: element.parentElement?.getAttribute('style'),
      }));
      throw new Error(`Profile tags did not expand: ${JSON.stringify(sizes)}`, { cause: error });
    });
  await expect(tags.getByText('website', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 667, height: 844 });
  const changedMetrics = await page.addStyleTag({ content: '.folder-profile-names .tag { letter-spacing: 0.3px; }' });
  await expect
    .poll(() =>
      tags.locator('.folder-profile-names').evaluate((element) => {
        const label = element.getBoundingClientRect();
        const control = element.parentElement?.getBoundingClientRect();
        return (
          getComputedStyle(element).visibility === 'visible' &&
          control !== undefined &&
          label.left >= control.left &&
          label.right <= control.right
        );
      }),
    )
    .toBe(true);
  await changedMetrics.evaluate((element) => {
    element.parentNode?.removeChild(element);
  });

  for (const width of [768, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await folder.getByRole('checkbox', { name: 'Select lunch/docs', exact: true }).check();
    await expect
      .poll(() =>
        tags.evaluate((element) => {
          const control = element.getBoundingClientRect();
          return [...element.children]
            .filter((child) => {
              const style = getComputedStyle(child);
              return style.visibility === 'visible' && style.display !== 'none';
            })
            .every((child) => {
              const content = child.getBoundingClientRect();
              return content.left >= control.left && content.right <= control.right;
            });
        }),
      )
      .toBe(true);
    await folder.getByRole('checkbox', { name: 'Select lunch/docs', exact: true }).uncheck();
  }
  await page.setViewportSize({ width: 390, height: 844 });

  for (const name of ['shared-api', 'shared-web']) {
    await add.click();
    await folder.getByRole('button', { name, exact: true }).click();
  }
  const count = folder.getByRole('button', { name: /^Profiles for Personal Configs:/u });
  await expect(count.getByText('4 profiles', { exact: true })).toBeVisible();
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const boxes = await folder.locator('.folder-heading > *').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
      }),
    );
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      expect(box.height).toBe(44);
      expect(box.top).toBe(boxes[0]?.top);
    }
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
    await expect(add).toBeVisible();
  }
  await count.click();
  const dialog = page.getByRole('dialog', { name: 'Profiles for Personal Configs', exact: true });
  await expect(dialog.locator('.layer-name .mono')).toHaveText(['base', 'teams/website', 'shared-api', 'shared-web']);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(count).toBeFocused();

  const menu = folder.getByLabel('Edit Personal Configs', { exact: true });
  await menu.click();
  await folder.getByRole('button', { name: 'Select all in Personal Configs', exact: true }).click();
  await expect(folder.getByRole('checkbox', { name: 'Select lunch/docs', exact: true })).toBeChecked();
  await expect(folder.getByRole('checkbox', { name: 'Select lunch/mobile', exact: true })).toBeChecked();
  await expect(menu).toBeFocused();
  await menu.click();
  await folder.getByRole('button', { name: 'Deselect all in Personal Configs', exact: true }).click();
  await expect(folder.getByRole('checkbox', { name: 'Select lunch/docs', exact: true })).not.toBeChecked();
  await expect(folder.getByRole('checkbox', { name: 'Select lunch/mobile', exact: true })).not.toBeChecked();
  await menu.click();
  await folder.getByRole('button', { name: 'Select all in Personal Configs', exact: true }).focus();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(menu).toBeFocused();
  await expect(folder.locator('.folder-menu')).toHaveJSProperty('open', false);
  await folder.getByRole('button', { name: 'Select all in Personal Configs', exact: true }).focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(menu).toBeFocused();
});

for (const members of [['lunch/infra'], ['lunch/docs', 'lunch/a_repository_name_with_no_hyphens_in_it_at_all']]) {
  test(`folder profiles save and open a review for ${members.length} existing repositories`, async ({ page }) => {
    await page.goto('/');
    for (const name of members) {
      await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
    }
    await newRepositoryFolder(page);
    await openFolderProfiles(page);
    const review = page.getByRole('button', { name: 'Save and apply', exact: true });
    await expect(review).toBeDisabled();
    await page.getByRole('combobox', { name: 'Add a profile' }).selectOption('base.yaml');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await review.click();

    if (members.length === 1) {
      await expect(page).toHaveURL(/\/apply$/u);
      await expect(
        page.getByRole('button', { name: 'Leave out Wiki, repository.has_wiki', exact: true }),
      ).toBeVisible();
    } else {
      await expect(page).toHaveURL(/\/batch$/u);
      for (const name of members) {
        await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
      }
    }
    await page.getByRole('link', { name: 'Repotted', exact: true }).click();
    await openFolderProfiles(page);
    await expect(page.getByRole('dialog').getByText('base', { exact: true })).toBeVisible();
  });
}

test('the header keeps to one row', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Repotted' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const middles = await page.evaluate(() =>
    [...document.querySelectorAll('.shell-bar > *')].map((part) => {
      const box = part.getBoundingClientRect();
      return Math.round(box.top + box.height / 2);
    }),
  );
  expect(middles.length, 'parts of the bar').toBeGreaterThan(1);
  for (const middle of middles) {
    expect(Math.abs(middle - (middles[0] ?? 0)), "distance from the first part's line").toBeLessThanOrEqual(2);
  }
});

test("a repository's checkbox takes taps across a 44px target", async ({ page }) => {
  await page.goto('/');
  const checkbox = page.getByRole('checkbox', { name: 'Select lunch/api' });
  await expect(checkbox).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const offsetsThatMiss = await checkbox.evaluate((element) => {
    element.scrollIntoView({ block: 'center' });
    const box = element.getBoundingClientRect();
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    return [
      [-20, 0],
      [20, 0],
      [0, -20],
      [0, 20],
    ]
      .filter(
        ([offsetX = 0, offsetY = 0]) => document.elementFromPoint(centerX + offsetX, centerY + offsetY) !== element,
      )
      .map(([offsetX, offsetY]) => `${offsetX},${offsetY}`);
  });
  expect(offsetsThatMiss, "taps 20px from the box's center that miss it").toEqual([]);
});

test('a batch shows labels and the affected repositories, keeping the confirmation in step with exclusions', async ({
  page,
}) => {
  const longName = 'lunch/a_repository_name_with_no_hyphens_in_it_at_all';
  await page.goto('/');
  for (const name of ['lunch/app', longName, 'lunch/api']) {
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  }
  const selected = page.getByRole('complementary', { name: 'Selected repositories' });
  await selected.getByRole('combobox', { name: 'Apply a profile to them' }).selectOption({ label: 'base' });
  await selected.getByRole('button', { name: 'Review apply' }).click();

  const all = page.getByRole('region', { name: 'All repositories', exact: true });
  const wiki = all.getByRole('list', { name: 'Repositories affected by Wiki', exact: true });
  await expect(all.getByText('Wiki', { exact: true })).toBeVisible();
  await expect(all).not.toContainText('repository.has_wiki');
  await expect(wiki.getByRole('listitem')).toHaveText([longName, 'lunch/api', 'lunch/app']);
  expect(await page.evaluate(elementsPastViewportEdges), 'the batch and repository lists fit').toEqual([]);

  await page
    .getByRole('region', { name: 'lunch/app', exact: true })
    .getByRole('button', { name: 'Leave out Wiki, repository.has_wiki, for lunch/app', exact: true })
    .click();
  await expect(wiki.getByRole('listitem')).toHaveText([longName, 'lunch/api']);
  await page.getByRole('checkbox', { name: `Apply to ${longName} in this batch`, exact: true }).uncheck();
  await expect(wiki.getByRole('listitem')).toHaveText(['lunch/api']);
  await expect(
    page.getByRole('list', { name: 'Repositories to change', exact: true }).getByRole('listitem'),
  ).toHaveText(['lunch/api', 'lunch/app']);

  await all.getByRole('button', { name: 'Leave out Wiki everywhere', exact: true }).click();
  await expect(wiki).toHaveCount(0);
  await all.getByRole('button', { name: 'Put back Wiki everywhere', exact: true }).click();
  await expect(wiki.getByRole('listitem')).toHaveText(['lunch/api', 'lunch/app']);
  await page.getByRole('button', { name: 'Apply to 2 repositories', exact: true }).click();

  const confirmation = page.getByRole('dialog', { name: 'Apply to 2 repositories?' });
  await expect(confirmation.getByRole('listitem')).toHaveText(['lunch/api', 'lunch/app']);
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  expect(await page.evaluate(elementsPastViewportEdges), 'the confirmation fits').toEqual([]);
});

test('Go to it focuses the ruleset pattern that holds Save back', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByText('website', { exact: true }).click();
  await page.getByRole('tab', { name: /^Rulesets/u }).click();
  await page.getByRole('button', { name: 'New ruleset', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Main');
  await page
    .getByRole('group', { name: 'Include', exact: true })
    .getByRole('checkbox', { name: 'Branches by pattern' })
    .check();
  const pattern = page.getByRole('textbox', { name: 'Branch patterns', exact: true });
  await pattern.fill('release/*');

  await page.getByRole('button', { name: '1 thing to fix', exact: true }).click();
  await page.getByRole('button', { name: 'Go to it', exact: true }).click();

  await expect(pattern).toBeFocused();
  await page.getByRole('button', { name: 'Back to rulesets', exact: true }).click();
  await page.getByRole('tab', { name: /^Repository/u }).click();
  await page.getByRole('tab', { name: /^Rulesets/u }).click();
  await expect(page.getByRole('button', { name: 'New ruleset', exact: true })).toBeVisible();
});

test('Go to it focuses a bypass list whose mode no longer fits its target', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByText('website', { exact: true }).click();
  await page.getByRole('tab', { name: /^Rulesets/u }).click();
  await page.getByRole('button', { name: 'New ruleset', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Main');
  await page.getByRole('button', { name: 'Manage the bypass list', exact: true }).click();
  await page.getByText('Add bypass', { exact: true }).click();
  await page.getByRole('button', { name: 'Repository admin', exact: true }).click();
  await page.getByRole('combobox', { name: 'When Repository admin can bypass' }).selectOption('pull_request');
  await page
    .getByRole('radiogroup', { name: 'Applies to', exact: true })
    .getByRole('radio', { name: 'Tags', exact: true })
    .check();

  await page.getByRole('button', { name: '1 thing to fix', exact: true }).click();
  await expect(page.getByRole('heading', { name: '1 thing to fix before you save' })).toBeVisible();
  expect(await page.evaluate(elementsPastViewportEdges), 'bypass list and save problems fit').toEqual([]);
  await page.getByRole('button', { name: 'Go to it', exact: true }).click();

  await expect(page.getByRole('region', { name: 'Bypass list', exact: true })).toBeFocused();
});

test('saved draft problems offer navigation without an ineffective Reset', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByText('unfinished', { exact: true }).click();
  await page.getByRole('button', { name: '1 thing to fix', exact: true }).click();
  const problems = page.getByRole('region', { name: '1 thing to fix before you save', exact: true });

  await expect(problems.getByRole('button', { name: /^Reset/u })).toHaveCount(0);
  await expect(problems.getByText('Saved in a draft. Edit it or discard the draft.')).toBeVisible();
  await problems.getByRole('button', { name: 'Go to it', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Hex color', exact: true })).toBeFocused();
});

test('import waits for its selected file before creating a definition', async ({ page }) => {
  await page.goto('/profiles/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('imported-policy');
  await page.evaluate(() => {
    const read = (file: File): Promise<string> => Blob.prototype.text.call(file);
    File.prototype.text = async function () {
      await new Promise<void>((resolve) => window.addEventListener('release-import', () => resolve(), { once: true }));
      return read(this);
    };
  });
  await page.getByLabel('Import YAML file').setInputFiles({
    name: 'policy.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from('kind: actions-policy\nactions_policies: [{ name: Approved, enforcement: active }]\n'),
  });
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('release-import')));
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByRole('heading', { name: 'imported-policy', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Actions policies', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Repository', exact: true })).toHaveCount(0);
});

test('a new reusable environment stays in the profile through a linked definition', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByText('shared-api', { exact: true }).click();
  await page.getByRole('tab', { name: 'Environments', exact: true }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('combobox', { name: 'Use a reusable environment', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'New environment', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Name', exact: true }).fill('staging');
  await panel.getByRole('textbox', { name: 'Wait timer, in minutes', exact: true }).fill('5');
  await panel.getByRole('checkbox', { name: /^Also save as a reusable environment/u }).check();
  await panel.getByRole('textbox', { name: 'Reusable definition name', exact: true }).fill('Staging deployment');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await expect(panel.getByText('Staging deployment', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show YAML', exact: true }).click();
  const yaml = page.getByRole('region', { name: 'shared-api as YAML', exact: true });
  await expect(yaml).toContainText('definitions/environment/Staging deployment.yaml');
  await expect(yaml).not.toContainText('wait_timer: 5');
  await panel.getByRole('button', { name: 'Back to environments', exact: true }).click();
  await panel.getByRole('button', { name: /staging.*Waits 5 minutes/u }).click();
  await expect(panel.getByRole('textbox', { name: 'Wait timer, in minutes', exact: true })).toHaveValue('5');
});

for (const [type, label] of [
  ['restrict_action_events', 'Restrict events'],
  ['restrict_actions_actors', 'Restrict actors'],
]) {
  test(`restoring the ${type} policy rule preserves its omitted allowlist`, async ({ page }) => {
    await page.goto('/actions-policies?new');
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Partial policy');
    await page.getByLabel('Import YAML file').setInputFiles({
      name: 'partial-policy.yaml',
      mimeType: 'application/yaml',
      buffer: Buffer.from(`kind: actions-policy\nactions_policies: [{ name: Partial, rules: [{ type: ${type} }] }]\n`),
    });
    await page.getByRole('button', { name: 'Create definition', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save definition', exact: true });
    const rule = page.getByRole('checkbox', { name: new RegExp(`^${label}`, 'u') });
    await expect(save).toBeDisabled();
    await rule.uncheck();
    await expect(save).toBeEnabled();
    await rule.check();
    await expect(save).toBeDisabled();
  });
}

test('named Actions policies edit workflow rules and link alongside general settings', async ({ page }) => {
  await page.goto('/actions-policies?new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Release workflows');
  await page.getByRole('textbox', { name: /^Target name/u }).fill('Release');
  await page.getByRole('button', { name: 'Create definition', exact: true }).click();
  await page
    .getByRole('radiogroup', { name: 'Enforcement', exact: true })
    .getByRole('radio', { name: 'Active', exact: true })
    .check();
  await page
    .getByRole('radiogroup', { name: 'Workflow targeting', exact: true })
    .getByRole('radio', { name: 'Selected workflows', exact: true })
    .check();
  const save = page.getByRole('button', { name: /^Save(?: definition)?$/u });
  await expect(save).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Include workflow paths', exact: true })
    .fill('.github/workflows/release.yml');
  await page.getByRole('checkbox', { name: /^Restrict events/u }).check();
  await page.getByRole('textbox', { name: 'Allowed events', exact: true }).fill('release\nworkflow_dispatch');
  await page.getByRole('checkbox', { name: /^Restrict actors/u }).check();
  await page.getByRole('button', { name: 'Add actor', exact: true }).click();
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: '1 thing to fix', exact: true }).click();
  await page.getByRole('button', { name: 'Go to it', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workflow rules', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'Actor ID', exact: true }).fill('1234');
  await save.click();
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Show YAML', exact: true }).click();
  const yaml = page.getByRole('region', { name: 'Release workflows as YAML', exact: true });
  await expect(yaml).toContainText('actions_policies:');
  await expect(yaml).toContainText('restrict_action_events');
  await expect(yaml).toContainText('allowed_actors:');
  await page.goto('/profiles');
  await page.getByText('shared-api', { exact: true }).click();
  await page.getByRole('tab', { name: 'Actions policies', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Use a reusable Actions policy', exact: true })
    .selectOption('Release workflows.yaml');
  await save.click();
  await expect(save).toBeDisabled();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('button', { name: /^Release active, 2 rules/u })).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Approved active, 1 rule/u })).toBeVisible();
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: 'Actions', exact: true })).toBeVisible();
});
