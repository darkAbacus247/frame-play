"""Settings, modes, ceilings and the key holder.

The server runs in one of three modes:
- mock: the default, whenever the key or the live switch is missing;
- live: MODEL_API_KEY is present and FRAMEPLAY_LIVE is exactly "yes";
- rehearsal: --rehearse http://127.0.0.1:PORT/v1, a loopback stand-in with a
  fixed dummy credential; it refuses to start if either live variable is set.

The operator sets the live variables in their own environment. This module
reads them from a mapping it is given (os.environ when the server starts),
keeps the key in a holder that never prints, and never writes it anywhere.
"""
import ipaddress
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

API_BASE = 'https://api.meta.ai/v1'
SPARK_MODEL = 'muse-spark-1.3'
SAM_MODEL = 'sam-3.1'
MODELS = (SPARK_MODEL, SAM_MODEL)

# Caps and ceilings. They are fixed: a setting can lower them, never raise them.
MAX_BODY = 4 * 1024 * 1024
MAX_SIDE = 4096
MAX_ANSWER_BYTES = 8 * 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024
CALL_TIMEOUT_S = 20.0
PHOTO_TIMEOUT_S = 60.0
SPARK_CALLS_PER_PHOTO = 1
SAM_CALLS_PER_PHOTO = 9
IN_FLIGHT = 2
PER_HOUR = 40
PER_DAY = 200
USD_STOP = 5.0
SPARK_MAX_COMPLETION_TOKENS = 2400

# Published prices (Standard): muse-spark-1.3 $1.25 per 1M input tokens and
# $4.25 per 1M output tokens, reasoning included; sam-3.1 $2.50 per 1,000 images.
PRICE_SPARK_IN = 1.25 / 1_000_000
PRICE_SPARK_OUT = 4.25 / 1_000_000
PRICE_SAM_IMAGE = 2.50 / 1000
# The worst case a Spark call is reserved at before it is sent: a generous
# input bound for one image and the instruction, plus the output ceiling.
SPARK_WORST_IN_TOKENS = 12_000

REHEARSAL_CREDENTIAL = 'rehearsal-dummy-credential'

LABELS = {
    'mock': 'Sample room · MOCK · drawn by code; no model was called',
    'live': 'LIVE · Meta Model API · muse-spark-1.3 and sam-3.1',
    'rehearsal': 'REHEARSAL · local stand-in, not Meta',
}

OUTLINE_SOURCE = 'traced_in_box'


class ConfigError(Exception):
    """The server refuses to start, with the reason in words."""


