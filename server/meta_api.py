"""Calls to the Meta Model API (or to the loopback stand-in in rehearsal).

- The base address is pinned: https://api.meta.ai/v1, or a loopback address.
  The credential goes only there, as the bearer token; redirects are never
  followed.
- One timer covers the whole answer (status line, headers and body).
- Answers are capped at 8 MiB, error bodies at 64 KiB.
- One retry on a network error, 500 or 502, and on 503 only when
  Retry-After is 3 s or less. A 429 (not quota) is retried twice while time
  remains, after Retry-After or 1 s, then 2 s. Never retried: 400, 401, 402, 403, 404, 413,
  504, or a malformed answer. Retry-After is read as seconds or as a date.
- With the owner's key, an account or model problem (401, 402, 403, a 404
  for a model route, a quota 429) marks the transport broken. While it is broken, the server sends
  no photo for LIVE_HOLD_S; after that one photo may check again, and any
  answer that is not an error clears the mark.
"""
import email.utils
import http.client
import json
import math
import socket
import threading
import time
from urllib.parse import urlsplit

from server import config
from server.config import KeyHolder, redact

RETRY_STATUSES = {429, 500, 502}
NEVER_RETRY = {400, 401, 402, 403, 404, 413, 504}
# Every failure in whole sentences, with the step that helps. "The same photo
# again" for passing faults; the owner for account or model problems.
AGAIN = 'Please try the same photo again.'
AGAIN_SOON = 'Please try the same photo again in a minute.'
OWNER = 'The owner of this server must fix this; the sample rooms still work.'
WORDS = {
    400: 'The Model API could not accept this request. Please try another photo.',
    401: f"The Model API did not accept this server's key. {OWNER}",
    402: f'The Model API account behind this server needs a payment method or credit. {OWNER}',
    403: f'The Model API refused this server access. {OWNER}',
    404: f'The Model API does not know this model or address (it may have been renamed or retired). {OWNER}',
    413: 'The photo was too large for the Model API. Please try a smaller photo.',
    429: f'The Model API is busy. {AGAIN_SOON}',
    500: f'The Model API had a problem on its side. {AGAIN}',
    502: f'The Model API had a problem on its side. {AGAIN}',
    503: f'The Model API is unavailable for now. {AGAIN_SOON}',
    504: f'The Model API took too long on its side. {AGAIN}',
}
TIMEOUT_WORDS = f'The Model API did not answer in time. {AGAIN}'
NETWORK_WORDS = f'The Model API could not be reached (a network error). {AGAIN}'
OUT_OF_TIME_WORDS = f'This photo ran out of time before every answer came back. {AGAIN}'
REDIRECT_WORDS = 'The Model API answered with a redirect, which this app never follows. Please try again later.'
TOO_LARGE_WORDS = "The Model API's answer was larger than this app allows. Please try another photo."
MALFORMED_WORDS = f"The Model API's answer could not be read. {AGAIN}"
# Account or model problems: no photo can be read until the owner fixes them.
BROKEN_STATUSES = {401, 402, 403}
MODEL_ROUTES = {'/chat/completions', '/responses'}
QUOTA_WORDS = f'The Model API account behind this server has used up its quota. {OWNER}'
LIVE_UNAVAILABLE = ('The live AI is unavailable on this server right now (an account or model problem '
                    'the owner must fix). The sample rooms still work.')


def other_status_words(status):
    if status >= 500:
        return f'The Model API had a problem on its side (it answered {status}). {AGAIN}'
    return f'The Model API refused this request (it answered {status}). Please try another photo.'


def is_transient(status, quota=False):
    """A passing fault: the same photo, again, later, may well work."""
    return (status == 429 and not quota) or (status is not None and status >= 500)


