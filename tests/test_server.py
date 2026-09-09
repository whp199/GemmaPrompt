import io
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

IMAGE = 'data:image/jpeg;base64,YQ=='
VIDEO = {'name': 'reference.mp4', 'duration': 3, 'frames': [
    {'time': 0, 'url': IMAGE}, {'time': 2.95, 'url': IMAGE}]}

class PromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profiles = server.load_profiles()

    def test_large_shot_counts_and_auto(self):
        for count in (1, 5, 100, 10000, '123456'):
            self.assertIn(f'exactly {count} shot', server.build_h3_directive({'h3': {'shots': count}}))
        for count in ('', None):
            self.assertNotIn('exactly', server.build_h3_directive({'h3': {'shots': count}}))
        for count in (0, -1, 1.5, True, 'foo'):
            with self.assertRaises(ValueError):
                server.build_h3_directive({'h3': {'shots': count}})

    def test_video_grouping_and_negative_tags(self):
        messages = server.build_messages({'images': [IMAGE], 'videos': [VIDEO, VIDEO],
            'options': {'negative': True, 'negativeTags': ['watermark']}}, self.profiles)
        self.assertIn('NEGATIVE prompt: watermark', messages[0]['content'])
        parts = messages[1]['content']
        self.assertEqual(sum(p['type'] == 'image_url' for p in parts), 5)
        text = '\n'.join(p.get('text', '') for p in parts)
        self.assertIn('Image 1:', text)
        self.assertIn('Video 2 — source timestamp 2.950s', text)
        self.assertNotIn('preview', text)
        self.assertIn('No audio', messages[0]['content'])

    def test_invalid_video_metadata(self):
        for change in ({'duration': float('nan')}, {'duration': 0}, {'frames': []},
                       {'frames': [{'time': 2, 'url': IMAGE}, {'time': 1, 'url': IMAGE}]},
                       {'frames': [{'time': 0, 'url': IMAGE}, {'time': 3, 'url': IMAGE}]}):
            with self.assertRaises(ValueError):
                server.build_messages({'videos': [{**VIDEO, **change}]}, self.profiles)
        with self.assertRaises(ValueError):
            server.build_messages({'images': ['https://example.com/private']}, self.profiles)

    def test_video_does_not_replace_source_image(self):
        with self.assertRaises(ValueError):
            server.build_messages({'profile': 'wan22i2v', 'videos': [VIDEO]}, self.profiles)
        messages = server.build_messages({'profile': 'wan22i2v', 'videos': [VIDEO], 'analysisOnly': True}, self.profiles)
        self.assertIn('Analyze', messages[0]['content'])
        self.assertNotIn('Wan', messages[0]['content'])

    def test_reasoning_chunks_and_prefill(self):
        splitter = server.ThinkSplitter()
        parts = []
        for chunk in ('<thi', 'nk>secret', '</th', 'ink>final'):
            parts += splitter.feed(chunk)
        parts += splitter.flush()
        self.assertEqual(''.join(t for k, t in parts if k == 'content'), 'final')
        self.assertEqual(''.join(t for k, t in parts if k == 'reasoning'), 'secret')

    @patch('server.shutil.which', return_value='/lms')
    @patch('server.subprocess.run')
    def test_unload_only_selected_local_model(self, run, which):
        run.return_value.returncode = 0
        run.return_value.stdout = 'unloaded'
        self.assertTrue(server.unload_model('http://127.0.0.1:1234/v1', 'model')['ok'])
        self.assertEqual(run.call_args.args[0], ['/lms', 'unload', 'model'])
        run.reset_mock()
        self.assertFalse(server.unload_model('http://remote:1234/v1', 'model')['ok'])
        self.assertFalse(server.unload_model('http://localhost:1234/v1', '')['ok'])
        run.assert_not_called()

class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.httpd.profiles = server.load_profiles()
        cls.httpd.verbose = False
        cls.httpd.backend = 'http://127.0.0.1:1234/v1'
        cls.httpd.api_key = ''
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.httpd.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()

    def post(self, body):
        request = urllib.request.Request(self.url + '/api/generate', data=json.dumps(body).encode(),
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.read().decode()

    def test_dry_run_with_video_and_many_shots(self):
        result = json.loads(self.post({'profile': 'h3', 'h3': {'shots': 120}, 'videos': [VIDEO], 'dryRun': True}))
        self.assertIn('exactly 120 shot', result['messages'][0]['content'])

    def test_bad_json_shape_and_sampling_values(self):
        for req in ([], {'temperature': 'bad'}, {'maxTokens': 1.5}):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.post(req)
            self.assertEqual(caught.exception.code, 400)
            caught.exception.close()

    def stream_result(self, chunks, req=None):
        stream = io.BytesIO(('\n'.join('data: ' + json.dumps(c) for c in chunks) + '\n').encode())
        with patch('server.api_call', return_value=stream):
            return self.post(req or {'idea': 'test'})

    def test_truncation_and_reasoning_prefill(self):
        result = self.stream_result([{'choices': [{'delta': {'content': '</think>hello'}, 'finish_reason': 'length'}]}],
            {'idea': 'test', 'thinking': 'prefill', 'thinkingPrefill': '<think>secret'})
        events = [json.loads(line[6:]) for line in result.splitlines() if line.startswith('data: ')]
        self.assertEqual(''.join(e.get('text', '') for e in events if e['type'] == 'content'), 'hello')
        self.assertEqual(events[-1]['finish_reason'], 'length')

    def test_empty_or_broken_stream_is_error(self):
        for chunks in ([], [{'choices': [{'delta': {'content': 'partial'}}]}],
                       [{'choices': [{'delta': {}, 'finish_reason': 'stop'}]}], [{'error': 'vision unsupported'}]):
            result = self.stream_result(chunks)
            self.assertIn('"type": "error"', result)
            self.assertNotIn('"type": "done"', result)

if __name__ == '__main__':
    unittest.main()
