"""Say it: a riddle answered by voice.

The page posts a short WAV clip; Meta's Muse Voice Transcribe writes it
down; code matches the transcript against the room's kept things. No model
judges the answer.
"""
import http.client
import json
import re
import socket
import struct
import threading
import time
from urllib.parse import urlsplit

from server import config
from server.config import KeyHolder, redact
from server.meta_api import (CallError, NEVER_RETRY, RETRY_STATUSES, WORDS,
                             excerpt, is_transient, next_utc_midnight,
                             other_status_words, retry_after_seconds)

ROUTE = '/asr/transcribe'

# 400, 406, 413 and 500 give words; 429 gives words that say to try again shortly.
VOICE_WORDS = {
    400: WORDS[400],
    406: 'The voice answer was not in a form the Model API accepts. Please try again from the page.',
    413: 'The voice clip was too large for the Model API. Please try a shorter clip.',
    429: 'The voice reader is busy. Please try again shortly.',
    500: WORDS[500],
}

RATES = (16000, 24000)

REFUSAL_VOICE_OFF = 'Say it is switched off on this server (FRAMEPLAY_VOICE is not yes). The sample rooms still work.'
REFUSAL_NOT_LIVE = 'This server is in MOCK mode, so it sends no voice anywhere. Play the sample rooms.'


def bad_wav():
    return ('The voice clip must be a short WAV: mono, 16-bit, 16000 or 24000 Hz, '
            f'at most {config.VOICE_MAX_SECONDS} seconds. Please try again from the page.')


def check_wav(data):
    """None when the clip may be sent; otherwise the refusal in words.

    Only RIFF/WAVE, PCM format 1, mono, 16-bit, 16000 or 24000 Hz, and a data
    length of at most VOICE_MAX_SECONDS. Read with the struct module; no
    outside library.
    """
    if not isinstance(data, (bytes, bytearray)) or len(data) < 44:
        return bad_wav()
    data = bytes(data)
    if data[0:4] != b'RIFF' or data[8:12] != b'WAVE':
        return bad_wav()
    try:
        (fmt_len,) = struct.unpack('<I', data[16:20])
        (audio, channels, rate, _byte_rate, _block, bits) = struct.unpack('<HHIIHH', data[20:36])
    except struct.error:
        return bad_wav()
    if data[12:16] != b'fmt ' or fmt_len < 16 or audio != 1 or channels != 1 or bits != 16 or rate not in RATES:
        return bad_wav()
    # the data chunk: the first chunk after fmt (extra fmt bytes skipped)
    off = 20 + fmt_len
    found = None
    end = len(data)
    while off + 8 <= end:
        tag, size = struct.unpack('<4sI', data[off:off + 8])
        if tag == b'data':
            found = (off + 8, size)
            break
        off += 8 + size
    if found is None:
        return bad_wav()
    start, size = found
    if start + size > end:
        return bad_wav()
    limit = config.VOICE_MAX_SECONDS * rate * 2
    if size == 0 or size > limit:
        return bad_wav()
    return None


_ARTICLES = {'a', 'an', 'the'}


def words_of(text):
    """Lower-cased words without punctuation or the articles a, an, the.
    A refrigerator is a fridge, so either word names it."""
    out = []
    for w in re.findall(r'[a-z0-9]+', str(text or '').lower()):
        if w in _ARTICLES:
            continue
        out.append('fridge' if w in ('refrigerator', 'refrigerators') else w)
    return out


def forms(word):
    """A word and its simple plural, so fridge matches fridges."""
    out = {word}
    if word.endswith('s') and len(word) > 3:
        out.add(word[:-1])
        if word.endswith('es') and len(word) > 4:
            out.add(word[:-2])
    else:
        out.add(word + 's')
        out.add(word + 'es')
    return out


def match_answer(transcript, things):
    """Against the room's kept things (dicts with id and name).

    Exactly one thing named gives its id; none or two give None and words.
    No model judges the answer.
    """
    said = set(words_of(transcript))
    hit = []
    for t in things or []:
        name = words_of((t or {}).get('name'))
        if not name:
            continue
        if any(f in said for w in name for f in forms(w)):
            hit.append(t.get('id'))
    if len(hit) == 1:
        return hit[0], 'That names the right thing.'
    if not said:
        return None, 'Nothing was heard. Please say it again from the page.'
    if len(hit) > 1:
        return None, 'That names more than one thing. Please say just one.'
    return None, 'That does not name any of the kept things. Please try again from the page.'


def request_json(names):
    return {'model': config.VOICE_MODEL, 'audioEncoding': 'WAV', 'mode': 'PUSH_TO_TALK',
            'keywords': list(names or []), 'languageBias': ['English']}


