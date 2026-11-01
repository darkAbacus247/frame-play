import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path

from server import config
from server.limits import SAM_COST, SPARK_WORST, Limits, Refusal


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class Ceilings(unittest.TestCase):
    def test_in_flight(self):
        lim = Limits(clock=Clock())
        self.assertEqual(config.IN_FLIGHT, 4)
        for _ in range(config.IN_FLIGHT):
            lim.admit()
        with self.assertRaises(Refusal) as c:
            lim.admit()
        self.assertEqual(c.exception.code, 'busy')
        self.assertTrue(c.exception.retry_after)
        # the busy words name no count (the ceiling is the server's to set)
        self.assertNotRegex(c.exception.message, r'\d|\b(two|three|four)\b')
        lim.finish()
        lim.admit()

    def test_per_hour_and_per_day(self):
        clock = Clock(1_800_000_000.0 - (1_800_000_000.0 % 86400) + 3600)  # 01:00 UTC
        lim = Limits(clock=clock)
        self.assertEqual(config.PER_HOUR, 120)
        for _ in range(config.PER_HOUR):
            lim.admit()
            lim.finish()
        with self.assertRaises(Refusal) as c:
            lim.admit()
        self.assertEqual(c.exception.code, 'hour_cap')
        clock.t += 3601
        lim.admit()
        lim.finish()
        small = Limits(day_cap=3, clock=clock)
        for _ in range(3):
            small.admit()
            small.finish()
        with self.assertRaises(Refusal) as c:
            small.admit()
        self.assertEqual(c.exception.code, 'day_cap')
        clock.t += 86400
        small.admit()

    def test_each_client_has_its_own_hour_and_day(self):
        clock = Clock(1_800_000_000.0 - (1_800_000_000.0 % 86400) + 3600)  # 01:00 UTC
        lim = Limits(clock=clock)
        # a judging panel behind one office or VPN address is one client, so
        # its caps give it room; the server's own ceilings still bound the spend
        self.assertEqual((config.CLIENT_PER_HOUR, config.CLIENT_PER_DAY), (12, 40))
        hour, day = config.CLIENT_PER_HOUR, config.CLIENT_PER_DAY
        for _ in range(hour):
            lim.uploaded(lim.admit('a'))  # its body read, as the server does
            lim.finish()
        with self.assertRaises(Refusal) as c:
            lim.admit('a')
        self.assertEqual(c.exception.code, 'client_hour_cap')
        # the refusal names the address, not the person, and keeps the ways on
        self.assertEqual(c.exception.message, f'This server has read {hour} photos from your address in the last hour '
                         '(visitors who share one address share this). Try again later, play the sample rooms, or mark the room yourself.')
        self.assertGreater(c.exception.retry_after, 3500)
        lim.admit('b')  # another client is not held by the first one's photos
        lim.finish()
        taken = hour
        while taken < day:
            clock.t += 3601
            for _ in range(min(hour, day - taken)):
                lim.uploaded(lim.admit('a'))
                lim.finish()
                taken += 1
        with self.assertRaises(Refusal) as c:
            lim.admit('a')
        self.assertEqual(c.exception.code, 'client_day_cap')
        self.assertEqual(c.exception.message, f'This server has read {day} photos from your address today '
                         '(visitors who share one address share this). Try again tomorrow, play the sample rooms, or mark the room yourself.')
        self.assertEqual(lim.counters()['photos_today'], day + 1, 'the server counts every client')
        clock.t += 86400  # a new UTC day
        lim.admit('a')
        # the server's own ceilings stay behind: they hold every client together
        small = Limits(day_cap=2, clock=clock)
        small.admit('a')
        small.finish()
        small.admit('b')
        small.finish()
        with self.assertRaises(Refusal) as c:
            small.admit('c')
        self.assertEqual(c.exception.code, 'day_cap')
        # not counted (MOCK, REHEARSAL), or no client given: only the server's ceilings
        off = Limits(clock=clock, clients=False)
        for _ in range(hour + 1):
            off.admit('a')
            off.finish()
        self.assertEqual(Limits(client_hour=50, client_day=50).client_hour, hour, 'a setting never raises a ceiling')

    def test_a_client_uploads_one_photo_at_a_time(self):
        lim = Limits()
        adm = lim.admit('a')
        with self.assertRaises(Refusal) as c:
            lim.admit('a')  # its first photo's body is still coming in
        self.assertEqual((c.exception.code, c.exception.retry_after), ('busy', 5))
        self.assertIn('from you', c.exception.message)
        self.assertEqual(lim.counters()['photos_in_flight'], 1, 'the refused one took no place')
        other = lim.admit('b')  # another client is not held by it
        lim.uploaded(adm)
        lim.uploaded(adm)  # twice is harmless
        lim.uploaded(lim.admit('a'))  # once read, the client may upload another
        lim.cancel(other)  # a photo given up frees its client too
        lim.uploaded(lim.admit('b'))
        # not counted (MOCK, REHEARSAL): no client is held
        off = Limits(clients=False)
        off.admit('a')
        off.admit('a')

    def test_settings_never_raise_a_ceiling(self):
        lim = Limits(day_cap=10_000, usd_stop=999)
        self.assertEqual((lim.day_cap, lim.usd_stop), (200, 5.0))

    def test_the_spend_stop_holds_against_racing_calls(self):
        lim = Limits(usd_stop=0.1, clock=Clock())
        ok, refused = [], []
        barrier = threading.Barrier(16)

        def call():
            barrier.wait()
            for _ in range(10):
                try:
                    r = lim.reserve(SAM_COST)
                    ok.append(r)
                except Refusal:
                    refused.append(1)
        threads = [threading.Thread(target=call) for _ in range(16)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(ok), int(0.1 / SAM_COST + 1e-9))
        self.assertLessEqual(lim.reserved, 0.1 + 1e-9)
        for r in ok:
            lim.settle(r, SAM_COST)
        with self.assertRaises(Refusal) as c:
            lim.admit()
        self.assertEqual(c.exception.code, 'spend_stop')

    def test_a_photo_refused_at_the_stop_uses_no_hour_or_day(self):
        # the rehearsal run's figures: $0.097 of a $0.12 stop leaves less than the read's worst
        lim = Limits(usd_stop=0.12, clock=Clock())
        r = lim.reserve(0.097)
        lim.settle(r, 0.097)
        for _ in range(3):
            with self.assertRaises(Refusal) as c:
                lim.admit()
            self.assertEqual(c.exception.code, 'spend_stop')
        c = lim.counters()
        self.assertEqual((c['photos_in_flight'], c['photos_this_hour'], c['photos_today']), (0, 0, 0))
        # a photo let in, then refused at its first call by a call racing it, gives its place back
        lim = Limits(clock=Clock())
        adm = lim.admit()
        lim.uncount(adm)
        lim.uncount(adm)  # once only
        lim.finish()
        c = lim.counters()
        self.assertEqual((c['photos_in_flight'], c['photos_this_hour'], c['photos_today']), (0, 0, 0))

    def test_reservations_settle_and_release(self):
        lim = Limits(clock=Clock())
        r = lim.reserve(SPARK_WORST)
        self.assertAlmostEqual(lim.counters()['estimated_usd_today'], round(SPARK_WORST, 4))
        lim.settle(r, 0.01)
        self.assertAlmostEqual(lim.spent, 0.01)
        lim.settle(r, 5)  # settling twice changes nothing
        self.assertAlmostEqual(lim.spent, 0.01)
        r2 = lim.reserve(SAM_COST)
        lim.release(r2)
        self.assertAlmostEqual(lim.reserved, 0.0)
        lost = lim.reserve(SAM_COST)
        lim.settle(lost, None)  # an answer that was lost stays counted
        self.assertAlmostEqual(lim.spent, 0.01 + SAM_COST)

    def test_a_call_sent_again_is_counted_each_time(self):
        lim = Limits(clock=Clock())
        lim.settle(lim.reserve(SAM_COST), SAM_COST, sends=3)
        self.assertAlmostEqual(lim.spent, 3 * SAM_COST)
        self.assertEqual(lim.calls, 3)
        # an error after two sends: the earlier one may be billed; the last as its answer says
        self.assertAlmostEqual(lim.failed(lim.reserve(SAM_COST), billed=False, sends=2), SAM_COST)
        self.assertAlmostEqual(lim.failed(lim.reserve(SAM_COST), billed=True, sends=2), 2 * SAM_COST)
        self.assertAlmostEqual(lim.failed(lim.reserve(SAM_COST), billed=False), 0.0)
        self.assertAlmostEqual(lim.spent, 6 * SAM_COST)
        self.assertAlmostEqual(lim.reserved, 0.0)
        self.assertEqual(lim.calls, 6, 'a last send refused before any work is not counted')

    def test_the_day_s_spend_is_kept_in_a_file_keyed_by_the_utc_day(self):
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, True)
        store = folder / 'spend.json'
        clock = Clock(1_800_000_000.0 - (1_800_000_000.0 % 86400) + 3600)  # 01:00 UTC
        lim = Limits(clock=clock, store=store)
        lim.admit('a')
        lim.settle(lim.reserve(SAM_COST), SAM_COST)
        open_one = lim.reserve(SPARK_WORST)  # still open when the server stops
        rec = json.loads(store.read_text(encoding='utf-8'))
        self.assertEqual(rec, {'utc_day': '2027-01-15', 'estimated_usd': round(SAM_COST + SPARK_WORST, 6), 'photos_today': 1})
        self.assertTrue(open_one.open)
        # a restart of the same server reads it: what was open may be billed, so it counts
        again = Limits(clock=clock, store=store)
        self.assertAlmostEqual(again.spent, SAM_COST + SPARK_WORST)
        self.assertEqual(again.counters()['photos_today'], 1)
        again.settle(again.reserve(SAM_COST), SAM_COST)
        self.assertAlmostEqual(json.loads(store.read_text(encoding='utf-8'))['estimated_usd'], round(2 * SAM_COST + SPARK_WORST, 6))
        # a new UTC day starts from zero
        clock.t += 86400
        self.assertEqual((Limits(clock=clock, store=store).spent, Limits(clock=clock, store=store).photos_today), (0.0, 0))
        # an unreadable file starts from zero; a folder that cannot be written keeps the count in memory
        store.write_text('not json', encoding='utf-8')
        self.assertEqual(Limits(clock=clock, store=store).spent, 0.0)
        bad = Limits(clock=clock, store=folder / 'spend.json' / 'inside-a-file.json')
        bad.settle(bad.reserve(SAM_COST), SAM_COST)
        self.assertAlmostEqual(bad.spent, SAM_COST)

    def test_counters(self):
        lim = Limits(clock=Clock())
        lim.admit()
        c = lim.counters()
        self.assertEqual((c['photos_in_flight'], c['photos_this_hour'], c['photos_today']), (1, 1, 1))


if __name__ == '__main__':
    unittest.main()
