"""Scope's read-only adapter for twitter-cli at the commit in upstream.json.

One bounded JSON request over stdin. Never imports upstream auth/CLI/config or
extracts browser cookies. Session credentials belong to Electron main only.
"""
import base64
import contextlib
import html
import io
import json
import logging
import re
import sys
import time
from datetime import datetime
from email.utils import parsedate_to_datetime
from http.cookies import SimpleCookie
from urllib.parse import urlencode, urlparse, unquote

PROTOCOL = 1
# Requests may carry the in-memory transaction seed (homepage + ondemand bundle).
MAX_REQUEST = 4 * 1024 * 1024
MAX_SEED_HTML = 3 * 1024 * 1024
MAX_SEED_SCRIPT = 1024 * 1024
ID = re.compile(r"^[0-9]{1,20}$")
HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
DIAGNOSTIC = {"stage": "request", "httpStatus": None}
# Transaction material fetched during this request, handed back to the host so the
# next request can skip re-downloading x.com's homepage and ondemand bundle.
FRESH_TRANSACTION = {}


def retry_after(headers, now=None):
    """Seconds until X accepts reads again: Retry-After, else the rate window's reset, else a minute."""
    retry = str(headers.get("retry-after") or "")
    if retry.isdigit():
        return int(retry)
    reset = str(headers.get("x-rate-limit-reset") or "")
    if reset.isdigit():
        wait = int(reset) - int(time.time() if now is None else now)
        # A reset in the past or implausibly far out is clock skew, not a real window.
        if 0 <= wait <= 3600:
            return wait + 1
    return 60


def rate_limit(headers):
    """X's per-endpoint quota headers, for diagnostics only."""
    values = {key: str(headers.get(f"x-rate-limit-{key}") or "") for key in ("limit", "remaining", "reset")}
    return {key: int(value) for key, value in values.items() if value.isdigit()} or None


class Failure(Exception):
    def __init__(self, code, retry=None):
        self.code, self.retry = code, retry


def get(value, *keys):
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise Failure("invalid_response")
    return value


def iso(value):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).isoformat()
    except (ValueError, TypeError):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
        except (ValueError, TypeError):
            return None


def user(raw, public=True):
    if not isinstance(raw, dict) or raw.get("__typename") in ("UserUnavailable", "UserTombstone"):
        raise Failure("not_found")
    legacy = raw.get("legacy", {})
    if public and (legacy.get("protected") is True or get(raw, "privacy", "protected") is True):
        raise Failure("protected_account")
    handle = get(raw, "core", "screen_name") or legacy.get("screen_name")
    if not isinstance(handle, str) or not HANDLE.fullmatch(handle):
        raise Failure("invalid_response")
    return dict(userId=identifier(raw.get("rest_id")), handle=handle,
                displayName=get(raw, "core", "name") or legacy.get("name") or handle,
                avatarUrl=get(raw, "avatar", "image_url") or legacy.get("profile_image_url_https"),
                description=legacy.get("description"))


