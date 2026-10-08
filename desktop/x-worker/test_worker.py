import copy
import unittest
from unittest.mock import patch
import worker


def account(uid='123', handle='author'):
    return dict(rest_id=uid, core=dict(screen_name=handle, name='Author'), legacy=dict(protected=False))


def post(tid='1234567890123456789', text='短い 📈 &amp; exact'):
    return dict(rest_id=tid, core=dict(user_results=dict(result=account())), legacy=dict(full_text=text,
        created_at='Wed Sep 16 12:00:00 +0000 2026', favorite_count=0, conversation_id_str=tid))


def timeline(posts, cursor='next'):
    entries = [dict(content=dict(itemContent=dict(tweet_results=dict(result=p)))) for p in posts]
    if cursor:
        entries.append(dict(content=dict(cursorType='Bottom', value=cursor)))
    return [dict(entries=entries)]


class NormalizationTests(unittest.TestCase):
    def test_session_identity_hint_requires_matching_authenticated_profile(self):
        from unittest.mock import MagicMock
        client = MagicMock()
        client._graphql_get.return_value = dict(data=dict(user=dict(result=account())))
        result = worker.verify_session_profile(client, {}, 'twid="u%3D123"')
        self.assertEqual(result['user']['userId'], '123')
        with self.assertRaises(worker.Failure):
            worker.verify_session_profile(client, {}, 'twid="u%3D999"')
        client._graphql_get.side_effect = worker.Failure('session_expired')
        with self.assertRaises(worker.Failure) as failure:
            worker.verify_session_profile(client, {}, 'twid="u%3D123"')
        self.assertEqual(failure.exception.code, 'session_expired')

    def test_missing_identity_endpoints_are_not_a_missing_account(self):
        from unittest.mock import MagicMock
        client = MagicMock()
        client._api_request.side_effect = worker.Failure('not_found')
        with patch.object(worker, 'client_for', return_value=(client, {})):
            with self.assertRaises(worker.Failure) as failure:
                worker.dispatch(dict(protocol=1, operation='status', credentials=dict(cookieHeader='synthetic')))
        self.assertEqual(failure.exception.code, 'invalid_response')
        self.assertEqual(client._api_request.call_count, 2)

    def test_stale_graphql_endpoint_refreshes_before_reporting_failure(self):
        from unittest.mock import MagicMock
        from twitter_cli.graphql import FALLBACK_QUERY_IDS
        stale, good = MagicMock(), MagicMock()
        stale.status_code = 404
        good.status_code = 200
        good.json.return_value = dict(data=dict(user=dict(result=account())))
        with patch('twitter_cli.client.TwitterClient._ensure_client_transaction'), \
             patch('twitter_cli.client._resolve_query_id', side_effect=[FALLBACK_QUERY_IDS['UserByScreenName'], 'fresh']) as resolve, \
             patch('twitter_cli.client._get_cffi_session') as session:
            session.return_value.get.side_effect = [stale, good]
            client, features = worker.client_for('auth_token=synthetic; ct0=csrf')
            result, _ = worker.lookup(client, features, 'author')
            self.assertEqual(result['userId'], '123')
            self.assertEqual(resolve.call_count, 2)
            self.assertFalse(resolve.call_args.kwargs['prefer_fallback'])

    def test_unrelated_browser_cookie_does_not_hide_credentials(self):
        with patch('twitter_cli.client.TwitterClient._ensure_client_transaction'):
            client, _ = worker.client_for('g_state={"i_l":0}; auth_token=synthetic; ct0=csrf')
        self.assertEqual(client._auth_token, 'synthetic')
        self.assertEqual(client._ct0, 'csrf')

    def test_people_search_reads_typeahead_users_only(self):
        from unittest.mock import MagicMock
        client = MagicMock()
        client._api_request.return_value = dict(users=[
            dict(id_str='123', screen_name='PewDiePie', name='PewDiePie', ext_is_blue_verified=True,
                 profile_image_url_https='https://pbs.twimg.com/profile_images/1/a_normal.jpg'),
            dict(id=456, screen_name='quiet_one', name=' ', is_protected=True, profile_image_url_https='http://insecure'),
            dict(id_str='789', screen_name='not a handle', name='Broken'),
            'garbage',
        ], topics=[dict(topic='ignored')])
        with patch.object(worker, 'client_for', return_value=(client, {})):
            result = worker.dispatch(dict(protocol=1, operation='user_search', params=dict(query=' pewdiepie '),
                                          credentials=dict(cookieHeader='synthetic')))
        url = client._api_request.call_args.args[0]
        self.assertTrue(url.startswith('https://x.com/i/api/1.1/search/typeahead.json?'))
        self.assertIn('q=pewdiepie&', url)
        self.assertEqual(result['users'], [
            dict(userId='123', handle='PewDiePie', displayName='PewDiePie',
                 avatarUrl='https://pbs.twimg.com/profile_images/1/a_normal.jpg', verified=True, protected=False),
            dict(userId='456', handle='quiet_one', displayName='quiet_one', avatarUrl=None, verified=False, protected=True),
        ])
        for bad in ('', 'x' * 101, 'line\nbreak', None):
            with self.assertRaises(worker.Failure):
                worker.search_users(client, bad)
        client._api_request.return_value = dict(errors=[])
        with self.assertRaises(worker.Failure):
            worker.search_users(client, 'pewdiepie')

    def test_full_text_entities_nullable_metrics_and_ids(self):
        raw = post()
        raw['note_tweet'] = dict(note_tweet_results=dict(result=dict(text='long 📈 &amp; note ' * 100)))
        result = worker.tweet(raw)
        self.assertEqual(result['id'], '1234567890123456789')
        self.assertEqual(result['text'], 'long 📈 & note ' * 100)
        self.assertEqual(result['contentStatus'], 'complete')
        self.assertIsNone(result['replyCount'])
        self.assertEqual(result['likeCount'], 0)

    def test_protected_author_rejected(self):
        raw = post()
        raw['core']['user_results']['result']['legacy']['protected'] = True
        with self.assertRaises(worker.Failure) as caught:
            worker.tweet(raw)
        self.assertEqual(caught.exception.code, 'protected_account')

    def test_quote_and_repost_attribution_and_time(self):
        original = post('123', 'original')
        quote = post('124', 'quote')
        original['quoted_status_result'] = dict(result=quote)
        wrapper = post('125', 'RT original')
        wrapper['core']['user_results']['result'] = account('456', 'reposter')
        wrapper['legacy']['retweeted_status_result'] = dict(result=original)
        wrapper['legacy']['created_at'] = 'Thu Sep 17 12:00:00 +0000 2026'
        items, _ = worker.page_items(timeline([wrapper]))
        result = items[0]
        self.assertEqual(result['tweet']['id'], '123')
        self.assertEqual(result['tweet']['author']['handle'], 'author')
        self.assertEqual(result['tweet']['quoted']['text'], 'quote')
        self.assertEqual(result['tweet']['repostedByHandle'], 'reposter')
        self.assertTrue(result['timelineAt'].startswith('2026-09-17'))
        self.assertTrue(result['tweet']['publishedAt'].startswith('2026-09-16'))

    def test_truncation_and_replies(self):
        raw = post()
        raw['legacy'].update(truncated=True, in_reply_to_status_id_str='999', in_reply_to_screen_name='other')
        items, _ = worker.page_items(timeline([raw]))
        self.assertEqual(items[0]['timelineKind'], 'reply')
        self.assertEqual(items[0]['tweet']['contentStatus'], 'summary')

    def test_invalid_operations_never_construct_client(self):
        with patch.object(worker, 'client_for') as client:
            for operation in ['post', 'like', 'follow', '/bin/sh', 'connect']:
                with self.assertRaises(worker.Failure):
                    worker.dispatch(dict(protocol=1, operation=operation))
            client.assert_not_called()

    def test_pagination_does_not_discard_overflow(self):
        class Client:
            def _graphql_get(self, operation, variables, _features):
                if operation == 'UserByScreenName':
                    return dict(data=dict(user=dict(result=account())))
                self.variables = variables
                return dict(data=dict(user=dict(result=dict(timeline_v2=dict(timeline=dict(
                    instructions=timeline([post(str(n)) for n in range(1, 6)])))))))
        client = Client()
        with patch.object(worker, 'client_for', return_value=(client, {})):
            request = dict(protocol=1, operation='user_posts', credentials=dict(cookieHeader='synthetic'),
                           params=dict(userId='123', handle='author', limit=2))
            first = worker.dispatch(request)
            request['params']['cursor'] = first['nextCursor']
            second = worker.dispatch(request)
            request['params']['cursor'] = second['nextCursor']
            third = worker.dispatch(request)
            self.assertEqual([item['tweet']['id'] for page in [first, second, third] for item in page['items']], ['1','2','3','4','5'])
            self.assertEqual(client.variables['userId'], '123')

    def test_timeline_reads_never_look_up_the_handle_again(self):
        class Client:
            calls = []

            def _graphql_get(self, operation, variables, _features):
                self.calls.append(operation)
                return dict(data=dict(user=dict(result=dict(timeline_v2=dict(timeline=dict(
                    instructions=timeline([post('1')])))))))
        client = Client()
        with patch.object(worker, 'client_for', return_value=(client, {})):
            worker.dispatch(dict(protocol=1, operation='user_posts', credentials=dict(cookieHeader='synthetic'),
                                 params=dict(userId='123', handle='author', limit=20)))
        self.assertEqual(client.calls, ['UserTweets'])

    def test_transaction_seed_shape_is_validated(self):
        self.assertIsNone(worker.transaction_seed(None))
        self.assertIsNone(worker.transaction_seed(dict(homeHtml='', ondemandText='x')))
        self.assertIsNone(worker.transaction_seed(dict(homeHtml='x' * (worker.MAX_SEED_HTML + 1), ondemandText='x')))
        self.assertEqual(worker.transaction_seed(dict(homeHtml='<html>', ondemandText='js', extra=1)),
                         dict(homeHtml='<html>', ondemandText='js'))

    def test_seeded_client_skips_homepage_download_and_fresh_seed_is_returned(self):
        seed = dict(homeHtml='<html></html>', ondemandText='js')
        with patch('twitter_cli.client.ClientTransaction') as transaction, \
             patch('twitter_cli.client._update_features_from_html'), \
             patch('twitter_cli.client._get_cffi_session') as session:
            worker.client_for('auth_token=a; ct0=b', seed)
            transaction.assert_called_once()
            session.assert_not_called()
        worker.FRESH_TRANSACTION.clear()
        with patch('twitter_cli.client.TwitterClient._ensure_client_transaction'):
            client, _ = worker.client_for('auth_token=a; ct0=b')
            client._save_ct_cache('<html>fresh</html>', 'bundle')
        self.assertEqual(worker.FRESH_TRANSACTION, dict(homeHtml='<html>fresh</html>', ondemandText='bundle'))
        worker.FRESH_TRANSACTION.clear()

    def test_rate_limit_wait_follows_x_headers(self):
        self.assertEqual(worker.retry_after({'retry-after': '30'}, now=1000), 30)
        self.assertEqual(worker.retry_after({'x-rate-limit-reset': '1600'}, now=1000), 601)
        self.assertEqual(worker.retry_after({'x-rate-limit-reset': '900'}, now=1000), 60)
        self.assertEqual(worker.retry_after({'x-rate-limit-reset': '99999'}, now=1000), 60)
        self.assertEqual(worker.retry_after({}, now=1000), 60)
        self.assertEqual(worker.rate_limit({'x-rate-limit-limit': '50', 'x-rate-limit-remaining': '0',
                                            'x-rate-limit-reset': '1600'}),
                         dict(limit=50, remaining=0, reset=1600))
        self.assertIsNone(worker.rate_limit({}))

    def test_upstream_constructor_and_private_read_contract(self):
        import inspect
        from twitter_cli.client import TwitterClient
        self.assertIn('cookie_string', inspect.signature(TwitterClient).parameters)
        self.assertIn('field_toggles', inspect.signature(TwitterClient._graphql_get).parameters)
        self.assertIn('method', inspect.signature(TwitterClient._api_request).parameters)


if __name__ == '__main__':
    unittest.main()
