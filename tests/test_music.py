import io
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import music
import server


class MusicTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.write('SKILL.md', '---\nname: music-caption-rewriter\n---\n### Global Metadata\n### Vocal Details\n### Arrangement\nNever reproduce lyrics.')
        self.write('references/genre-router.md', '[Pop](index-pop.md) [Rock](index-rock.md)')
        self.write('references/index-pop.md', '`templates/pop.txt`\n`templates/arrangement.txt`')
        self.write('references/index-rock.md', '`templates/rock.txt`')
        self.write('templates/pop.txt', 'A restrained instrumental foundation.')
        self.write('templates/arrangement.txt', 'Introduce drums in the chorus, then return to piano.')
        self.write('templates/rock.txt', 'A heavier variation.')
        self.env = patch.dict(os.environ, {'GEMMA_MUSIC_SKILL': str(self.root)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.req = {'profile': 'music3', 'idea': 'warm piano instrumental',
                    'music': {'vocals': 'instrumental', 'lyrics': '[Intro: piano]\nUNIQUE PRIVATE LYRIC\n[Chorus: drums]',
                              'constraints': 'no strings; 85 BPM'}}
        self.profiles = server.load_profiles()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_music_rules_are_separate_from_visual_profile_rules(self):
        req = {**self.req, 'images': ['bad'], 'videos': ['bad'],
               'options': {'artists': ['unrelated artist'], 'tags': ['full body'], 'negative': True},
               'h3': {'shots': 999, 'musicMode': 'none'}}
        messages = server.build_messages(req, self.profiles)
        self.assertEqual(len(messages), 2)
        self.assertNotIn('unrelated artist', messages[0]['content'])
        self.assertNotIn('full body', messages[0]['content'])
        self.assertNotIn('exactly 999', messages[0]['content'])
        self.assertNotIn('GemmaPrompt Core', messages[0]['content'])
        self.assertIn('### Global Metadata', messages[0]['content'])
        self.assertIn('Instrumental only', messages[1]['content'])
        self.assertIn('UNIQUE PRIVATE LYRIC', messages[1]['content'])
        self.assertIn('[Chorus: drums]', messages[1]['content'])
        self.assertIn('no strings; 85 BPM', messages[1]['content'])
        self.assertNotIn('name: music-caption-rewriter', messages[0]['content'])

    def test_progressive_disclosure_reads_only_selected_paths(self):
        library = music.MusicLibrary()
        replies = iter([{'indexes': ['index-pop.md']}, {'references': [
            {'role': 'Foundation', 'path': 'templates/pop.txt'},
            {'role': 'Arrangement', 'path': 'templates/arrangement.txt'}]}])
        progress = []
        with patch.object(library, 'read', wraps=library.read) as read:
            context = library.select(self.req, lambda *_: next(replies), lambda text: progress.append(text) or True)
        self.assertEqual([c.args[0] for c in read.call_args_list], [
            'references/genre-router.md', 'references/index-pop.md', 'templates/pop.txt', 'templates/arrangement.txt'])
        self.assertEqual(len(progress), 3)
        self.assertIn('A restrained instrumental foundation.', context)
        prompt = server.build_messages(self.req, self.profiles, context)[0]['content']
        self.assertIn('already been completed', prompt)
        self.assertIn('Introduce drums', prompt)

    def test_rejects_unknown_paths_duplicate_roles_and_excessive_disclosure(self):
        cases = [
            [{'indexes': ['../private.md']}],
            [{'indexes': ['index-pop.md', 'index-rock.md', 'index-pop.md']}],
            [{'indexes': ['index-pop.md']}, {'references': [{'role': 'Foundation', 'path': 'templates/rock.txt'}]}],
            [{'indexes': ['index-pop.md']}, {'references': [{'role': 'Foundation', 'path': '../secret'}]}],
            [{'indexes': ['index-pop.md']}, {'references': [
                {'role': 'Foundation', 'path': 'templates/pop.txt'},
                {'role': 'Foundation', 'path': 'templates/arrangement.txt'}]}],
        ]
        for answers in cases:
            with self.subTest(answers=answers), self.assertRaises(ValueError):
                iterator = iter(answers)
                music.MusicLibrary().select(self.req, lambda *_: next(iterator))

    def test_cancellation_stops_before_model_call(self):
        with self.assertRaises(ConnectionAbortedError):
            music.MusicLibrary().select(self.req, lambda *_: self.fail('model should not be called'), lambda _: False)

    def test_http_pipeline_supplies_schemas_then_streams_caption(self):
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        httpd.profiles = self.profiles
        httpd.verbose = False
        httpd.backend = 'http://127.0.0.1:1234/v1'
        httpd.api_key = ''
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        replies = iter([
            {'indexes': ['index-pop.md']},
            {'references': [{'role': 'Foundation', 'path': 'templates/pop.txt'}]},
        ])
        payloads = []
        def api(*args, **kwargs):
            payload = json.loads(kwargs['data'])
            payloads.append(payload)
            if not payload['stream']:
                result = {'choices': [{'message': {'content': json.dumps(next(replies))}, 'finish_reason': 'stop'}]}
                return io.BytesIO(json.dumps(result).encode())
            return io.BytesIO(('data: ' + json.dumps({'choices': [{'delta': {'content': '### Global Metadata'},
                                   'finish_reason': 'stop'}]}) + '\n\ndata: [DONE]\n\n').encode())
        request = urllib.request.Request(f'http://127.0.0.1:{httpd.server_port}/api/generate',
            data=json.dumps(self.req).encode(), headers={'Content-Type': 'application/json'})
        with patch('server.api_call', side_effect=api), urllib.request.urlopen(request, timeout=3) as response:
            output = response.read().decode()
        self.assertEqual(len(payloads), 3)
        self.assertEqual(payloads[0]['response_format']['type'], 'json_schema')
        self.assertEqual(payloads[0]['reasoning_effort'], 'none')
        self.assertIn('A restrained instrumental foundation.', payloads[2]['messages'][0]['content'])
        self.assertIn('"type": "status"', output)
        self.assertIn('"type": "content"', output)
        self.assertIn('"type": "done"', output)
        self.assertNotIn('"type": "error"', output)

    def test_missing_skill_and_empty_caption_are_actionable(self):
        with self.assertRaisesRegex(ValueError, 'Describe the music'):
            server.build_messages({'profile': 'music3', 'idea': ''}, self.profiles)
        (self.root / 'SKILL.md').unlink()
        with self.assertRaisesRegex(ValueError, 'GEMMA_MUSIC_SKILL'):
            server.build_messages(self.req, self.profiles)

    def test_selection_json_and_system_overrides(self):
        self.assertEqual(music.parse_selection('<think>private</think>```json\n{"indexes": ["index-pop.md"]}\n```'),
                         {'indexes': ['index-pop.md']})
        for value in ('[]', 'not JSON', '{broken'):
            with self.assertRaises(ValueError):
                music.parse_selection(value)
        self.assertEqual(music.build_music_system({**self.req, 'systemMode': 'replace', 'systemExtra': 'Custom rules'}), 'Custom rules')

    def test_h3_background_music_preserves_video_format(self):
        prompt = server.build_h3_directive({'h3': {'musicMode': 'custom', 'musicDirection': 'solo piano, no vocals'}})
        self.assertIn('solo piano, no vocals', prompt)
        self.assertIn('non_diegetic_music', prompt)
        self.assertIn('1–3', prompt)
        self.assertNotIn('### Global Metadata', prompt)
        no_score = server.build_h3_directive({'h3': {'musicMode': 'none', 'dialogue': 'hello'}})
        self.assertIn('non_diegetic_music must be N/A', no_score)
        self.assertIn('hello', no_score)
        with self.assertRaisesRegex(ValueError, 'Describe the H3 soundtrack'):
            server.build_h3_directive({'h3': {'musicMode': 'custom'}})


if __name__ == '__main__':
    unittest.main()