def tweet(raw, depth=0):
    if not isinstance(raw, dict) or depth > 2:
        return None
    if raw.get("__typename") == "TweetWithVisibilityResults":
        raw = raw.get("tweet", {})
    if raw.get("__typename") in ("TweetTombstone", "TweetUnavailable"):
        return None
    legacy = raw.get("legacy")
    if not isinstance(legacy, dict):
        return None
    author = user(get(raw, "core", "user_results", "result"))
    repost = get(legacy, "retweeted_status_result", "result")
    if repost:
        original = tweet(repost, depth + 1)
        if original:
            original.update(isRepost=True, repostedByUserId=author["userId"], repostedByHandle=author["handle"])
        return original
    tid = identifier(raw.get("rest_id"))
    note = get(raw, "note_tweet", "note_tweet_results", "result")
    text = get(note, "text") or legacy.get("full_text", "")
    if not isinstance(text, str):
        raise Failure("invalid_response")
    entities = get(note, "entity_set", "urls") or get(legacy, "entities", "urls") or []
    for entity in entities:
        if entity.get("url") and entity.get("expanded_url"):
            text = text.replace(entity["url"], entity["expanded_url"])
    media = []
    for item in get(legacy, "extended_entities", "media") or []:
        preview = item.get("media_url_https")
        if preview:
            media.append(dict(kind={"animated_gif": "gif", "video": "video"}.get(item.get("type"), "photo"),
                              url=preview, previewUrl=preview, altText=item.get("ext_alt_text")))
    quote = tweet(get(raw, "quoted_status_result", "result"), depth + 1)
    quoted = None if not quote else dict(tweetId=quote["id"], userId=quote["author"]["userId"],
        handle=quote["author"]["handle"], name=quote["author"]["displayName"], text=quote["text"], url=quote["url"])
    # Restricted and truncated previews are never eligible for analysis.
    restricted = raw.get("__typename") == "TweetPreviewDisplay" or bool(raw.get("limitedActionResults"))
    complete = bool(text) and not restricted and (bool(get(note, "text")) or legacy.get("truncated") is not True)
    count = lambda name: legacy.get(name) if isinstance(legacy.get(name), int) and legacy[name] >= 0 else None
    return dict(id=tid, author=author, text=html.unescape(text), language=legacy.get("lang"),
        url=f"https://x.com/{author['handle']}/status/{tid}", publishedAt=iso(legacy.get("created_at")),
        replyCount=count("reply_count"), repostCount=count("retweet_count"), likeCount=count("favorite_count"), quoteCount=count("quote_count"),
        contentStatus="complete" if complete else "summary" if text else "unavailable", isRepost=False,
        conversationId=legacy.get("conversation_id_str"), inReplyToTweetId=legacy.get("in_reply_to_status_id_str"),
        inReplyToUserId=legacy.get("in_reply_to_user_id_str"), inReplyToHandle=legacy.get("in_reply_to_screen_name"),
        quoted=quoted, media=media)


def page_items(instructions):
    if not isinstance(instructions, list):
        raise Failure("invalid_response")
    items, cursor, seen = [], None, set()
    for instruction in instructions:
        entries = instruction.get("entries", [])
        if instruction.get("entry"):
            entries = [*entries, instruction["entry"]]
        for entry in entries:
            content = entry.get("content", {})
            if content.get("cursorType") == "Bottom":
                cursor = content.get("value")
            candidates = [content.get("itemContent", {})]
            candidates += [get(nested, "item", "itemContent") or {} for nested in content.get("items", [])]
            for candidate in candidates:
                if candidate.get("promotedMetadata"):
                    continue
                raw = get(candidate, "tweet_results", "result")
                try:
                    normalized = tweet(raw)
                except Failure as exc:
                    if exc.code == "protected_account":
                        continue  # Never collect private quoted/reposted content.
                    raise
                if not normalized or normalized["id"] in seen:
                    continue
                seen.add(normalized["id"])
                original = raw.get("tweet", raw) if isinstance(raw, dict) else {}
                event_time = iso(get(original, "legacy", "created_at"))
                kind = "repost" if normalized["isRepost"] else "reply" if normalized.get("inReplyToTweetId") else "post"
                items.append(dict(tweet=normalized, timelineKind=kind, timelineAt=event_time))
    return items, cursor


def transaction_seed(value):
    """A host-held transaction seed, or None. Never trusted beyond its shape."""
    if not isinstance(value, dict):
        return None
    home, script = value.get("homeHtml"), value.get("ondemandText")
    if not isinstance(home, str) or not isinstance(script, str) or not home or not script:
        return None
    if len(home) > MAX_SEED_HTML or len(script) > MAX_SEED_SCRIPT:
        return None
    return dict(homeHtml=home, ondemandText=script)


