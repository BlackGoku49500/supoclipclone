"""Estimate horizontal speaker framing from faces and relative mouth motion in a selected edit."""
import math
from pathlib import Path
import subprocess


def frame_centers(path, start, seconds, width, height):
    import cv2
    import numpy as np

    cv2.setNumThreads(1)
    cascade = cv2.CascadeClassifier(str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"))
    if cascade.empty():
        raise RuntimeError("Face detector could not load its frontal-face cascade.")
    w = 320
    h = max(32, min(480, round(height / width * w / 2) * 2))
    args = ["ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-protocol_whitelist", "file,pipe",
            "-ss", str(start), "-i", str(path), "-t", str(seconds), "-an", "-vf", f"fps=3,scale={w}:{h},format=gray",
            "-threads", "1", "-f", "rawvideo", "pipe:1"]
    raw = subprocess.run(args, capture_output=True, check=True, timeout=150).stdout
    previous, points, current, proposed, votes = None, [], None, None, 0
    for index, frame in enumerate(np.frombuffer(raw, dtype=np.uint8).reshape((-1, h, w))):
        faces = cascade.detectMultiScale(frame, scaleFactor=1.12, minNeighbors=4, minSize=(20, 20))
        scores = []
        for x, y, fw, fh in faces:
            center = (x + fw / 2) / w
            mouth = (slice(y + fh * 3 // 5, y + fh * 9 // 10), slice(x + fw // 5, x + fw * 4 // 5))
            brow = (slice(y + fh // 5, y + fh // 2), mouth[1])
            movement = 0.0
            if previous is not None:
                def motion(region):
                    return float(cv2.absdiff(previous[region], frame[region]).mean())
                movement = max(0, motion(mouth) - motion(brow))
            continuity = 0.1 if current is not None and abs(center - current) < .12 else 0
            scores.append((math.sqrt(fw * fh / (w * h)) + min(movement / 30, .6) + continuity, center))
        previous = frame
        if not scores:
            continue
        winner = float(max(scores)[1])
        if current is None:
            current = winner
        elif abs(winner - current) < .15:
            current += .4 * (winner - current)
            votes = 0
        else:
            votes = votes + 1 if proposed is not None and abs(winner - proposed) < .1 else 1
            proposed = winner
            if votes >= 3:
                current, votes = winner, 0
        if not points or (index / 3 - points[-1][0] >= .9 and abs(current - points[-1][1]) > .025):
            points.append((index / 3, current))
    return points


def pan_expression(centers, width, height, fallback):
    ratio = min(1, height * 9 / (width * 16))
    if not centers or ratio >= .999:
        return f"{fallback:.6f}"
    def pan(center):
        return min(1, max(0, (center - ratio / 2) / (1 - ratio)))
    first, center = centers[0]
    previous = pan(center) if first <= .4 else fallback
    terms = [f"{previous:.5f}"]
    for timestamp, center in centers:
        target = pan(center)
        if abs(target - previous) > .005:
            terms.append(f"({target - previous:.5f})*clip((t-{timestamp:.3f})/0.40,0,1)")
            previous = target
    return "+".join(terms)
