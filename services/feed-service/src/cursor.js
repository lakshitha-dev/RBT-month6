// Opaque pagination cursor: the timestamp (ms) of the last item on the page.
// The next page returns items strictly older than it.
function encodeCursor(ts) {
  return Buffer.from(String(ts)).toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  const ts = Number(Buffer.from(String(cursor), 'base64url').toString());
  if (!Number.isFinite(ts) || ts <= 0) {
    const err = new Error('invalid cursor');
    err.status = 400;
    throw err;
  }
  return ts;
}

module.exports = { encodeCursor, decodeCursor };
