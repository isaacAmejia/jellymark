import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ['DATA_DIR'] = TMP.name
os.environ['JWS_ADMIN_TOKEN'] = 'test-token'
APP_PATH = Path(__file__).parents[1] / 'sync' / 'app.py'
spec = importlib.util.spec_from_file_location('jws_app', APP_PATH)
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


def movie(item_id, name='Dune', tmdb='438631', liked=True, played=False, path=None, year=2021):
    return {
        'Id': str(item_id), 'Name': name, 'Type': 'Movie', 'ProductionYear': year,
        'ProviderIds': {'Tmdb': tmdb} if tmdb else {},
        'Path': path,
        'UserData': {'Likes': liked, 'Played': played}
    }


def series(item_id, name='Show', tvdb=None, year=2024):
    return {'Id': str(item_id), 'Name': name, 'Type': 'Series', 'ProductionYear': year,
            'ProviderIds': {'Tvdb': tvdb} if tvdb else {}, 'UserData': {}}


def episode(item_id, series_id='s1', series='Show', season=1, ep=1, tvdb=None, path=None, liked=True):
    return {
        'Id': str(item_id), 'Name': f'Episode {ep}', 'Type': 'Episode',
        'SeriesId': series_id, 'SeriesName': series, 'ParentIndexNumber': season,
        'IndexNumber': ep, 'ProviderIds': {'Tvdb': tvdb} if tvdb else {},
        'Path': path, 'UserData': {'Likes': liked, 'Played': False}
    }


class FakeJellyfin:
    def __init__(self, side, catalog, liked_ids=()):
        self.side = side
        self.name = side
        self.url = 'http://' + side
        self.catalog = {str(x['Id']): dict(x) for x in catalog}
        self.likes = {str(x) for x in liked_ids}
        self.writes = []

    def liked_items(self, user_id, types):
        out = []
        for item_id in sorted(self.likes):
            item = dict(self.catalog[item_id])
            item['UserData'] = dict(item.get('UserData') or {})
            item['UserData']['Likes'] = True
            if item['Type'] in types:
                out.append(item)
        return out

    def item(self, item_id, user_id=None):
        item = self.catalog.get(str(item_id))
        return dict(item) if item else None

    def search(self, user_id, name, item_type, limit=60):
        n = app.norm_text(name)
        return [dict(x) for x in self.catalog.values()
                if x.get('Type') == item_type and app.norm_text(x.get('Name')) == n][:limit]

    def all_items(self, user_id, types):
        return [dict(x) for x in self.catalog.values() if x.get('Type') in types]

    def children(self, user_id, parent_id, item_type, recursive=False, index=None, parent_index=None):
        out = []
        for x in self.catalog.values():
            if x.get('Type') != item_type:
                continue
            if item_type == 'Episode' and str(x.get('SeriesId')) != str(parent_id):
                continue
            if item_type == 'Season' and str(x.get('SeriesId')) != str(parent_id):
                continue
            if index is not None and x.get('IndexNumber') != index:
                continue
            if parent_index is not None and x.get('ParentIndexNumber') != parent_index:
                continue
            out.append(dict(x))
        return out

    def set_like(self, user_id, item_id, liked):
        item_id = str(item_id)
        self.writes.append((item_id, bool(liked)))
        if liked:
            self.likes.add(item_id)
        else:
            self.likes.discard(item_id)


