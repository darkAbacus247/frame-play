"""Ceilings: 2 photos in flight, 40 an hour, the day's cap (200 by default),
and a hard stop at the day's estimated spend ($5 by default, never more).
Each call reserves its worst-case cost under one lock before it is sent, so
calls racing each other cannot pass the stop together. The counters live in
memory: a restart clears them, so the account's own spend notification is
the first line of defence and these are the second."""
import threading
import time
from collections import deque

from server import config


class Refusal(Exception):
    """Past a ceiling: a refusal in words, with how long to wait."""

    def __init__(self, code, message, retry_after=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after = retry_after


def _utc_day(t):
    return int(t // 86400)


class Reservation:
    __slots__ = ('usd', 'open')

    def __init__(self, usd):
        self.usd = usd
        self.open = True


class Limits:
    def __init__(self, day_cap=config.PER_DAY, usd_stop=config.USD_STOP, clock=time.time,
                 in_flight=config.IN_FLIGHT, per_hour=config.PER_HOUR):
        self.lock = threading.Lock()
        self.clock = clock
        self.day_cap = min(day_cap, config.PER_DAY)
        self.usd_stop = min(usd_stop, config.USD_STOP)
        self.max_in_flight = min(in_flight, config.IN_FLIGHT)
        self.per_hour = min(per_hour, config.PER_HOUR)
        self.in_flight = 0
        self.hour = deque()
        self.day = _utc_day(clock())
        self.photos_today = 0
        self.spent = 0.0      # settled estimates today
        self.reserved = 0.0   # reservations still open
        self.calls = 0
        self.answered = 0

    def _roll(self, now):
        d = _utc_day(now)
        if d != self.day:
            self.day = d
            self.photos_today = 0
            self.spent = 0.0
        while self.hour and now - self.hour[0] >= 3600:
            self.hour.popleft()

    def _to_midnight(self, now):
        return int((self.day + 1) * 86400 - now) + 1

    def admit(self):
        """Take a photo in, or raise a Refusal. Pair with finish()."""
        with self.lock:
            now = self.clock()
            self._roll(now)
            if self.spent + self.reserved >= self.usd_stop:
                raise Refusal('spend_stop', f'This server has reached its spending stop for today (${self.usd_stop:.2f} estimated). Please try again tomorrow, or play the sample rooms.', self._to_midnight(now))
            if self.in_flight >= self.max_in_flight:
                raise Refusal('busy', 'Two photos are already being read. Please try again in a few seconds.', 5)
            if len(self.hour) >= self.per_hour:
                wait = int(3600 - (now - self.hour[0])) + 1
                raise Refusal('hour_cap', f'This server has read {self.per_hour} photos in the last hour. Please try again later.', wait)
            if self.photos_today >= self.day_cap:
                raise Refusal('day_cap', f'This server has read its {self.day_cap} photos for today. Please try again tomorrow.', self._to_midnight(now))
            self.in_flight += 1
            self.hour.append(now)
            self.photos_today += 1
            return True

    def finish(self):
        with self.lock:
            self.in_flight = max(0, self.in_flight - 1)
            self.answered += 1

    def reserve(self, usd):
        """Reserve a call's worst-case cost before it is sent, or refuse."""
        with self.lock:
            self._roll(self.clock())
            if self.spent + self.reserved + usd > self.usd_stop + 1e-12:
                raise Refusal('spend_stop', f'This server has reached its spending stop for today (${self.usd_stop:.2f} estimated).', self._to_midnight(self.clock()))
            self.reserved += usd
            self.calls += 1
            return Reservation(usd)

    def settle(self, res, actual_usd):
        """The reservation becomes the call's actual estimate. A call whose
        answer was lost stays counted at its reservation (it may be billed)."""
        with self.lock:
            if not res.open:
                return
            res.open = False
            self.reserved = max(0.0, self.reserved - res.usd)
            self.spent += res.usd if actual_usd is None else max(0.0, actual_usd)

    def release(self, res):
        """A call refused before any work: nothing was billed."""
        with self.lock:
            if not res.open:
                return
            res.open = False
            self.reserved = max(0.0, self.reserved - res.usd)
            self.calls = max(0, self.calls - 1)

    def counters(self):
        with self.lock:
            self._roll(self.clock())
            return {
                'photos_in_flight': self.in_flight,
                'photos_this_hour': len(self.hour),
                'photos_today': self.photos_today,
                'photos_answered': self.answered,
                'calls_sent': self.calls,
                'estimated_usd_today': round(self.spent + self.reserved, 4),
            }


def spark_cost(tokens_in, tokens_out):
    return tokens_in * config.PRICE_SPARK_IN + tokens_out * config.PRICE_SPARK_OUT


SPARK_WORST = spark_cost(config.SPARK_WORST_IN_TOKENS, config.SPARK_MAX_COMPLETION_TOKENS)
SAM_COST = config.PRICE_SAM_IMAGE
