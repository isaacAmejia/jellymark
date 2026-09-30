#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 JellyMark contributors
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import ssl
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen

APP_VERSION = "3.0.1"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CONFIG_PATH = DATA_DIR / "config.json"
DB_PATH = DATA_DIR / "state.db"
ADMIN_TOKEN = os.environ.get("JWS_ADMIN_TOKEN", "").strip()
PORT = int(os.environ.get("PORT", "8788"))

ALL_TYPES = ["Movie", "Series", "Season", "Episode", "Video", "BoxSet", "Playlist"]
DEFAULT_TYPES = ["Movie", "Series", "Season", "Episode"]
# Only optional ItemFields enum values belong in Fields; identity/title/index/year
# properties are included in Jellyfin's base DTO.
FIELDS = "ProviderIds,Path,ParentId,MediaSources"


DEFAULT_CONFIG = {
    "poll_seconds": 15,
    "path_matching": {
        "enabled": True,
        "index_ttl_hours": 6,
    },
    "title_year_fallback": True,
    "server_a": {"name": "Main Jellyfin", "url": "", "api_key": "", "verify_tls": True},
    "server_b": {"name": "TV Jellyfin", "url": "", "api_key": "", "verify_tls": True},
    "pairs": [],
}

CONFIG_LOCK = threading.RLock()
SYNC_LOCK = threading.Lock()
WAKE_EVENT = threading.Event()
LOGS = deque(maxlen=500)
STATUS = {
    "running": False,
    "last_started": None,
    "last_finished": None,
    "last_error": None,
    "last_summary": None,
}

# In-memory path indexes are deliberately ephemeral. Persistent successful matches
# live in SQLite. The indexes are only a fallback when normal metadata matching
# cannot resolve an item.
PATH_INDEX_LOCK = threading.Lock()
PATH_INDEX_CACHE: dict[str, dict] = {}


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log(message: str, level: str = "INFO") -> None:
    line = f"{utcnow()} [{level}] {message}"
    LOGS.append(line)
    print(line, flush=True)


def deep_merge(base, update):
    if isinstance(base, dict) and isinstance(update, dict):
        out = dict(base)
        for key, value in update.items():
            out[key] = deep_merge(out[key], value) if key in out else value
        return out
    return update


def load_config() -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG)
        return json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        raw = json.loads(CONFIG_PATH.read_text())
        cfg = deep_merge(DEFAULT_CONFIG, raw)
        return sanitize_config(cfg)
    except Exception as exc:
        log(f"Could not read config.json: {exc}; using defaults", "ERROR")
        return json.loads(json.dumps(DEFAULT_CONFIG))


def sanitize_config(cfg: dict) -> dict:
    try:
        poll_seconds = max(5, int(cfg.get("poll_seconds", DEFAULT_CONFIG["poll_seconds"]) or DEFAULT_CONFIG["poll_seconds"]))
    except (TypeError, ValueError):
        poll_seconds = DEFAULT_CONFIG["poll_seconds"]

    raw_path = cfg.get("path_matching", {})
    if not isinstance(raw_path, dict):
        raw_path = {}
    path_matching = deep_merge(DEFAULT_CONFIG["path_matching"], raw_path)
    path_matching["enabled"] = bool(path_matching.get("enabled", True))
    try:
        path_matching["index_ttl_hours"] = max(0.25, float(path_matching.get("index_ttl_hours", 6) or 6))
    except (TypeError, ValueError):
        path_matching["index_ttl_hours"] = DEFAULT_CONFIG["path_matching"]["index_ttl_hours"]

    clean = {
        "poll_seconds": poll_seconds,
        "path_matching": path_matching,
        "title_year_fallback": bool(cfg.get("title_year_fallback", True)),
        "server_a": deep_merge(DEFAULT_CONFIG["server_a"], cfg.get("server_a", {}) if isinstance(cfg.get("server_a", {}), dict) else {}),
        "server_b": deep_merge(DEFAULT_CONFIG["server_b"], cfg.get("server_b", {}) if isinstance(cfg.get("server_b", {}), dict) else {}),
        "pairs": [],
    }
    allowed_pair_keys = {
        "id", "name", "enabled", "a_user_id", "a_user_name", "b_user_id", "b_user_name",
        "direction", "bootstrap", "conflict", "auto_remove_watched", "types",
    }
    if not isinstance(cfg.get("pairs", []), list):
        raise ValueError("pairs must be a list")
    seen_pair_ids = set()
    for pair in cfg.get("pairs", []):
        if isinstance(pair, dict):
            pair = {k: v for k, v in pair.items() if k in allowed_pair_keys}
            pair["id"] = str(pair.get("id") or uuid.uuid4())
            if pair["id"] in seen_pair_ids:
                raise ValueError("Pair IDs must be unique")
            seen_pair_ids.add(pair["id"])
            for key, allowed in (("direction", ("both", "a_to_b", "b_to_a")),
                                 ("bootstrap", ("a_to_b", "b_to_a", "merge")), ("conflict", ("a", "b"))):
                if key in pair and pair[key] not in allowed:
                    raise ValueError(f"Invalid pair {key}")
            if "types" in pair and (not isinstance(pair["types"], list) or not pair["types"] or
                                    any(t not in ALL_TYPES for t in pair["types"])):
                raise ValueError("Select at least one supported item type")
            clean["pairs"].append(pair)
    return clean


def save_config(cfg: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    clean = sanitize_config(json.loads(json.dumps(cfg)))
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(clean, indent=2))
    tmp.replace(CONFIG_PATH)


CONFIG = load_config()


def public_config() -> dict:
    with CONFIG_LOCK:
        cfg = json.loads(json.dumps(CONFIG))
    for key in ("server_a", "server_b"):
        secret = cfg.get(key, {}).get("api_key", "")
        cfg[key]["api_key_set"] = bool(secret)
        cfg[key]["api_key"] = ""
    return cfg


def normalize_url(url: str) -> str:
    return (url or "").strip().rstrip("/")


def ssl_context(verify: bool):
    return None if verify else ssl._create_unverified_context()  # noqa: SLF001


