// Exercise staged package-boundary checks in an isolated Git repository.
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('staged package imports reject internals without rejecting comments or exported names', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-design-gate-test-'));
  const gate = join(dirname(fileURLToPath(import.meta.url)), 'design-gate.ts');
  const git = (...args: string[]) => execFileSync('git', args, {cwd: root, stdio: 'pipe'});
  try {
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-qm', 'baseline');
    const path = 'throughline/durable-agent/extensions/sample.ts';
    mkdirSync(dirname(join(root, path)), {recursive: true});
    const staged = (source: string) => {
      writeFileSync(join(root, path), source);
      git('add', path);
      return spawnSync(process.execPath, [gate, 'imports'], {cwd: root, encoding: 'utf8'});
    };
    for (const source of [
      "import { load } from '../../../packages/coding-agent/dist/core/extensions/loader.js';",
      "const x = require('../../../packages/coding-agent/src/core/extensions/loader.js');",
      "const x = import('../../../packages/coding-agent/dist/core/extensions/loader.js');",
      "export { x } from '../../../packages/coding-agent/src/index.js';",
      "import x from '\\u002e\\u002e/../../packages/coding-agent/dist/index.js';",
    ]) {
      const result = staged(source);
      assert.equal(result.status, 1, source);
      assert.match(result.stderr, /upstream fold/);
    }
    assert.equal(staged("// import x from '../../../packages/coding-agent/dist/index.js';\nconst note = \"require('../../../packages/coding-agent/src/x')\";\nimport { agent } from '@earendil-works/pi-durable';").status, 0);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
