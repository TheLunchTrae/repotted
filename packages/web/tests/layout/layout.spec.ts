// Every screen of the web app fits a touch screen's width: the page doesn't
// scroll sideways, and nothing sticks out past the right edge except inside
// something that scrolls or clips on its own, such as a code block.

import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Locator, type Page, test as base } from '@playwright/test';
import { build } from 'esbuild';

import { pageBundle } from '../../aliases.ts';

interface Screen {
  /** The address that opens it, or the page to start from. */
  readonly path: string;
  /** What reaches it from that page, when no address opens it. */
  readonly open?: (page: Page) => Promise<void>;
  /** What shows once it has drawn everything it loads. */
  readonly ready: (page: Page) => Locator;
  /**
   * Projects in playwright.config.ts where it is known to overflow. The test
   * is expected to fail there, so the change that fixes it removes the entry.
   */
  readonly overflowsAt?: readonly string[];
}

// To check another screen, add it here.
const screens: Readonly<Record<string, Screen>> = {
  'sign-in': {
    path: '/?signed-out',
    ready: (page) => page.getByRole('heading', { name: 'Set up every repository the same way' }),
  },
  repositories: {
    path: '/',
    ready: (page) => page.getByRole('checkbox', { name: 'Tick lunch/website-with-a-rather-long-repository-name' }),
  },
  'owner menu': {
    path: '/',
    open: (page) => page.getByText('All owners').click(),
    ready: (page) => page.getByRole('button', { name: 'Only personal' }),
  },
  'repository details': {
    path: '/?repository=lunch/website-with-a-rather-long-repository-name',
    ready: (page) => page.getByRole('heading', { name: 'website-with-a-rather-long-repository-name' }),
  },
  settings: { path: '/settings', ready: (page) => page.getByRole('heading', { name: 'Account' }) },
  profiles: { path: '/profiles', ready: (page) => page.getByText('website', { exact: true }) },
};

const origin = 'https://repotted.test';
const site = new URL('../../static/', import.meta.url);

const test = base.extend<object, { bundle: string }>({
  // The app as harness.tsx starts it, bundled once for each worker.
  bundle: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from its first parameter, and this one has none
    async ({}, use) => {
      const result = await build({
        entryPoints: [fileURLToPath(new URL('harness.tsx', import.meta.url))],
        ...pageBundle,
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

/** Elements whose box ends past the viewport's right edge with nothing between them and the page that scrolls or clips. */
function outside(): string[] {
  const width = document.documentElement.clientWidth;
  const found: string[] = [];
  for (const element of document.body.querySelectorAll('*')) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.right <= width + 1 || !element.checkVisibility({ visibilityProperty: true })) {
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
        `<${element.localName} class="${element.getAttribute('class') ?? ''}"> ${name} ends at ${Math.round(box.right)}`,
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
    await screen.open?.(page);
    await expect(screen.ready(page)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const width = await page.evaluate(() => document.documentElement.clientWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'page width').toBeLessThanOrEqual(width);
    expect(await page.evaluate(outside), 'elements past the right edge').toEqual([]);
    expect(errors, 'page errors').toEqual([]);
  });
}
