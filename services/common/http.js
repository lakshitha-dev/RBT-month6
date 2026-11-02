// Service-to-service HTTP client: resolves the target through discovery,
// enforces a timeout and propagates the correlation id.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createServiceClient({ discovery, timeoutMs = 2000 }) {
  return async function request(service, path, { method = 'GET', body, requestId } = {}) {
    const { address, port } = await discovery.resolve(service);
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (requestId) headers['x-request-id'] = requestId;

    let res;
    try {
      res = await fetch(`http://${address}:${port}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Connection refused / timeout: drop the cached instance list so the
      // next call re-reads healthy instances from Consul.
      discovery.invalidate(service);
      throw err;
    }
    if (!res.ok) throw new HttpError(res.status, `${service} ${method} ${path} -> ${res.status}`);
    return res.json();
  };
}

module.exports = { createServiceClient, HttpError };
