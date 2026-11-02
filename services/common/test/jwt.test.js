const test = require('node:test');
const assert = require('node:assert/strict');
const { signToken, verifyToken } = require('../jwt');

const opts = { secret: 'test-secret', issuer: 'socialflow' };

test('a signed token verifies and carries its claims', () => {
  const token = signToken({ sub: 'user-1' }, opts);
  const claims = verifyToken(token, opts);
  assert.equal(claims.sub, 'user-1');
  assert.equal(claims.iss, 'socialflow');
  assert.ok(claims.exp > claims.iat);
});

test('tampered, foreign, expired or malformed tokens are rejected', () => {
  const token = signToken({ sub: 'user-1' }, opts);
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', iss: 'socialflow', exp: 9e9 })).toString('base64url')}.${s}`;
  assert.throws(() => verifyToken(forged, opts), /bad signature/);
  assert.throws(() => verifyToken(token, { ...opts, secret: 'other' }), /bad signature/);
  assert.throws(() => verifyToken(signToken({ sub: 'u' }, { ...opts, issuer: 'evil' }), opts), /wrong issuer/);
  assert.throws(() => verifyToken(signToken({ sub: 'u' }, { ...opts, ttlSeconds: -1 }), opts), /expired/);
  assert.throws(() => verifyToken('not-a-jwt', opts), /malformed/);
});