def http_json(base_url: str, path: str, *, method="GET", params=None, body=None,
              headers=None, verify_tls=True, timeout=20, allow_404=False):
    base_url = normalize_url(base_url)
    if not base_url:
        raise RuntimeError("URL is not configured")
    url = base_url + (path if path.startswith("/") else "/" + path)
    if params:
        clean = {k: v for k, v in params.items() if v is not None and v != ""}
        if clean:
            url += ("&" if "?" in url else "?") + urlencode(clean, doseq=True)
    data = None
    req_headers = {"Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    if body is not None:
        data = json.dumps(body).encode()
        req_headers["Content-Type"] = "application/json"
    req = Request(url, data=data, headers=req_headers, method=method)
    try:
        with urlopen(req, timeout=timeout, context=ssl_context(verify_tls)) as resp:
            raw = resp.read()
            if not raw:
                return None
            ctype = resp.headers.get("Content-Type", "")
            if "json" in ctype or raw[:1] in (b"{", b"["):
                return json.loads(raw.decode())
            return raw.decode(errors="replace")
    except HTTPError as exc:
        if allow_404 and exc.code == 404:
            return None
        try:
            detail = exc.read().decode(errors="replace")[:800]
        except Exception:
            detail = ""
        raise RuntimeError(f"HTTP {exc.code} {method} {url}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Cannot reach {url}: {exc.reason}") from exc


class JellyfinClient:
    def __init__(self, config: dict, side: str):
        self.side = side
        self.name = config.get("name") or f"Jellyfin {side.upper()}"
        self.url = normalize_url(config.get("url"))
        self.api_key = (config.get("api_key") or "").strip()
        self.verify_tls = bool(config.get("verify_tls", True))

    @property
    def ready(self):
        return bool(self.url and self.api_key)

    def auth(self):
        if not self.api_key:
            raise RuntimeError(f"{self.name}: API key is not configured")
        return {"Authorization": (
            f'MediaBrowser Client="JellyMark Sync", Device="Server", '
            f'DeviceId="jellymark-sync-{self.side}", Version="{APP_VERSION}", '
            f'Token="{self.api_key}"'
        )}

    def get(self, path, params=None, *, allow_404=False, timeout=20):
        return http_json(self.url, path, params=params, headers=self.auth(),
                         verify_tls=self.verify_tls, allow_404=allow_404, timeout=timeout)

    def post(self, path, params=None, body=None):
        return http_json(self.url, path, method="POST", params=params, body=body,
                         headers=self.auth(), verify_tls=self.verify_tls)

    def users(self):
        data = self.get("/Users") or []
        return sorted([{"id": x.get("Id"), "name": x.get("Name")} for x in data if x.get("Id")],
                      key=lambda x: (x["name"] or "").casefold())

    def system_info(self):
        return self.get("/System/Info/Public")

    def query_items(self, params, *, timeout=20):
        items = []
        seen = set()
        offset = 0
        while True:
            data = self.get("/Items", {**params, "StartIndex": offset, "Limit": 500,
                                      "EnableTotalRecordCount": "true"}, timeout=timeout)
            if not isinstance(data, dict) or not isinstance(data.get("Items"), list):
                raise RuntimeError(f"{self.name}: invalid item-list response; refusing incomplete sync")
            page = data["Items"]
            total = data.get("TotalRecordCount")
            if not page:
                if total is not None and offset < total:
                    raise RuntimeError(f"{self.name}: incomplete item-list response")
                return items
            for item in page:
                item_id = str(item.get("Id") or "")
                if not item_id or item_id in seen:
                    raise RuntimeError(f"{self.name}: duplicate/missing item ID during pagination")
                seen.add(item_id)
                items.append(item)
            offset += len(page)
            if total is not None and offset >= total:
                return items
            # Without a total, request until empty (servers can impose a page cap).

    def liked_items(self, user_id: str, types: list[str]):
        return self.query_items({
            "UserId": user_id, "Recursive": "true", "Filters": "Likes",
            "IncludeItemTypes": ",".join(types), "Fields": FIELDS,
            "EnableUserData": "true", "SortBy": "SortName",
        })

    def item(self, item_id: str, user_id: str | None = None):
        return self.get(f"/Items/{quote(str(item_id), safe='')}", {
            "UserId": user_id, "Fields": FIELDS, "EnableUserData": "true"
        }, allow_404=True)

    def search(self, user_id: str, name: str, item_type: str, limit: int = 60):
        data = self.get("/Items", {
            "UserId": user_id,
            "Recursive": "true",
            "SearchTerm": name,
            "IncludeItemTypes": item_type,
            "Fields": FIELDS,
            "EnableUserData": "true",
            "EnableTotalRecordCount": "false",
            "Limit": limit,
        }) or {}
        return data.get("Items") or []

    def all_items(self, user_id: str, types: list[str]):
        return self.query_items({
            "UserId": user_id, "Recursive": "true",
            "IncludeItemTypes": ",".join(types), "Fields": FIELDS,
            "EnableUserData": "false", "SortBy": "SortName",
        }, timeout=120)

    def children(self, user_id: str, parent_id: str, item_type: str, *, recursive=False,
                 index: int | None = None, parent_index: int | None = None):
        params = {
            "UserId": user_id,
            "ParentId": parent_id,
            "Recursive": "true" if recursive else "false",
            "IncludeItemTypes": item_type,
            "Fields": FIELDS,
            "EnableUserData": "true",
            "EnableTotalRecordCount": "false",
            "Limit": 5000,
        }
        if index is not None:
            params["IndexNumber"] = index
        if parent_index is not None:
            params["ParentIndexNumber"] = parent_index
        return self.query_items(params)

    def set_like(self, user_id: str, item_id: str, liked: bool):
        self.post(f"/UserItems/{quote(str(item_id), safe='')}/Rating",
                  {"UserId": user_id, "Likes": "true" if liked else "false"})


# ----------------------------- database ---------------------------------

@contextmanager
def db_connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db_connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS mappings (
            pair_id TEXT NOT NULL,
            logical_key TEXT NOT NULL,
            item_type TEXT,
            title TEXT,
            a_id TEXT,
            b_id TEXT,
            match_method TEXT,
            match_detail TEXT,
            last_a INTEGER,
            last_b INTEGER,
            last_seen REAL NOT NULL DEFAULT 0,
            PRIMARY KEY(pair_id, logical_key)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mapping_a
            ON mappings(pair_id, a_id) WHERE a_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mapping_b
            ON mappings(pair_id, b_id) WHERE b_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS pair_state (
            pair_id TEXT PRIMARY KEY,
            bootstrapped INTEGER NOT NULL DEFAULT 0,
            last_sync TEXT,
            last_error TEXT,
            last_stats TEXT
        );
        """)
        cols = {r[1] for r in db.execute("PRAGMA table_info(mappings)")}
        if "match_detail" not in cols:
            db.execute("ALTER TABLE mappings ADD COLUMN match_detail TEXT")


init_db()


def pair_state(pair_id: str):
    with db_connect() as db:
        row = db.execute("SELECT * FROM pair_state WHERE pair_id=?", (pair_id,)).fetchone()
        if row:
            return dict(row)
        db.execute("INSERT INTO pair_state(pair_id,bootstrapped) VALUES(?,0)", (pair_id,))
        return {"pair_id": pair_id, "bootstrapped": 0, "last_sync": None, "last_error": None, "last_stats": None}


def update_pair_state(pair_id: str, **values):
    if not values:
        return
    pair_state(pair_id)
    cols = ", ".join(f"{k}=?" for k in values)
    with db_connect() as db:
        db.execute(f"UPDATE pair_state SET {cols} WHERE pair_id=?", tuple(values.values()) + (pair_id,))


def reset_pair_state(pair_id: str):
    with db_connect() as db:
        db.execute("DELETE FROM mappings WHERE pair_id=?", (pair_id,))
        db.execute("DELETE FROM pair_state WHERE pair_id=?", (pair_id,))
    pair_state(pair_id)


def mapping_by_side(pair_id: str, side: str, item_id: str):
    col = "a_id" if side == "a" else "b_id"
    with db_connect() as db:
        row = db.execute(f"SELECT * FROM mappings WHERE pair_id=? AND {col}=?", (pair_id, str(item_id))).fetchone()
        return dict(row) if row else None


def mapping_by_key(pair_id: str, logical_key: str):
    with db_connect() as db:
        row = db.execute("SELECT * FROM mappings WHERE pair_id=? AND logical_key=?", (pair_id, logical_key)).fetchone()
        return dict(row) if row else None


def all_mappings(pair_id: str):
    with db_connect() as db:
        return [dict(r) for r in db.execute("SELECT * FROM mappings WHERE pair_id=? ORDER BY title", (pair_id,))]


def upsert_mapping(row: dict):
    cols = ["pair_id", "logical_key", "item_type", "title", "a_id", "b_id", "match_method",
            "match_detail", "last_a", "last_b", "last_seen"]
    vals = [row.get(c) for c in cols]
    with db_connect() as db:
        db.execute("""
        INSERT INTO mappings(pair_id,logical_key,item_type,title,a_id,b_id,match_method,match_detail,last_a,last_b,last_seen)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(pair_id,logical_key) DO UPDATE SET
            item_type=excluded.item_type,
            title=excluded.title,
            a_id=COALESCE(excluded.a_id,mappings.a_id),
            b_id=COALESCE(excluded.b_id,mappings.b_id),
            match_method=COALESCE(excluded.match_method,mappings.match_method),
            match_detail=COALESCE(excluded.match_detail,mappings.match_detail),
            last_a=COALESCE(excluded.last_a,mappings.last_a),
            last_b=COALESCE(excluded.last_b,mappings.last_b),
            last_seen=excluded.last_seen
        """, vals)


def update_mapping_state(pair_id: str, logical_key: str, **values):
    if not values:
        return
    cols = ", ".join(f"{k}=?" for k in values)
    with db_connect() as db:
        db.execute(f"UPDATE mappings SET {cols} WHERE pair_id=? AND logical_key=?",
                   tuple(values.values()) + (pair_id, logical_key))


# ----------------------------- matching ---------------------------------

def norm_text(value: str | None) -> str:
    value = (value or "").casefold()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def normalized_provider_ids(item: dict) -> dict[str, str]:
    out = {}
    for key, value in (item.get("ProviderIds") or {}).items():
        if value is not None and str(value).strip():
            out[str(key).lower()] = str(value).strip().lower()
    return out


def provider_matches(source: dict, candidate: dict) -> list[str]:
    a, b = normalized_provider_ids(source), normalized_provider_ids(candidate)
    return [k for k in ("tmdb", "tvdb", "imdb") if a.get(k) and a.get(k) == b.get(k)]


def provider_key(item: dict) -> str | None:
    ids = normalized_provider_ids(item)
    for key in ("tmdb", "tvdb", "imdb"):
        if ids.get(key):
            return f"{key}:{ids[key]}"
    return None


def item_media_path(item: dict) -> str | None:
    direct = item.get("Path")
    if direct:
        return str(direct)
    for source in item.get("MediaSources") or []:
        if isinstance(source, dict) and source.get("Path"):
            return str(source["Path"])
    return None


def normalized_path_segments(path: str | None) -> list[str] | None:
    if not path:
        return None
    path = str(path).strip().replace("\\", "/")
    path = re.sub(r"/+", "/", path).rstrip("/")
    if not path:
        return None
    segments = [s.casefold() for s in path.split("/") if s]
    if not segments or "." not in segments[-1]:
        return None
    return segments


def scoped_md5(scope: str, suffix: str) -> str:
    return hashlib.md5(f"{scope}:{suffix}".encode(), usedforsecurity=False).hexdigest()


def path_fingerprints(item: dict) -> dict[str, str]:
    """Generate conservative same-file suffix fingerprints for cross-server matching.

    Movies: final two normalized path segments.
    Episodes: final three segments + season/episode numbers.
    Episode show fingerprint: two directory segments immediately before the file.
    """
    segments = normalized_path_segments(item_media_path(item))
    if not segments:
        return {}
    typ = item.get("Type")
    if typ == "Movie" and len(segments) >= 2:
        suffix = "/" + "/".join(segments[-2:])
        return {"media": scoped_md5("movie", suffix), "suffix": suffix}
    if typ == "Episode" and len(segments) >= 3:
        season = item.get("ParentIndexNumber")
        episode = item.get("IndexNumber")
        if season is None or episode is None:
            return {}
        episode_suffix = "/" + "/".join(segments[-3:]) + f"/{season}/{episode}"
        show_suffix = "/" + "/".join(segments[-3:-1])
        return {
            "media": scoped_md5("episode", episode_suffix),
            "show": scoped_md5("show", show_suffix),
            "suffix": episode_suffix,
            "show_suffix": show_suffix,
        }
    return {}


def safe_name_year_match(source: dict, candidates: list[dict]) -> dict | None:
    # Generic episode/season names cannot establish series identity.
    if source.get("Type") not in ("Movie", "Series", "Video", "BoxSet", "Playlist"):
        return None
    name, year = norm_text(source.get("Name")), source.get("ProductionYear")
    if not name or year is None:
        return None
    source_ids = normalized_provider_ids(source)
    exact = []
    for candidate in candidates:
        ids = normalized_provider_ids(candidate)
        conflict = any(source_ids.get(k) and ids.get(k) and source_ids[k] != ids[k]
                       for k in ("tmdb", "tvdb", "imdb"))
        if (not conflict and candidate.get("Type") == source.get("Type") and
                norm_text(candidate.get("Name")) == name and candidate.get("ProductionYear") == year):
            exact.append(candidate)
    return exact[0] if len(exact) == 1 else None


def logical_key(item: dict) -> str:
    typ = item.get("Type") or "Unknown"
    if typ == "Season":
        p = provider_key(item)
        if p:
            return f"Season:{p}"
        # Seasons often lack portable IDs. Include year when available so remakes
        # with the same normalized series name/season number cannot share state.
        return f"Season:{norm_text(item.get('SeriesName'))}:{item.get('IndexNumber')}:{item.get('ProductionYear') or ''}"
    if typ == "Episode":
        p = provider_key(item)
        if p:
            return f"Episode:{p}"
        pf = path_fingerprints(item).get("media")
        if pf:
            return f"Episode:path:{pf}"
        return f"Episode:{norm_text(item.get('SeriesName'))}:s{item.get('ParentIndexNumber')}e{item.get('IndexNumber')}"
    p = provider_key(item)
    if p:
        return f"{typ}:{p}"
    pf = path_fingerprints(item).get("media")
    if pf:
        return f"{typ}:path:{pf}"
    return f"{typ}:{norm_text(item.get('Name'))}:{item.get('ProductionYear') or ''}"


def get_series_item(client: JellyfinClient, user_id: str, item: dict) -> dict | None:
    series_id = item.get("SeriesId")
    if series_id:
        found = client.item(str(series_id), user_id)
        if found:
            return found
    series_name = item.get("SeriesName")
    if not series_name:
        return item if item.get("Type") == "Series" else None
    candidates = client.search(user_id, series_name, "Series")
    exact = [x for x in candidates if norm_text(x.get("Name")) == norm_text(series_name)]
    return exact[0] if len(exact) == 1 else None


def match_series(source_client, target_client, source_user, target_user, source_series):
    candidates = target_client.search(target_user, source_series.get("Name") or "", "Series")
    strong = [(c, provider_matches(source_series, c)) for c in candidates]
    strong = [(c, ids) for c, ids in strong if ids]
    if len(strong) == 1:
        c, ids = strong[0]
        return c, "provider", "+".join(ids)

    indexed = indexed_provider_match(target_client, target_user, source_series, CONFIG)
    if indexed[0]:
        return indexed

    # If series metadata IDs/names differ, use episode paths to recover series identity:
    # derive a show fingerprint from one of the series' episode paths, then require
    # the target path index to point to exactly one target SeriesId.
    if CONFIG.get("path_matching", {}).get("enabled", True) and source_series.get("Id"):
        episodes = source_client.children(source_user, source_series["Id"], "Episode", recursive=True)
        for ep in episodes[:25]:
            show_fp = path_fingerprints(ep).get("show")
            if not show_fp:
                continue
            idx = build_identity_index(target_client, target_user, CONFIG)
            target_eps = idx["show"].get(show_fp, [])
            series_ids = {str(x.get("SeriesId")) for x in target_eps if x.get("SeriesId")}
            if len(series_ids) == 1:
                sid = next(iter(series_ids))
                target_series = target_client.item(sid, target_user)
                if target_series:
                    return target_series, "path-series", path_fingerprints(ep).get("show_suffix") or show_fp

    if CONFIG.get("title_year_fallback", True):
        c = safe_name_year_match(source_series, candidates)
        if c:
            return c, "title-year", "unique exact series title/year"
    return None, None, None


def target_hierarchy_match(source_client, target_client, source_user, target_user, item):
    typ = item.get("Type")
    if typ not in ("Season", "Episode"):
        return None, None, None
    source_series = get_series_item(source_client, source_user, item)
    if not source_series:
        return None, None, None
    target_series, series_method, series_detail = match_series(
        source_client, target_client, source_user, target_user, source_series
    )
    if not target_series:
        return None, None, None
    if typ == "Season":
        index = item.get("IndexNumber")
        if index is None:
            return None, None, None
        candidates = target_client.children(target_user, target_series["Id"], "Season", index=index)
        exact = [x for x in candidates if x.get("IndexNumber") == index]
        if len(exact) == 1:
            return exact[0], "hierarchy", f"series via {series_method}; season={index}"
        return None, None, None
    season = item.get("ParentIndexNumber")
    episode = item.get("IndexNumber")
    if season is None or episode is None:
        return None, None, None
    candidates = target_client.children(target_user, target_series["Id"], "Episode", recursive=True,
                                        index=episode, parent_index=season)
    exact = [x for x in candidates if x.get("IndexNumber") == episode and x.get("ParentIndexNumber") == season]
    if len(exact) == 1:
        return exact[0], "hierarchy", f"series via {series_method}; s{season}e{episode}"
    return None, None, None


def build_identity_index(client: JellyfinClient, user_id: str, config: dict) -> dict:
    ttl = max(0.25, float(config.get("path_matching", {}).get("index_ttl_hours", 6))) * 3600
    cache_key = f"{client.side}:{client.url}:{user_id}"
    now = time.time()
    with PATH_INDEX_LOCK:
        cached = PATH_INDEX_CACHE.get(cache_key)
        if cached and now - cached["built_at"] < ttl:
            return cached
    log(f"{client.name}: building on-demand identity index")
    items = client.all_items(user_id, ["Movie", "Series", "Episode"])
    providers: dict[str, list[dict]] = defaultdict(list)
    media: dict[str, list[dict]] = defaultdict(list)
    show: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        typ = item.get("Type") or ""
        for provider, value in normalized_provider_ids(item).items():
            if provider in ("tmdb", "tvdb", "imdb"):
                providers[f"{typ}:{provider}:{value}"].append(item)
        fp = path_fingerprints(item)
        if fp.get("media"):
            media[fp["media"]].append(item)
        if fp.get("show"):
            show[fp["show"]].append(item)
    built = {"built_at": now, "providers": providers, "media": media, "show": show, "count": len(items)}
    with PATH_INDEX_LOCK:
        PATH_INDEX_CACHE[cache_key] = built
    log(f"{client.name}: identity index ready ({len(items)} movie/series/episode items)")
    return built


def indexed_provider_match(target_client, target_user, source_item, cfg):
    ids = normalized_provider_ids(source_item)
    typ = source_item.get("Type")
    if not ids or typ not in ("Movie", "Series", "Episode"):
        return None, None, None
    idx = build_identity_index(target_client, target_user, cfg)
    matches = {}
    matched_providers = []
    for provider in ("tmdb", "tvdb", "imdb"):
        value = ids.get(provider)
        if not value:
            continue
        candidates = idx["providers"].get(f"{typ}:{provider}:{value}", [])
        if len(candidates) == 1:
            candidate = candidates[0]
            matches[str(candidate.get("Id"))] = candidate
            matched_providers.append(provider)
        elif len(candidates) > 1:
            return None, None, None
    if len(matches) == 1:
        return next(iter(matches.values())), "provider-index", "+".join(matched_providers)
    return None, None, None


def path_match(target_client, target_user, source_item, cfg):
    if not cfg.get("path_matching", {}).get("enabled", True):
        return None, None, None
    if source_item.get("Type") not in ("Movie", "Episode"):
        return None, None, None
    fp = path_fingerprints(source_item)
    if not fp.get("media"):
        return None, None, None
    idx = build_identity_index(target_client, target_user, cfg)
    candidates = idx["media"].get(fp["media"], [])
    # Collision guard: never accept a non-unique fingerprint.
    candidates = [c for c in candidates if c.get("Type") == source_item.get("Type")]
    if len(candidates) == 1:
        return candidates[0], "path", fp.get("suffix") or fp["media"]
    return None, None, None


def direct_match(source_client, target_client, source_user, target_user, item, cfg):
    typ = item.get("Type")
    name = item.get("Name") or item.get("SeriesName") or ""
    candidates = target_client.search(target_user, name, typ) if name and typ else []

    # 1) External provider IDs are the strongest portable identity.
    strong = [(c, provider_matches(item, c)) for c in candidates]
    strong = [(c, ids) for c, ids in strong if ids]
    if len(strong) == 1:
        c, ids = strong[0]
        return c, "provider", "+".join(ids)

    indexed = indexed_provider_match(target_client, target_user, item, cfg)
    if indexed[0]:
        return indexed

    if typ == "Series":
        return match_series(source_client, target_client, source_user, target_user, item)

    # 2) For hierarchy items, identify the series then use season/episode numbers.
    if typ in ("Season", "Episode"):
        h = target_hierarchy_match(source_client, target_client, source_user, target_user, item)
        if h[0]:
            return h

    # 3) Same-file path fingerprint. This is on-demand and collision guarded.
    p = path_match(target_client, target_user, item, cfg)
    if p[0]:
        return p

    # 4) Final conservative metadata fallback; never choose among duplicates.
    if cfg.get("title_year_fallback", True):
        c = safe_name_year_match(item, candidates)
        if c:
            return c, "title-year", "unique exact title/year"
    return None, None, None


def ensure_mapping(pair: dict, source_side: str, source_item: dict, clients: dict,
                   bootstrapped: bool, current_likes: dict):
    pair_id = pair["id"]
    source_id = str(source_item.get("Id") or "")
    if not source_id:
        return None
    existing = mapping_by_side(pair_id, source_side, source_id)
    if existing and existing.get("a_id") and existing.get("b_id"):
        return existing

    other_side = "b" if source_side == "a" else "a"
    source_user = pair[f"{source_side}_user_id"]
    target_user = pair[f"{other_side}_user_id"]
    target_item, method, detail = direct_match(
        clients[source_side], clients[other_side], source_user, target_user, source_item, CONFIG
    )
    # A logical fingerprint is diagnostic, not a unique local identity. Two
    # editions/remakes can share it. Never overwrite another source item's row.
    target_id = str(target_item["Id"]) if target_item and target_item.get("Id") else None
    target_row = mapping_by_side(pair_id, other_side, target_id) if target_id else None
    if target_row and target_row.get(f"{source_side}_id") not in (None, source_id):
        target_item = target_id = target_row = None
        method = detail = None
    row = existing or target_row
    if row is None:
        key = logical_key(source_item)
        if mapping_by_key(pair_id, key):
            key = f"{key}:local:{source_side}:{source_id}"
        row = {
            "pair_id": pair_id, "logical_key": key,
            "item_type": source_item.get("Type"),
            "title": source_item.get("Name") or source_item.get("SeriesName"),
            "a_id": None, "b_id": None, "last_a": None, "last_b": None,
        }
    row[f"{source_side}_id"] = source_id
    if target_id:
        # Combine two previously unmatched rows only after an actual match.
        if target_row and target_row["logical_key"] != row["logical_key"]:
            with db_connect() as db:
                db.execute("DELETE FROM mappings WHERE pair_id=? AND logical_key=?",
                           (pair_id, target_row["logical_key"]))
        row[f"{other_side}_id"] = target_id
        row["match_method"], row["match_detail"] = method, detail
        log(f"{pair.get('name', pair_id)}: mapped {row['title']} via {method}")
    if bootstrapped:
        row[f"last_{source_side}"] = 0
        if target_id:
            row[f"last_{other_side}"] = int(target_id in current_likes[other_side])
    row["last_seen"] = time.time()
    upsert_mapping(row)
    return mapping_by_key(pair_id, row["logical_key"])


# ----------------------------- sync engine -------------------------------

def set_like_if_needed(client, user_id, item_id, desired, current, stats, side_name):
    if not item_id or current == desired:
        return current
    client.set_like(user_id, item_id, desired)
    stats["writes"] += 1
    log(f"{side_name}: {'added' if desired else 'removed'} Watchlist item {item_id}")
    return desired


def remove_played_likes(pair: dict, clients: dict, likes: dict, stats: dict):
    if not pair.get("auto_remove_watched", True):
        return
    for side in ("a", "b"):
        user_id = pair.get(f"{side}_user_id")
        for item_id, item in list(likes[side].items()):
            if bool((item.get("UserData") or {}).get("Played")):
                clients[side].set_like(user_id, item_id, False)
                likes[side].pop(item_id, None)
                stats["writes"] += 1
                stats["auto_removed"] += 1
                log(f"{side.upper()}: auto-removed played Watchlist item {item.get('Name') or item_id}")


def sync_pair(pair: dict, clients: dict):
    pair_id = pair["id"]
    state = pair_state(pair_id)
    bootstrapped = bool(state.get("bootstrapped"))
    types = [t for t in pair.get("types", DEFAULT_TYPES) if t in ALL_TYPES] or DEFAULT_TYPES
    a_user, b_user = pair.get("a_user_id"), pair.get("b_user_id")
    if not a_user or not b_user:
        raise RuntimeError("User pair is missing one or both user IDs")

    a_items = clients["a"].liked_items(a_user, types)
    b_items = clients["b"].liked_items(b_user, types)
    likes = {
        "a": {str(x["Id"]): x for x in a_items if x.get("Id")},
        "b": {str(x["Id"]): x for x in b_items if x.get("Id")},
    }
    stats = {"a_likes": len(likes["a"]), "b_likes": len(likes["b"]), "mapped": 0,
             "unmatched": 0, "writes": 0, "conflicts": 0, "auto_removed": 0,
             "methods": {}}

    for side in ("a", "b"):
        for item in likes[side].values():
            try:
                ensure_mapping(pair, side, item, clients, bootstrapped, likes)
            except Exception as exc:
                log(f"{pair.get('name', pair_id)}: mapping failed for {item.get('Name')}: {exc}", "WARN")

    rows = [r for r in all_mappings(pair_id) if r.get("item_type") in types]
    active_rows = []
    for row in rows:
        if not row.get("a_id") or not row.get("b_id"):
            active_rows.append(row)
            continue
        if row["a_id"] not in likes["a"] and row["b_id"] not in likes["b"]:
            active_rows.append(row)
            continue
        items = {}
        for side in ("a", "b"):
            item_id = row[f"{side}_id"]
            items[side] = likes[side].get(item_id) or clients[side].item(item_id, pair[f"{side}_user_id"])
        if not all(items.values()):
            # Release stale IDs so surviving liked items can be rematched next poll.
            with db_connect() as db:
                db.execute("DELETE FROM mappings WHERE pair_id=? AND logical_key=?",
                           (pair_id, row["logical_key"]))
            with PATH_INDEX_LOCK:
                PATH_INDEX_CACHE.clear()
            log(f"{pair_id}: discarded unavailable mapping {row['title']}", "WARN")
            continue
        if pair.get("auto_remove_watched", True) and any(
                (item.get("UserData") or {}).get("Played") for item in items.values()):
            for side in ("a", "b"):
                item_id = row[f"{side}_id"]
                if item_id in likes[side]:
                    clients[side].set_like(pair[f"{side}_user_id"], item_id, False)
                    likes[side].pop(item_id)
                    stats["writes"] += 1
                    stats["auto_removed"] += 1
            # Watched removal takes priority over an addition on the other server.
            update_mapping_state(pair_id, row["logical_key"], last_a=0, last_b=0)
            row["last_a"] = row["last_b"] = 0
        active_rows.append(row)
    rows = active_rows
    remove_played_likes(pair, clients, likes, stats)
    stats["a_likes"], stats["b_likes"] = len(likes["a"]), len(likes["b"])
    stats["mapped"] = sum(1 for r in rows if r.get("a_id") and r.get("b_id"))
    stats["unmatched"] = sum(1 for r in rows if not r.get("a_id") or not r.get("b_id"))
    method_counts = defaultdict(int)
    for row in rows:
        if row.get("a_id") and row.get("b_id"):
            method_counts[row.get("match_method") or "cached"] += 1
    stats["methods"] = dict(method_counts)

    if not bootstrapped:
        strategy = pair.get("bootstrap", "a_to_b")
        for row in rows:
            a_id, b_id = row.get("a_id"), row.get("b_id")
            ca, cb = bool(a_id and a_id in likes["a"]), bool(b_id and b_id in likes["b"])
            if a_id and b_id:
                if strategy == "a_to_b":
                    cb = set_like_if_needed(clients["b"], b_user, b_id, ca, cb, stats, "B")
                elif strategy == "b_to_a":
                    ca = set_like_if_needed(clients["a"], a_user, a_id, cb, ca, stats, "A")
                elif strategy == "merge":
                    desired = ca or cb
                    ca = set_like_if_needed(clients["a"], a_user, a_id, desired, ca, stats, "A")
                    cb = set_like_if_needed(clients["b"], b_user, b_id, desired, cb, stats, "B")
            update_mapping_state(pair_id, row["logical_key"], last_a=int(ca), last_b=int(cb), last_seen=time.time())
        update_pair_state(pair_id, bootstrapped=1, last_sync=utcnow(), last_error=None,
                          last_stats=json.dumps(stats))
        log(f"Bootstrapped pair {pair.get('name') or pair_id} using {strategy}")
        return stats

    direction, conflict = pair.get("direction", "both"), pair.get("conflict", "a")
    for row in rows:
        a_id, b_id = row.get("a_id"), row.get("b_id")
        if not a_id or not b_id:
            continue
        ca, cb = a_id in likes["a"], b_id in likes["b"]
        la = ca if row.get("last_a") is None else bool(row["last_a"])
        lb = cb if row.get("last_b") is None else bool(row["last_b"])
        if direction == "a_to_b":
            cb = set_like_if_needed(clients["b"], b_user, b_id, ca, cb, stats, "B")
        elif direction == "b_to_a":
            ca = set_like_if_needed(clients["a"], a_user, a_id, cb, ca, stats, "A")
        else:
            changed_a, changed_b = ca != la, cb != lb
            if changed_a and not changed_b:
                cb = set_like_if_needed(clients["b"], b_user, b_id, ca, cb, stats, "B")
            elif changed_b and not changed_a:
                ca = set_like_if_needed(clients["a"], a_user, a_id, cb, ca, stats, "A")
            elif changed_a and changed_b and ca != cb:
                stats["conflicts"] += 1
                if conflict == "b":
                    ca = set_like_if_needed(clients["a"], a_user, a_id, cb, ca, stats, "A")
                else:
                    cb = set_like_if_needed(clients["b"], b_user, b_id, ca, cb, stats, "B")
        update_mapping_state(pair_id, row["logical_key"], last_a=int(ca), last_b=int(cb), last_seen=time.time())

    update_pair_state(pair_id, last_sync=utcnow(), last_error=None, last_stats=json.dumps(stats))
    return stats


def sync_all():
    if not SYNC_LOCK.acquire(blocking=False):
        return {"skipped": "sync already running"}
    STATUS["running"] = True
    STATUS["last_started"] = utcnow()
    STATUS["last_error"] = None
    try:
        with CONFIG_LOCK:
            cfg = json.loads(json.dumps(CONFIG))
        clients = {
            "a": JellyfinClient(cfg["server_a"], "a"),
            "b": JellyfinClient(cfg["server_b"], "b"),
        }
        if not clients["a"].ready or not clients["b"].ready:
            raise RuntimeError("Configure both Jellyfin URLs and API keys before syncing")
        summary = {}
        for pair in cfg.get("pairs", []):
            if not pair.get("enabled", True) or not pair.get("id"):
                continue
            name = pair.get("name") or pair["id"]
            try:
                summary[name] = sync_pair(pair, clients)
            except Exception as exc:
                update_pair_state(pair["id"], last_sync=utcnow(), last_error=str(exc))
                summary[name] = {"error": str(exc)}
                log(f"Pair {name} failed: {exc}", "ERROR")
        STATUS["last_summary"] = summary
        return summary
    except Exception as exc:
        STATUS["last_error"] = str(exc)
        log(f"Sync cycle failed: {exc}", "ERROR")
        return {"error": str(exc)}
    finally:
        STATUS["running"] = False
        STATUS["last_finished"] = utcnow()
        SYNC_LOCK.release()


def worker():
    log(f"JellyMark Sync {APP_VERSION} started (standalone matcher)")
    while True:
        with CONFIG_LOCK:
            seconds = max(5, int(CONFIG.get("poll_seconds", 15) or 15))
        WAKE_EVENT.wait(timeout=seconds)
        WAKE_EVENT.clear()
        sync_all()


# ----------------------------- admin UI ---------------------------------
INDEX_HTML = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JellyMark Sync</title><style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101114;color:#eee}body{margin:0}.wrap{max-width:1080px;margin:auto;padding:24px}.card{background:#181a1f;border:1px solid #30333b;border-radius:12px;padding:18px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}label{display:block;font-size:.86rem;color:#b8bdc7;margin-bottom:4px}input,select,button{font:inherit}input,select{width:100%;box-sizing:border-box;padding:9px;border:1px solid #414651;border-radius:7px;background:#0f1115;color:#fff}button{padding:9px 14px;border:0;border-radius:8px;background:#00a4dc;color:white;font-weight:650;cursor:pointer}button.secondary{background:#353a45}button.danger{background:#a63a3a}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.muted{color:#9298a3}.good{color:#71d596}.bad{color:#ff8080}h1{margin:.2em 0}h2{font-size:1.1rem;margin-top:0}.pair{border-top:1px solid #30333b;padding-top:14px;margin-top:14px}.types{display:flex;flex-wrap:wrap;gap:10px}.types label{display:flex;gap:5px;align-items:center}.types input{width:auto}pre{white-space:pre-wrap;max-height:350px;overflow:auto;background:#0c0d10;padding:12px;border-radius:8px}.status{font-size:.9rem}.pill{display:inline-block;padding:.15rem .5rem;border-radius:99px;background:#2b3039;margin-right:.35rem}.note{padding:.7rem .9rem;background:#121a20;border-left:3px solid #00a4dc;border-radius:.25rem}
</style></head><body><div class="wrap">
<h1>JellyMark Sync</h1>
<div class="muted">Standalone per-user Jellyfin Likes ↔ Likes synchronization.</div>
<div id="auth" class="card" style="display:none"><h2>Admin token</h2><div class="row"><input id="token" placeholder="JWS_ADMIN_TOKEN" style="max-width:430px"><button onclick="setToken()">Unlock</button></div></div>
<div id="app" style="display:none">
<div class="card"><h2>Connections</h2><div class="grid">
<div><label>Server A name</label><input id="a_name"><label>Server A URL</label><input id="a_url"><label>Server A API key</label><input id="a_key" type="password" placeholder="leave blank to keep current"></div>
<div><label>Server B name</label><input id="b_name"><label>Server B URL</label><input id="b_url"><label>Server B API key</label><input id="b_key" type="password" placeholder="leave blank to keep current"></div>
</div><div class="row" style="margin-top:12px"><button onclick="saveConnections()">Save connections</button><button class="secondary" onclick="loadUsers()">Load users</button><button class="secondary" onclick="testConnections()">Test connections</button></div><div id="connStatus" class="status muted"></div></div>
<div class="card"><h2>Matcher</h2><div class="note">Matching order: cached mapping → provider IDs → series/season/episode hierarchy → normalized media-path fingerprint → unique exact title/year. Path indexing happens only when needed and is cached.</div><div class="grid" style="margin-top:12px"><div><label>Poll seconds</label><input id="poll" type="number" min="5"></div><div><label>Path index cache (hours)</label><input id="path_ttl" type="number" min="0.25" step="0.25"></div></div><div class="row" style="margin-top:10px"><label><input id="path_enabled" type="checkbox"> Enable path matching</label><label><input id="title_fallback" type="checkbox"> Allow unique exact title/year fallback</label></div></div>
<div class="card"><h2>User pairs</h2><div id="pairs"></div><div class="row"><button onclick="addPair()">Add pair</button><button class="secondary" onclick="savePairs()">Save pairs</button></div></div>
<div class="card"><h2>Operations</h2><div class="row"><button onclick="syncNow()">Sync now</button><button class="secondary" onclick="refreshStatus()">Refresh status</button></div><pre id="status"></pre></div>
<div class="card"><h2>Mappings</h2><div class="row"><select id="mapPair" style="max-width:420px"></select><button class="secondary" onclick="loadMappings()">Load mappings</button><button class="danger" onclick="resetSelectedPair()">Reset selected pair</button></div><pre id="mappings"></pre></div>
<div class="card"><h2>Recent log</h2><pre id="logs"></pre></div>
</div></div>
<script>
let cfg=null, users={a:[],b:[]}; const K='jwsAdminToken';
const statusEl=document.getElementById('status');
function pairId(){return crypto.randomUUID ? crypto.randomUUID() : 'pair-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('')}
window.addEventListener('unhandledrejection',event=>{event.preventDefault();statusEl.textContent=event.reason?.message||String(event.reason);connStatus.textContent=statusEl.textContent});
function token(){return localStorage.getItem(K)||''} function headers(){return {'Authorization':'Bearer '+token(),'Content-Type':'application/json'}}
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{...headers(),...(opt.headers||{})}});if(r.status===401){showAuth();throw new Error('Unauthorized')}const t=await r.text();let d=t;try{d=t?JSON.parse(t):null}catch{}if(!r.ok)throw new Error((d&&d.error)||t||r.status);return d}
function showAuth(){document.getElementById('auth').style.display='block';document.getElementById('app').style.display='none'}
function setToken(){localStorage.setItem(K,document.getElementById('token').value.trim());boot()}
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
async function boot(){try{cfg=await api('/api/config');document.getElementById('auth').style.display='none';document.getElementById('app').style.display='block';fill();await loadUsers(false);renderPairs();refreshStatus()}catch(e){showAuth()}}
function fill(){a_name.value=cfg.server_a.name||'';a_url.value=cfg.server_a.url||'';b_name.value=cfg.server_b.name||'';b_url.value=cfg.server_b.url||'';poll.value=cfg.poll_seconds||15;path_enabled.checked=cfg.path_matching?.enabled!==false;path_ttl.value=cfg.path_matching?.index_ttl_hours||6;title_fallback.checked=cfg.title_year_fallback!==false}
async function saveConnections(){const body={server_a:{name:a_name.value,url:a_url.value,api_key:a_key.value},server_b:{name:b_name.value,url:b_url.value,api_key:b_key.value},poll_seconds:+poll.value||15,path_matching:{enabled:path_enabled.checked,index_ttl_hours:+path_ttl.value||6},title_year_fallback:title_fallback.checked};cfg=await api('/api/config',{method:'POST',body:JSON.stringify(body)});a_key.value=b_key.value='';connStatus.textContent='Saved';fill()}
async function testConnections(){try{const d=await api('/api/test',{method:'POST',body:'{}'});connStatus.innerHTML='<span class="good">'+esc(JSON.stringify(d))+'</span>'}catch(e){connStatus.innerHTML='<span class="bad">'+esc(e.message)+'</span>'}}
async function loadUsers(show=true){try{const [a,b]=await Promise.all([api('/api/users?side=a'),api('/api/users?side=b')]);users={a,b};if(show)connStatus.textContent=`Loaded ${a.length} Server A and ${b.length} Server B users`;renderPairs()}catch(e){if(show)connStatus.innerHTML='<span class="bad">'+esc(e.message)+'</span>'}}
function opts(side,sel){return users[side].map(u=>`<option value="${esc(u.id)}" ${u.id===sel?'selected':''}>${esc(u.name)}</option>`).join('')}
function pairHtml(p={}){const id=p.id||pairId();const types=p.types||['Movie','Series','Season','Episode'];return `<div class="pair" data-id="${esc(id)}"><div class="grid"><div><label>Name</label><input class="pname" value="${esc(p.name||'')}"><label>Server A user</label><select class="pa"><option value="">Select…</option>${opts('a',p.a_user_id)}</select><label>Server B user</label><select class="pb"><option value="">Select…</option>${opts('b',p.b_user_id)}</select></div><div><label>Direction</label><select class="pdir"><option value="both" ${p.direction==='both'?'selected':''}>Two-way</option><option value="a_to_b" ${p.direction==='a_to_b'?'selected':''}>A → B</option><option value="b_to_a" ${p.direction==='b_to_a'?'selected':''}>B → A</option></select><label>Initial bootstrap</label><select class="pboot"><option value="a_to_b" ${p.bootstrap!=='b_to_a'&&p.bootstrap!=='merge'?'selected':''}>Make B match A</option><option value="b_to_a" ${p.bootstrap==='b_to_a'?'selected':''}>Make A match B</option><option value="merge" ${p.bootstrap==='merge'?'selected':''}>Merge</option></select><label>Conflict winner</label><select class="pconf"><option value="a" ${p.conflict!=='b'?'selected':''}>Server A</option><option value="b" ${p.conflict==='b'?'selected':''}>Server B</option></select></div></div><div class="types">${['Movie','Series','Season','Episode'].map(t=>`<label><input type="checkbox" data-type="${t}" ${types.includes(t)?'checked':''}>${t}</label>`).join('')}</div><div class="row"><label><input class="pen" type="checkbox" ${p.enabled!==false?'checked':''}> Enabled</label><label><input class="pauto" type="checkbox" ${p.auto_remove_watched!==false?'checked':''}> Auto-remove watched</label><button class="danger" onclick="this.closest('.pair').remove()">Remove pair</button></div></div>`}
function renderPairs(){pairs.innerHTML=(cfg.pairs||[]).map(pairHtml).join('');if(!pairs.children.length)pairs.innerHTML='<div class="muted">No user pairs configured.</div>';mapPair.innerHTML=(cfg.pairs||[]).map(p=>`<option value="${esc(p.id)}">${esc(p.name||p.id)}</option>`).join('')}
function addPair(){if(pairs.querySelector('.muted'))pairs.innerHTML='';pairs.insertAdjacentHTML('beforeend',pairHtml({}))}
function readPairs(){return [...pairs.querySelectorAll('.pair')].map(el=>{const au=users.a.find(u=>u.id===el.querySelector('.pa').value),bu=users.b.find(u=>u.id===el.querySelector('.pb').value);return{id:el.dataset.id,name:el.querySelector('.pname').value||`${au?.name||'A'} ↔ ${bu?.name||'B'}`,enabled:el.querySelector('.pen').checked,a_user_id:el.querySelector('.pa').value,a_user_name:au?.name||'',b_user_id:el.querySelector('.pb').value,b_user_name:bu?.name||'',direction:el.querySelector('.pdir').value,bootstrap:el.querySelector('.pboot').value,conflict:el.querySelector('.pconf').value,auto_remove_watched:el.querySelector('.pauto').checked,types:[...el.querySelectorAll('[data-type]:checked')].map(x=>x.dataset.type)}})}
async function savePairs(){cfg=await api('/api/config',{method:'POST',body:JSON.stringify({pairs:readPairs()})});renderPairs()}
async function syncNow(){statusEl.textContent='Syncing…';statusEl.textContent=JSON.stringify(await api('/api/sync',{method:'POST',body:'{}'}),null,2);refreshStatus()}
async function refreshStatus(){try{const d=await api('/api/status');statusEl.textContent=JSON.stringify(d.status,null,2);logs.textContent=(d.logs||[]).join('\n')}catch(e){statusEl.textContent=e.message}}
async function loadMappings(){if(!mapPair.value)return;mappings.textContent=JSON.stringify(await api('/api/mappings?pair_id='+encodeURIComponent(mapPair.value)),null,2)}
async function resetSelectedPair(){if(!mapPair.value||!confirm('Reset cached mappings and bootstrap state for this pair?'))return;await api('/api/reset-pair',{method:'POST',body:JSON.stringify({pair_id:mapPair.value})});mappings.textContent='Reset complete.'}
boot(); setInterval(refreshStatus,10000);
</script></body></html>'''


class Handler(BaseHTTPRequestHandler):
    server_version = "JellyfinWatchlistSync/" + APP_VERSION

    def log_message(self, fmt, *args):
        return

    def send_json(self, data, status=200):
        raw = json.dumps(data, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def send_html(self, html):
        raw = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self):
        if not ADMIN_TOKEN:
            return True
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {ADMIN_TOKEN}" or self.headers.get("X-Admin-Token") == ADMIN_TOKEN

    def body_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode())

    def require_auth(self):
        if self.authorized():
            return True
        self.send_json({"error": "unauthorized"}, 401)
        return False

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            return self.send_json({"ok": True, "version": APP_VERSION, "matcher": "standalone"})
        if parsed.path == "/":
            return self.send_html(INDEX_HTML)
        if not self.require_auth():
            return
        try:
            if parsed.path == "/api/config":
                return self.send_json(public_config())
            if parsed.path == "/api/users":
                side = (parse_qs(parsed.query).get("side") or [""])[0]
                if side not in ("a", "b"):
                    raise RuntimeError("side must be a or b")
                with CONFIG_LOCK:
                    c = json.loads(json.dumps(CONFIG[f"server_{side}"]))
                return self.send_json(JellyfinClient(c, side).users())
            if parsed.path == "/api/status":
                return self.send_json({"status": STATUS, "logs": list(LOGS)})
            if parsed.path == "/api/mappings":
                pair_id = (parse_qs(parsed.query).get("pair_id") or [""])[0]
                return self.send_json(all_mappings(pair_id) if pair_id else [])
            return self.send_json({"error": "not found"}, 404)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self.require_auth():
            return
        try:
            body = self.body_json()
            if parsed.path == "/api/config":
                global CONFIG
                with SYNC_LOCK, CONFIG_LOCK:
                    new = deep_merge(CONFIG, body)
                    for key in ("server_a", "server_b"):
                        # Blank submitted API key means preserve existing secret.
                        if body.get(key, {}).get("api_key", None) == "":
                            new[key]["api_key"] = CONFIG[key].get("api_key", "")
                    new = sanitize_config(new)
                    changed_server = any(normalize_url(new[k].get("url")) != normalize_url(CONFIG[k].get("url"))
                                         for k in ("server_a", "server_b"))
                    old_pairs = {p["id"]: p for p in CONFIG.get("pairs", []) if p.get("id")}
                    for removed_id in old_pairs.keys() - {p["id"] for p in new["pairs"]}:
                        reset_pair_state(removed_id)
                    for pair in new["pairs"]:
                        old = old_pairs.get(pair["id"])
                        if old and (changed_server or any(old.get(k) != pair.get(k) for k in ("a_user_id", "b_user_id"))):
                            reset_pair_state(pair["id"])
                    save_config(new)
                    CONFIG = new
                with PATH_INDEX_LOCK:
                    PATH_INDEX_CACHE.clear()
                return self.send_json(public_config())
            if parsed.path == "/api/test":
                with CONFIG_LOCK:
                    cfg = json.loads(json.dumps(CONFIG))
                result = {}
                for side in ("a", "b"):
                    c = JellyfinClient(cfg[f"server_{side}"], side)
                    info = c.system_info()
                    c.users()  # Public server info does not validate the API key.
                    result[side] = {"ok": True, "name": info.get("ServerName"), "version": info.get("Version")}
                return self.send_json(result)
            if parsed.path == "/api/sync":
                return self.send_json(sync_all())
            if parsed.path == "/api/reset-pair":
                pair_id = body.get("pair_id")
                if not pair_id:
                    raise RuntimeError("pair_id required")
                with SYNC_LOCK:
                    reset_pair_state(pair_id)
                return self.send_json({"ok": True})
            return self.send_json({"error": "not found"}, 404)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 500)


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not ADMIN_TOKEN:
        log("JWS_ADMIN_TOKEN is empty; admin UI is unauthenticated", "WARN")
    threading.Thread(target=worker, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"Admin UI listening on :{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