def client_for(cookie_header, seed=None):
    from twitter_cli import client as upstream
    from twitter_cli.client import TwitterClient, _get_cffi_session
    from twitter_cli.graphql import FEATURES
    from twitter_cli.exceptions import TwitterAPIError

    class ReadClient(TwitterClient):
        def _load_ct_cache(self):
            # The host keeps the seed in memory only; nothing is read from disk.
            if seed is None:
                return False
            try:
                home = upstream.bs4.BeautifulSoup(seed["homeHtml"], "html.parser")
                self._client_transaction = upstream.ClientTransaction(
                    home_page_response=home, ondemand_file_response=seed["ondemandText"])
                upstream._update_features_from_html(seed["homeHtml"])
                return True
            except Exception:
                return False

        def _save_ct_cache(self, home_html, ondemand_text):
            # No HTML, credentials or browser data written to disk: the seed goes
            # back over the pipe and lives in the host's memory.
            FRESH_TRANSACTION.clear()
            if isinstance(home_html, str) and isinstance(ondemand_text, str):
                FRESH_TRANSACTION.update(transaction_seed(dict(homeHtml=home_html, ondemandText=ondemand_text)) or {})

        def _graphql_get(self, operation_name, *args, **kwargs):
            if operation_name not in {"UserByScreenName", "UserByRestId", "UserTweets", "TweetResultByRestId"}:
                raise Failure("invalid_response")
            try:
                return super()._graphql_get(operation_name, *args, **kwargs)
            except TwitterAPIError:
                # An obsolete endpoint is not evidence that an account vanished.
                raise Failure("invalid_response")

        def _api_request(self, url, method="GET", body=None):
            target = urlparse(url)
            if method != "GET" or target.scheme != "https" or target.hostname not in {"x.com", "api.x.com"}:
                raise Failure("invalid_response")
            DIAGNOSTIC.update(stage=("profile" if target.path.endswith(("/UserByScreenName", "/UserByRestId")) else
                "user_search" if target.path.endswith("/search/typeahead.json") else
                "verify_credentials" if target.path.endswith("/verify_credentials.json") else
                "account_settings" if target.path.endswith("/settings.json") else "read"), httpStatus=None)
            response = _get_cffi_session().get(url, headers=self._build_headers(url=url, method="GET"),
                                              timeout=20, allow_redirects=False)
            code = response.status_code
            DIAGNOSTIC.update(httpStatus=code, rateLimit=rate_limit(response.headers))
            if code == 401:
                raise Failure("session_expired")
            if code == 403 or 300 <= code < 400:
                raise Failure("verification_required")
            if code == 429:
                raise Failure("rate_limited", retry_after(response.headers))
            if code in (404, 422) and target.path.startswith("/i/api/graphql/"):
                # Preserve the pinned client's single live-query-ID refresh.
                raise TwitterAPIError(code, "GraphQL endpoint needs refresh")
            if code == 404:
                raise Failure("not_found")
            if code != 200:
                raise Failure("network" if code >= 500 else "invalid_response")
            data = response.json()
            if not isinstance(data, dict):
                raise Failure("invalid_response")
            errors = data.get("errors") or []
            if errors:
                code = errors[0].get("code")
                raise Failure({88: "rate_limited", 89: "session_expired", 32: "session_expired", 326: "verification_required", 144: "not_found"}.get(code, "invalid_response"), retry_after(response.headers) if code == 88 else None)
            return data

    # Chromium may include unrelated cookies with values (for example JSON)
    # that SimpleCookie rejects. Parse only the two authentication fields;
    # preserve the original browser header for the actual request.
    jar = SimpleCookie()
    for part in cookie_header.split(";"):
        name, separator, value = part.strip().partition("=")
        if separator and name in {"auth_token", "ct0"}:
            jar.load(f"{name}={value}")
    if not jar.get("auth_token") or not jar.get("ct0"):
        raise Failure("not_connected")
    return ReadClient(jar["auth_token"].value, jar["ct0"].value,
                      rate_limit_config={"maxRetries": 0, "maxCount": 100}, cookie_string=cookie_header), FEATURES