class KeyHolder:
    """Holds the key. Its text forms say "never shown"; it cannot be copied,
    pickled or formatted out. Only the transport asks it for a header."""

    __slots__ = ('_value',)

    def __init__(self, value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError('empty key')
        object.__setattr__(self, '_value', value.strip())

    def __setattr__(self, name, value):
        raise AttributeError('the key holder is read-only')

    def __repr__(self):
        return 'KeyHolder(never shown)'

    __str__ = __repr__

    def __format__(self, spec):
        return 'KeyHolder(never shown)'

    def __reduce__(self):
        raise TypeError('the key cannot be copied out')

    def __reduce_ex__(self, protocol):
        raise TypeError('the key cannot be copied out')

    def __copy__(self):
        raise TypeError('the key cannot be copied out')

    def __deepcopy__(self, memo):
        raise TypeError('the key cannot be copied out')

    def __eq__(self, other):
        return self is other

    __hash__ = object.__hash__

    def authorization(self):
        return 'Bearer ' + self._value

    def redact(self, text):
        return text.replace(self._value, '[redacted]') if self._value in text else text


_BEARER = re.compile(r'(?i)(bearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/=\-]+')  # RFC 6750 token characters
_KEYISH = re.compile(r'[A-Za-z0-9_\-]{32,}')
_HEX = re.compile(r'[0-9a-f]+')


def _keyish(m):
    s = m.group(0)
    # sha256 digests and request ids are lowercase hex: those stay
    return s if _HEX.fullmatch(s) else '[redacted]'


def redact(text, holder=None):
    """Remove the key and anything shaped like a key from a log line or reply."""
    if not isinstance(text, str):
        text = str(text)
    if holder is not None:
        text = holder.redact(text)
    text = _BEARER.sub(r'\1[redacted]', text)
    return _KEYISH.sub(_keyish, text)


def loopback_base(url):
    """A rehearsal address: http:// on a loopback IP, with a port and a path,
    no name, no credentials, no query. Returns it without a trailing slash."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port
    except ValueError as e:
        raise ConfigError(f'The rehearsal address cannot be read: {e}') from None
    if parts.scheme != 'http':
        raise ConfigError('The rehearsal address must start with http://')
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ConfigError('The rehearsal address may not carry a name, a password, a query or a fragment')
    try:
        ip = ipaddress.ip_address(host or '')
    except ValueError:
        raise ConfigError('The rehearsal address must be a loopback IP such as 127.0.0.1, never a name') from None
    if not ip.is_loopback:
        raise ConfigError('The rehearsal address must be on this machine (a loopback IP)')
    if not port:
        raise ConfigError('The rehearsal address needs a port')
    netloc = f'[{ip}]:{port}' if ip.version == 6 else f'{ip}:{port}'
    return f'http://{netloc}{parts.path.rstrip("/")}'


CONTRIBUTOR = '-contri' + 'butor'  # split so that no file names a Contributor model


def check_models(ids):
    """Standard mode only: refuse any model id naming a Contributor model."""
    for m in ids:
        if CONTRIBUTOR in m.lower():
            raise ConfigError(f'Refusing to start: {m} is not a Standard model id')


def _lowered(environ, name, ceiling, cast):
    raw = environ.get(name)
    if raw is None or raw == '':
        return ceiling
    try:
        v = cast(raw)
    except ValueError:
        raise ConfigError(f'{name} must be a number from 0 to {ceiling}') from None
    if v < 0 or v != v:
        raise ConfigError(f'{name} must be a number from 0 to {ceiling}')
    return min(v, ceiling)


@dataclass
class Settings:
    mode: str
    reason: str
    key: object = field(default=None, repr=False)
    base: str = API_BASE
    day_cap: int = PER_DAY
    usd_stop: float = USD_STOP
    rehearsal_room: str = ''
    key_present: bool = False

    @property
    def label(self):
        return LABELS[self.mode]

    def credential(self):
        if self.mode == 'live':
            return self.key
        if self.mode == 'rehearsal':
            return REHEARSAL_CREDENTIAL
        return None


def settings_from(environ, rehearse=None, rehearsal_room='desk'):
    """Decide the mode from an environment mapping and the --rehearse flag."""
    check_models(MODELS)
    day_cap = int(_lowered(environ, 'FRAMEPLAY_DAY_CAP', PER_DAY, int))
    usd_stop = float(_lowered(environ, 'FRAMEPLAY_USD_STOP', USD_STOP, float))
    has_key = bool((environ.get('MODEL_API_KEY') or '').strip())
    live_on = environ.get('FRAMEPLAY_LIVE') == 'yes'
    if rehearse is not None:
        if 'MODEL_API_KEY' in environ or 'FRAMEPLAY_LIVE' in environ:
            raise ConfigError('Refusing to rehearse: MODEL_API_KEY or FRAMEPLAY_LIVE is set. Rehearsal never holds a key.')
        if not re.fullmatch(r'[a-z0-9_-]{1,32}', rehearsal_room or ''):
            raise ConfigError('The rehearsal room must be a sample room id')
        return Settings('rehearsal', 'Rehearsing against a local stand-in, not Meta. No key is held.',
                        None, loopback_base(rehearse), day_cap, usd_stop, rehearsal_room)
    if has_key and live_on:
        return Settings('live', 'The key is present and FRAMEPLAY_LIVE is yes.',
                        KeyHolder(environ['MODEL_API_KEY']), API_BASE, day_cap, usd_stop, '', True)
    if has_key:
        why = 'The key is present but FRAMEPLAY_LIVE is not yes, so no model is called.'
    elif live_on:
        why = 'FRAMEPLAY_LIVE is yes but there is no key, so no model is called.'
    else:
        why = 'No key and no live switch: sample rooms only, no model is called.'
    return Settings('mock', why, None, API_BASE, day_cap, usd_stop, '', has_key)
