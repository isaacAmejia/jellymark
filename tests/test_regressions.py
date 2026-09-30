import copy
import json
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import test_sync as fixtures

app = fixtures.app
movie, series, episode, FakeJellyfin = fixtures.movie, fixtures.series, fixtures.episode, fixtures.FakeJellyfin


class RegressionTests(unittest.TestCase):
    setUp = fixtures.Tests.setUp
    pair = fixtures.Tests.pair
    clients = fixtures.Tests.clients

    def test_duplicate_logical_keys_do_not_overwrite_source_mapping(self):
        clients = self.clients()
        clients['a'].catalog['a2'] = movie('a2')
        clients['a'].likes.add('a2')
        app.sync_pair(self.pair(), clients)
        rows = app.all_mappings('pair1')
        self.assertEqual({r['a_id'] for r in rows}, {'a1', 'a2'})
        self.assertEqual(sum(r['b_id'] == 'b1' for r in rows), 1)

    def test_identical_titles_do_not_join_unmatched_rows(self):
        clients = self.clients(('a1',), ('b1',))
        with patch.object(app, 'direct_match', return_value=(None, None, None)):
            app.sync_pair(self.pair(), clients)
        rows = app.all_mappings('pair1')
        self.assertEqual(len(rows), 2)
        self.assertFalse(any(r['a_id'] and r['b_id'] for r in rows))
        self.assertEqual(clients['b'].writes, [])

    def test_partial_rows_merge_after_identity_becomes_available(self):
        clients = self.clients(('a1',), ('b1',))
        with patch.object(app, 'direct_match', return_value=(None, None, None)):
            app.sync_pair(self.pair(), clients)
        app.sync_pair(self.pair(), clients)
        rows = app.all_mappings('pair1')
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['a_id'], rows[0]['b_id']), ('a1', 'b1'))

    def test_excluded_types_keep_baseline_and_likes(self):
        clients = self.clients()
        app.sync_pair(self.pair(), clients)
        before = app.all_mappings('pair1')[0]
        clients['a'].likes.clear()
        app.sync_pair(self.pair(types=['Series']), clients)
        self.assertIn('b1', clients['b'].likes)
        self.assertEqual(app.all_mappings('pair1')[0]['last_a'], before['last_a'])
        app.sync_pair(self.pair(), clients)
        self.assertNotIn('b1', clients['b'].likes)

    def test_deleted_item_does_not_remove_surviving_watchlist_entry(self):
        clients = self.clients()
        app.sync_pair(self.pair(), clients)
        clients['a'].likes.clear()
        del clients['a'].catalog['a1']
        app.sync_pair(self.pair(), clients)
        self.assertIn('b1', clients['b'].likes)
        self.assertEqual(app.all_mappings('pair1'), [])

    def test_replacement_item_can_remap(self):
        clients = self.clients()
        app.sync_pair(self.pair(), clients)
        clients['b'].likes.clear()
        del clients['b'].catalog['b1']
        clients['b'].catalog['b2'] = movie('b2')
        app.sync_pair(self.pair(), clients)
        app.sync_pair(self.pair(), clients)
        self.assertEqual(clients['b'].likes, {'b2'})

    def test_watched_target_does_not_get_readded(self):
        clients = self.clients()
        clients['b'].catalog['b1']['UserData']['Played'] = True
        app.sync_pair(self.pair(), clients)
        self.assertEqual(clients['a'].likes, set())
        self.assertEqual(clients['b'].likes, set())
        app.sync_pair(self.pair(), clients)
        self.assertEqual(clients['b'].likes, set())

    def test_series_path_matching_is_used_by_sync(self):
        sa, sb = series('sa', name='A'), series('sb', name='B')
        ea = episode('ea', series_id='sa', path='/mnt/Show/Season 01/ep.mkv')
        eb = episode('eb', series_id='sb', path='/tv/Show/Season 01/ep.mkv')
        clients = {'a': FakeJellyfin('a', [sa, ea], ['sa']), 'b': FakeJellyfin('b', [sb, eb])}
        app.sync_pair(self.pair(types=['Series']), clients)
        self.assertIn('sb', clients['b'].likes)

    def test_generic_episode_title_never_matches_another_series(self):
        source = episode('ea', series='First Show')
        target = episode('eb', series='Other Show')
        self.assertIsNone(app.safe_name_year_match(source, [target]))

    def test_title_fallback_requires_year_and_no_conflicting_provider(self):
        self.assertIsNone(app.safe_name_year_match(movie('a'), [movie('b', year=None)]))
        self.assertIsNone(app.safe_name_year_match(movie('a'), [movie('b', tmdb='wrong')]))

    def test_pagination_uses_total_even_when_server_caps_pages(self):
        client = app.JellyfinClient({'url': 'http://fake', 'api_key': 'x'}, 'a')
        pages = [{'Items': [movie('1')], 'TotalRecordCount': 2},
                 {'Items': [movie('2')], 'TotalRecordCount': 2}]
        with patch.object(client, 'get', side_effect=pages) as get:
            self.assertEqual(len(client.liked_items('u', ['Movie'])), 2)
        self.assertEqual(get.call_args_list[1].args[1]['StartIndex'], 1)

    def test_incomplete_or_invalid_snapshot_is_rejected(self):
        client = app.JellyfinClient({'url': 'http://fake', 'api_key': 'x'}, 'a')
        for data in [None, {}, {'Items': [], 'TotalRecordCount': 2}]:
            with self.subTest(data=data), patch.object(client, 'get', return_value=data):
                with self.assertRaises(RuntimeError):
                    client.liked_items('u', ['Movie'])

    def test_failed_read_makes_no_writes(self):
        clients = self.clients()
        with patch.object(clients['b'], 'liked_items', side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError):
                app.sync_pair(self.pair(), clients)
        self.assertEqual(clients['a'].writes + clients['b'].writes, [])

    def test_failed_write_is_retried_without_advancing_baseline(self):
        clients = self.clients()
        app.sync_pair(self.pair(), clients)
        clients['a'].likes.clear()
        with patch.object(clients['b'], 'set_like', side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError):
                app.sync_pair(self.pair(), clients)
        self.assertEqual(app.all_mappings('pair1')[0]['last_a'], 1)
        app.sync_pair(self.pair(), clients)
        self.assertEqual(clients['b'].likes, set())

    def test_empty_types_and_duplicate_pairs_are_rejected(self):
        for pairs in [[self.pair(types=[])], [self.pair(), self.pair()]]:
            with self.assertRaises(ValueError):
                app.sanitize_config({'pairs': pairs})


