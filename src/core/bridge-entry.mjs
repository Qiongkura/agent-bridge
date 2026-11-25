// The reverse channel: how a peer calls back.
//
// Forward is easy — the bridge spawns or connects to an agent and sends it text.
// Back is harder, because the peer has to be given a way to reach us. Two
// mechanisms exist, and they share one entry description:
//
//   * MCP: the peer's host is pointed at `src/mcp/server.mjs`, and it calls
//     `bridge_*` tools. Used by ZCode, Codex, and any MCP host.
//   * ACP: the peer is told to connect to `src/mcp/server.mjs` on session/new,
//     which is how an ACP agent gets the same tool set.
//
// Both need the *same* extra piece of information to be useful: which agent is
// on the other end. Without it a peer that calls back announces itself as the
// generic default, self-exclusion stops working, and two agents can address each
// other in a circle that each side believes is legitimate.
//
// So the entry always carries the peer's own backend id in BRIDGE_CALLER.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER_PATH = join(HERE, '..', 'mcp', 'server.mjs');

/**
 * Describe how a peer with the given backend id should reach the bridge.
 *
 * `dataDir` is passed through so the reverse path reads and writes the same
 * config as the forward path — otherwise the peer's choices would live in a
 * second, invisible set of files.
 */
export function reverseEntry({ backendId, dataDir, name = 'agent-bridge', env = {} } = {}) {
  return {
    name,
    // `process.execPath` rather than "node": the peer's environment may not have
    // node on PATH, but it always has the interpreter that is running us.
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      // The peer speaks for itself. This is the single line that makes the
      // returned call attributable, and therefore loop-safe.
      BRIDGE_CALLER: backendId || 'bridge',
      ...(dataDir ? { BRIDGE_DATA_DIR: dataDir } : {}),
      ...env,
    },
  };
}

/**
 * The same entry in the shape an MCP host config wants (ZCode, Claude, most
 * JSON-config hosts). Codex uses TOML and is handled separately by setup.
 */
export function mcpServerBlock(entry) {
  return {
    command: entry.command,
    args: entry.args,
    env: entry.env,
  };
}
