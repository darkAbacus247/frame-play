import copy
import pickle
import unittest
from pathlib import Path

from server import config
from server.config import ConfigError, KeyHolder, loopback_base, redact, settings_from

# A stand-in value for tests only. It is not a key and is never sent anywhere
# but a loopback test server.
TEST_VALUE = 'TESTONLY-not-a-key-0123456789abcdefXYZ'


class Modes(unittest.TestCase):
    def test_mock_by_default_with_the_reason(self):
        s = settings_from({})
        self.assertEqual(s.mode, 'mock')
        self.assertIn('No key', s.reason)
        self.assertIsNone(s.key)
        self.assertEqual(settings_from({'FRAMEPLAY_LIVE': 'yes'}).mode, 'mock')
        only_key = settings_from({'MODEL_API_KEY': TEST_VALUE})
        self.assertEqual(only_key.mode, 'mock')
        self.assertTrue(only_key.key_present)
        self.assertIsNone(only_key.key, 'mock mode holds no key at all')
        self.assertEqual(settings_from({'MODEL_API_KEY': TEST_VALUE, 'FRAMEPLAY_LIVE': 'YES'}).mode, 'mock', 'only the exact word yes')

    def test_live_needs_both(self):
        s = settings_from({'MODEL_API_KEY': TEST_VALUE, 'FRAMEPLAY_LIVE': 'yes'})
        self.assertEqual(s.mode, 'live')
        self.assertIsInstance(s.key, KeyHolder)
        self.assertEqual(s.base, 'https://api.meta.ai/v1')
        self.assertNotIn(TEST_VALUE, repr(s))

    def test_rehearsal_refuses_any_live_variable(self):
        s = settings_from({}, 'http://127.0.0.1:8192/v1', 'living')
        self.assertEqual((s.mode, s.base, s.rehearsal_room), ('rehearsal', 'http://127.0.0.1:8192/v1', 'living'))
        self.assertEqual(s.credential(), config.REHEARSAL_CREDENTIAL)
        for env in ({'MODEL_API_KEY': ''}, {'FRAMEPLAY_LIVE': 'no'}):
            with self.assertRaises(ConfigError):
                settings_from(env, 'http://127.0.0.1:8192/v1')

    def test_loopback_only(self):
        self.assertEqual(loopback_base('http://127.0.0.1:9/v1/'), 'http://127.0.0.1:9/v1')
        self.assertEqual(loopback_base('http://[::1]:9/v1'), 'http://[::1]:9/v1')
        for bad in ('https://127.0.0.1:9/v1', 'http://localhost:9/v1', 'http://10.0.0.2:9/v1',
                    'http://api.meta.ai/v1', 'http://u:p@127.0.0.1:9/v1', 'http://127.0.0.1:9/v1?x=1', 'http://127.0.0.1/v1'):
            with self.assertRaises(ConfigError, msg=bad):
                loopback_base(bad)

    def test_settings_lower_ceilings_never_raise_them(self):
        s = settings_from({'FRAMEPLAY_DAY_CAP': '5000', 'FRAMEPLAY_USD_STOP': '50'})
        self.assertEqual((s.day_cap, s.usd_stop), (200, 5.0))
        s = settings_from({'FRAMEPLAY_DAY_CAP': '10', 'FRAMEPLAY_USD_STOP': '1.5'})
        self.assertEqual((s.day_cap, s.usd_stop), (10, 1.5))
        with self.assertRaises(ConfigError):
            settings_from({'FRAMEPLAY_USD_STOP': '-1'})

    def test_contributor_ids_are_refused(self):
        with self.assertRaises(ConfigError):
            config.check_models(['muse-spark-1.3' + '-contri' + 'butor'])  # split so no file names one
        config.check_models(config.MODELS)


class Ceilings(unittest.TestCase):
    def test_the_spark_answer_has_room_to_finish(self):
        self.assertEqual(config.SPARK_MAX_COMPLETION_TOKENS, 4000)
        from server.limits import SPARK_WORST
        self.assertLess(SPARK_WORST, 0.035, 'the worst Spark call is still reserved at a few cents')

    def test_twelve_sam_calls_and_what_a_photo_costs_at_worst(self):
        # W1c: the floor and up to eleven kinds of things
        self.assertEqual((config.SPARK_CALLS_PER_PHOTO, config.SAM_CALLS_PER_PHOTO), (1, 12))
        from server.limits import SAM_COST, SPARK_WORST
        # Ask the room's riddle call is reserved at its own worst, the read's output room
        riddle_worst = config.SPARK_WORST_IN_TOKENS * config.PRICE_SPARK_IN + config.RIDDLE_MAX_COMPLETION_TOKENS * config.PRICE_SPARK_OUT
        self.assertAlmostEqual(config.PHOTO_WORST_USD, SPARK_WORST + 12 * SAM_COST + riddle_worst)
        self.assertAlmostEqual(config.PHOTO_WORST_USD, 0.094, places=3, msg='about nine cents, as config.py and the README say')
        self.assertGreaterEqual(int(config.USD_STOP / config.PHOTO_WORST_USD), 50, 'at least 50 photos a day under the $5 stop')
        readme = (Path(__file__).resolve().parents[2] / 'README.md').read_text(encoding='utf-8')
        self.assertIn('at most 14 calls in all', ' '.join(readme.split()))
        self.assertIn('about nine cents at worst', ' '.join(readme.split()))
        self.assertIn('at least 50 photos a day', ' '.join(readme.split()))

    def test_room_for_several_judges_with_the_day_and_dollar_guards_kept(self):
        self.assertEqual((config.IN_FLIGHT, config.PER_HOUR), (4, 120))
        self.assertEqual((config.PER_DAY, config.USD_STOP), (200, 5.0))
        from server.limits import Limits
        lim = Limits()
        self.assertEqual((lim.max_in_flight, lim.per_hour), (4, 120))
        self.assertEqual(Limits(in_flight=10, per_hour=1000).per_hour, 120, 'a setting never raises them')


class TheKey(unittest.TestCase):
    def test_the_holder_never_prints_or_copies(self):
        k = KeyHolder(TEST_VALUE)
        for text in (repr(k), str(k), f'{k}', '%s' % (k,), format(k, '>40')):
            self.assertNotIn(TEST_VALUE, text)
            self.assertIn('never shown', text)
        for fn in (lambda: pickle.dumps(k), lambda: copy.copy(k), lambda: copy.deepcopy(k)):
            with self.assertRaises(TypeError):
                fn()
        with self.assertRaises(AttributeError):
            k._value = 'x'
        self.assertEqual(k.authorization(), 'Bearer ' + TEST_VALUE)

    def test_redaction(self):
        k = KeyHolder(TEST_VALUE)
        self.assertNotIn(TEST_VALUE, redact(f'oops {TEST_VALUE} here', k))
        self.assertEqual(redact('Authorization: Bearer abc.def'), 'Authorization: Bearer [redacted]')
        self.assertNotIn('sk_LIVE', redact('token sk_LIVEabcdefghijklmnopqrstuvwxyz0123456789'))
        digest = 'a' * 64
        self.assertIn(digest, redact(f'sha256 {digest}'), 'hex digests stay')


if __name__ == '__main__':
    unittest.main()
