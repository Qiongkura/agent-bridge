// Loop prevention is the one subsystem where a bug is expensive and invisible:
// a broken guard looks exactly like a working guard until the bill arrives. So
// it is tested directly rather than through a full round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  pairKey, checkLease, takeLease, checkHop, childHopEnv, activeLeases, clearLeases, leasePath,
} from '../src/core/lease.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'bridge-lease-'));
}

test('pairKey is direction-independent', () => {
  // A and B calling each other is one conversation. If the key were directional,
  // a two-agent ping-pong would look like two harmless pairs.
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'));
  assert.notEqual(pairKey('a', 'b'), pairKey('a', 'c'));
});

test('a held lease blocks the same pair and nothing else', () => {
  const dataDir = scratch();
  const release = takeLease({ dataDir, caller: 'a', target: 'b' });

  assert.equal(checkLease({ dataDir, caller: 'a', target: 'b' }).ok, false);
  assert.equal(checkLease({ dataDir, caller: 'b', target: 'a' }).ok, false, 'reverse direction');
  assert.equal(checkLease({ dataDir, caller: 'a', target: 'c' }).ok, true, 'unrelated pair');
  assert.equal(checkLease({ dataDir, caller: 'c', target: 'b' }).ok, true, 'unrelated pair, other side');

  release();
  assert.equal(checkLease({ dataDir, caller: 'a', target: 'b' }).ok, true);
});

test('a lease expires instead of wedging the bridge forever', () => {
  const dataDir = scratch();
  takeLease({ dataDir, caller: 'a', target: 'b', leaseMs: 1000, now: 0 });

  assert.equal(checkLease({ dataDir, caller: 'a', target: 'b', now: 500 }).ok, false);
  assert.equal(checkLease({ dataDir, caller: 'a', target: 'b', now: 1500 }).ok, true);
});

test('checkLease prunes expired entries rather than accumulating them', () => {
  const dataDir = scratch();
  takeLease({ dataDir, caller: 'a', target: 'b', leaseMs: 1000, now: 0 });
  checkLease({ dataDir, caller: 'x', target: 'y', now: 5000 });

  const file = JSON.parse(readFileSync(leasePath(dataDir), 'utf8'));
  assert.deepEqual(Object.keys(file), [], 'expired lease was removed from disk');
});

test('a corrupt lease file degrades to "no leases", not to a dead bridge', () => {
  const dataDir = scratch();
  writeFileSync(leasePath(dataDir), '{not json', 'utf8');
  // The alternative — throwing here — would disable collaboration until the user
  // finds and deletes a file they do not know about.
  assert.equal(checkLease({ dataDir, caller: 'a', target: 'b' }).ok, true);
});

test('a stale release does not remove a lease another process now holds', () => {
  const dataDir = scratch();
  const release = takeLease({ dataDir, caller: 'a', target: 'b' });

  // Another process takes over the pair after ours expires (simulated by
  // rewriting the owner). Our late release must not clear their lease: that
  // would let two overlapping runs believe they are exclusive.
  const file = JSON.parse(readFileSync(leasePath(dataDir), 'utf8'));
  const key = pairKey('a', 'b');
  file[key].pid = process.pid + 1;
  file[key].expiresAt = Date.now() + 60000;
  writeFileSync(leasePath(dataDir), JSON.stringify(file));

  release();

  assert.equal(activeLeases({ dataDir }).length, 1, 'foreign lease still held');
  assert.equal(checkLease({ dataDir, caller: 'a', target: 'b' }).ok, false);
});

test('hop counting stops a nested call and allows a fresh one', () => {
  const saved = process.env.BRIDGE_HOP;
  try {
    delete process.env.BRIDGE_HOP;
    assert.equal(checkHop({ maxHops: 1 }).ok, true, 'a fresh origin may ask');

    process.env.BRIDGE_HOP = '1';
    assert.equal(checkHop({ maxHops: 1 }).ok, true, 'hop 1 is the peer itself, still allowed');

    process.env.BRIDGE_HOP = '2';
    const blocked = checkHop({ maxHops: 1 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'hop_limit');
  } finally {
    if (saved === undefined) delete process.env.BRIDGE_HOP;
    else process.env.BRIDGE_HOP = saved;
  }
});

test('childHopEnv increments without mutating the base env', () => {
  const base = { PATH: '/x', BRIDGE_HOP: '2' };
  const child = childHopEnv(base);
  assert.equal(child.BRIDGE_HOP, '3');
  assert.equal(child.PATH, '/x');
  assert.equal(base.BRIDGE_HOP, '2', 'caller env untouched');
});

test('clearLeases removes the file', () => {
  const dataDir = scratch();
  takeLease({ dataDir, caller: 'a', target: 'b' });
  clearLeases({ dataDir });
  assert.deepEqual(activeLeases({ dataDir }), []);
});
