export class ApiAuthError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'ApiAuthError';
  }
}

export class ResyncRequiredError extends Error {
  constructor(message = 'Event stream resynchronization required') {
    super(message);
    this.name = 'ResyncRequiredError';
  }
}

export class ApiRequestError extends Error {
  constructor(status, message) {
    super(message || `API request failed with HTTP ${status}`);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

export function createSseParser(onFrame) {
  if (typeof onFrame !== 'function') throw new Error('SSE parser requires a frame callback');
  const decoder = new TextDecoder();
  let textBuffer = '';
  let frame = emptyFrame();

  function processLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      emitFrame();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') frame.id = value;
    else if (field === 'event') frame.event = value;
    else if (field === 'data') frame.dataLines.push(value);
  }

  function emitFrame() {
    if (frame.id === undefined && frame.event === undefined && frame.dataLines.length === 0) {
      frame = emptyFrame();
      return;
    }
    const emitted = {};
    if (frame.id !== undefined) emitted.id = frame.id;
    if (frame.event !== undefined) emitted.event = frame.event;
    if (frame.dataLines.length) emitted.data = frame.dataLines.join('\n');
    frame = emptyFrame();
    onFrame(emitted);
  }

  function consumeText(text) {
    textBuffer += text;
    for (;;) {
      const newline = textBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = textBuffer.slice(0, newline);
      textBuffer = textBuffer.slice(newline + 1);
      processLine(line);
    }
  }

  return {
    push(chunk) {
      if (typeof chunk === 'string') consumeText(chunk);
      else if (chunk instanceof Uint8Array) consumeText(decoder.decode(chunk, { stream: true }));
      else throw new Error('SSE parser accepts only strings or Uint8Array chunks');
    },
    finish() {
      consumeText(decoder.decode());
      if (textBuffer.length) {
        processLine(textBuffer);
        textBuffer = '';
      }
      if (frame.id !== undefined || frame.event !== undefined || frame.dataLines.length) {
        throw new Error('SSE stream ended with an incomplete frame');
      }
    },
  };
}

export function createApiClient({ origin, getToken }) {
  if (typeof origin !== 'string' || !origin) throw new Error('API client origin is required');
  if (typeof getToken !== 'function') throw new Error('API client getToken callback is required');
  const base = new URL(origin).origin;

  async function json(path, options = {}) {
    const url = apiUrl(base, path);
    const headers = requestHeaders(getToken(), options.body !== undefined);
    const response = await fetch(url, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    return readJsonResponse(response);
  }

  async function streamEvents({ after, signal, onOpen, onEvent }) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Event stream cursor must be a non-negative safe integer');
    if (!(signal instanceof AbortSignal)) throw new Error('Event stream requires an AbortSignal');
    if (typeof onEvent !== 'function') throw new Error('Event stream requires an event callback');
    const url = new URL('/api/v1/events/stream', base);
    url.searchParams.set('after', String(after));
    const response = await fetch(url, {
      method: 'GET',
      signal,
      headers: {
        ...requestHeaders(getToken(), false),
        accept: 'text/event-stream',
      },
    });
    if (response.status === 401) throw new ApiAuthError(await errorMessage(response, 'Authentication required'));
    if (response.status === 409) throw new ResyncRequiredError(await errorMessage(response, 'Event stream resynchronization required'));
    if (!response.ok) throw new ApiRequestError(response.status, await errorMessage(response, `Event stream failed with HTTP ${response.status}`));
    if (!response.body) throw new ApiRequestError(response.status, 'Event stream response has no body');
    onOpen?.();

    let parserError;
    const parser = createSseParser((frame) => {
      if (frame.event !== 'helix.event') return;
      if (typeof frame.id !== 'string' || typeof frame.data !== 'string') {
        parserError = new ResyncRequiredError('Malformed Helix SSE frame');
        return;
      }
      let event;
      try {
        event = JSON.parse(frame.data);
      } catch {
        parserError = new ResyncRequiredError('Malformed Helix SSE JSON payload');
        return;
      }
      const id = Number(frame.id);
      if (!Number.isSafeInteger(id) || id < 1 || !event || typeof event !== 'object' || event.sequence !== id) {
        parserError = new ResyncRequiredError('Helix SSE sequence does not match event payload');
        return;
      }
      onEvent(event);
    });

    const reader = response.body.getReader();
    try {
      for (;;) {
        if (parserError) throw parserError;
        const result = await reader.read();
        if (result.done) break;
        parser.push(result.value);
        if (parserError) throw parserError;
      }
      try {
        parser.finish();
      } catch (error) {
        throw new ResyncRequiredError(error instanceof Error ? error.message : String(error));
      }
      if (!signal.aborted) throw new ApiRequestError(response.status, 'Event stream closed unexpectedly');
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  return { json, streamEvents };
}

function emptyFrame() {
  return { id: undefined, event: undefined, dataLines: [] };
}

function apiUrl(origin, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('API path must be an absolute same-origin path');
  return new URL(`/api/v1${path}`, origin);
}

function requestHeaders(token, hasBody) {
  const headers = { accept: 'application/json' };
  if (typeof token === 'string' && token.length) headers.authorization = `Bearer ${token}`;
  if (hasBody) headers['content-type'] = 'application/json';
  return headers;
}

async function readJsonResponse(response) {
  if (response.status === 401) throw new ApiAuthError(await errorMessage(response, 'Authentication required'));
  if (!response.ok) throw new ApiRequestError(response.status, await errorMessage(response, `API request failed with HTTP ${response.status}`));
  try {
    return await response.json();
  } catch {
    throw new ApiRequestError(response.status, 'API returned malformed JSON');
  }
}

async function errorMessage(response, fallback) {
  try {
    const payload = await response.json();
    return typeof payload?.error === 'string' && payload.error ? payload.error : fallback;
  } catch {
    return fallback;
  }
}
