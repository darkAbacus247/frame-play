"""Ask the room on the server (server/riddles.py): the prompt and its strict
schema, the listing, the cleaning rules one by one, the stage inside the
stream (after the reply, never before it, never touching it), the switch,
the spend stop, refusals and broken answers, and the stand-in's riddles."""
import json
import unittest

from server import config, riddles
from server.config import settings_from
from server.limits import Limits
from server.pipeline import Pipeline
from server.server import Log
from server.standin import StandIn
from server.tests import images
from server.tests.fakemeta import FakeMeta, ok_json, spark_answer
from server.tests.test_pipeline import ANSWERS, READ, W, H, sam_by_noun
from server.tests.test_server import Running

L = 1024
DESK_OBJECTS = [  # boxes in pixels on a 1024 x 768 picture, half-open
    {'id': 'o1', 'name': 'cardboard box', 'box': [70, 472, 240, 640]},
    {'id': 'o2', 'name': 'gold coin', 'box': [283, 444, 317, 465]},
    {'id': 'o3', 'name': 'gold coin', 'box': [725, 552, 759, 573]},
    {'id': 'o4', 'name': 'coffee mug', 'box': [560, 383, 670, 482]},
    {'id': 'o5', 'name': 'desk lamp', 'box': [161, 170, 298, 386]},
]


def walk(schema, path='root'):
    """Every object in a JSON schema: (path, the object's schema)."""
    if schema.get('type') == 'object':
        yield path, schema
        for k, v in schema['properties'].items():
            yield from walk(v, f'{path}.{k}')
    elif schema.get('type') == 'array':
        yield from walk(schema['items'], path + '[]')


def riddle(text='Touch the thing you would fill with hot tea.', rule='one', ids=('o4',), points=None, why='Hot drinks!'):
    pts = points if points is not None else [{'id': i, 'x': 600, 'y': 560} for i in ids]
    return {'text': text, 'rule': rule, 'answer_ids': list(ids), 'points': pts, 'why': why}


def clean(*rs):
    warnings = []
    kept = riddles.clean_riddles(list(rs), DESK_OBJECTS, L, 768, warnings)
    return kept, warnings


class Prompt(unittest.TestCase):
    def test_the_schema_is_strict_everywhere(self):
        for path, obj in walk(riddles.RIDDLE_SCHEMA):
            self.assertIs(obj['additionalProperties'], False, path)
            self.assertEqual(sorted(obj['required']), sorted(obj['properties']), path)

    def test_the_body_follows_the_read_s_rules(self):
        body = riddles.riddle_body('o1 | mug | x 1-2, y 3-4', 'desk', 'data:image/jpeg;base64,AAAA')
        self.assertEqual(body['model'], config.SPARK_MODEL)
        self.assertEqual(body['reasoning_effort'], 'low')
        self.assertNotIn('temperature', body)
        self.assertEqual(body['max_completion_tokens'], config.RIDDLE_MAX_COMPLETION_TOKENS)
        fmt = body['response_format']
        self.assertEqual(fmt['json_schema']['name'], 'room_riddles')
        self.assertIs(fmt['json_schema']['strict'], True)
        text, image = body['messages'][0]['content']
        self.assertEqual(image['type'], 'image_url')
        self.assertIn('o1 | mug | x 1-2, y 3-4', text['text'])
        self.assertIn('The play surface is the desk;', text['text'])
        self.assertIn('{n}', text['text'], 'the count is left to the game, literally')
        self.assertNotIn('{LIST}', text['text'])
        # the entry is for players 18 and over
        self.assertIn('Prefer riddles anyone could answer by looking.', text['text'])
        self.assertNotIn('a child could', text['text'])

    def test_the_listing_is_on_the_grid_in_reply_order(self):
        lines = riddles.listing(DESK_OBJECTS, L, 768).splitlines()
        self.assertEqual(lines[0], 'o1 | cardboard box | x 68-234, y 615-833')
        self.assertEqual(lines[1], 'o2 | gold coin | x 276-310, y 578-605')
        self.assertEqual(len(lines), 5)


