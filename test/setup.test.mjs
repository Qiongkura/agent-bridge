// Setup edits other people's configuration files, which makes "did it touch
// something it should not have?" the only question that matters. Every case here
// is about refusing to write rather than about writing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installInto, hostTargets, manualInstructions } from '../src/core/setup.mjs';

const ENTRY = {
  name: 'agent-bridge',
  command: 'node',
  args: ['/bridge/src/mcp/server.mjs'],
  env: { BRIDGE_CALLER: 'codex', BRIDGE_DATA_DIR: '/data' },
};

function scratch() {
  return mkdtempSync(join(tmpdir(), 'bridge-setup-'));
}

test('dry-run reports the change without writing it', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify({ other: true }, null, 2));

  const result = installInto({ label: 'T', kind: 'json', path, keyPath: ['mcpServers'] }, ENTRY, { dryRun: true });

  assert.equal(result.changed, false);
  assert.equal(result.wouldChange, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { other: true }, 'file untouched');
});

test('JSON install adds its key and preserves everything else', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  const original = { theme: 'dark', mcpServers: { existing: { command: 'x' } } };
  writeFileSync(path, JSON.stringify(original, null, 2));

  const result = installInto({ label: 'T', kind: 'json', path, keyPath: ['mcpServers'] }, ENTRY);

  assert.equal(result.changed, true);
  const next = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(next.theme, 'dark');
  assert.deepEqual(next.mcpServers.existing, { command: 'x' }, 'neighbour preserved');
  assert.equal(next.mcpServers['agent-bridge'].env.BRIDGE_CALLER, 'codex');
});

test('a second identical run is a no-op', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{}');
  const host = { label: 'T', kind: 'json', path, keyPath: ['mcpServers'] };

  installInto(host, ENTRY);
  const again = installInto(host, ENTRY);

  assert.equal(again.changed, false);
  assert.match(again.reason, /一致/);
});

test('a conflicting entry is left alone without --overwrite', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify({
    mcpServers: { 'agent-bridge': { command: 'someone-elses' } },
  }));

  const result = installInto({ label: 'T', kind: 'json', path, keyPath: ['mcpServers'] }, ENTRY);

  assert.equal(result.changed, false);
  assert.match(result.reason, /overwrite/);
  const next = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(next.mcpServers['agent-bridge'].command, 'someone-elses', 'untouched');
});

test('invalid JSON is reported, never rewritten', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{ this is not json');

  const result = installInto({ label: 'T', kind: 'json', path, keyPath: ['mcpServers'] }, ENTRY);

  assert.equal(result.changed, false);
  assert.equal(readFileSync(path, 'utf8'), '{ this is not json', 'left exactly as found');
});

test('a missing config file is not created from thin air', () => {
  const dir = scratch();
  const path = join(dir, 'nope.json');

  const result = installInto({ label: 'T', kind: 'json', path, keyPath: ['mcpServers'] }, ENTRY);

  assert.equal(result.changed, false);
  assert.equal(existsSync(path), false);
  assert.ok(result.preview.includes('agent-bridge'), 'shows what to paste instead');
});

test('TOML install appends a table with env in a sub-table', () => {
  const dir = scratch();
  const path = join(dir, 'config.toml');
  writeFileSync(path, 'model = "x"\n\n[mcp_servers.other]\ncommand = \'y\'\n');

  const result = installInto({ label: 'T', kind: 'toml', path, table: 'mcp_servers' }, ENTRY);

  assert.equal(result.changed, true);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /model = "x"/, 'existing config preserved');
  assert.match(text, /\[mcp_servers\.agent-bridge\]/);
  assert.match(text, /\[mcp_servers\.agent-bridge\.env\]/, 'Codex wants env in a sub-table');
  assert.match(text, /BRIDGE_CALLER = 'codex'/);
});

test('an existing TOML table is refused rather than surgically replaced', () => {
  const dir = scratch();
  const path = join(dir, 'config.toml');
  const original = '[mcp_servers.agent-bridge]\ncommand = \'old\'\n\n[mcp_servers.keep]\ncommand = \'k\'\n';
  writeFileSync(path, original);

  const result = installInto({ label: 'T', kind: 'toml', path, table: 'mcp_servers' }, ENTRY, { overwrite: true });

  // Re-splicing TOML by text means deciding where a table ends, and getting that
  // wrong silently deletes a neighbour. Refusing is the safer failure.
  assert.equal(result.changed, false);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('every write leaves one backup', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{}');

  installInto({ label: 'T', kind: 'json', path, keyPath: ['mcpServers'] }, ENTRY);

  assert.equal(existsSync(`${path}.bridge-backup`), true);
});

test('hostTargets points at the paths that were actually verified', () => {
  const targets = hostTargets({ homedir: '/home/u', appData: 'C:/Users/u/AppData/Roaming' });

  assert.deepEqual(Object.keys(targets).sort(), ['claude', 'codex', 'zcode']);

  // ZCode nests its servers under mcp.servers in the CLI config. An earlier
  // version of this file guessed settings.json plus a flat mcpServers key, which
  // would have written a file ZCode never reads.
  assert.deepEqual(targets.zcode.keyPath, ['mcp', 'servers']);
  assert.match(targets.zcode.path.replace(/\\/g, '/'), /\.zcode\/cli\/config\.json$/);

  // Claude Desktop's documented Windows location, not Claude Code's settings.
  assert.deepEqual(targets.claude.keyPath, ['mcpServers']);
  assert.match(targets.claude.path.replace(/\\/g, '/'), /Roaming\/Claude\/claude_desktop_config\.json$/);

  assert.equal(targets.codex.kind, 'toml');
});

test('a nested key path is written without disturbing siblings', () => {
  const dir = scratch();
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    plugins: { enabledPlugins: { 'a@b': true } },
    mcp: { servers: { existing: { command: 'x' } }, otherSetting: 1 },
  }, null, 2));

  installInto({ label: 'T', kind: 'json', path, keyPath: ['mcp', 'servers'] }, ENTRY);

  const next = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(next.mcp.servers.existing, { command: 'x' }, 'sibling server kept');
  assert.equal(next.mcp.otherSetting, 1, 'sibling setting kept');
  assert.equal(next.mcp.servers['agent-bridge'].env.BRIDGE_CALLER, 'codex');
  assert.equal(next.plugins.enabledPlugins['a@b'], true, 'unrelated top-level key kept');
});

test('a nested key path creates missing intermediate objects', () => {
  const dir = scratch();
  const path = join(dir, 'config.json');
  writeFileSync(path, '{}');

  installInto({ label: 'T', kind: 'json', path, keyPath: ['mcp', 'servers'] }, ENTRY);

  const next = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(next.mcp.servers['agent-bridge']);
});

test('manual instructions stay self-contained for an agent that cannot ask', () => {
  const text = manualInstructions(ENTRY);
  assert.match(text, /BRIDGE_CALLER/);
  assert.match(text, /server\.mjs/);
});
