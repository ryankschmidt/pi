// Commit-time checks for package boundaries and Durable design alternatives.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Evaluate = (post: (url: string, body: string) => Promise<{status: number; text: string}>, request: object) => Promise<
    {ok: true; requestId: string; model: string; answers: Record<string, {type: string; noul: number}>; usage: object} |
    {ok: false; requestId: string; reason: string}
  >;
const git = (...args: string[]) => execFileSync('git', args, {encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
const repo = git('rev-parse', '--show-toplevel').trim();
const stagedPaths = (filter: string) => git('diff', '--cached', '--no-renames', '--name-only', `--diff-filter=${filter}`, '-z').split('\0').filter(Boolean);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const refuse = (caught: string, action: string): never => {
  console.error(`Pi design gate: ${caught}\nThis check protects public package boundaries and deliberate design choices; skipping it can leave a change that breaks on an upstream fold or adds unnecessary maintenance. The commit was not made. ${action}`);
  process.exit(1);
};

function imports(text: string, path: string): string[] {
  const found: string[] = [];
  const tokenPattern = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|[A-Za-z_$][\w$]*|[^\s]/g;
  const tokens = [...text.matchAll(tokenPattern)].map(m => m[0]).filter(t => !t.startsWith('//') && !t.startsWith('/*'));
  const inspect = (token: string | undefined) => {
    if (!token || !/^["'`]/.test(token)) return;
    const specifier = token.slice(1, -1).replace(/\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([^\r\n]))/gi,
      (_match, long: string, unicode: string, hex: string, escaped: string) => long || unicode || hex ? String.fromCodePoint(parseInt(long || unicode || hex, 16)) : escaped);
    if (!/^\.{1,2}\//.test(specifier)) return;
    const target = relative(repo, resolve(repo, dirname(path), specifier)).split(sep).join('/');
    if (/^packages\/[^/]+\/(?:src|dist)(?:\/|$)/.test(target)) found.push(specifier);
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ((token === 'require' || token === 'import') && tokens[i + 1] === '(') { inspect(tokens[i + 2]); continue; }
    if (token === 'import' && /^["'`]/.test(tokens[i + 1] ?? '')) { inspect(tokens[i + 1]); continue; }
    if (token !== 'import' && token !== 'export') continue;
    for (let j = i + 1; j < tokens.length && tokens[j] !== ';' && tokens[j] !== 'import' && tokens[j] !== 'export'; j++) {
      if (tokens[j] === 'from') { inspect(tokens[j + 1]); break; }
    }
  }
  return found;
}

function checkImports(): void {
  for (const path of stagedPaths('ACMR').filter(p => p.startsWith('throughline/'))) {
    const now = imports(git('show', `:${path}`), path);
    let before: string[] = [];
    try { before = imports(git('show', `HEAD:${path}`), path); } catch { /* a new file has no earlier imports */ }
    for (const item of now) {
      const index = before.indexOf(item);
      if (index >= 0) before.splice(index, 1);
      else refuse(`the staged file ${path} adds an import of package internals: ${item}.`, 'Use the package’s exported API, then stage the change again.');
    }
  }
}

const questions = {
  different: {type: 'noul', instructions: 'Does state.alternative explicitly name a concrete other implementation, distinct from the approach described in state.message and state.diff? Answer false when it only repeats the chosen approach or says no alternative exists.'},
  advantage: {type: 'noul', instructions: 'state.message describes a staged change; state.diff is its Durable-agent patch. Does state.alternative explain a concrete reason the chosen design is better than the named alternative for maintenance or upstream folds?'}
};
const decide = (answers: Record<string, {type: string; noul: number}> | null) =>
  !!answers && Object.keys(questions).every(key => answers[key]?.type === 'noul' && Number.isFinite(answers[key].noul) && answers[key].noul >= 0.7 && answers[key].noul <= 1);

async function checkAlternative(messagePath: string): Promise<void> {
  const paths = stagedPaths('ACMRD').filter(p => p.startsWith('throughline/durable-agent/'));
  if (!paths.length) return;
  const message = readFileSync(messagePath, 'utf8');
  const parsed = git('interpret-trailers', '--parse', messagePath);
  const trailers = [...parsed.matchAll(/^Strongest-alternative:\s*(.+)$/gim)].map(m => m[1].trim());
  if (trailers.length !== 1 || /^(?:none|n\/?a|not applicable|no alternative)[.!\s]*$/i.test(trailers[0] ?? '')) {
    refuse('the Durable-agent change lacks one meaningful Strongest-alternative trailer.', 'Name the best different design and why this design has less upkeep or survives upstream folds better.');
  }
  const facts = {message, alternative: trailers[0], paths, tree: git('write-tree').trim(), diff: git('diff', '--cached', '--no-ext-diff', '--', 'throughline/durable-agent/')};
  const factsHash = sha(JSON.stringify(facts));
  const { evaluate } = require('/Users/Admin/core-root/src/tools/throughline-ship/dist/jev-client.js') as {evaluate: Evaluate};
  const result = await evaluate(async (url, body) => {
    const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body, signal: AbortSignal.timeout(600_000)});
    return {status: response.status, text: await response.text()};
  }, {requestId: `pi-design-gate-${randomUUID()}`, state: facts, questions});
  const record = {schema: 'pi.design-gate-decision.v1', question_version: 'pi.strongest-alternative.v1', facts, facts_sha256: factsHash, questions, jev: result, verdict: result.ok && decide(result.answers) ? 'approve' : 'refuse', decided_at: new Date().toISOString()};
  const directory = resolve(repo, git('rev-parse', '--git-common-dir').trim(), 'pi-design-gate');
  mkdirSync(directory, {recursive: true});
  const path = join(directory, `${factsHash}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {flag: 'wx'});
  const readback = JSON.parse(readFileSync(path, 'utf8')) as typeof record;
  if (readback.facts_sha256 !== sha(JSON.stringify(readback.facts)) || readback.facts_sha256 !== factsHash || !readback.jev.ok || !decide(readback.jev.answers)) {
    const reason = result.ok ? 'the named alternative or its maintenance advantage was not established' : `JEV could not assess the alternative (${result.reason})`;
    refuse(`${reason}; decision record: ${path}.`, 'Name a genuinely different design and a concrete upkeep or upstream-fold advantage, then retry when the broker is available.');
  }
}

try {
  if (process.argv[2] === 'imports') checkImports();
  else if (process.argv[2] === 'alternative' && process.argv[3]) await checkAlternative(process.argv[3]);
  else refuse('the design check was invoked without its required operation or commit message.', 'Restore the fork’s commit hooks and retry.');
} catch (error) {
  refuse(`the design check could not inspect the staged change (${error instanceof Error ? error.message : String(error)}).`, 'Correct the named inspection failure and retry.');
}