def build_multipart(request_obj, wav):
    """Exactly two parts: 'request' JSON and 'audio' WAV bytes."""
    boundary = 'frameplay-voice-%d' % (time.monotonic_ns() % 1_000_000)
    req = json.dumps(request_obj).encode('utf-8')
    parts = [
        b'--' + boundary.encode('ascii') + b'\r\n'
        b'Content-Disposition: form-data; name="request"\r\n'
        b'Content-Type: application/json\r\n\r\n' + req + b'\r\n',
        b'--' + boundary.encode('ascii') + b'\r\n'
        b'Content-Disposition: form-data; name="audio"; filename="clip.wav"\r\n'
        b'Content-Type: audio/wav\r\n\r\n' + bytes(wav) + b'\r\n',
        b'--' + boundary.encode('ascii') + b'--\r\n',
    ]
    return b''.join(parts), 'multipart/form-data; boundary=' + boundary


def voice_cost(seconds):
    """The price of audio at $0.18 per hour."""
    return max(0.0, float(seconds)) * config.PRICE_VOICE_HOUR


def voice_worst():
    """The reservation: VOICE_MAX_SECONDS of audio at the hourly price."""
    return config.VOICE_MAX_SECONDS * config.PRICE_VOICE_HOUR


class VoiceTransport:
    """The multipart post beside meta_api's JSON transport: reuses its key
    handling, timeouts and error words; the photo path is untouched."""

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
        self.connect = connect

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

    def post_once(self, payload, content_type, timeout):
        """One multipart request. Returns (status, parsed JSON). Raises CallError."""
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
            conn.request('POST', self.path + ROUTE, body=payload, headers={
                'Authorization': self._auth(),
                'Content-Type': content_type,
                'Accept': 'application/json',
                'User-Agent': 'FRAMEPLAY/2',
            })
            r = conn.getresponse()
            status = r.status
            retry = retry_after_seconds(r.getheader('Retry-After'))
            if 300 <= status < 400:
                raise CallError('redirect', 'The Model API answered with a redirect, which this app never follows. Please try again later.', status)
            cap = config.MAX_ANSWER_BYTES if status < 400 else config.MAX_ERROR_BYTES
            data = r.read(cap + 1)
            if len(data) > cap:
                raise CallError('too_large', "The Model API's answer was larger than this app allows. Please try another photo.", status)
        except CallError:
            raise
        except (OSError, http.client.HTTPException, ValueError) as e:
            if fired.is_set() or isinstance(e, TimeoutError):
                raise CallError('timeout', 'The Model API did not answer in time. Please try the same voice clip again.', retryable=True, transient=True) from None
            raise CallError('network', 'The Model API could not be reached (a network error). Please try the same voice clip again.', retryable=True, excerpt=type(e).__name__, transient=True) from None
        finally:
            timer.cancel()
            try:
                conn.close()
            except OSError:
                pass
        if status >= 400:
            try:
                err = json.loads(data.decode('utf-8'))
                code = (err.get('error') or {}).get('code') if isinstance(err, dict) else None
                code = code if isinstance(code, str) and len(code) <= 64 else f'http_{status}'
            except (UnicodeDecodeError, ValueError):
                code = f'http_{status}'
            retryable = status in RETRY_STATUSES or (status == 503 and retry is not None and retry <= 3)
            if status in NEVER_RETRY:
                retryable = False
            words = VOICE_WORDS.get(status) or WORDS.get(status) or other_status_words(status)
            raise CallError(code, words, status, retry, retryable, billed=False,
                            excerpt=excerpt(data, self.holder) if data else None, transient=is_transient(status))
        try:
            return status, json.loads(data.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise CallError('malformed', "The Model API's answer could not be read. Please try the same voice clip again.", status, excerpt=excerpt(data, self.holder)) from None

    def transcribe(self, wav, names, deadline, sleep=time.sleep, clock=time.monotonic):
        """With the retry table: a 429 (not quota) is sent up to three times.
        Returns (parsed JSON, attempts, ms)."""
        request_obj = request_json(names)
        payload, content_type = build_multipart(request_obj, wav)
        per_call = config.VOICE_TIMEOUT_S
        t0 = clock()
        attempt = 1
        while True:
            left = deadline - clock()
            if left <= 0:
                raise CallError('timeout', 'The voice clip ran out of time before its answer came back. Please try the same voice clip again.', retryable=False, transient=True)
            try:
                _, j = self.post_once(payload, content_type, min(per_call, left))
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


def transcript_of(answer):
    """The transcript of the answer JSON {"sessionId", "transcript",
    "audioDurationMs", "turns"}, or '' when it cannot be read."""
    if isinstance(answer, dict) and isinstance(answer.get('transcript'), str):
        return answer['transcript']
    return ''


def duration_s(answer, wav=None, rate=None):
    """Seconds of audio: the answer's audioDurationMs when usable, else the
    WAV's own length."""
    try:
        ms = (answer or {}).get('audioDurationMs')
        if ms is not None and float(ms) >= 0:
            return float(ms) / 1000.0
    except (TypeError, ValueError):
        pass
    if wav is not None and rate:
        try:
            return len(bytes(wav)) / (float(rate) * 2)
        except (TypeError, ValueError):
            pass
    return config.VOICE_MAX_SECONDS


def words_for_error(e):
    """The refusal in words for a failed transcribe call."""
    return str(e)