class Cleaning(unittest.TestCase):
    def test_a_good_riddle_is_kept_with_its_points_in_pixels(self):
        kept, warnings = clean(riddle())
        self.assertEqual(warnings, [])
        self.assertEqual(kept[0]['id'], 'q1')
        self.assertEqual(kept[0]['answers'], ['o4'])
        self.assertEqual(kept[0]['n'], 1)
        self.assertEqual(kept[0]['points'], [[614.4, 430.1, 'o4']])

    def test_kept_riddles_read_as_sentences_within_their_limits(self):
        # as the 10-28 live read wrote them: lower case, no full stop
        kept, _ = clean(riddle(text='touch the tall white chilly keeper that keeps snacks cold', why='it keeps food cold'))
        self.assertEqual(kept[0]['text'], 'Touch the tall white chilly keeper that keeps snacks cold.')
        self.assertEqual(kept[0]['why'], 'It keeps food cold.')
        full = 'touch ' + 'x' * 84
        kept, _ = clean(riddle(text=full))
        self.assertEqual(len(kept[0]['text']), 90, 'no stop added past the limit')

    def test_rule_1_the_shape(self):
        kept, warnings = clean({'text': 'x'}, riddle(rule=3))
        self.assertEqual(kept, [])
        self.assertRegex(warnings[0], 'dropped riddle 1: it is not in the riddle shape')

    def test_rule_2_the_text(self):
        for text, rule, ids, why in [
            ('Too short', 'one', ('o4',), 'characters'),
            ('x' * 91, 'one', ('o4',), 'characters'),
            ('Touch the 1 thing you would fill with hot tea.', 'one', ('o4',), 'digit'),
            ('Find the things you could spend at the shop.', 'all', ('o2', 'o3'), 'count to the game'),
            ('Find the two {n} things you could spend there.', 'all', ('o2', 'o3'), 'count itself'),
            ('Touch the {n} thing you would fill with tea.', 'one', ('o4',), 'count'),
        ]:
            kept, warnings = clean(riddle(text=text, rule=rule, ids=ids))
            self.assertEqual(kept, [], text)
            self.assertIn(why, warnings[0], text)

    def test_rule_3_no_people(self):
        kept, warnings = clean(riddle(text='Touch what a child would fill with hot tea.'))
        self.assertEqual(kept, [])
        self.assertIn('people ("child")', warnings[0])
        kept, _ = clean(riddle(text='Touch the thing you would fill with hot tea.'))
        self.assertEqual(len(kept), 1, 'a riddle speaks to you')

    def test_rule_4_no_leak(self):
        kept, warnings = clean(riddle(text='Touch the mug you would fill with hot tea.'))
        self.assertEqual(kept, [])
        self.assertIn('names its answer ("mug")', warnings[0])
        kept, warnings = clean(riddle(text='Find the {n} gold things you could spend.', rule='all', ids=('o2', 'o3'),
                                      points=[{'id': 'o2', 'x': 293, 'y': 590}, {'id': 'o3', 'x': 725, 'y': 730}]))
        self.assertIn('"gold"', warnings[0])

    def test_rule_5_the_ids(self):
        kept, warnings = clean(riddle(ids=('o9',)))
        self.assertIn('o9 is not on the list', warnings[0])
        kept, warnings = clean(riddle(rule='any', ids=tuple(o['id'] for o in DESK_OBJECTS)))
        self.assertIn('every listed thing answers it', warnings[0])
        kept, warnings = clean(riddle(ids=()))
        self.assertIn('no answer', warnings[0])

    def test_rule_6_the_rule_fits_the_answers(self):
        kept, _ = clean(riddle(rule='any'))
        self.assertEqual(kept[0]['rule'], 'one')
        kept, warnings = clean(riddle(rule='one', ids=('o2', 'o3'), points=[{'id': 'o2', 'x': 293, 'y': 590}, {'id': 'o3', 'x': 725, 'y': 730}]))
        self.assertIn('one answer but several', warnings[0])
        kept, warnings = clean(riddle(text='Find the {n} things you would fill with tea.', rule='all'))
        self.assertIn('asks for all but has one answer', warnings[0])

    def test_rule_7_spark_s_points_against_sam_s_boxes_on_the_real_desk_coins(self):
        # the real 10-27 desk read put its coin points 11.7 px and 11.0 px beside SAM's coin boxes:
        # kept at 1.5% of the long side (15.4 px); a point 40 px away is not where SAM found it
        near = riddle(text='Find the {n} things you could spend at a shop.', rule='all', ids=('o2', 'o3'),
                      points=[{'id': 'o2', 'x': 321, 'y': 592}, {'id': 'o3', 'x': 752, 'y': 731}])
        kept, warnings = clean(near)
        self.assertEqual(warnings, [])
        self.assertEqual(kept[0]['n'], 2)
        far = riddle(points=[{'id': 'o4', 'x': round((670 + 40) * 1000 / L), 'y': 560}])
        kept, warnings = clean(far)
        self.assertEqual(kept, [])
        self.assertIn('Muse Spark’s point for the coffee mug is not where SAM found it', warnings[0])
        kept, warnings = clean(riddle(points=[]))
        self.assertIn('no point for the coffee mug', warnings[0])

    def test_rule_8_no_repeats_and_at_most_three(self):
        kept, warnings = clean(riddle(), riddle(text='Touch whatever keeps a drink warm for you.'))
        self.assertEqual(len(kept), 1)
        self.assertIn('same answer', warnings[0])
        four = [
            riddle(),
            riddle(text='Touch the thing that makes light at night.', ids=('o5',), points=[{'id': 'o5', 'x': 224, 'y': 360}]),
            riddle(text='Touch whatever you could post a parcel in.', ids=('o1',), points=[{'id': 'o1', 'x': 150, 'y': 720}]),
            riddle(text='Find the {n} things you could spend at a shop.', rule='all', ids=('o2', 'o3'),
                   points=[{'id': 'o2', 'x': 293, 'y': 590}, {'id': 'o3', 'x': 725, 'y': 730}]),
        ]
        kept, warnings = clean(*four)
        self.assertEqual([r['id'] for r in kept], ['q1', 'q2', 'q3'])
        self.assertIn('at most 3', warnings[0])


