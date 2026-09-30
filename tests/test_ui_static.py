import shutil
import subprocess
import unittest
from pathlib import Path

UI = Path(__file__).parents[1] / 'ui' / 'jellymark.js'


class UIStaticTests(unittest.TestCase):
    def test_javascript_parses(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node not installed')
        subprocess.run([node, '--check', str(UI)], check=True, capture_output=True, text=True)

    def test_expected_watchlist_features_present(self):
        text = UI.read_text()
        for marker in [
            "Filters: 'Likes'",
            "Series Progress",
            "Watch History",
            "Statistics",
            "exportWatchlist",
            "importWatchlist",
            "syncPlaylist",
            "autoRemovePlayed",
            "updateUserItemRating",
            f"const VERSION = '{(UI.parent / 'VERSION').read_text().strip()}'",
        ]:
            self.assertIn(marker, text)

    def test_does_not_own_directional_navigation(self):
        text = UI.read_text()
        self.assertNotIn("'ArrowLeft'", text)
        self.assertNotIn("'ArrowRight'", text)
        self.assertNotIn("'ArrowUp'", text)
        self.assertNotIn("'ArrowDown'", text)


    def test_does_not_replace_jellyfin_websocket_handler(self):
        text = UI.read_text()
        self.assertNotIn('socket.onmessage=', text.replace(' ', ''))
        self.assertIn("addEventListener('message'", text)



if __name__ == '__main__':
    unittest.main()


