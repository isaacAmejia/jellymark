import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]


class StandaloneRuntimeTests(unittest.TestCase):
    def test_runtime_uses_only_jellyfin_api_surface(self):
        text = (ROOT / 'sync' / 'app.py').read_text().casefold()
        self.assertNotIn('/v1/api/history', text)
        self.assertNotIn('x-apikey', text)

    def test_example_config_contains_only_supported_top_level_sections(self):
        import json
        data = json.loads((ROOT / 'config' / 'config.example.json').read_text())
        self.assertEqual(
            set(data),
            {'poll_seconds', 'path_matching', 'title_year_fallback', 'server_a', 'server_b', 'pairs'}
        )


if __name__ == '__main__':
    unittest.main()

