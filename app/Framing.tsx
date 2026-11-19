"use client";
import * as React from "react";
import {
  Captions,
  Crop,
  Image as ImageIcon,
  PanelTop,
  ScanLine,
  Focus,
  SlidersHorizontal,
} from "lucide-react";
import type { Clip, Settings, Source } from "../lib/types";

export const DEFAULT_SETTINGS: Settings = {
  mode: "split",
  facecam: { x: 0.02, y: 0.035, w: 0.28, h: 0.34 },
  pan: 0.5,
  captionStyle: "neon",
  hook: true,
};

const bounded = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
const modes = [
  { id: "split", label: "Streamer split", Icon: PanelTop },
  { id: "smart", label: "Smart crop", Icon: ScanLine },
  { id: "speaker", label: "Speaker", Icon: Focus },
] as const;
const presets = [
  { id: "tl", label: "Top left" },
  { id: "tr", label: "Top right" },
  { id: "bl", label: "Bottom left" },
  { id: "br", label: "Bottom right" },
] as const;
const styles = [
  { id: "neon", label: "Neon" },
  { id: "yellow", label: "Bold yellow" },
  { id: "white", label: "White" },
  { id: "box", label: "Dark box" },
] as const;
type EditorProps = {
  source: Source;
  settings: Settings;
  onChange: (s: Settings) => void;
  mediaUrl?: string;
  onDrag: (v: boolean) => void;
};
type Region = Settings["facecam"];

function SourceFrame({
  source,
  mediaUrl,
  at,
}: {
  source: Source;
  mediaUrl?: string;
  at?: number;
}) {
  const [failed, setFailed] = React.useState<"video" | "image" | null>(null);
  React.useEffect(() => setFailed(null), [source.id, mediaUrl]);
  if (mediaUrl && !failed)
    return (
      <video
        src={mediaUrl}
        muted
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          v.currentTime = Math.min(at ?? 0, Math.max(0, v.duration - 0.1));
        }}
        onError={() => setFailed("video")}
      />
    );
  if (source.thumbnail && failed !== "image")
    return (
      <img
        src={source.thumbnail}
        alt=""
        draggable={false}
        onError={() => setFailed("image")}
      />
    );
  return (
    <div className="source-placeholder">
      <ImageIcon size={23} />
      <span>Source frame</span>
    </div>
  );
}

