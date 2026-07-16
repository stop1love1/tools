"""Wrapper quanh TikTokApi: giu MOT session dung chung, tu tao lai khi loi."""
from __future__ import annotations

import asyncio
import os
import re
from typing import Any, Awaitable, Callable, TypeVar

import httpx
from TikTokApi import TikTokApi

try:
    from TikTokApi.exceptions import TikTokException
except Exception:  # pragma: no cover - phong khi doi cau truc module
    TikTokException = Exception  # type: ignore[misc, assignment]

BOT_HINT = "TikTok chặn bot — thử đặt MS_TOKEN hoặc dùng proxy"
URL_HINT = "Kiểm tra lại URL video TikTok (dạng https://www.tiktok.com/@user/video/123...)"

T = TypeVar("T")


class UpstreamError(Exception):
    """Loi tu phia TikTok / anti-bot. Map ra HTTP 502."""

    def __init__(self, message: str, hint: str = BOT_HINT) -> None:
        super().__init__(message)
        self.hint = hint


class SearchNotSupported(Exception):
    """Phien ban TikTokApi khong ho tro search video. Map ra HTTP 501."""


_api: TikTokApi | None = None
_lock = asyncio.Lock()


def ms_token() -> str | None:
    token = os.getenv("MS_TOKEN", "").strip()
    return token or None


async def _create_api() -> TikTokApi:
    api = TikTokApi()
    token = ms_token()
    await api.create_sessions(
        ms_tokens=[token] if token else None,
        num_sessions=1,
        sleep_after=3,
        browser="chromium",
        headless=True,
    )
    return api


async def _get_api() -> TikTokApi:
    global _api
    async with _lock:
        if _api is None:
            _api = await _create_api()
        return _api


async def close_api() -> None:
    """Dong session hien tai (neu co). Goi khi loi hoac khi shutdown."""
    global _api
    async with _lock:
        api = _api
        _api = None
    if api is None:
        return
    for method in ("close_sessions", "stop_playwright"):
        fn = getattr(api, method, None)
        if fn is None:
            continue
        try:
            await fn()
        except Exception:
            pass


async def _call(fn: Callable[[TikTokApi], Awaitable[T]]) -> T:
    """Chay fn voi api dung chung; neu loi thi tao lai session va thu lai 1 lan."""
    last: Exception | None = None
    for attempt in (1, 2):
        try:
            api = await _get_api()
            return await fn(api)
        except SearchNotSupported:
            raise
        except Exception as exc:  # noqa: BLE001 - moi loi upstream deu xu ly nhu nhau
            last = exc
            await close_api()
    if isinstance(last, UpstreamError):
        raise last
    raise UpstreamError(f"{type(last).__name__}: {last}") from last


# ---------------------------------------------------------------- URL helpers

_VIDEO_ID_RE = re.compile(r"/(?:video|photo)/(\d+)")


async def resolve_video_url(url: str) -> str:
    """Tra ve URL day du dang www.tiktok.com/@user/video/<id> tu URL bat ky."""
    url = url.strip()
    if url.isdigit():
        return f"https://www.tiktok.com/@_/video/{url}"
    if _VIDEO_ID_RE.search(url) and "tiktok.com" in url:
        return url
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=10.0,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
        ) as client:
            resp = await client.get(url)
            final_url = str(resp.url)
    except httpx.HTTPError as exc:
        raise UpstreamError(f"cannot resolve short link: {exc}", hint=URL_HINT) from exc
    if _VIDEO_ID_RE.search(final_url):
        return final_url
    raise UpstreamError(f"no video id found in url: {final_url}", hint=URL_HINT)


async def resolve_video_id(url: str) -> str:
    """Lay video id tu URL day du hoac short link (vm.tiktok.com...)."""
    url = url.strip()
    if url.isdigit():
        return url
    match = _VIDEO_ID_RE.search(url)
    if match:
        return match.group(1)
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=10.0,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
        ) as client:
            resp = await client.get(url)
            final_url = str(resp.url)
    except httpx.HTTPError as exc:
        raise UpstreamError(f"cannot resolve short link: {exc}", hint=URL_HINT) from exc
    match = _VIDEO_ID_RE.search(final_url)
    if match:
        return match.group(1)
    raise UpstreamError(f"no video id found in url: {final_url}", hint=URL_HINT)


# ------------------------------------------------------------------- mappers

def _to_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _first_url(value: Any) -> str:
    if isinstance(value, dict):
        urls = value.get("url_list") or value.get("urlList") or []
        return urls[0] if urls else ""
    return value or ""


