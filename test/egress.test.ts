import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initDb } from '../server/db';
import { log, recentActivity } from '../server/services/activity';
import { inboundSignature, redactSensitive, sourceUrlProblem, validInboundSignature } from '../server/services/security';

test('source URLs reject unsafe protocols, credentials, and private-network targets', () => {
  assert.match(sourceUrlProblem('file:///etc/passwd')!, /http and https/);
  assert.match(sourceUrlProblem('http://user:pass@example.com')!, /credentials/);
  assert.match(sourceUrlProblem('http://127.0.0.1/admin')!, /private-network/);
  assert.match(sourceUrlProblem('http://169.254.169.254/latest/meta-data')!, /private-network/);
  assert.match(sourceUrlProblem('http://[::1]/')!, /private-network/);
  assert.equal(sourceUrlProblem('https://www.example.com/news'), null);
});

test('inbound signatures use a constant-time HMAC comparison', () => {
  const body = Buffer.from('{"message_id":"m_1","text":"yes"}');
  const signature = inboundSignature(body, 'local-demo-secret');
  assert.ok(validInboundSignature(body, `sha256=${signature}`, 'local-demo-secret'));
  assert.ok(!validInboundSignature(body, signature, 'other-secret'));
  assert.ok(!validInboundSignature(body, 'not-a-signature', 'local-demo-secret'));
});

test('activity entries and model context redact credential-shaped values', () => {
  initDb(':memory:');
  const raw = 'api_key=sk-secret-value Bearer abcdefghijklmnopqrstuvwxyz';
  assert.equal(redactSensitive(raw), 'api_key= [redacted] Bearer [redacted]');
  log('system', 'info', raw);
  const entry = recentActivity(1)[0];
  assert.doesNotMatch(entry.message, /sk-secret-value|abcdefghijklmnopqrstuvwxyz/);
  assert.match(entry.message, /\[redacted\]/);
});
