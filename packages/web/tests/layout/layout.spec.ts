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
