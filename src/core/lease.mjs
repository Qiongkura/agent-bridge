// Loop prevention.
//
// Two agents that can both call each other will, sooner or later, call each
// other forever: A finishes a turn and asks B to review; B's turn ends and asks
// A; A finishes and asks B. The bill arrives later.
//
// Three guards, in order of reliability:
//
//   1. A lease file. A process that sends a prompt takes a lease naming the pair
//      and a deadline. While a lease is held, the same pair may not be asked
//      again. This is the only guard that works across independent processes —
//      and independent processes are the hard case, because a resident daemon
//      (an MCP server, an editor's language server) inherits its environment at
//      launch and then lives for days. An env var set by a parent that has since
//      exited is invisible to it, so env-only guards silently fail open.
//
//   2. The BRIDGE_HOP environment variable, incremented on every subprocess a
//      backend spawns. Cheap and exact for the CLI/ACP path, useless for the
//      daemon path. Kept because when it *is* visible it is authoritative.
//
//   3. The caller's own bookkeeping (the Stop hook's `stop_hook_active`, the
//      fingerprint dedupe, the cooldown). These catch repeats within one host.
//
// A lease is deliberately short. It is not a lock on correctness, it is a
// rate limit on a runaway conversation: long enough that a slow model still
// gets its answer, short enough that a wedged lease expires instead of
// disabling the bridge until someone deletes a file.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const DEFAULT_LEASE_MS = 300000; // 5 minutes
export const MAX_HOPS = 1;

export function leasePath(dataDir) {
  return join(dataDir, 'leases.json');
}

function readLeases(path) {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    // A corrupt lease file must not disable collaboration permanently: treat it
    // as empty. Worst case a loop runs one extra round; the alternative is a
    // bridge that never works again until the user finds and deletes a file.
    return {};
  }
}

function writeLeases(path, leases) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(leases, null, 2)}\n`, 'utf8');
  } catch {
    // Losing the lease file degrades to the env guard; it must never throw from
    // inside the send path.
  }
}

// The identity of a "pair". Direction matters: A→B and B→A are the same
// conversation and must share a lease, otherwise a two-agent ping-pong is two
// distinct pairs that each look innocent.
export function pairKey(a, b) {
  const left = String(a || 'unknown');
  const right = String(b || 'unknown');
  return [left, right].sort().join('|');
}

/**
 * Read the hop count for this process.
 *
 * BRIDGE_HOP is set by the bridge when it spawns a child, so a nested call
 * knows it is nested. Zero means "this is a fresh origin".
 */
export function currentHop() {
  const n = Number(process.env.BRIDGE_HOP);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Decide whether this send may proceed.
 *
 * Returns { ok: true } or { ok: false, reason, detail } — never throws. A guard
 * that can throw is a guard that turns a loop into an error the user has to
 * debug.
 */
export function checkLease({ dataDir, caller, target, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  const path = leasePath(dataDir);
  const leases = readLeases(path);

  // Drop expired leases first, so a wedged entry cannot block forever.
  let pruned = false;
  for (const [key, lease] of Object.entries(leases)) {
    if (!lease || typeof lease.expiresAt !== 'number' || lease.expiresAt <= now) {
      delete leases[key];
      pruned = true;
    }
  }
  if (pruned) writeLeases(path, leases);

  const key = pairKey(caller, target);
  const held = leases[key];
  if (held) {
    const seconds = Math.max(1, Math.round((held.expiresAt - now) / 1000));
    return {
      ok: false,
      reason: 'lease_held',
      detail: `${held.caller} 和 ${held.target} 之间已有一轮协作在进行中（还剩 ${seconds} 秒）。`
        + '两个代理互相调用会形成环，所以并发的第二轮被拒绝。等这一轮结束再试。',
    };
  }

  return { ok: true, path, leases };
}

/**
 * Take the lease. Call this immediately before sending, after checkLease passed.
 *
 * Returns a release() function. Releasing early is good hygiene but not
 * required: the lease expires on its own.
 */
export function takeLease({ dataDir, caller, target, leaseMs = DEFAULT_LEASE_MS, now = Date.now() }) {
  const path = leasePath(dataDir);
  const leases = readLeases(path);
  const key = pairKey(caller, target);

  leases[key] = {
    caller,
    target,
    takenAt: new Date(now).toISOString(),
    expiresAt: now + leaseMs,
    pid: process.pid,
  };
  writeLeases(path, leases);

  return function release() {
    try {
      const current = readLeases(path);
      // Only remove it if it is still ours: another process may have taken the
      // lease after ours expired, and stealing the release would let two
      // overlapping runs exist.
      if (current[key] && current[key].pid === process.pid) {
        delete current[key];
        writeLeases(path, current);
      }
    } catch {
      /* best effort */
    }
  };
}

/**
 * Raise the hop counter for a child process this backend spawns.
 *
 * Merge into the child's env. When the child is another bridge, its own send
 * sees BRIDGE_HOP=1 and refuses to forward again — which is what stops a chain
 * of three agents from becoming a ring.
 */
export function childHopEnv(baseEnv = process.env) {
  return { ...baseEnv, BRIDGE_HOP: String(currentHop() + 1) };
}

/**
 * Gate for a send that may be nested.
 *
 * maxHops=1 means: a fresh origin (hop 0) may ask once; the agent it asks runs
 * at hop 1 and may not ask anyone through this bridge. Raise it to allow
 * deliberate chains (A consults B consults C) at the cost of a longer possible
 * ring.
 */
export function checkHop({ maxHops = MAX_HOPS } = {}) {
  const hop = currentHop();
  if (hop > maxHops) {
    return {
      ok: false,
      reason: 'hop_limit',
      detail: `这是一次嵌套调用（第 ${hop} 跳，上限 ${maxHops}）。`
        + '继续转发会让代理互相调用成环，所以被拒绝。',
    };
  }
  return { ok: true, hop };
}

/** Write and remove the lease file, for tests and `bridge_status`. */
export function activeLeases({ dataDir, now = Date.now() } = {}) {
  const path = leasePath(dataDir);
  const leases = readLeases(path);
  const out = [];
  for (const [key, lease] of Object.entries(leases)) {
    if (!lease || typeof lease.expiresAt !== 'number' || lease.expiresAt <= now) continue;
    out.push({ pair: key, ...lease, remainingMs: lease.expiresAt - now });
  }
  return out;
}

export function clearLeases({ dataDir } = {}) {
  const path = leasePath(dataDir);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best effort */
  }
  return path;
}
