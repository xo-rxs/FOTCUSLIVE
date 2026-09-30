"""업로드한 영상에서 사람의 화면상 위치와 임시 추적 ID를 추출한다."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import cv2
from ultralytics import YOLO


def analyze_video(video_path: Path, on_progress: Callable[[int], None]) -> dict:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("분석할 영상을 열 수 없습니다.")

    fps = capture.get(cv2.CAP_PROP_FPS) or 24.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if width <= 0 or height <= 0:
        capture.release()
        raise ValueError("영상 크기를 읽을 수 없습니다.")

    # 작은 모델로 시작하고 4fps만 분석해 CPU에서도 첫 버전을 실행할 수 있게 한다.
    model = YOLO("yolo11n.pt")
    step = max(1, round(fps / 4))
    frames: list[dict] = []
    frame_index = 0

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % step == 0:
                prediction = model.track(
                    frame,
                    persist=True,
                    tracker="bytetrack.yaml",
                    classes=[0],  # 일반 사람 검출. 심판/관중도 포함될 수 있다.
                    conf=0.2,
                    imgsz=640,
                    verbose=False,
                )[0]
                boxes = []
                if prediction.boxes is not None and prediction.boxes.id is not None:
                    ids = prediction.boxes.id.int().cpu().tolist()
                    coordinates = prediction.boxes.xyxy.cpu().tolist()
                    for track_id, (x1, y1, x2, y2) in zip(ids, coordinates):
                        boxes.append(
                            {
                                "id": track_id,
                                "box": [
                                    round(max(0.0, min(1.0, x1 / width)), 5),
                                    round(max(0.0, min(1.0, y1 / height)), 5),
                                    round(max(0.0, min(1.0, x2 / width)), 5),
                                    round(max(0.0, min(1.0, y2 / height)), 5),
                                ],
                            }
                        )
                frames.append({"time": round(frame_index / fps, 3), "boxes": boxes})
                if total_frames and len(frames) % 12 == 0:
                    on_progress(min(99, round(frame_index / total_frames * 100)))
            frame_index += 1
    finally:
        capture.release()

    if frame_index == 0:
        raise ValueError("영상에서 프레임을 읽지 못했습니다.")
    on_progress(100)
    return {
        "width": width,
        "height": height,
        "duration": round(frame_index / fps, 2),
        "sample_fps": round(fps / step, 2),
        "frames": frames,
    }
