// `bridge setup` — register the bridge with a host, so the reverse channel
// exists before anyone needs it.
//
// This deliberately does *not* parse and rewrite the whole host config. These
// files are hand-edited by their owners, often contain comments, and losing a
// line of someone's configuration is a much worse failure than not writing
// anything. So each writer is either:
//
//   * a JSON read/modify/write that only touches its own key, or
//   * a pure text append guarded by a "does this block already exist?" test
//
// and every writer supports --dry-run. Printing the change is the default in
// `setup --check`, because the useful question is usually "what would you do?"
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { mcpServerBlock } from './bridge-entry.mjs';

const SERVER_NAME = 'agent-bridge';

/**
 * Where each known host keeps its MCP configuration.
 *
 * These are conventions, not contracts: a host that moves its file simply ends
 * up in the "unknown" branch, which prints the block for the user to paste.
 */
export function hostTargets({ homedir: home = homedir() } = {}) {
  return {
    zcode: {
      label: 'ZCode',
      kind: 'json',
      path: join(home, '.zcode', 'settings.json'),
      // ZCode reads MCP servers from settings.json under "mcpServers"; plugin
      // installs use .mcp.json instead and do not need this.
      key: 'mcpServers',
    },
    codex: {
      label: 'Codex',
      kind: 'toml',
      path: join(home, '.codex', 'config.toml'),
      table: 'mcp_servers',
    },
    claude: {
      label: 'Claude Code',
      kind: 'json',
      path: join(home, '.claude', 'settings.json'),
      key: 'mcpServers',
    },
  };
}

/**
 * Write the bridge into one host's config.
 *
 * Returns { changed, path, preview, reason }. `changed: false` with a reason is
 * a normal outcome (already configured, file missing), not an error — setup must
 * be safe to run repeatedly.
 */
export function installInto(host, entry, { dryRun = false, overwrite = false } = {}) {
  const block = mcpServerBlock(entry);

  if (host.kind === 'json') return installJson(host, block, { dryRun, overwrite });
  if (host.kind === 'toml') return installToml(host, block, { dryRun, overwrite });
  return { changed: false, path: host.path, reason: `unknown host kind "${host.kind}"` };
}

function installJson(host, block, { dryRun, overwrite }) {
  if (!existsSync(host.path)) {
    // Creating the file would be a guess about its schema. Print instead.
    return {
      changed: false,
      path: host.path,
      reason: `${host.label} 的配置文件不存在`,
      preview: JSON.stringify({ [host.key]: { [SERVER_NAME]: block } }, null, 2),
    };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(host.path, 'utf8'));
  } catch (err) {
    return { changed: false, path: host.path, reason: `不是合法 JSON，未改动：${err.message}` };
  }

  const existing = raw?.[host.key]?.[SERVER_NAME];
  if (existing && !overwrite) {
    const same = JSON.stringify(existing) === JSON.stringify(block);
    if (same) return { changed: false, path: host.path, reason: '已配置且内容一致' };
    return {
      changed: false,
      path: host.path,
      reason: `${SERVER_NAME} 已存在且不同；加 --overwrite 覆盖`,
      preview: JSON.stringify(existing, null, 2),
    };
  }

  const next = {
    ...raw,
    [host.key]: { ...(raw?.[host.key] || {}), [SERVER_NAME]: block },
  };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (!dryRun) writeAtomic(host.path, text);
  return { changed: !dryRun, wouldChange: true, path: host.path, preview: text };
}

function installToml(host, block, { dryRun, overwrite }) {
  if (!existsSync(host.path)) {
    return {
      changed: false,
      path: host.path,
      reason: `${host.label} 的配置文件不存在`,
      preview: tomlBlock(host.table, block),
    };
  }

  const current = readFileSync(host.path, 'utf8');
  const marker = `[${host.table}.${SERVER_NAME}]`;
  if (current.includes(marker) && !overwrite) {
    return { changed: false, path: host.path, reason: '已配置；加 --overwrite 覆盖' };
  }

  let text = current;
  if (text.includes(marker)) {
    // Replacing an existing table in TOML by text surgery means finding where it
    // ends, and "where it ends" is exactly the kind of judgement that silently
    // eats a neighbour's setting. Ask for the file to be fixed by hand instead.
    return {
      changed: false,
      path: host.path,
      reason: `${marker} 已存在。请手工删除该段后重试（自动替换可能误删相邻配置）`,
      preview: tomlBlock(host.table, block),
    };
  }

  const sep = text.endsWith('\n') ? '' : '\n';
  text = `${text}${sep}\n${tomlBlock(host.table, block)}`;
  if (!dryRun) writeAtomic(host.path, text);
  return { changed: !dryRun, wouldChange: true, path: host.path, preview: tomlBlock(host.table, block) };
}

// TOML strings are single-quoted here (literal strings): config paths on Windows
// are full of backslashes, and a literal string means nobody has to think about
// escaping them.
function tomlBlock(table, block) {
  const lines = [`[${table}.${SERVER_NAME}]`, `command = '${block.command}'`];
  lines.push(`args = [${(block.args || []).map(a => `'${a}'`).join(', ')}]`);
  const env = Object.entries(block.env || {});
  if (env.length) {
    // Codex puts env vars in a sub-table, not inline.
    lines.push('');
    lines.push(`[${table}.${SERVER_NAME}.env]`);
    for (const [k, v] of env) lines.push(`${k} = '${v}'`);
  }
  return `${lines.join('\n')}\n`;
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  // Keep one backup: the whole point of this module is not to lose a line of
  // someone's config, and a backup is how you recover if it happens anyway.
  if (existsSync(path)) {
    try { copyFileSync(path, `${path}.bridge-backup`); } catch { /* best effort */ }
  }
  writeFileSync(path, text, 'utf8');
}

/**
 * What to tell an agent that has no config file we know how to edit.
 *
 * The instruction has to be self-contained: the agent reading it is not the user
 * and cannot ask follow-up questions.
 */
export function manualInstructions(entry) {
  const block = mcpServerBlock(entry);
  return [
    '把这个 MCP server 加到你的配置里（stdio 传输）：',
    '',
    JSON.stringify({ mcpServers: { [SERVER_NAME]: block } }, null, 2),
    '',
    `BRIDGE_CALLER=${entry.env.BRIDGE_CALLER} 不能省：它让回调用可归因，防循环靠它。`,
  ].join('\n');
}
