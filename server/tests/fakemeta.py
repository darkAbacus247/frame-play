"""A scripted fake of the Model API on a loopback port, for transport and
pipeline tests. Each answer is (status, headers, body bytes) or a callable
that writes the answer itself (for slow or broken answers)."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def ok_json(obj, status=200, headers=None):
    return status, headers or {}, json.dumps(obj).encode('utf-8')


class FakeMeta:
    def __init__(self):
        self.requests = []
        self.script = {}       # route -> list of answers, used in order
        self.default = {}      # route -> answer or callable(request) -> answer
        self.lock = threading.Lock()
        fake = self

        class H(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(n)
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = None
                req = {'path': self.path, 'headers': dict(self.headers), 'body': body}
                with fake.lock:
                    fake.requests.append(req)
                    queue = fake.script.get(self.path)
                    answer = queue.pop(0) if queue else fake.default.get(self.path)
                if callable(answer):
                    answer = answer(req, self)
                    if answer is None:
                        return  # the callable wrote the answer itself
                if answer is None:
                    answer = (404, {}, b'')
                status, headers, data = answer
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)

        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.srv.daemon_threads = True
        self.srv.handle_error = lambda request, address: None  # aborted test connections
        self.port = self.srv.server_address[1]
        self.base = f'http://127.0.0.1:{self.port}/v1'
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def on(self, route, *answers):
        self.script.setdefault('/v1' + route, []).extend(answers)

    def always(self, route, answer):
        self.default['/v1' + route] = answer

    def count(self, route):
        return sum(1 for r in self.requests if r['path'] == '/v1' + route)

    def stop(self):
        self.srv.shutdown()
        self.srv.server_close()


def spark_answer(read, finish='stop', usage=None):
    return ok_json({
        'id': 'chatcmpl-test',
        'object': 'chat.completion',
        'model': 'muse-spark-1.3',
        'choices': [{'index': 0, 'finish_reason': finish, 'message': {'role': 'assistant', 'content': json.dumps(read)}}],
        'usage': usage or {'prompt_tokens': 2000, 'completion_tokens': 1500, 'total_tokens': 3500,
                           'completion_tokens_details': {'reasoning_tokens': 900}},
    })


def sam_answer(text):
    """A Responses answer in the shape sam-3.1 gave on the first live calls:
    the text in output[0].content[0], and no output_text field."""
    return ok_json({'id': 'resp_test', 'object': 'response', 'model': 'sam-3.1', 'status': 'completed', 'error': None,
                    'metadata': {'mask_encoding': 'one_bit', 'include_confidence': 'true'},
                    'output': [{'type': 'message', 'id': 'msg_test', 'role': 'assistant', 'status': 'completed',
                                'content': [{'type': 'output_text', 'text': text, 'annotations': [], 'logprobs': []}]}],
                    'usage': {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0, 'images_processed': 1}})