class Tests(unittest.TestCase):
    def setUp(self):
        app.CONFIG = app.deep_merge(app.DEFAULT_CONFIG, {
            'path_matching': {'enabled': True, 'index_ttl_hours': 6},
            'title_year_fallback': True,
        })
        with app.PATH_INDEX_LOCK:
            app.PATH_INDEX_CACHE.clear()
        with app.db_connect() as db:
            db.execute('DELETE FROM mappings')
            db.execute('DELETE FROM pair_state')

    def pair(self, **overrides):
        base = {
            'id': 'pair1', 'name': 'A ↔ B', 'enabled': True,
            'a_user_id': 'ua', 'b_user_id': 'ub', 'direction': 'both',
            'bootstrap': 'a_to_b', 'conflict': 'a', 'types': ['Movie'],
            'auto_remove_watched': True,
        }
        base.update(overrides)
        return base

    def clients(self, a_likes=('a1',), b_likes=()):
        a = FakeJellyfin('a', [movie('a1')], a_likes)
        b = FakeJellyfin('b', [movie('b1')], b_likes)
        return {'a': a, 'b': b}

    def test_bootstrap_a_to_b(self):
        clients = self.clients(('a1',), ())
        stats = app.sync_pair(self.pair(), clients)
        self.assertIn('b1', clients['b'].likes)
        self.assertEqual(stats['writes'], 1)
        self.assertEqual(app.pair_state('pair1')['bootstrapped'], 1)

    def test_two_way_removal_propagates(self):
        clients = self.clients(('a1',), ())
        app.sync_pair(self.pair(), clients)
        app.sync_pair(self.pair(), clients)
        clients['a'].likes.remove('a1')
        app.sync_pair(self.pair(), clients)
        self.assertNotIn('b1', clients['b'].likes)

    def test_conflict_prefers_a(self):
        clients = self.clients(('a1',), ())
        app.sync_pair(self.pair(), clients)
        app.sync_pair(self.pair(), clients)
        clients['a'].likes.clear(); clients['b'].likes.clear()
        app.sync_pair(self.pair(), clients)
        row = app.all_mappings('pair1')[0]
        app.update_mapping_state('pair1', row['logical_key'], last_a=0, last_b=1)
        clients['a'].likes.add('a1'); clients['b'].likes.clear()
        stats = app.sync_pair(self.pair(conflict='a'), clients)
        self.assertIn('b1', clients['b'].likes)
        self.assertEqual(stats['conflicts'], 1)

    def test_auto_remove_played_before_sync(self):
        a = FakeJellyfin('a', [movie('a1', played=True)], {'a1'})
        b = FakeJellyfin('b', [movie('b1')], set())
        stats = app.sync_pair(self.pair(), {'a': a, 'b': b})
        self.assertNotIn('a1', a.likes)
        self.assertEqual(stats['auto_removed'], 1)
        self.assertNotIn('b1', b.likes)

    def test_movie_path_fingerprint_ignores_leading_root_and_slashes(self):
        a = movie('a1', tmdb=None, path='/mnt/media/Movies/Dune (2021)/Dune.mkv')
        b = movie('b1', tmdb=None, path=r'Z:\\Library\\Dune (2021)\\Dune.mkv')
        self.assertEqual(app.path_fingerprints(a)['media'], app.path_fingerprints(b)['media'])

    def test_episode_path_fingerprint_includes_season_episode(self):
        a = episode('a1', path='/mnt/tv/Show/Season 01/S01E01.mkv', season=1, ep=1)
        b = episode('b1', path=r'Z:\\Show\\Season 01\\S01E01.mkv', season=1, ep=1)
        c = episode('b2', path=r'Z:\\Show\\Season 01\\S01E01.mkv', season=1, ep=2)
        self.assertEqual(app.path_fingerprints(a)['media'], app.path_fingerprints(b)['media'])
        self.assertNotEqual(app.path_fingerprints(a)['media'], app.path_fingerprints(c)['media'])

    def test_path_match_maps_when_provider_ids_missing(self):
        aitem = movie('a1', name='Different Metadata A', tmdb=None,
                      path='/mnt/media/Movies/Foo/Foo.mkv', year=None)
        bitem = movie('b1', name='Different Metadata B', tmdb=None,
                      path=r'Z:\\Whatever\\Foo\\Foo.mkv', year=None)
        a = FakeJellyfin('a', [aitem], {'a1'})
        b = FakeJellyfin('b', [bitem], set())
        pair = self.pair(types=['Movie'])
        stats = app.sync_pair(pair, {'a': a, 'b': b})
        self.assertIn('b1', b.likes)
        row = app.all_mappings('pair1')[0]
        self.assertEqual(row['match_method'], 'path')
        self.assertEqual(stats['methods']['path'], 1)

    def test_path_collision_is_rejected(self):
        source = movie('a1', name='A', tmdb=None, path='/mnt/movies/Foo/Foo.mkv', year=None)
        b1 = movie('b1', name='B1', tmdb=None, path='/one/Foo/Foo.mkv', year=None)
        b2 = movie('b2', name='B2', tmdb=None, path='/two/Foo/Foo.mkv', year=None)
        target = FakeJellyfin('b', [b1, b2], set())
        found, method, _ = app.path_match(target, 'ub', source, app.CONFIG)
        self.assertIsNone(found)
        self.assertIsNone(method)

    def test_series_can_map_from_episode_show_path(self):
        sa = series('sa', name='Metadata Name A', tvdb=None)
        ea = episode('ea', series_id='sa', series='Metadata Name A',
                     path='/mnt/tv/Actual Show/Season 01/S01E01.mkv')
        sb = series('sb', name='Metadata Name B', tvdb=None)
        eb = episode('eb', series_id='sb', series='Metadata Name B',
                     path=r'Z:\\TV\\Actual Show\\Season 01\\S01E01.mkv')
        a = FakeJellyfin('a', [sa, ea], set())
        b = FakeJellyfin('b', [sb, eb], set())
        found, method, _ = app.match_series(a, b, 'ua', 'ub', sa)
        self.assertEqual(found['Id'], 'sb')
        self.assertEqual(method, 'path-series')

    def test_provider_id_beats_title_fallback(self):
        src = movie('a1', name='Same', tmdb='111')
        good = movie('b1', name='Same', tmdb='111')
        wrong = movie('b2', name='Same', tmdb='222')
        a = FakeJellyfin('a', [src], {'a1'})
        b = FakeJellyfin('b', [good, wrong], set())
        app.sync_pair(self.pair(), {'a': a, 'b': b})
        self.assertIn('b1', b.likes)
        self.assertNotIn('b2', b.likes)
        self.assertEqual(app.all_mappings('pair1')[0]['match_method'], 'provider')

    def test_provider_index_matches_even_when_titles_differ(self):
        src = movie('a1', name='Title A', tmdb='777', path=None)
        dst = movie('b1', name='Completely Different Title', tmdb='777', path=None)
        a = FakeJellyfin('a', [src], {'a1'})
        b = FakeJellyfin('b', [dst], set())
        app.sync_pair(self.pair(), {'a': a, 'b': b})
        self.assertIn('b1', b.likes)
        self.assertEqual(app.all_mappings('pair1')[0]['match_method'], 'provider-index')

    def test_media_source_path_is_used_when_item_path_missing(self):
        a = movie('a1', tmdb=None, path=None)
        b = movie('b1', tmdb=None, path=None)
        a['MediaSources'] = [{'Path': '/mnt/media/Foo/Foo.mkv'}]
        b['MediaSources'] = [{'Path': r'Z:\\Other\\Foo\\Foo.mkv'}]
        self.assertEqual(app.path_fingerprints(a)['media'], app.path_fingerprints(b)['media'])

    def test_invalid_numeric_config_falls_back_safely(self):
        cfg = app.sanitize_config({
            'poll_seconds': 'not-a-number',
            'path_matching': {'enabled': True, 'index_ttl_hours': 'bad'},
            'server_a': {}, 'server_b': {}, 'pairs': []
        })
        self.assertEqual(cfg['poll_seconds'], 15)
        self.assertEqual(cfg['path_matching']['index_ttl_hours'], 6)

    def test_season_logical_key_uses_provider_id_when_available(self):
        a = {'Type': 'Season', 'SeriesName': 'Show', 'IndexNumber': 1,
             'ProductionYear': 2024, 'ProviderIds': {'Tvdb': '12345'}}
        b = {'Type': 'Season', 'SeriesName': 'Renamed Show', 'IndexNumber': 1,
             'ProductionYear': 2024, 'ProviderIds': {'Tvdb': '12345'}}
        self.assertEqual(app.logical_key(a), app.logical_key(b))

    def test_season_logical_key_distinguishes_same_name_remakes(self):
        a = {'Type': 'Season', 'SeriesName': 'The Show', 'IndexNumber': 1,
             'ProductionYear': 1995, 'ProviderIds': {}}
        b = {'Type': 'Season', 'SeriesName': 'The Show', 'IndexNumber': 1,
             'ProductionYear': 2025, 'ProviderIds': {}}
        self.assertNotEqual(app.logical_key(a), app.logical_key(b))


if __name__ == '__main__':
    unittest.main()