def map_video(raw: dict[str, Any]) -> dict[str, Any]:
    author = raw.get("author") or {}
    if isinstance(author, str):
        author = {"uniqueId": author}
    # statsV2 chua so dang chuoi, khong bi tran int32 nhu stats (video >2 ty view)
    stats = raw.get("statsV2") or raw.get("stats") or {}
    music = raw.get("music") or {}
    video = raw.get("video") or {}
    return {
        "id": str(raw.get("id", "")),
        "description": raw.get("desc", ""),
        "author": {
            "id": str(author.get("id", "")),
            "uniqueId": author.get("uniqueId", ""),
            "nickname": author.get("nickname", ""),
            "avatar": author.get("avatarLarger") or author.get("avatarThumb") or "",
        },
        "stats": {
            "views": _to_int(stats.get("playCount")),
            "likes": _to_int(stats.get("diggCount")),
            "comments": _to_int(stats.get("commentCount")),
            "shares": _to_int(stats.get("shareCount")),
        },
        "music": {
            "title": music.get("title", ""),
            "author": music.get("authorName", ""),
        },
        "video": {
            "duration": _to_int(video.get("duration")),
            "cover": video.get("cover", ""),
            "downloadUrl": video.get("downloadAddr", ""),
            "playUrl": _first_url(video.get("playAddr")),
        },
    }


def _map_user(info: dict[str, Any]) -> dict[str, Any]:
    user_info = info.get("userInfo") or {}
    user = user_info.get("user") or info.get("user") or {}
    stats = user_info.get("stats") or info.get("stats") or {}
    return {
        "id": str(user.get("id", "")),
        "uniqueId": user.get("uniqueId", ""),
        "nickname": user.get("nickname", ""),
        "avatar": user.get("avatarLarger") or user.get("avatarThumb") or "",
        "signature": user.get("signature", ""),
        "verified": bool(user.get("verified", False)),
        "stats": {
            "followers": _to_int(stats.get("followerCount")),
            "following": _to_int(stats.get("followingCount")),
            "hearts": _to_int(stats.get("heartCount") or stats.get("heart")),
            "videos": _to_int(stats.get("videoCount")),
        },
    }


def _map_comment(raw: dict[str, Any]) -> dict[str, Any]:
    user = raw.get("user") or {}
    return {
        "id": str(raw.get("cid") or raw.get("id") or ""),
        "text": raw.get("text", ""),
        "user": {
            "uniqueId": user.get("unique_id") or user.get("uniqueId") or "",
            "nickname": user.get("nickname", ""),
            "avatar": _first_url(user.get("avatar_thumb")) or user.get("avatarThumb", ""),
        },
        "likes": _to_int(raw.get("digg_count") or raw.get("diggCount")),
        "replyCount": _to_int(
            raw.get("reply_comment_total") or raw.get("replyCommentTotal")
        ),
    }


# ------------------------------------------------------------------ services

async def video_meta(url: str) -> dict[str, Any]:
    # TikTokApi v7: video.info() bat buoc phai co url (khong dung duoc voi id)
    video_url = await resolve_video_url(url)

    async def run(api: TikTokApi) -> dict[str, Any]:
        info = await api.video(url=video_url).info()
        return map_video(info)

    return await _call(run)


async def user_profile(username: str) -> dict[str, Any]:
    async def run(api: TikTokApi) -> dict[str, Any]:
        info = await api.user(username=username).info()
        return _map_user(info)

    return await _call(run)


async def user_posts(username: str, count: int) -> list[dict[str, Any]]:
    async def run(api: TikTokApi) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        async for video in api.user(username=username).videos(count=count):
            out.append(map_video(video.as_dict))
            if len(out) >= count:
                break
        return out

    return await _call(run)


async def video_comments(url: str, count: int) -> list[dict[str, Any]]:
    video_id = await resolve_video_id(url)

    async def run(api: TikTokApi) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        async for comment in api.video(id=video_id).comments(count=count):
            out.append(_map_comment(comment.as_dict))
            if len(out) >= count:
                break
        return out

    return await _call(run)


async def comment_replies(url: str, comment_id: str, count: int) -> list[dict[str, Any]]:
    video_id = await resolve_video_id(url)

    async def run(api: TikTokApi) -> list[dict[str, Any]]:
        resp = await api.make_request(
            url="https://www.tiktok.com/api/comment/list/reply/",
            params={
                "count": count,
                "cursor": 0,
                "item_id": video_id,
                "comment_id": comment_id,
            },
            headers={"referer": "https://www.tiktok.com/"},
        )
        if not resp:
            raise UpstreamError("empty response when fetching replies")
        return [_map_comment(c) for c in (resp.get("comments") or [])]

    return await _call(run)


async def trending(count: int) -> list[dict[str, Any]]:
    async def run(api: TikTokApi) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        async for video in api.trending.videos(count=count):
            out.append(map_video(video.as_dict))
            if len(out) >= count:
                break
        return out

    return await _call(run)


async def search_videos(keyword: str, count: int) -> list[dict[str, Any]]:
    async def run(api: TikTokApi) -> list[dict[str, Any]]:
        # Ban moi co the co search.videos; 7.3.x dung search_type(..., "item").
        videos_fn = getattr(api.search, "videos", None)
        if videos_fn is not None:
            iterator = videos_fn(keyword, count=count)
        elif hasattr(api.search, "search_type"):
            iterator = api.search.search_type(keyword, "item", count=count)
        else:
            raise SearchNotSupported()
        out: list[dict[str, Any]] = []
        try:
            async for video in iterator:
                out.append(map_video(video.as_dict))
                if len(out) >= count:
                    break
        except NotImplementedError as exc:
            raise SearchNotSupported() from exc
        return out

    return await _call(run)