def profile_features(features):
    return {**features,
        "hidden_profile_subscriptions_enabled": True,
        "rweb_tipjar_consumption_enabled": True,
        "subscriptions_verification_info_is_identity_verified_enabled": True,
        "subscriptions_verification_info_verified_since_enabled": True,
        "highlights_tweets_tab_ui_enabled": True,
        "responsive_web_twitter_article_notes_tab_enabled": True,
        "subscriptions_feature_can_gift_premium": True,
    }
def lookup(client, features, handle, public=True):
    if not isinstance(handle, str) or not HANDLE.fullmatch(handle):
        raise Failure("invalid_response")
    data = client._graphql_get("UserByScreenName", {"screen_name": handle, "withSafetyModeUserFields": True}, profile_features(features))
    raw = get(data, "data", "user", "result")
    return user(raw, public), get(raw, "legacy", "pinned_tweet_ids_str") or []


def search_users(client, query):
    # X's own people typeahead (the x.com search box): one read-only GET that
    # returns ranked accounts. Only fields Scope stores or displays are kept.
    if not isinstance(query, str) or not query.strip() or len(query) > 100 or re.search(r"[\x00-\x1f\x7f]", query):
        raise Failure("invalid_response")
    params = urlencode({"include_ext_is_blue_verified": 1, "include_ext_verified_type": 1,
                        "include_ext_profile_image_shape": 1, "q": query.strip(),
                        "src": "search_box", "result_type": "users"})
    data = client._api_request(f"https://x.com/i/api/1.1/search/typeahead.json?{params}")
    raw_users = data.get("users")
    if not isinstance(raw_users, list):
        raise Failure("invalid_response")
    users = []
    for raw in raw_users[:20]:
        if not isinstance(raw, dict):
            continue
        handle = raw.get("screen_name")
        uid = raw.get("id_str") or (str(raw["id"]) if isinstance(raw.get("id"), int) else None)
        if not isinstance(handle, str) or not HANDLE.fullmatch(handle) or not isinstance(uid, str) or not ID.match(uid):
            continue
        avatar = raw.get("profile_image_url_https")
        users.append(dict(userId=uid, handle=handle,
                          displayName=raw.get("name") if isinstance(raw.get("name"), str) and raw.get("name").strip() else handle,
                          avatarUrl=avatar if isinstance(avatar, str) and avatar.startswith("https://") else None,
                          verified=bool(raw.get("verified") or raw.get("ext_is_blue_verified") or raw.get("ext_verified_type")),
                          protected=bool(raw.get("is_protected") or raw.get("protected"))))
        if len(users) == 10:
            break
    return dict(users=users)


def verify_session_profile(client, features, header):
    # twid is only an identity hint from the isolated browser session. A successful
    # authenticated GraphQL response with the same ID is mandatory.
    uid = None
    for part in header.split(";"):
        name, _, value = part.strip().partition("=")
        if name == "twid":
            match = re.fullmatch(r'u=(\d{1,20})', unquote(value.strip('"')))
            uid = match.group(1) if match else None
    if not uid:
        raise Failure("invalid_response")
    data = client._graphql_get("UserByRestId", {"userId": uid, "withSafetyModeUserFields": True}, profile_features(features))
    identity = user(get(data, "data", "user", "result"), public=False)
    if identity["userId"] != uid:
        raise Failure("invalid_response")
    return dict(connected=True, user=identity)


