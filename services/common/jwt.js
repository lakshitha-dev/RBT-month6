'use strict';
// Minimal HS256 JWT sign/verify on node:crypto (no extra dependency).
// Kong's jwt plugin is the first check at the edge; services verify again so a request
// that somehow bypasses the gateway still cannot pick its own identity.
const crypto = require('node:crypto');

const b64url = (input) => Buffer.from(input).toString('base64url');
const hmac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function signToken(claims, { secret, issuer, ttlSeconds = 24 * 3600, now = Date.now() } = {}) {
  if (!secret) throw new Error('JWT secret is not configured');
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ ...claims, iss: issuer, iat, exp: iat + ttlSeconds }));
  return `${header}.${payload}.${hmac(`${header}.${payload}`, secret)}`;
}

// Returns the claims, or throws an Error whose message says why the token was rejected.
function verifyToken(token, { secret, issuer, now = Date.now() } = {}) {
  if (!secret) throw new Error('JWT secret is not configured');
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new Error('malformed token');
  const [header, payload, signature] = parts;

  const expected = Buffer.from(hmac(`${header}.${payload}`, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('bad signature');

  let head;
  let claims;
  try {
    head = JSON.parse(Buffer.from(header, 'base64url').toString());
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    throw new Error('malformed token');
  }
  if (head.alg !== 'HS256') throw new Error('unsupported alg');
  if (issuer && claims.iss !== issuer) throw new Error('wrong issuer');
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(now / 1000)) throw new Error('token expired');
  return claims;
}

module.exports = { signToken, verifyToken };