function RegionPicker({
  source,
  settings,
  onChange,
  mediaUrl,
  onDrag,
}: EditorProps) {
  const region = settings.facecam;
  const frame = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{
    pointer: number;
    startX: number;
    startY: number;
    rect: Region;
    mode: "move" | "resize";
  } | null>(null);
  const update = (part: Partial<Region>) =>
    onChange({ ...settings, facecam: { ...region, ...part } });
  React.useEffect(() => () => onDrag(false), [onDrag]);
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const mode = (e.target as HTMLElement).closest("[data-resize]")
      ? "resize"
      : "move";
    drag.current = {
      pointer: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      rect: { ...region },
      mode,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    onDrag(true);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current,
      bounds = frame.current?.getBoundingClientRect();
    if (
      !start ||
      start.pointer !== e.pointerId ||
      !bounds?.width ||
      !bounds.height
    )
      return;
    const dx = (e.clientX - start.startX) / bounds.width,
      dy = (e.clientY - start.startY) / bounds.height,
      r = start.rect;
    if (start.mode === "resize")
      update({
        w: bounded(r.w + dx, 0.06, 1 - r.x),
        h: bounded(r.h + dy, 0.06, 1 - r.y),
      });
    else
      update({
        x: bounded(r.x + dx, 0, 1 - r.w),
        y: bounded(r.y + dy, 0, 1 - r.h),
      });
  };
  const stop = () => {
    if (drag.current) {
      drag.current = null;
      onDrag(false);
    }
  };
  return (
    <div className="region-editor">
      <div className="field-row">
        <span className="field-label">Facecam region</span>
        <small>Drag to move · pull the corner to resize</small>
      </div>
      <div
        className="region-frame"
        style={{
          aspectRatio: Math.max(0.1, source.width / Math.max(1, source.height)),
          width:
            "min(100%, " +
            (320 * source.width) / Math.max(1, source.height) +
            "px)",
        }}
        ref={frame}
      >
        <SourceFrame source={source} mediaUrl={mediaUrl} />
        <div
          aria-hidden="true"
          className="facecam-box"
          style={{
            left: region.x * 100 + "%",
            top: region.y * 100 + "%",
            width: region.w * 100 + "%",
            height: region.h * 100 + "%",
          }}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
        >
          <span>Facecam</span>
          <i data-resize="true" />
        </div>
      </div>
      <div className="presets" aria-label="Facecam presets">
        {presets.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() =>
              update({
                x: id.endsWith("r")
                  ? Math.max(0, 0.985 - region.w)
                  : Math.min(0.015, 1 - region.w),
                y: id.startsWith("b")
                  ? Math.max(0, 0.985 - region.h)
                  : Math.min(0.015, 1 - region.h),
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      <details className="numeric-region">
        <summary>Region coordinates</summary>
        <div className="region-inputs">
          {(["x", "y", "w", "h"] as const).map((field, i) => {
            const max = {
                x: 1 - region.w,
                y: 1 - region.h,
                w: 1 - region.x,
                h: 1 - region.y,
              }[field],
              min = i > 1 ? 0.06 : 0;
            return (
              <label key={field}>
                {["X", "Y", "Width", "Height"][i]}
                <span>
                  <input
                    type="number"
                    step="1"
                    min={Math.ceil(min * 100)}
                    max={Math.round(max * 100)}
                    value={Math.round(region[field] * 100)}
                    onChange={(e) => {
                      const n = e.currentTarget.valueAsNumber;
                      if (Number.isFinite(n))
                        update({ [field]: bounded(n / 100, min, max) });
                    }}
                  />
                  %
                </span>
              </label>
            );
          })}
        </div>
      </details>
    </div>
  );
}

export function FramingEditor(props: EditorProps) {
  const { settings, onChange, onDrag } = props;
  return (
    <section className="panel edit-panel">
      <div className="panel-head">
        <SlidersHorizontal size={17} />
        <h2>Clip adjustments</h2>
      </div>
      <div className="panel-body">
        <div className="field-row">
          <span className="field-label">Vertical layout</span>
        </div>
        <div className="tabs" role="group" aria-label="Vertical layout">
          {modes.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={id === settings.mode}
              className={"tab" + (id === settings.mode ? " active" : "")}
              onClick={() => onChange({ ...settings, mode: id })}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        <p className="layout-note">
          {settings.mode === "split"
            ? "Facecam on top (35%), action below (65%)."
            : settings.mode === "speaker"
              ? "Follow the speaking face. Pan sets the framing when no face is visible."
              : "Vertical crop with 1.2× punch-ins on hype moments."}
        </p>
        {settings.mode === "split" && <RegionPicker {...props} />}
        <div className="field-row crop-row">
          <label htmlFor="pan">
            <Crop size={14} />
            {settings.mode === "split"
              ? "Action framing"
              : "Horizontal framing"}
          </label>
          <output>{Math.round(settings.pan * 100)}%</output>
        </div>
        <input
          className="crop-slider"
          id="pan"
          type="range"
          min={0}
          max={100}
          value={Math.round(settings.pan * 100)}
          onPointerDown={() => onDrag(true)}
          onPointerUp={() => onDrag(false)}
          onPointerCancel={() => onDrag(false)}
          onLostPointerCapture={() => onDrag(false)}
          onChange={(e) =>
            onChange({ ...settings, pan: Number(e.target.value) / 100 })
          }
        />
        <div className="field-row">
          <span className="field-label">
            <Captions size={14} />
            Caption style
          </span>
        </div>
        <div className="caption-grid">
          {styles.map(({ id, label }) => (
            <button
              type="button"
              key={id}
              aria-pressed={settings.captionStyle === id}
              className={
                "caption-option" +
                (settings.captionStyle === id ? " active" : "")
              }
              onClick={() => onChange({ ...settings, captionStyle: id })}
            >
              <span className={"cap-sample " + id}>Aa</span>
              {label}
            </button>
          ))}
        </div>
        <label className="hook-switch">
          <span>
            Opening hook <small>First 3 seconds</small>
          </span>
          <input
            type="checkbox"
            checked={settings.hook}
            onChange={(e) => onChange({ ...settings, hook: e.target.checked })}
          />
        </label>
      </div>
    </section>
  );
}

export function FramingPreview({
  source,
  settings,
  clip,
  mediaUrl,
}: {
  source: Source;
  settings: Settings;
  clip: Clip | null;
  mediaUrl?: string;
}) {
  const W = source.width || 16,
    H = source.height || 9,
    split = settings.mode === "split",
    face = settings.facecam;
  const [media, setMedia] = React.useState<
    HTMLImageElement | HTMLVideoElement | null
  >(null);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const first = clip?.segments[0]?.start ?? 0;
  React.useEffect(() => {
    let active = true;
    setMedia(null);
    const image = new Image();
    const loadThumbnail = () => {
      if (!active || !source.thumbnail) return;
      image.onload = () => {
        if (active) setMedia(image);
      };
      image.src = source.thumbnail;
    };
    if (mediaUrl) {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      const loaded = () => {
        if (active) setMedia(v);
      };
      v.onloadedmetadata = () => {
        if (first > 0)
          v.currentTime = Math.min(first, Math.max(0, v.duration - 0.05));
      };
      v.onloadeddata = () => {
        if (!v.seeking) loaded();
      };
      v.onseeked = loaded;
      v.onerror = loadThumbnail;
      v.src = mediaUrl;
      return () => {
        active = false;
        v.onloadeddata = null;
        v.onloadedmetadata = null;
        v.onseeked = null;
        v.onerror = null;
        image.onload = null;
        v.removeAttribute("src");
        v.load();
      };
    }
    loadThumbnail();
    return () => {
      active = false;
      image.onload = null;
    };
  }, [source.id, source.thumbnail, mediaUrl, first]);
  React.useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !media) return;
    const w =
        media instanceof HTMLVideoElement
          ? media.videoWidth
          : media.naturalWidth,
      h =
        media instanceof HTMLVideoElement
          ? media.videoHeight
          : media.naturalHeight;
    if (!w || !h) return;
    const sw = W,
      sh = H;
    function crop(
      x: number,
      y: number,
      cw: number,
      ch: number,
      top: number,
      height: number,
      pan: number,
    ) {
      let sx = x,
        sy = y,
        ww = cw,
        hh = ch;
      const ratio = 540 / height;
      if (cw / ch > ratio) {
        ww = ch * ratio;
        sx += (cw - ww) * pan;
      } else {
        hh = cw / ratio;
        sy += (ch - hh) * 0.5;
      }
      ctx!.drawImage(
        media!,
        (sx / sw) * w,
        (sy / sh) * h,
        (ww / sw) * w,
        (hh / sh) * h,
        0,
        top,
        540,
        height,
      );
    }
    if (split) {
      crop(face.x * sw, face.y * sh, face.w * sw, face.h * sh, 0, 336, 0.5);
      crop(0, 0, sw, sh, 336, 624, settings.pan);
    } else crop(0, 0, sw, sh, 0, 960, settings.pan);
  }, [W, H, media, face, settings.pan, split]);
  const cue = clip?.captions.find(
    (c) => c.start <= first + 0.2 && c.end > first,
  );
  return (
    <div className="framing-preview">
      {media ? (
        <canvas
          ref={canvas}
          width={540}
          height={960}
          aria-label="Live framing preview"
        />
      ) : (
        <div className="frame-wait">
          <ImageIcon size={21} />
          <span>{source.title}</span>
        </div>
      )}
      {clip && settings.hook && (
        <div className="frame-hook">{clip.hookTitle}</div>
      )}
      {cue && (
        <div className={"frame-caption " + settings.captionStyle}>
          <span>{cue.text}</span>
        </div>
      )}
    </div>
  );
}
