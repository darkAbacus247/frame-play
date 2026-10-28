"""Ceilings: photos in flight at once and photos an hour (config.IN_FLIGHT and
config.PER_HOUR), the day's cap (200 by default),
and a hard stop at the day's estimated spend ($5 by default, never more).
In LIVE each client also has its own photos an hour and a day
(config.CLIENT_PER_HOUR and config.CLIENT_PER_DAY), on top of the server's:
one visitor cannot use up the day for everyone.
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


class Admission:
    """A photo taken in: when it was counted in the hour and the day, so a
    photo that sends nothing can give its place back (uncount)."""
    __slots__ = ('t', 'day', 'counted')

    def __init__(self, t, day):
        self.t = t
        self.day = day
        self.counted = True


class Limits:
    def __init__(self, day_cap=config.PER_DAY, usd_stop=config.USD_STOP, clock=time.time,
                 in_flight=config.IN_FLIGHT, per_hour=config.PER_HOUR, clients=True,
                 client_hour=config.CLIENT_PER_HOUR, client_day=config.CLIENT_PER_DAY):
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
        # per client: [the times of its photos this hour, its photos today];
        # None when clients are not counted (MOCK, REHEARSAL)
        self.clients = {} if clients else None
        self.client_hour = min(client_hour, config.CLIENT_PER_HOUR)
        self.client_day = min(client_day, config.CLIENT_PER_DAY)

    def _roll(self, now):
        d = _utc_day(now)
        if d != self.day:
            self.day = d
            self.photos_today = 0
            self.spent = 0.0
            if self.clients:
                for key, c in list(self.clients.items()):
                    self._trim(c[0], now)
                    if c[0]:
                        c[1] = 0
                    else:
                        del self.clients[key]
        self._trim(self.hour, now)

    @staticmethod
    def _trim(times, now):
        while times and now - times[0] >= 3600:
            times.popleft()

    def _to_midnight(self, now):
        return int((self.day + 1) * 86400 - now) + 1

    def admit(self, client=None):
        """Take a photo in, or raise a Refusal. Pair with finish(). A photo
        whose first call could not be reserved is refused here, before it
        counts in the hour or the day. client: who sent it (an opaque key),
        held to its own hour and day when clients are counted."""
        with self.lock:
            now = self.clock()
            self._roll(now)
            if self.spent + self.reserved + SPARK_WORST > self.usd_stop + 1e-12:
                raise Refusal('spend_stop', f'This server has reached its spending stop for today (${self.usd_stop:.2f} estimated). Please try again tomorrow, or play the sample rooms.', self._to_midnight(now))
            if self.in_flight >= self.max_in_flight:
                raise Refusal('busy', 'Every reader on this server is busy with other photos. Please try again in a few seconds.', 5)
            mine = self.clients.get(client) if self.clients is not None and client is not None else None
            if mine is not None:
                self._trim(mine[0], now)
                if len(mine[0]) >= self.client_hour:
                    wait = int(3600 - (now - mine[0][0])) + 1
                    raise Refusal('client_hour_cap', f'This server has read {self.client_hour} photos from you in the last hour. Please try again later, or play the sample rooms.', wait)
                if mine[1] >= self.client_day:
                    raise Refusal('client_day_cap', f'This server has read {self.client_day} photos from you today. Please try again tomorrow, or play the sample rooms.', self._to_midnight(now))
            if len(self.hour) >= self.per_hour:
                wait = int(3600 - (now - self.hour[0])) + 1
                raise Refusal('hour_cap', f'This server has read {self.per_hour} photos in the last hour. Please try again later.', wait)
            if self.photos_today >= self.day_cap:
                raise Refusal('day_cap', f'This server has read its {self.day_cap} photos for today. Please try again tomorrow.', self._to_midnight(now))
            self.in_flight += 1
            self.hour.append(now)
            self.photos_today += 1
            if self.clients is not None and client is not None:
                mine = self.clients.setdefault(client, [deque(), 0])
                mine[0].append(now)
                mine[1] += 1
            return Admission(now, self.day)

    def uncount(self, adm):
        """A photo that sent nothing (refused at the spending stop by a call
        racing it): it uses none of the server's hour or day. Its client's
        own count stays: each photo a client sends counts for it."""
        with self.lock:
            if adm is None or not adm.counted:
                return
            adm.counted = False
            try:
                self.hour.remove(adm.t)
            except ValueError:
                pass  # already out of the hour
            if adm.day == self.day:
                self.photos_today = max(0, self.photos_today - 1)

    def cancel(self, adm):
        """A photo let in that never reached a reader (its upload did not
        arrive whole, or it was no photo): its place is free again and it
        uses none of the server's hour or day."""
        self.uncount(adm)
        with self.lock:
            self.in_flight = max(0, self.in_flight - 1)

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
