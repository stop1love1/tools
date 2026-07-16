"""TikTok data sidecar - FastAPI app dung sau Go gateway (/api/data/*)."""
from __future__ import annotations

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable

from dotenv import load_dotenv
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

load_dotenv()

import audio_service  # noqa: E402 - can load .env truoc
import tiktok_service as tk  # noqa: E402

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await tk.close_api()

app = FastAPI(title="TikTok Data Sidecar", lifespan=lifespan)

async def _guard(coro: Awaitable[Any]) -> Any:
    """Chay service call; moi loi upstream tra ve JSON 502, khong bao gio crash."""
    try:
        return await coro
    except tk.SearchNotSupported:
        return JSONResponse(
            status_code=501,
            content={
                "error": "search not supported",
                "hint": "Phiên bản TikTokApi đang cài không hỗ trợ tìm kiếm video; "
                "thử nâng cấp TikTokApi hoặc dùng /user/posts thay thế.",
            },
        )
    except tk.UpstreamError as exc:
        return JSONResponse(status_code=502, content={"error": str(exc), "hint": exc.hint})
    except Exception as exc:  # noqa: BLE001 - chan moi loi con lai
        return JSONResponse(
            status_code=502,
            content={"error": f"{type(exc).__name__}: {exc}", "hint": tk.BOT_HINT},
        )

@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "msToken": tk.ms_token() is not None}

@app.get("/video/meta")
async def video_meta(url: str = Query(..., description="URL video TikTok")) -> Any:
    return await _guard(tk.video_meta(url))

@app.get("/user/profile")
async def user_profile(username: str = Query(..., description="uniqueId")) -> Any:
    return await _guard(tk.user_profile(username))

@app.get("/user/posts")
async def user_posts(
    username: str = Query(..., description="uniqueId"),
    count: int = Query(10, ge=1, le=50),
) -> Any:
    return await _guard(tk.user_posts(username, count))

@app.get("/comments")
async def comments(
    url: str = Query(..., description="URL video TikTok"),
    count: int = Query(20, ge=1, le=100),
) -> Any:
    return await _guard(tk.video_comments(url, count))

@app.get("/comments/replies")
async def comment_replies(
    url: str = Query(..., description="URL video TikTok"),
    comment_id: str = Query(..., description="ID cua comment cha"),
    count: int = Query(20, ge=1, le=100),
) -> Any:
    return await _guard(tk.comment_replies(url, comment_id, count))

@app.get("/trending")
async def trending(count: int = Query(10, ge=1, le=50)) -> Any:
    return await _guard(tk.trending(count))

@app.get("/audio/resolve")
async def audio_resolve(
    url: str = Query(..., description="Link YouTube/SoundCloud/… can lay audio"),
) -> Any:
    return await _guard(audio_service.resolve_audio(url))

@app.get("/search")
async def search(
    q: str = Query(..., description="Tu khoa tim kiem"),
    count: int = Query(10, ge=1, le=50),
) -> Any:
    return await _guard(tk.search_videos(q, count))

if __name__ == "__main__":
    import uvicorn

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    port = int(os.getenv("SIDECAR_PORT", "8500"))
    uvicorn.run(app, host="127.0.0.1", port=port)