RIDDLES_JSON = {'riddles': [
    {'text': 'Touch the thing you would fill with hot tea.', 'rule': 'one', 'answer_ids': ['o1'], 'points': [], 'why': 'Hot drinks.'},
]}


class Candidates(unittest.TestCase):
    """Only what SAM 3.1 found may answer a riddle: the panel labels every
    live riddle "found by sam-3.1" (src/riddle.js), so a thing traced around
    Muse Spark's points (found_by "points", server/pipeline.py) is never
    listed and never an answer."""

    def run_with(self, objects, answer=None):
        sent = []

        class Spark:
            def post(self, route, body, deadline, sleep, clock):
                sent.append(body)
                return json.loads(spark_answer(answer or {'riddles': []})[2]), 1, 5

        settings = settings_from({}, 'http://127.0.0.1:9/v1', 'desk')
        pipe = Pipeline(settings, Limits(), transport=Spark(), sleep=lambda x: None)
        photo = {'width': L, 'height': 768, 'type': 'image/jpeg', 'bytes': b'\xff\xd8'}
        reply = {'status': 'ok', 'request_id': 'r1', 'surface': {'name': 'desk'}, 'objects': objects}
        return riddles.run_riddles(pipe, photo, reply), sent

    def test_a_point_traced_thing_is_never_a_candidate(self):
        mug = {**DESK_OBJECTS[3], 'found_by': 'sam'}
        lamp = {**DESK_OBJECTS[4], 'found_by': 'points'}
        line, sent = self.run_with([mug, lamp])
        self.assertEqual((line['status'], line['error']['code']), ('none', 'too_few'))
        self.assertEqual(sent, [], 'one SAM-found thing is too few for a fair riddle: no call')
        box = {**DESK_OBJECTS[0], 'found_by': 'sam'}
        lit = riddle(text='Touch the thing that makes light at night.', ids=('o5',), points=[{'id': 'o5', 'x': 224, 'y': 360}])
        line, sent = self.run_with([box, mug, lamp], answer={'riddles': [lit]})
        text = sent[0]['messages'][0]['content'][0]['text']
        self.assertIn('o1 | cardboard box |', text)
        self.assertIn('o4 | coffee mug |', text)
        self.assertNotIn('o5 |', text, 'the traced lamp is not offered')
        self.assertEqual(line['riddles'], [])
        self.assertIn('its answer o5 is not on the list', line['warnings'][0])


