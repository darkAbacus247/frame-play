"""Calls to the Meta Model API (or to the loopback stand-in in rehearsal).

- The base address is pinned: https://api.meta.ai/v1, or a loopback address.
  The credential goes only there, as the bearer token; redirects are never
  followed.
- One timer covers the whole answer (status line, headers and body).
- Answers are capped at 8 MiB, error bodies at 64 KiB.
- One retry on a network error, 429, 500 or 502, and on 503 only when
  Retry-After is 3 s or less. Never retried: 400, 401, 402, 403, 404, 413,
  504, or a malformed answer. Retry-After is read as seconds or as a date.
"""
import email.utils
import http.client
import json
import socket
import threading
import time
from urllib.parse import urlsplit

from server import config
from server.config import KeyHolder, redact

RETRY_STATUSES = {429, 500, 502}
NEVER_RETRY = {400, 401, 402, 403, 404, 413, 504}
WORDS = {
    400: 'The Model API refused the request as malformed',
    401: 'The Model API did not accept the key',
    402: 'The Model API account needs a payment method or credit',
    403: 'The Model API refused access',
    404: 'The Model API does not know this address or model',
    413: 'The photo was too large for the Model API',
    429: 'The Model API asked us to slow down',
    500: 'The Model API had an internal error',
    502: 'The Model API had a gateway error',
    503: 'The Model API is unavailable for now',
    504: 'The Model API timed out',
}


class CallError(Exception):
    def __init__(self, code, message, status=None, retry_after=None, retryable=False, billed=True, excerpt=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retry_after = retry_after
        self.retryable = retryable
        self.billed = billed
        self.excerpt = excerpt


def retry_after_seconds(value, now=None):
    """Seconds to wait from a Retry-After header, or None when unreadable.
    A wait below zero is no wait."""
    if value is None:
        return None
    value = value.strip()
    if value.isdigit():
        return int(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if when is None:
        return None
    now = time.time() if now is None else now
    return max(0, int(round(when.timestamp() - now)))


def excerpt(text, holder=None, limit=300):
    """At most 300 characters of an unreadable answer, redacted."""
    if isinstance(text, (bytes, bytearray)):
        text = bytes(text[:4 * limit]).decode('utf-8', 'replace')
    return redact(str(text)[:limit], holder)


class Transport:
    """Sends JSON to the pinned base with the credential, under the rules."""

    def __init__(self, base, credential, connect=None):
        if base == config.API_BASE:
            if not isinstance(credential, KeyHolder):
                raise ValueError('the live address needs the key holder')
        else:
            try:
                ok = config.loopback_base(base) == base
            except config.ConfigError:
                ok = False
            if not ok:
                raise ValueError('only the Model API or a loopback address')
        if isinstance(credential, KeyHolder):
            self.holder = credential
        elif credential == config.REHEARSAL_CREDENTIAL and base != config.API_BASE:
            self.holder = None
        else:
            raise ValueError('unknown credential')
        self.base = base
        parts = urlsplit(base)
        self.scheme = parts.scheme
        self.host = parts.hostname
        self.port = parts.port
        self.path = parts.path.rstrip('/')
        self.credential = credential
        self.connect = connect  # tests may swap the connection maker

    def _auth(self):
        if self.holder is not None:
            return self.holder.authorization()
        return 'Bearer ' + config.REHEARSAL_CREDENTIAL

    def _connection(self, timeout):
        if self.connect:
            return self.connect(self, timeout)
        if self.scheme == 'https':
            return http.client.HTTPSConnection(self.host, self.port or 443, timeout=timeout)
        return http.client.HTTPConnection(self.host, self.port or 80, timeout=timeout)

    def post_once(self, route, body, timeout):
        """One request. Returns (status, parsed JSON). Raises CallError."""
        payload = json.dumps(body).encode('utf-8')
        conn = self._connection(timeout)
        fired = threading.Event()

        def stop():
            fired.set()
            try:
                if conn.sock is not None:
                    conn.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        timer = threading.Timer(timeout, stop)
        timer.daemon = True
        timer.start()
        try:
            conn.request('POST', self.path + route, body=payload, headers={
                'Authorization': self._auth(),
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'FRAMEPLAY/2',
            })
            r = conn.getresponse()
            status = r.status
            retry = retry_after_seconds(r.getheader('Retry-After'))
            if 300 <= status < 400:
                raise CallError('redirect', 'The Model API answered with a redirect, which is never followed', status)
            cap = config.MAX_ANSWER_BYTES if status < 400 else config.MAX_ERROR_BYTES
            data = r.read(cap + 1)
            if len(data) > cap:
                raise CallError('too_large', 'The answer was larger than allowed', status)
        except CallError:
            raise
        except (OSError, http.client.HTTPException, ValueError) as e:
            if fired.is_set():
                raise CallError('timeout', 'The Model API did not answer in time', retryable=True) from None
            raise CallError('network', f'A network error: {type(e).__name__}', retryable=True) from None
        finally:
            timer.cancel()
            try:
                conn.close()
            except OSError:
                pass
        if fired.is_set():
            raise CallError('timeout', 'The Model API did not answer in time', retryable=True)
        if status >= 400:
            code = _error_code(data) or f'http_{status}'
            retryable = status in RETRY_STATUSES or (status == 503 and retry is not None and retry <= 3)
            if status in NEVER_RETRY:
                retryable = False
            raise CallError(code, WORDS.get(status, f'The Model API answered {status}'), status, retry, retryable,
                            billed=False, excerpt=excerpt(data, self.holder) if data else None)
        try:
            return status, json.loads(data.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise CallError('malformed', 'The answer could not be read', status, excerpt=excerpt(data, self.holder)) from None

    def post(self, route, body, deadline, sleep=time.sleep, clock=time.monotonic):
        """With the retry table. Returns (parsed JSON, attempts, ms)."""
        t0 = clock()
        attempt = 1
        while True:
            left = deadline - clock()
            if left <= 0:
                raise CallError('timeout', 'The photo ran out of time', retryable=False)
            try:
                _, j = self.post_once(route, body, min(config.CALL_TIMEOUT_S, left))
                return j, attempt, int((clock() - t0) * 1000)
            except CallError as e:
                e.attempt = attempt
                if attempt >= 2 or not e.retryable:
                    raise
                wait = e.retry_after if e.retry_after is not None else 0
                if e.status == 429 and e.retry_after is None:
                    wait = 1
                if wait > deadline - clock() - 1:
                    raise
                if wait:
                    sleep(wait)
                attempt += 1


def _error_code(data):
    try:
        j = json.loads(data.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return None
    err = j.get('error') if isinstance(j, dict) else None
    if isinstance(err, dict):
        code = err.get('code') or err.get('type')
        if isinstance(code, str) and len(code) <= 64:
            return code
    return None
