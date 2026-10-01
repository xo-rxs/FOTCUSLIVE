"""촬영방의 한 송출자와 여러 시청자 사이에서 WebRTC 신호를 전달한다."""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Callable

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect


class LiveHub:
    def __init__(self, read_room: Callable, find_device: Callable) -> None:
        self.read_room = read_room
        self.find_device = find_device
        self.publishers: dict[str, WebSocket] = {}
        self.publisher_slots: dict[str, int] = {}
        self.public_ids: dict[str, str] = {}
        self.viewers: dict[str, dict[str, WebSocket]] = {}
        self.lock = asyncio.Lock()
        self.router = APIRouter()
        self.router.add_api_route("/api/live/rooms", self.list_rooms, methods=["GET"])

    async def list_rooms(self) -> list[dict]:
        async with self.lock:
            return [
                {"id": self.public_ids[code], "slot": self.publisher_slots[code], "viewers": len(self.viewers[code])}
                for code in self.publishers
            ]

    async def room_for_live_id(self, live_id: str) -> str | None:
        async with self.lock:
            return next((code for code, public_id in self.public_ids.items() if public_id == live_id), None)

    async def connect(self, websocket: WebSocket, code: str, viewer_only: bool = False) -> None:
        code = code.upper()
        try:
            room = self.read_room(code)
        except HTTPException:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        role = None
        viewer_id = None
        try:
            hello = await websocket.receive_json()
            if not isinstance(hello, dict):
                await websocket.send_json({"type": "error", "message": "잘못된 라이브 요청입니다."})
                return
            if hello.get("type") == "publish" and not viewer_only:
                try:
                    device = self.find_device(room, hello.get("token", ""))
                except Exception:
                    await websocket.send_json({"type": "error", "message": "송출 권한이 없습니다."})
                    return
                slot = room["devices"].index(device) + 1
                async with self.lock:
                    if code in self.publishers:
                        await websocket.send_json({"type": "error", "message": "이 방은 이미 라이브 중입니다."})
                        return
                    self.publishers[code] = websocket
                    self.publisher_slots[code] = slot
                    self.public_ids[code] = secrets.token_urlsafe(12)
                    self.viewers[code] = {}
                role = "publisher"
                await websocket.send_json({"type": "published", "slot": slot})
            elif hello.get("type") == "view":
                async with self.lock:
                    publisher = self.publishers.get(code)
                    if publisher is None:
                        await websocket.send_json({"type": "error", "message": "현재 라이브 중인 방이 아닙니다."})
                        return
                    viewer_id = secrets.token_urlsafe(12)
                    self.viewers[code][viewer_id] = websocket
                role = "viewer"
                await websocket.send_json({"type": "watching", "viewer_id": viewer_id})
                await publisher.send_json({"type": "viewer_joined", "viewer_id": viewer_id})
            else:
                await websocket.send_json({"type": "error", "message": "잘못된 라이브 요청입니다."})
                return

            while True:
                message = await websocket.receive_json()
                if not isinstance(message, dict):
                    continue
                kind = message.get("type")
                if kind not in ("offer", "answer", "candidate"):
                    continue
                if role == "publisher":
                    target = self.viewers.get(code, {}).get(message.get("viewer_id"))
                    if target and kind in ("offer", "candidate"):
                        await target.send_json(message)
                elif role == "viewer":
                    publisher = self.publishers.get(code)
                    if publisher and kind in ("answer", "candidate"):
                        message["viewer_id"] = viewer_id
                        await publisher.send_json(message)
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            if role == "publisher":
                async with self.lock:
                    if self.publishers.get(code) is websocket:
                        del self.publishers[code]
                        del self.publisher_slots[code]
                        del self.public_ids[code]
                        viewers = self.viewers.pop(code, {})
                    else:
                        viewers = {}
                for viewer in viewers.values():
                    try:
                        await viewer.send_json({"type": "ended"})
                        await viewer.close()
                    except (RuntimeError, WebSocketDisconnect):
                        pass
            elif role == "viewer":
                async with self.lock:
                    self.viewers.get(code, {}).pop(viewer_id, None)
                    publisher = self.publishers.get(code)
                if publisher:
                    try:
                        await publisher.send_json({"type": "viewer_left", "viewer_id": viewer_id})
                    except (RuntimeError, WebSocketDisconnect):
                        pass