class HTTPTests(unittest.TestCase):
    def setUp(self):
        fixtures.Tests.setUp(self)
        self.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, data=None, auth=True):
        headers = {'Authorization': 'Bearer test-token'} if auth else {}
        req = Request(self.base + path, data=json.dumps(data).encode() if data is not None else None,
                      headers=headers)
        with urlopen(req) as response:
            return json.load(response)

    def test_health_and_auth_and_secret_redaction(self):
        self.assertTrue(self.request('/health', auth=False)['ok'])
        with self.assertRaises(HTTPError) as err:
            self.request('/api/config', auth=False)
        self.assertEqual(err.exception.code, 401)
        saved = self.request('/api/config', {'server_a': {'api_key': 'secret'}})
        self.assertEqual(saved['server_a']['api_key'], '')
        saved = self.request('/api/config', {'server_a': {'api_key': ''}})
        self.assertTrue(saved['server_a']['api_key_set'])
        self.assertEqual(app.CONFIG['server_a']['api_key'], 'secret')

    def test_changing_user_pair_resets_old_state(self):
        pair = fixtures.Tests.pair(self)
        app.CONFIG['pairs'] = [pair]
        app.update_pair_state(pair['id'], bootstrapped=1)
        new = {**pair, 'b_user_id': 'another-user'}
        self.request('/api/config', {'pairs': [new]})
        self.assertFalse(app.pair_state(pair['id'])['bootstrapped'])

    def test_connection_test_checks_authenticated_endpoint(self):
        with patch.object(app.JellyfinClient, 'system_info', return_value={'ServerName': 'Public'}), \
             patch.object(app.JellyfinClient, 'users', side_effect=RuntimeError('HTTP 401')):
            with self.assertRaises(HTTPError):
                self.request('/api/test', {})

