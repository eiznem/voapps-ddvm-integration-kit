'use strict';
// Dependency-free tests (Node 18+ `node --test`). No network calls, no live sends.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  recordsToCsv, campaignName, campaignNamePrefix, localDayBoundary,
  verifyPostbackSignature, createClient, VOAPPS_DAY_OFFSET,
} = require('../voapps');

// ---- fixed postback HMAC vector (regression-locked) --------------------------
// signed string = `${timestamp}.${destination}.${rawBody}`, HMAC-SHA256, "v1=" + hex.
const VEC = {
  secret: 'whsec_demo_secret',
  timestamp: '1730000000',
  destination: 'https://example.com/voapps/postback',
  body: '{"record":{"id":123,"delivery_status_code":200,"original_fields":{"account_number":"CRM-1001"}}}',
  sig: 'v1=e1f3c7710ab46ebbbb29b89b763055c8bc388feb09cc82740a027d90f90c8c25',
};
const FOREVER = Number.MAX_SAFE_INTEGER; // bypass the freshness gate to isolate the HMAC check

test('postback: valid signature verifies (fixed vector)', () => {
  assert.equal(verifyPostbackSignature({
    signingSecret: VEC.secret, timestamp: VEC.timestamp, destination: VEC.destination,
    rawBody: VEC.body, signatureHeader: VEC.sig, toleranceSeconds: FOREVER,
  }), true);
});

test('postback: wrong secret fails', () => {
  assert.equal(verifyPostbackSignature({
    signingSecret: 'nope', timestamp: VEC.timestamp, destination: VEC.destination,
    rawBody: VEC.body, signatureHeader: VEC.sig, toleranceSeconds: FOREVER,
  }), false);
});

test('postback: altered raw body fails', () => {
  assert.equal(verifyPostbackSignature({
    signingSecret: VEC.secret, timestamp: VEC.timestamp, destination: VEC.destination,
    rawBody: VEC.body.replace('200', '300'), signatureHeader: VEC.sig, toleranceSeconds: FOREVER,
  }), false);
});

test('postback: altered destination fails (destination is part of the signed string)', () => {
  assert.equal(verifyPostbackSignature({
    signingSecret: VEC.secret, timestamp: VEC.timestamp, destination: 'https://evil.example/cb',
    rawBody: VEC.body, signatureHeader: VEC.sig, toleranceSeconds: FOREVER,
  }), false);
});

test('postback: stale timestamp rejected under default tolerance', () => {
  assert.equal(verifyPostbackSignature({
    signingSecret: VEC.secret, timestamp: VEC.timestamp, destination: VEC.destination,
    rawBody: VEC.body, signatureHeader: VEC.sig, // default 300s; the vector timestamp is far in the past
  }), false);
});

test('postback: missing signature header returns false', () => {
  assert.equal(verifyPostbackSignature({
    signingSecret: VEC.secret, timestamp: VEC.timestamp, destination: VEC.destination,
    rawBody: VEC.body, signatureHeader: undefined, toleranceSeconds: FOREVER,
  }), false);
});

// ---- recordsToCsv ------------------------------------------------------------
test('recordsToCsv: header + union of columns, escaping, unicode', () => {
  const csv = recordsToCsv([
    { number: '+15551234567', voapps_zip_code: '92563', account_number: 'CRM-1' },
    { number: '+15559876543', note: 'a,b "q"\nx', name: 'José' },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'number,voapps_zip_code,account_number,note,name');
  assert.ok(csv.includes('"a,b ""q""\nx"')); // quoted, doubled quotes, embedded newline preserved
  assert.ok(csv.includes('José'));
});

test('recordsToCsv: phone_number alias satisfies the number requirement', () => {
  assert.ok(recordsToCsv([{ phone_number: '+15551234567' }]).startsWith('phone_number'));
});

test('recordsToCsv: a single row missing a number throws (every row is validated)', () => {
  assert.throws(
    () => recordsToCsv([{ number: '+15551234567' }, { voapps_zip_code: '92563' }]),
    /row 1 is missing a number/,
  );
});

test('recordsToCsv: empty input throws', () => {
  assert.throws(() => recordsToCsv([]), /non-empty array/);
});

// ---- naming + day boundary ---------------------------------------------------
test('campaignName / campaignNamePrefix format', () => {
  assert.equal(campaignNamePrefix('45+ DPD'), '45+ DPD | Transactional Campaign | ');
  assert.equal(campaignNamePrefix(''), 'Transactional Campaign | ');
  assert.match(campaignName('45+ DPD'), /^45\+ DPD \| Transactional Campaign \| \d{4}-\d{2}-\d{2}T/);
});

test('localDayBoundary uses the fixed VoApps UTC-07:00 cutoff (no DST shift in winter)', () => {
  assert.equal(VOAPPS_DAY_OFFSET, '-07:00');
  const winter = localDayBoundary(new Date('2026-01-15T12:00:00Z'));
  const summer = localDayBoundary(new Date('2026-07-15T12:00:00Z'));
  assert.match(winter, /^\d{4}-\d{2}-\d{2} 00:00:00 -07:00$/);
  assert.ok(winter.endsWith(' 00:00:00 -07:00'));
  assert.ok(summer.endsWith(' 00:00:00 -07:00'));
});

// ---- client guards (no network) ---------------------------------------------
test('createClient requires apiKey and accountId', () => {
  assert.throws(() => createClient({ accountId: 1 }), /apiKey is required/);
  assert.throws(() => createClient({ apiKey: 'k' }), /accountId is required/);
});

test('createClient exposes the expected methods', () => {
  const c = createClient({ apiKey: 'k', accountId: 1 });
  for (const m of ['sendVoicemail', 'createCampaign', 'addRecord', 'getRecord',
    'getCampaign', 'listCampaigns', 'findTodaysCampaign', 'fetchExport']) {
    assert.equal(typeof c[m], 'function', `missing method: ${m}`);
  }
});
