"""두 휴대폰의 경기 영상과 선수 추적 결과를 관리하는 로컬 서버."""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from tracking import analyze_video


ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = Path(os.environ.get("FOTCUS_DATA_DIR", ROOT / "data")).resolve()
DATA.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".3gp"}
ROOM_CODE = re.compile(r"^[A-F0-9]{6}$")
LOCK = threading.RLock()
WORKERS = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-analysis")
LOG = logging.getLogger(__name__)

app = FastAPI(title="FOTCUSLIVE")
app.mount("/static", StaticFiles(directory=WEB), name="static")


class JoinRequest(BaseModel):
    token: str | None = None


class HeartbeatRequest(BaseModel):
    token: str
    recording: bool = False


def room_directory(code: str) -> Path:
    code = code.upper()
    if not ROOM_CODE.fullmatch(code):
        raise HTTPException(404, "촬영방을 찾을 수 없습니다.")
    return DATA / code


def read_room(code: str) -> dict:
    manifest = room_directory(code) / "room.json"
    if not manifest.is_file():
        raise HTTPException(404, "촬영방을 찾을 수 없습니다.")
    return json.loads(manifest.read_text(encoding="utf-8"))


def write_room(room: dict) -> None:
    directory = room_directory(room["code"])
    temporary = directory / "room.tmp"
    temporary.write_text(json.dumps(room, ensure_ascii=False), encoding="utf-8")
    temporary.replace(directory / "room.json")


def find_device(room: dict, token: str) -> dict:
    for device in room["devices"]:
        if device and secrets.compare_digest(device["token"], token):
            return device
    raise HTTPException(403, "이 휴대폰의 연결 정보를 찾을 수 없습니다.")


def public_room(room: dict) -> dict:
    now = time.time()
    devices = []
    for index, device in enumerate(room["devices"], start=1):
        if not device:
            devices.append({"slot": index, "joined": False, "connected": False})
            continue
        video = device.get("video")
        devices.append(
            {
                "slot": index,
                "joined": True,
                "connected": now - device["last_seen"] < 45,
                "recording": device.get("recording", False),
                "video": video,
            }
        )
    return {"code": room["code"], "devices": devices}


def update_video(code: str, slot: int, **changes: object) -> None:
    with LOCK:
        room = read_room(code)
        video = room["devices"][slot - 1].get("video")
        if video:
            video.update(changes)
            write_room(room)


def process_video(code: str, slot: int, source: Path) -> None:
    directory = room_directory(code) / f"device-{slot}"
    output = directory / "video.mp4"
    tracks = directory / "tracks.json"
    try:
        update_video(code, slot, status="converting", progress=0)
        command = [
            "ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", str(source),
            "-vf", "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
            "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(output),
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=1800)
        if result.returncode != 0:
            raise RuntimeError(result.stderr[-1000:] or "영상 변환에 실패했습니다.")

        update_video(code, slot, status="analyzing", progress=0)
        analysis = analyze_video(output, lambda value: update_video(code, slot, progress=value))
        tracks.write_text(json.dumps(analysis, ensure_ascii=False), encoding="utf-8")
        update_video(
            code, slot, status="ready", progress=100,
            duration=analysis["duration"],
            media_url=f"/api/rooms/{code}/videos/{slot}/media",
            tracks_url=f"/api/rooms/{code}/videos/{slot}/tracks",
        )
    except Exception:
        LOG.exception("영상 처리 실패: 촬영방 %s, 기기 %s", code, slot)
        update_video(code, slot, status="failed", error="영상 처리에 실패했습니다. 영상 형식과 서버 로그를 확인해 주세요.")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "index.html")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/rooms")
def create_room() -> dict:
    with LOCK:
        for _ in range(10):
            code = secrets.token_hex(3).upper()
            directory = room_directory(code)
            try:
                directory.mkdir()
                break
            except FileExistsError:
                continue
        else:
            raise HTTPException(503, "촬영방을 만들 수 없습니다. 다시 시도해 주세요.")

        token = secrets.token_urlsafe(24)
        room = {
            "code": code,
            "devices": [
                {"token": token, "last_seen": time.time(), "recording": False, "video": None},
                None,
            ],
        }
        write_room(room)
        return {"code": code, "slot": 1, "token": token}


