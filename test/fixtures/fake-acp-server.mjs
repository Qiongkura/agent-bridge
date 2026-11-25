#!/usr/bin/env node
// A minimal ACP server used by the tests.
//
// It does the least a real agent must do — answer initialize, accept session/new
// and echo one prompt — and records what the client asked for, so the test can
// assert on the *protocol traffic* rather than on the client's intent. A mock at
// the object level would only prove the code calls itself correctly.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

// Optional path: when given, every session/new request is written there so the
// test can inspect what crossed the wire after this process has exited.
const logPath = process.argv[2];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    if (logPath) writeFileSync(logPath, JSON.stringify(msg.params, null, 2), 'utf8');
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_fake_1' } });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FAKE_ACP_OK' } },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
