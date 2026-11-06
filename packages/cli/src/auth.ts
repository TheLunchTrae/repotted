import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class AuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
  }
}

/**
 * Finds a GitHub token: GITHUB_TOKEN, then GH_TOKEN, then the GitHub CLI's
 * own sign-in. The token is only ever held in memory.
 */
export async function resolveToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { env, timeout: 10_000 });
    const token = stdout.trim();
    if (token !== '') {
      return token;
    }
  } catch (error) {
    throw new AuthError('No GitHub token found. Set GITHUB_TOKEN, or sign in with the GitHub CLI (gh auth login).', {
      cause: error,
    });
  }
  throw new AuthError('The GitHub CLI returned an empty token. Run gh auth login, or set GITHUB_TOKEN.');
}
