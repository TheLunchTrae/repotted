import { afterEach, expect, test, vi } from 'vitest';

import { FakeGitRepository } from '../../core/tests/support/fake-git.js';
import { Notifications } from '../src/app/notifications.js';
import { Profiles } from '../src/app/profiles/profiles.js';
import { profileConfirmation } from '../src/views/layout/notifications.js';

afterEach(() => vi.useRealTimers());

test('a local copy never claims GitHub success and failed syncs or conflicts keep their durable notices', () => {
  const profiles = new Profiles(
    new FakeGitRepository(),
    { read: () => undefined, write: () => undefined },
    () => undefined,
  );
  profiles.markProblem.value = 'A previous repository could not be unmarked';
  expect(profileConfirmation(profiles, 'Saved.')).toEqual({ message: 'Saved.', detail: 'Available in this tab.' });
  profiles.source.value = { kind: 'repository', repository: 'lunch/config', path: 'profiles' };
  profiles.sync.value = { status: 'failed', message: 'Offline' };
  expect(profileConfirmation(profiles, 'Saved.')).toBeUndefined();
  profiles.sync.value = { status: 'synced', pulled: 0, pushed: 1 };
  profiles.conflicts.value = ['base.yaml'];
  expect(profileConfirmation(profiles, 'Saved.')).toBeUndefined();
  profiles.conflicts.value = [];
  expect(profileConfirmation(profiles, 'Saved.')).toEqual({ message: 'Saved.', detail: 'Synced with lunch/config.' });
});

test('a confirmation closes after five seconds and a replacement has its own interval', () => {
  vi.useFakeTimers();
  const notifications = new Notifications();
  notifications.show({ message: 'First' });
  vi.advanceTimersByTime(4000);
  notifications.show({ message: 'Second' });
  vi.advanceTimersByTime(4999);
  expect(notifications.current.value?.message).toBe('Second');
  vi.advanceTimersByTime(1);
  expect(notifications.current.value).toBeUndefined();
});

test('hover, focus, dialogs and hidden pages pause the remaining interval independently', () => {
  vi.useFakeTimers();
  const notifications = new Notifications();
  notifications.show({ message: 'Saved' });
  vi.advanceTimersByTime(2000);
  notifications.pause('hover');
  notifications.pause('focus');
  vi.advanceTimersByTime(6000);
  notifications.resume('hover');
  vi.advanceTimersByTime(6000);
  expect(notifications.current.value?.message).toBe('Saved');
  notifications.resume('focus');
  vi.advanceTimersByTime(2999);
  expect(notifications.current.value?.message).toBe('Saved');
  vi.advanceTimersByTime(1);
  expect(notifications.current.value).toBeUndefined();
});

test('dismissal and sign-out cancel the timer and late completions cannot notify a disposed session', () => {
  vi.useFakeTimers();
  const notifications = new Notifications();
  notifications.show({ message: 'Saved' });
  notifications.dismiss();
  expect(vi.getTimerCount()).toBe(0);
  notifications.show({ message: 'Connected' });
  notifications.dispose();
  notifications.show({ message: 'Late save' });
  expect(notifications.current.value).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

test('dismissing a focused confirmation cannot leave future confirmations paused', () => {
  vi.useFakeTimers();
  const notifications = new Notifications();
  notifications.show({ message: 'First' });
  notifications.pause('focus');
  notifications.pause('hover');
  notifications.dismiss();
  notifications.show({ message: 'Second' });
  vi.advanceTimersByTime(5000);
  expect(notifications.current.value).toBeUndefined();
});