def dispatch(request):
    if not isinstance(request, dict) or request.get("protocol") != PROTOCOL:
        raise Failure("invalid_response")
    operation = request.get("operation")
    if operation == "runtime":
        # Import native dependencies without making a request, including in clean-package CI.
        from twitter_cli.client import TwitterClient  # noqa: F401
        return {"version": "0.8.6", "commit": "7c634e0d396b1e7af9f63315b414925fe4f29ae7"}
    if operation not in {"status", "user", "user_search", "user_posts", "tweet"}:
        raise Failure("invalid_response")
    header = get(request, "credentials", "cookieHeader")
    if not isinstance(header, str) or len(header) > 32768 or "\n" in header or "\r" in header:
        raise Failure("not_connected")
    params = request.get("params") or {}
    if not isinstance(params, dict):
        raise Failure("invalid_response")
    client, features = client_for(header, transaction_seed(request.get("transaction")))
    if operation == "status":
        # Fail closed: a successful authenticated identity AND profile read are required.
        try:
            data = client._api_request("https://api.x.com/1.1/account/verify_credentials.json")
        except Failure as exc:
            if exc.code != "not_found":
                raise
            try:
                data = client._api_request("https://x.com/i/api/1.1/account/settings.json")
            except Failure as fallback:
                if fallback.code == "not_found":
                    return verify_session_profile(client, features, header)
                raise
        identity, _ = lookup(client, features, data.get("screen_name"), public=False)
        return dict(connected=True, user=identity)
    if operation == "user_search":
        return search_users(client, params.get("query"))
    if operation == "user":
        identity, pinned = lookup(client, features, params.get("handle"))
        return dict(user=identity, pinnedTweetId=pinned[0] if pinned else None)
    if operation == "tweet":
        tid = identifier(params.get("tweetId"))
        data = client._graphql_get("TweetResultByRestId", {"tweetId": tid, "withCommunity": False, "includePromotedContent": False, "withVoice": True}, features)
        result = tweet(get(data, "data", "tweetResult", "result"))
        if result and result["id"] != tid:
            raise Failure("invalid_response")
        return dict(found=result is not None, tweet=result)
    # The timeline is addressed by the saved numeric id, so a recycled handle can never
    # change whose posts are read; the host resolves the handle once per traversal.
    uid = identifier(params.get("userId"))
    limit = params.get("limit", 20)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise Failure("invalid_response")
    cursor, skip = None, 0
    if params.get("cursor"):
        try:
            value = json.loads(base64.urlsafe_b64decode(params["cursor"]).decode())
            if value.get("userId") != uid:
                raise ValueError()
            cursor, skip = value.get("cursor"), value.get("skip", 0)
            if (cursor is not None and (not isinstance(cursor, str) or len(cursor) > 2048)) or not isinstance(skip, int) or not 0 <= skip <= 1000:
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise Failure("invalid_response")
    variables = dict(userId=uid, count=100, includePromotedContent=False,
                     withQuickPromoteEligibilityTweetFields=True, withVoice=True, withV2Timeline=True)
    if cursor:
        variables["cursor"] = cursor
    data = client._graphql_get("UserTweets", variables, features)
    raw = get(data, "data", "user", "result")
    if get(raw, "legacy", "protected") is True:
        raise Failure("protected_account")
    instructions = get(raw, "timeline", "timeline", "instructions")
    if instructions is None:
        instructions = get(raw, "timeline_v2", "timeline", "instructions")
    items, next_cursor = page_items(instructions)
    selected = items[skip:skip + limit]
    if skip + len(selected) < len(items):
        continuation = dict(userId=uid, cursor=cursor, skip=skip + len(selected))
    elif next_cursor and next_cursor != cursor:
        continuation = dict(userId=uid, cursor=next_cursor, skip=0)
    else:
        continuation = None
    encoded = base64.urlsafe_b64encode(json.dumps(continuation).encode()).decode() if continuation else None
    return dict(items=selected, nextCursor=encoded, exhausted=encoded is None)


def main():
    logging.disable(logging.CRITICAL)
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise Failure("invalid_response")
        request = json.loads(raw)
        # Upstream diagnostics must never become protocol output or leak credentials.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            data = dispatch(request)
        envelope = dict(ok=True, schema_version=1, data=data)
    except Failure as exc:
        envelope = dict(ok=False, error=dict(code=exc.code, retryAfterSeconds=exc.retry), diagnostic=DIAGNOSTIC)
    except Exception:
        envelope = dict(ok=False, error=dict(code="invalid_response"), diagnostic=DIAGNOSTIC)
    if FRESH_TRANSACTION:
        envelope["transaction"] = dict(FRESH_TRANSACTION)
    sys.stdout.write(json.dumps(envelope, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
