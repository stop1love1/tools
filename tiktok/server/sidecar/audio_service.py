"""Giai link YouTube/SoundCloud/... ra URL audio truc tiep bang yt-dlp."""
from __future__ import annotations

import asyncio
import os
from typing import Any

from yt_dlp import YoutubeDL

from tiktok_service import UpstreamError

_YDL_OPTS: dict[str, Any] = {
    "format": "bestaudio/best",
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "skip_download": True,
    "socket_timeout": 15,
    # YouTube chan request server nhu bot ("Sign in to confirm you're not a
    # bot"). Uu tien player client di dong/TV — thuong khong dinh check nay
    # va khong can dang nhap. Web de fallback cuoi.
    "extractor_args": {
        "youtube": {"player_client": ["tv", "ios", "android", "web"]}
    },
}

# Neu van bi chan: tro toi cookies (trinh duyet dang dang nhap YouTube tren
# may) qua bien moi truong — YTDLP_COOKIES_FROM_BROWSER=chrome|edge|firefox
# hoac YTDLP_COOKIES_FILE=/duong/dan/cookies.txt
_cookie_browser = os.environ.get("YTDLP_COOKIES_FROM_BROWSER", "").strip()
if _cookie_browser:
    _YDL_OPTS["cookiesfrombrowser"] = (_cookie_browser,)
_cookie_file = os.environ.get("YTDLP_COOKIES_FILE", "").strip()
if _cookie_file:
    _YDL_OPTS["cookiefile"] = _cookie_file

def _extract(url: str) -> dict[str, Any]:
    with YoutubeDL(_YDL_OPTS) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is None:
        raise UpstreamError("yt-dlp khong doc duoc url", hint="Kiem tra lai link")
    if "entries" in info and info["entries"]:
        info = info["entries"][0]
    audio_url = info.get("url")
    if not audio_url:
        formats = info.get("formats") or []
        audio_only = [f for f in formats if f.get("acodec") not in (None, "none") and f.get("url")]
        if audio_only:
            audio_url = audio_only[-1]["url"]
    if not audio_url:
        raise UpstreamError(
            "khong tim thay stream audio", hint="Video co the bi chan/gioi han khu vuc"
        )
    return {
        "audioUrl": audio_url,
        "title": info.get("title") or "Audio",
        "thumbnail": info.get("thumbnail") or "",
        "duration": info.get("duration"),
        "site": info.get("extractor_key", ""),
    }

async def resolve_audio(url: str) -> dict[str, Any]:
    """yt-dlp la sync + ton vai giay -> day sang thread de khong chan event loop."""
    try:
        return await asyncio.to_thread(_extract, url)
    except UpstreamError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise UpstreamError(
            f"yt-dlp: {type(exc).__name__}: {exc}",
            hint="Link không được hỗ trợ hoặc bị chặn — thử link YouTube khác",
        ) from exc