class InTheStream(unittest.TestCase):
    """The stage over HTTP, in rehearsal against a fake Meta."""

    def setUp(self, environ=None):
        self.fake = FakeMeta()
        self.fake.always('/responses', sam_by_noun(ANSWERS))
        self.settings = settings_from(environ or {}, self.fake.base, 'desk')
        self.limits = Limits()
        self.lines = []
        self.pipe = Pipeline(self.settings, self.limits, log=Log(stream=self.lines), sleep=lambda x: None)
        self.run_ = Running(self.settings, pipeline=self.pipe, limits=self.limits)

    def tearDown(self):
        self.run_.stop()
        self.fake.stop()

    def post(self, accept='application/x-ndjson'):
        status, h, body = self.run_.request('POST', '/api/room', images.jpeg(W, H),
                                            {'X-FramePlay-Request': '1', 'Content-Type': 'image/jpeg', 'Accept': accept})
        return [json.loads(x) for x in body.decode().splitlines()] if accept == 'application/x-ndjson' else json.loads(body)

    def riddles_answer(self, req, handler):
        """Spark's riddles for this request: the first listed thing, with its point on its box."""
        text = req['body']['messages'][0]['content'][0]['text']
        first = next(ln for ln in text.splitlines() if ln.startswith('o1 | '))
        name = first.split(' | ')[1]
        x0, x1 = [int(v) for v in first.split('x ')[1].split(',')[0].split('-')]
        y0, y1 = [int(v) for v in first.split('y ')[1].split('-')]
        r = {'text': 'Touch the thing that would hold a warm drink.', 'rule': 'one', 'answer_ids': ['o1'],
             'points': [{'id': 'o1', 'x': (x0 + x1) // 2, 'y': (y0 + y1) // 2}], 'why': 'It holds a hot drink.'}
        if any(w in r['text'].lower() for w in name.split()):
            r['text'] = 'Touch the first thing the reader found here.'
        return spark_answer(r and {'riddles': [r]}, usage={'prompt_tokens': 1450, 'completion_tokens': 800, 'total_tokens': 2250})

    def test_progress_progress_reply_then_riddles_and_the_reply_is_untouched(self):
        self.fake.on('/chat/completions', spark_answer(READ), self.riddles_answer)
        lines = self.post()
        self.assertEqual([x['type'] for x in lines], ['progress', 'progress', 'reply', 'riddles'])
        reply, line = lines[2]['reply'], lines[3]['riddles']
        self.assertEqual(line['schema'], 'frameplay.riddles/1')
        self.assertEqual(line['request_id'], reply['request_id'])
        self.assertEqual(line['provenance']['mode'], 'rehearsal')
        self.assertEqual(line['provenance']['models'], [], 'a rehearsal claims no model')
        self.assertEqual(line['provenance']['calls'][0]['model'], 'REHEARSAL stand-in for muse-spark-1.3')
        self.assertEqual(self.fake.count('/chat/completions'), 2)
        self.assertNotIn('riddle', json.dumps(reply), 'the reply carries nothing of the riddles')
        self.assertFalse(any('Touch the' in ln for ln in self.lines), 'the log never holds riddle words')

    def test_switched_off_no_riddle_call_and_no_line(self):
        self.tearDown()
        self.setUp({'FRAMEPLAY_RIDDLES': 'no'})
        self.fake.on('/chat/completions', spark_answer(READ))
        lines = self.post()
        self.assertEqual([x['type'] for x in lines], ['progress', 'progress', 'reply'])
        self.assertEqual(self.fake.count('/chat/completions'), 1)
        self.assertEqual(json.loads(self.run_.request('GET', '/api/health')[2])['riddles'], 'off')

    def test_one_json_object_without_the_stream_makes_no_riddle_call(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        self.assertEqual(self.post('application/json')['status'], 'ok')
        self.assertEqual(self.fake.count('/chat/completions'), 1)

    def test_a_room_that_failed_makes_no_riddle_call(self):
        self.fake.on('/chat/completions', spark_answer({**READ, 'people_present': True}))
        lines = self.post()
        self.assertEqual(lines[-1]['riddles']['status'], 'none')
        self.assertEqual(self.fake.count('/chat/completions'), 1)

    def test_the_spend_stop_refuses_the_riddles_and_keeps_the_room(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        reserve = self.limits.reserve
        seen = []

        def reserve_once_more(usd):
            seen.append(usd)
            # the read's reservation comes first; the riddle call's is the next Spark-sized one
            if usd == riddles.RIDDLE_WORST and seen.count(usd) == 2:
                from server.limits import Refusal
                raise Refusal('spend_stop', 'This server reached its spending stop.')
            return reserve(usd)
        self.limits.reserve = reserve_once_more
        lines = self.post()
        self.assertEqual(lines[2]['reply']['status'], 'ok')
        self.assertEqual(lines[3]['riddles']['status'], 'refused')
        self.assertEqual(self.fake.count('/chat/completions'), 1)

    def test_a_refusal_and_a_broken_answer_say_so_and_leave_the_room(self):
        self.fake.on('/chat/completions', spark_answer(READ), spark_answer({'riddles': []}, finish='content_filter'))
        lines = self.post()
        self.assertEqual(lines[3]['riddles']['status'], 'refused')
        self.fake.on('/chat/completions', spark_answer(READ),
                     ok_json({'choices': [{'finish_reason': 'stop', 'message': {'content': 'not json ' + 'k' * 40}}], 'usage': {}}))
        lines = self.post()
        line = lines[3]['riddles']
        self.assertEqual(line['status'], 'error')
        self.assertEqual(line['error']['code'], 'malformed')
        self.assertEqual(lines[2]['reply']['status'], 'ok')

    def test_health_says_riddles_on_and_their_ceiling(self):
        h = json.loads(self.run_.request('GET', '/api/health')[2])
        self.assertEqual(h['riddles'], 'on')
        self.assertEqual(h['ceilings']['riddle_spark_calls_per_photo'], 1)
        self.assertEqual(h['ceilings']['spark_calls_per_photo'], 1, 'the read itself is still one call')


class StandInRiddles(unittest.TestCase):
    def ask(self, room, drill=None, objects=None):
        s = StandIn(room, drill)
        listing = riddles.listing(objects, s.room['width'], s.room['height'])
        body = riddles.riddle_body(listing, 'floor', 'data:image/jpeg;base64,AAAA')
        status, _, j = s.answer('/v1/chat/completions', {'Authorization': 'Bearer ' + config.REHEARSAL_CREDENTIAL}, body)
        return status, j, objects, s

    def objects_of(self, room):
        s = StandIn(room)
        from server.standin import pixel_box
        out = []
        for k, o in enumerate(s.room['objects']):
            b = pixel_box(o['shape'], s.room['width'], s.room['height'])
            out.append({'id': f'o{k + 1}', 'name': o['name'], 'box': [b[0], b[1], b[2] + 1, b[3] + 1]})
        return out

    def test_each_sample_room_s_riddles_come_back_clean_under_the_request_s_ids(self):
        for room in ('desk', 'living', 'apartment'):
            objects = self.objects_of(room)
            status, j, _, s = self.ask(room, objects=objects)
            self.assertEqual(status, 200)
            got, _, _ = riddles.read_riddles(j)
            warnings = []
            kept = riddles.clean_riddles(got, objects, s.room['width'], s.room['height'], warnings)
            self.assertEqual(warnings, [], room)
            self.assertEqual(len(kept), 3, room)

    def test_each_drill_is_caught(self):
        objects = self.objects_of('desk')
        for drill, expect in [('riddle_bad_id', 'not on the list'), ('riddle_point_outside', 'not where SAM found it'),
                              ('riddle_leak', 'names its answer')]:
            status, j, _, s = self.ask('desk', drill, objects)
            got, _, _ = riddles.read_riddles(j)
            warnings = []
            riddles.clean_riddles(got, objects, s.room['width'], s.room['height'], warnings)
            self.assertTrue(any(expect in w for w in warnings), (drill, warnings))
        status, j, _, _ = self.ask('desk', 'riddle_none', objects)
        self.assertEqual(riddles.read_riddles(j)[0], [])
        for drill, code in [('riddle_malformed', 'malformed'), ('riddle_filter', 'content_filter')]:
            status, j, _, _ = self.ask('desk', drill, objects)
            with self.assertRaises(riddles.CallError) as e:
                riddles.read_riddles(j)
            self.assertEqual(e.exception.code, code)


if __name__ == '__main__':
    unittest.main()