class CallError(Exception):
    """transient: a passing fault (a 429 that is not quota, a 5xx, a timeout or
    a network error); the page offers the same photo again."""

    def __init__(self, code, message, status=None, retry_after=None, retryable=False, billed=True, excerpt=None,
                 transient=False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retry_after = retry_after
        self.retryable = retryable
        self.billed = billed
        self.excerpt = excerpt
        self.transient = bool(transient)
        self.latched = False  # True when this answer marked the transport broken


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
        self.now = time.monotonic  # tests may swap the latch's clock
        # The latch guards the owner's key. Rehearsal drills each failure one
        # photo at a time, so it latches only when asked to.
        self.latching = self.holder is not None
        self.broken = None  # or {'code', 'words', 'since'} after an account or model problem
        self.probing = False
        self._latch = threading.Lock()

    # ---- the live-unavailable latch ----
    def _trip(self, code, words):
        with self._latch:
            self.broken = {'code': code, 'words': words, 'since': self.now()}

    def _clear(self):
        if self.broken is not None:
            with self._latch:
                self.broken = None

    def live_state(self):
        """('ok', None, 0) or ('unavailable', words, seconds until a photo may check again)."""
        with self._latch:
            b = self.broken
            if b is None:
                return 'ok', None, 0
            left = config.LIVE_HOLD_S - (self.now() - b['since'])
            if left <= 0 and not self.probing:
                return 'ok', None, 0
            return 'unavailable', b['words'], max(1, math.ceil(left))

    def claim(self):
        """Before a photo: 'open' (not broken), 'probe' (this photo checks again;
        call release() after it), or None (refused, send nothing)."""
        with self._latch:
            b = self.broken
            if b is None:
                return 'open'
            if self.probing or self.now() - b['since'] < config.LIVE_HOLD_S:
                return None
            self.probing = True
            return 'probe'

    def release(self):
        with self._latch:
            self.probing = False

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
                raise CallError('redirect', REDIRECT_WORDS, status)
            cap = config.MAX_ANSWER_BYTES if status < 400 else config.MAX_ERROR_BYTES
            data = r.read(cap + 1)
            if len(data) > cap:
                raise CallError('too_large', TOO_LARGE_WORDS, status)
        except CallError:
            raise
        except (OSError, http.client.HTTPException, ValueError) as e:
            if fired.is_set():
                raise CallError('timeout', TIMEOUT_WORDS, retryable=True, transient=True) from None
            raise CallError('network', NETWORK_WORDS, retryable=True, excerpt=type(e).__name__, transient=True) from None
        finally:
            timer.cancel()
            try:
                conn.close()
            except OSError:
                pass
        if fired.is_set():
            raise CallError('timeout', TIMEOUT_WORDS, retryable=True, transient=True)
        if status >= 400:
            code = _error_code(data) or f'http_{status}'
            quota = status == 429 and 'quota' in code.lower()
            retryable = status in RETRY_STATUSES or (status == 503 and retry is not None and retry <= 3)
            if status in NEVER_RETRY or quota:
                retryable = False
            words = QUOTA_WORDS if quota else WORDS.get(status) or other_status_words(status)
            e = CallError(code, words, status, retry, retryable, billed=False,
                          excerpt=excerpt(data, self.holder) if data else None, transient=is_transient(status, quota))
            if self.latching and (status in BROKEN_STATUSES or quota
                                  or (status == 404 and (route in MODEL_ROUTES or code == 'model_not_found'))):
                self._trip(code, words)
                e.latched = True
            raise e
        self._clear()
        try:
            return status, json.loads(data.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise CallError('malformed', MALFORMED_WORDS, status, excerpt=excerpt(data, self.holder)) from None

    def post(self, route, body, deadline, sleep=time.sleep, clock=time.monotonic):
        """With the retry table. Returns (parsed JSON, attempts, ms)."""
        t0 = clock()
        attempt = 1
        while True:
            left = deadline - clock()
            if left <= 0:
                raise CallError('timeout', OUT_OF_TIME_WORDS, retryable=False, transient=True)
            try:
                _, j = self.post_once(route, body, min(config.CALL_TIMEOUT_S, left))
                return j, attempt, int((clock() - t0) * 1000)
            except CallError as e:
                e.attempt = attempt
                if attempt >= (3 if e.status == 429 else 2) or not e.retryable:
                    raise
                wait = e.retry_after if e.retry_after is not None else 0
                if e.status == 429 and e.retry_after is None:
                    wait = attempt  # 1 s, then 2 s
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
