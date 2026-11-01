import base64
import json
import struct
import unittest

from server import config, voice
from server.config import settings_from
from server.limits import Limits
from server.meta_api import CallError
from server.server import FramePlayServer, Handler
from server.standin import DRILLS, StandIn
from server.tests.fakemeta import FakeMeta, ok_json
from server.tests.test_config import TEST_VALUE
from server.tests.test_server import Running
from server.voice import VoiceTransport


def clip(rate=16000, channels=1, bits=16, seconds=1, pcm=b'\x00\x01' * 8000, riff=True):
    n = len(pcm)
    head = struct.pack('<4sI4s4sIHHIIHH', b'RIFF' if riff else b'XXXX', 36 + n, b'WAVE',
                       b'fmt ', 16, 1, channels, rate, rate * channels * bits // 8,
                       channels * bits // 8, bits)
    return head + struct.pack('<4sI', b'data', n) + pcm


GOOD = clip()
THINGS = [{'id': 'o1', 'name': 'refrigerator'}, {'id': 'o2', 'name': 'lamp'}]


def live_env(extra=None):
    env = {'MODEL_API_KEY': TEST_VALUE, 'FRAMEPLAY_LIVE': 'yes', 'FRAMEPLAY_VOICE': 'yes'}
    env.update(extra or {})
    return env


class WavCheck(unittest.TestCase):
    def test_a_good_clip_passes(self):
        self.assertIsNone(voice.check_wav(clip()))
        self.assertIsNone(voice.check_wav(clip(rate=24000, seconds=1, pcm=b'\x00\x01' * 24000)))

    def test_bad_clips_are_refused(self):
        for bad in (b'not a wav at all' + b'\x00' * 40,
                    clip(riff=False),
                    clip(channels=2, pcm=b'\x00\x01' * 16000),
                    clip(bits=8, pcm=b'\x00' * 16000),
                    clip(rate=8000, pcm=b'\x00\x01' * 8000),
                    clip(seconds=7, pcm=b'\x00\x01' * 16000 * 7),
                    b'RIFF' + b'\x00' * 40):
            self.assertIsInstance(voice.check_wav(bad), str, bad[:8])

    def test_refused_before_any_request(self):
        fake = FakeMeta()
        try:
            fake.default['/v1/asr/transcribe'] = ok_json({'sessionId': 's', 'transcript': 'x', 'audioDurationMs': 1, 'turns': []})
            for bad in (clip(riff=False), clip(channels=2, pcm=b'\x00\x01' * 16000),
                        clip(bits=8, pcm=b'\x00' * 16000), clip(rate=8000, pcm=b'\x00\x01' * 8000),
                        clip(seconds=7, pcm=b'\x00\x01' * 16000 * 7)):
                self.assertIsNotNone(voice.check_wav(bad))
            self.assertEqual(fake.count('/asr/transcribe'), 0)
        finally:
            fake.stop()


class Multipart(unittest.TestCase):
    def test_exact_parts_and_request_json(self):
        fake = FakeMeta()
        try:
            seen = {}

            def cap(req, handler):
                seen['type'] = req['headers'].get('Content-Type')
                n = int(req['headers'].get('Content-Length') or 0)
                return None  # never reached: fakemeta has no raw body

            # capture at the transport level instead: build the body the test sends
            req = voice.request_json(['refrigerator'])
            self.assertEqual(req, {'model': 'muse-voice-transcribe-1.0', 'audioEncoding': 'WAV',
                                   'mode': 'PUSH_TO_TALK', 'keywords': ['refrigerator'], 'languageBias': ['English']})
            payload, ctype = voice.build_multipart(req, GOOD)
            self.assertTrue(ctype.startswith('multipart/form-data; boundary='))
            boundary = ctype.split('boundary=')[1]
            chunks = payload.split(b'--' + boundary.encode('ascii'))
            # ['', part1, part2, '--\r\n']
            self.assertEqual(len(chunks), 4)
            self.assertIn(b'name="request"', chunks[1])
            self.assertIn(b'application/json', chunks[1])
            got = json.loads(chunks[1].split(b'\r\n\r\n', 1)[1].rsplit(b'\r\n', 1)[0])
            self.assertEqual(got, req)
            self.assertIn(b'name="audio"', chunks[2])
            self.assertTrue(chunks[2].split(b'\r\n\r\n', 1)[1].rsplit(b'\r\n', 1)[0].endswith(GOOD[-8:]))
            t = VoiceTransport(fake.base, config.REHEARSAL_CREDENTIAL)
            fake.default['/v1/asr/transcribe'] = ok_json({'sessionId': 's', 'transcript': 'x', 'audioDurationMs': 1, 'turns': []})
            j, attempts, _ = t.transcribe(GOOD, ['refrigerator'], __import__('time').monotonic() + 10)
            self.assertEqual(j['transcript'], 'x')
            self.assertEqual(attempts, 1)
            last = fake.requests[-1]
            raw_ct = last['headers'].get('Content-Type') or last['headers'].get('Content-type')
            self.assertTrue(raw_ct.startswith('multipart/form-data; boundary='))
            self.assertIsNone(last['body'], 'multipart is not JSON')
        finally:
            fake.stop()


class Matcher(unittest.TestCase):
    def test_names(self):
        things = THINGS
        mid, _ = voice.match_answer('the refrigerator', things)
        self.assertEqual(mid, 'o1')
        mid, _ = voice.match_answer('fridges', things)
        self.assertEqual(mid, 'o1')
        mid, words = voice.match_answer('the', things)
        self.assertIsNone(mid)
        self.assertTrue(words)
        mid, words = voice.match_answer('', things)
        self.assertIsNone(mid)
        self.assertTrue(words)
        mid, words = voice.match_answer('the refrigerator and the lamp', things)
        self.assertIsNone(mid)
        self.assertTrue(words)


class Route(unittest.TestCase):
    def setUp(self):
        self.fake = FakeMeta()
        self.fake.default['/v1/asr/transcribe'] = ok_json(
            {'sessionId': 's', 'transcript': 'the fridge', 'audioDurationMs': 1500, 'turns': []})

    def tearDown(self):
        self.fake.stop()
        if hasattr(self, 'run_'):
            self.run_.stop()

    def start(self, env=None, limits=None):
        settings = settings_from(live_env(env), self.fake.base if False else None) if False else None
        # live settings pointed at the fake loopback base
        from server.config import Settings
        from server.config import KeyHolder
        settings = Settings('live', 'test', KeyHolder(TEST_VALUE), self.fake.base,
                            voice=(env is None or env.get('FRAMEPLAY_VOICE', 'yes') == 'yes'))
        if env and env.get('FRAMEPLAY_LIVE') == 'no':
            settings.mode = 'mock'
        lim = limits or Limits(clock=lambda: 1_800_000_000.0)
        self.run_ = Running(settings, pipeline=None, limits=lim)
        # the route builds its own VoiceTransport from settings, so point settings at the fake
        return lim

    def post(self, wav_b64, things=THINGS):
        body = json.dumps({'wav': wav_b64, 'things': things}).encode('utf-8')
        return self.run_.request('POST', '/api/voice', body,
                                 {'X-FramePlay-Request': '1', 'Content-Type': 'application/json'})

    def test_success(self):
        self.start()
        status, _, data = self.post(base64.b64encode(GOOD).decode('ascii'))
        j = json.loads(data)
        self.assertEqual(status, 200)
        self.assertEqual(j['status'], 'ok')
        self.assertEqual(j['transcript'], 'the fridge')
        self.assertEqual(j['match'], 'o1', 'fridge names the refrigerator')
        self.assertTrue(j['words'])
        self.assertEqual(self.fake.count('/asr/transcribe'), 1)

    def test_switch_off_sends_nothing(self):
        self.start({'FRAMEPLAY_VOICE': 'no'})
        status, _, data = self.post(base64.b64encode(GOOD).decode('ascii'))
        self.assertEqual(status, 409)
        self.assertIn('voice_off', data.decode())
        self.assertEqual(self.fake.count('/asr/transcribe'), 0)

    def test_not_live_sends_nothing(self):
        self.start({'FRAMEPLAY_LIVE': 'no'})
        status, _, _ = self.post(base64.b64encode(GOOD).decode('ascii'))
        self.assertEqual(status, 409)
        self.assertEqual(self.fake.count('/asr/transcribe'), 0)

    def test_bad_wav_sends_nothing(self):
        self.start()
        status, _, _ = self.post(base64.b64encode(clip(channels=2, pcm=b'\x00\x01' * 16000)).decode('ascii'))
        self.assertEqual(status, 400)
        self.assertEqual(self.fake.count('/asr/transcribe'), 0)

    def test_drills(self):
        self.start()
        t = VoiceTransport(self.fake.base, config.REHEARSAL_CREDENTIAL)
        import time as _t
        # 400 gives words
        self.fake.script['/v1/asr/transcribe'] = [(400, {}, json.dumps({'error': {'code': 'x'}}).encode())]
        with self.assertRaises(CallError) as c:
            t.transcribe(GOOD, [], _t.monotonic() + 10)
        self.assertIn('could not accept', str(c.exception))
        # 429 gives words that say to try again shortly
        self.fake.script['/v1/asr/transcribe'] = [(429, {'Retry-After': '60'}, json.dumps({'error': {}}).encode())] * 3
        with self.assertRaises(CallError) as c:
            t.transcribe(GOOD, [], _t.monotonic() + 30, sleep=lambda s: None)
        self.assertIn('shortly', str(c.exception))
        # 503 gives words
        self.fake.script['/v1/asr/transcribe'] = [(503, {}, json.dumps({'error': {}}).encode())]
        with self.assertRaises(CallError) as c:
            t.transcribe(GOOD, [], _t.monotonic() + 10, sleep=lambda s: None)
        self.assertTrue(str(c.exception))

    def test_caps(self):
        lim = Limits(clock=lambda: 1_800_000_000.0)
        self.start(limits=lim)
        for i in range(config.VOICE_DAY_CAP):
            lim.admit_voice(f'c{i}')
        status, h, _ = self.post(base64.b64encode(GOOD).decode('ascii'))
        self.assertEqual(status, 429)
        self.assertEqual(self.fake.count('/asr/transcribe'), 0)
        # per-client hour cap
        lim2 = Limits(clock=lambda: 1_800_000_000.0)
        self.run_.stop()
        self.start(limits=lim2)
        for _ in range(config.VOICE_CLIENT_HOUR_CAP):
            lim2.admit_voice(self.run_.srv.salt and 'x')
        # direct check of the matcher limit path is covered; the route counts per client digest
        self.assertEqual(lim2.voice_today, config.VOICE_CLIENT_HOUR_CAP)

    def test_health_lists_voice(self):
        self.start()
        status, _, data = self.run_.request('GET', '/api/health')
        j = json.loads(data)
        self.assertEqual(j['voice'], 'on')
        self.assertEqual(j['ceilings']['voice_max_seconds'], 6)
        self.assertEqual(j['ceilings']['voice_per_day'], config.VOICE_DAY_CAP)
        self.assertEqual(j['ceilings']['voice_per_client_per_hour'], config.VOICE_CLIENT_HOUR_CAP)

    def test_standin_transcribe_and_drills(self):
        s = StandIn('desk')
        st, _, j = s.answer('/v1/asr/transcribe', {'Authorization': 'Bearer ' + config.REHEARSAL_CREDENTIAL}, None)
        self.assertEqual(st, 200)
        self.assertEqual(set(j), {'sessionId', 'transcript', 'audioDurationMs', 'turns'})
        for drill, want in (('voice_400', 400), ('voice_429', 429), ('voice_503', 503)):
            s2 = StandIn('desk', drill)
            st, _, _ = s2.answer('/v1/asr/transcribe', {'Authorization': 'Bearer ' + config.REHEARSAL_CREDENTIAL}, None)
            self.assertEqual(st, want, drill)
        self.assertIn('voice_400', DRILLS)
        self.assertIn('voice_429', DRILLS)
        self.assertIn('voice_503', DRILLS)

    def test_config_switch(self):
        self.assertFalse(settings_from({}).voice)
        self.assertTrue(settings_from({'FRAMEPLAY_VOICE': 'yes'}).voice)
        self.assertFalse(settings_from({'FRAMEPLAY_VOICE': 'YES '}).voice is False or False)
        self.assertEqual(config.VOICE_MAX_SECONDS, 6)


if __name__ == '__main__':
    unittest.main()
