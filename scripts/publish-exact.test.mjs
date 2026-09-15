import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyRegistryIntegrity,
  publishExactVersion,
} from './publish-exact.mjs';

const integrity = 'sha512-Zml4dHVyZQ==';
const missing = { status: 1, stdout: '', stderr: 'npm error code E404' };
const published = { status: 0, stdout: `"${integrity}"\n`, stderr: '' };
const publishSucceeded = { status: 0, stdout: '+ package', stderr: '' };
let previousDirectory;
let directory;

beforeEach(() => {
  previousDirectory = process.cwd();
  directory = mkdtempSync(join(tmpdir(), 'publish-exact-test-'));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@scope/package', version: '1.2.3' }),
  );
  process.chdir(directory);
});

afterEach(() => {
  process.chdir(previousDirectory);
  rmSync(directory, { force: true, recursive: true });
});

function runner(results) {
  return vi.fn(() => {
    const result = results.shift();
    if (!result) throw new Error('Unexpected command');
    return result;
  });
}

it('fails closed when registry integrity differs', () => {
  expect(() =>
    classifyRegistryIntegrity(
      { status: 0, stdout: '"sha512-b3RoZXI="', stderr: '' },
      integrity,
    ),
  ).toThrow(/integrity mismatch/i);
});

describe('exact publication', () => {
  it('skips an exact version already present', async () => {
    const run = runner([published]);
    await expect(
      publishExactVersion({ run, computeIntegrity: () => integrity }),
    ).resolves.toBe('already-published');
  });

  it('rechecks registry integrity after npm publish succeeds', async () => {
    const run = runner([
      missing,
      publishSucceeded,
      missing,
      published,
    ]);
    await expect(
      publishExactVersion({
        run,
        computeIntegrity: () => integrity,
        retryDelayMs: 0,
      }),
    ).resolves.toBe('published');
    expect(run).toHaveBeenCalledWith('npm', [
      'view',
      '@scope/package@1.2.3',
      'dist.integrity',
      '--json',
    ]);
  });

  it('reconciles an ambiguous npm publish failure', async () => {
    const run = runner([
      missing,
      { status: 1, stdout: '', stderr: 'socket closed' },
      published,
    ]);
    await expect(
      publishExactVersion({
        run,
        computeIntegrity: () => integrity,
        retryDelayMs: 0,
      }),
    ).resolves.toBe('reconciled');
  });
});
