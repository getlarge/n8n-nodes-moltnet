import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolvePackFilename } from './pack-result.mjs';

const commandTimeoutMs = 600_000;

export function runCommand(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: commandTimeoutMs,
  });
}

export function classifyRegistryIntegrity(result, expectedIntegrity) {
  if (result.status === 0) {
    const integrity = JSON.parse(result.stdout);
    if (integrity !== expectedIntegrity) {
      throw new Error(
        `Published integrity mismatch: expected ${expectedIntegrity}, received ${String(integrity)}`,
      );
    }
    return 'published';
  }
  if (/\bE404\b|404 Not Found/iu.test(`${result.stdout}\n${result.stderr}`)) {
    return 'missing';
  }
  throw new Error(
    `Unable to inspect npm registry: ${`${result.stdout}\n${result.stderr}`.trim()}`,
  );
}

export function localIntegrity(run, directory) {
  const result = run('npm', [
    'pack',
    '--json',
    '--pack-destination',
    directory,
  ]);
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`);
  const tarball = resolvePackFilename(result.stdout, directory);
  return `sha512-${createHash('sha512')
    .update(readFileSync(tarball))
    .digest('base64')}`;
}

export async function publishExactVersion({
  run = runCommand,
  computeIntegrity = localIntegrity,
  wait = (duration) => new Promise((done) => setTimeout(done, duration)),
  attempts = 6,
  retryDelayMs = 10_000,
} = {}) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const exactPackage = `${manifest.name}@${manifest.version}`;
  const temporary = mkdtempSync(join(tmpdir(), 'moltnet-n8n-publish-'));

  try {
    const expected = computeIntegrity(run, temporary);
    const inspect = () =>
      classifyRegistryIntegrity(
        run('npm', ['view', exactPackage, 'dist.integrity', '--json']),
        expected,
      );
    if (inspect() === 'published') return 'already-published';

    const publish = run('npm', ['publish', '--access', 'public', '--provenance']);
    let lastInspectionError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (inspect() === 'published') {
          return publish.status === 0 ? 'published' : 'reconciled';
        }
      } catch (error) {
        lastInspectionError = error;
      }
      if (attempt < attempts) await wait(retryDelayMs);
    }

    const publishDiagnostic = `${publish.stdout}\n${publish.stderr}`.trim();
    throw new Error(
      `npm publish was not verified for ${exactPackage}: ${lastInspectionError instanceof Error ? lastInspectionError.message : publishDiagnostic}`,
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  publishExactVersion()
    .then((state) => process.stdout.write(`${state}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
      process.exitCode = 1;
    });
}
