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

async function newRepositoryFolder(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Work');
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
}

async function openFolderSettings(page: Page): Promise<void> {
  await page.getByLabel('Edit Work', { exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

const screens: Readonly<Record<string, Screen>> = {
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
    visibleOnceDrawn: (page) => page.getByText(/^\s*in \d+s$/u),
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
  'folder settings': {
    path: '/',
    reachFromPath: async (page) => {
      await newRepositoryFolder(page);
      await openFolderSettings(page);
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
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
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

test('folder settings default off, and enabling them opens single and bulk move reviews', async ({ page }) => {
  await page.goto('/');
  await newRepositoryFolder(page);
  await openFolderSettings(page);
  const onMove = page.getByRole('checkbox', { name: 'Apply profiles to repositories moved here' });
  await expect(onMove).not.toBeChecked();
  await page.getByRole('combobox', { name: 'Add a profile' }).selectOption('base.yaml');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select lunch/api', exact: true }).check();
  await page.getByRole('combobox', { name: 'Move to a folder' }).selectOption('Work');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page).toHaveURL(/repotted\.test\/$/u);

  await openFolderSettings(page);
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
    buffer: Buffer.from('kind: actions-policy\nactions: { enabled: true }\n'),
  });
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('release-import')));
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByRole('heading', { name: 'imported-policy', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Actions', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Repository', exact: true })).toHaveCount(0);
});