@app.post("/api/rooms/{code}/join")
def join_room(code: str, request: JoinRequest) -> dict:
    with LOCK:
        room = read_room(code)
        if request.token:
            try:
                device = find_device(room, request.token)
                slot = room["devices"].index(device) + 1
                device["last_seen"] = time.time()
                write_room(room)
                return {"code": room["code"], "slot": slot, "token": request.token}
            except HTTPException:
                pass
        if room["devices"][1] is not None:
            raise HTTPException(409, "이미 두 대의 휴대폰이 연결되어 있습니다.")
        token = secrets.token_urlsafe(24)
        room["devices"][1] = {
            "token": token, "last_seen": time.time(), "recording": False, "video": None,
        }
        write_room(room)
        return {"code": room["code"], "slot": 2, "token": token}


@app.post("/api/rooms/{code}/heartbeat")
def heartbeat(code: str, request: HeartbeatRequest) -> dict:
    with LOCK:
        room = read_room(code)
        device = find_device(room, request.token)
        device["last_seen"] = time.time()
        device["recording"] = request.recording
        write_room(room)
        return public_room(room)


@app.get("/api/rooms/{code}")
def room_status(code: str) -> dict:
    with LOCK:
        return public_room(read_room(code))


@app.post("/api/rooms/{code}/videos")
async def upload_video(code: str, token: str = Form(...), file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "MP4, MOV, M4V, WEBM, 3GP 영상만 등록할 수 있습니다.")

    with LOCK:
        room = read_room(code)
        device = find_device(room, token)
        if device.get("video") is not None:
            raise HTTPException(409, "이 휴대폰의 영상이 이미 등록되었습니다. 새 촬영방을 만들어 주세요.")
        slot = room["devices"].index(device) + 1
        device["video"] = {"status": "uploading", "progress": 0}
        write_room(room)

    directory = room_directory(code) / f"device-{slot}"
    directory.mkdir(exist_ok=True)
    source = directory / f"source{suffix}"
    size = 0
    try:
        with source.open("wb") as destination:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "영상은 500MB 이하만 등록할 수 있습니다.")
                destination.write(chunk)
        if not size:
            raise HTTPException(400, "비어 있는 영상은 등록할 수 없습니다.")
    except Exception:
        source.unlink(missing_ok=True)
        with LOCK:
            room = read_room(code)
            room["devices"][slot - 1]["video"] = None
            write_room(room)
        raise
    finally:
        await file.close()

    update_video(code, slot, status="queued")
    WORKERS.submit(process_video, code.upper(), slot, source)
    return {"slot": slot, "status": "queued"}


@app.get("/api/rooms/{code}/videos/{slot}/media")
def media(code: str, slot: int) -> FileResponse:
    if slot not in (1, 2):
        raise HTTPException(404, "영상을 찾을 수 없습니다.")
    room = read_room(code)
    device = room["devices"][slot - 1]
    if not device or not device.get("video") or device["video"]["status"] != "ready":
        raise HTTPException(404, "영상이 아직 준비되지 않았습니다.")
    return FileResponse(room_directory(code) / f"device-{slot}" / "video.mp4", media_type="video/mp4")


@app.get("/api/rooms/{code}/videos/{slot}/tracks")
def track_results(code: str, slot: int) -> FileResponse:
    if slot not in (1, 2):
        raise HTTPException(404, "분석 결과를 찾을 수 없습니다.")
    room = read_room(code)
    device = room["devices"][slot - 1]
    if not device or not device.get("video") or device["video"]["status"] != "ready":
        raise HTTPException(404, "분석 결과가 아직 준비되지 않았습니다.")
    return FileResponse(room_directory(code) / f"device-{slot}" / "tracks.json", media_type="application/json")
