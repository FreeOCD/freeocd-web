import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('check-version', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'freeocd-check-version-'));
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('../scripts/check-version.js', import.meta.url),
      join(root, 'scripts/check-version.js'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function check(version) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      version, packages: { '': { version } },
    }));
    return execFileSync(process.execPath, [join(root, 'scripts/check-version.js')], {
      env: { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  it.each(['0.0.0', '1.2.3', '1.2.3-rc.1', '1.2.3-001abc'])('accepts %s', (version) => {
    expect(check(version)).toContain(`Version check passed: ${version}`);
  });

  it.each(['01.2.3', '1.2.03', '1.2.3-rc.01', '1.2.3-rc..1', '1.2', '1.2.3+linux'])(
    'rejects %s', (version) => {
      expect(() => check(version)).toThrow(/is not valid SemVer/);
    },
  );
});
