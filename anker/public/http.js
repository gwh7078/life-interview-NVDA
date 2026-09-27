export async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(url, { ...options, headers, cache: 'no-store' });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Successful mutations may return an empty body.
  }
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `请求失败（${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.errorCode = payload.errorCode;
    throw error;
  }
  return payload;
}
