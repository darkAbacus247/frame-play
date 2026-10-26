import threading
import unittest

from server.limits import SAM_COST, SPARK_WORST, Limits, Refusal


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class Ceilings(unittest.TestCase):
    def test_in_flight(self):
        lim = Limits(clock=Clock())
        lim.admit()
        lim.admit()
        with self.assertRaises(Refusal) as c:
            lim.admit()
        self.assertEqual(c.exception.code, 'busy')
        self.assertTrue(c.exception.retry_after)
        lim.finish()
        lim.admit()

    def test_per_hour_and_per_day(self):
        clock = Clock(1_800_000_000.0 - (1_800_000_000.0 % 86400) + 3600)  # 01:00 UTC
        lim = Limits(clock=clock)
        for _ in range(40):
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

    def test_counters(self):
        lim = Limits(clock=Clock())
        lim.admit()
        c = lim.counters()
        self.assertEqual((c['photos_in_flight'], c['photos_this_hour'], c['photos_today']), (1, 1, 1))


if __name__ == '__main__':
    unittest.main()
