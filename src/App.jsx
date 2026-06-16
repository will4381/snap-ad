import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;
const DEFAULT_CAPTION = "quick check";
const MIN_CLIPS = 2;
const MIN_TRIM_DURATION = 0.1;
const TRIM_STEP = 0.05;
const DEFAULT_OUTGOING_FREEZE_MS = 70;
const DEFAULT_SOURCE_FRAME_STEP_MS = Math.round(1000 / OUTPUT_FPS);
const DEFAULT_LOW_FRAME_HOLD_MS = Math.round(1000 / OUTPUT_FPS);
const DEFAULT_WARM_FRAME_HOLD_MS = Math.round(1000 / OUTPUT_FPS);
const DEFAULT_LOW_EXPOSURE_PERCENT = 56;
const DEFAULT_WARM_TINT = 14;
const DEFAULT_VIDEO_FIT_MODE = "cover";
const PRESET_VERSION = 1;
const CAPTION_FONT_SIZE = 44;
const DEFAULT_CAPTION_TOP = 49;
const CAPTION_BAR_ALPHA = 0.52;
const CAPTION_HORIZONTAL_PADDING = 58;
const CAPTION_VERTICAL_PADDING_RATIO = 0.31;
const CAPTION_LINE_HEIGHT_RATIO = 1.12;
const CAPTION_FONT_FAMILY = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const CAPTION_FONT_WEIGHT = 400;
const CAPTION_TRACKING_EM = -0.015;
const CAPTION_KERNING_PAIRS = {
  AV: -0.045,
  VA: -0.035,
  AY: -0.035,
  YA: -0.03,
  AW: -0.035,
  WA: -0.025,
  AT: -0.025,
  TA: -0.02,
  Yo: -0.018,
  Ya: -0.016,
};
const MIME_CANDIDATES = [
  { mimeType: 'video/mp4;codecs="avc1.42E01E, mp4a.40.2"', extension: "mp4", label: "MP4" },
  { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4", label: "MP4" },
  { mimeType: "video/mp4", extension: "mp4", label: "MP4" },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm", label: "WebM" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm", label: "WebM" },
  { mimeType: "video/webm", extension: "webm", label: "WebM" },
];
const VIDEO_FIT_MODES = new Set(["cover", "contain", "stretch"]);

function createClip(file) {
  return {
    id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
    file,
    name: file.name,
    size: file.size,
    url: URL.createObjectURL(file),
    duration: null,
    trimStart: 0,
    trimEnd: null,
  };
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "loading";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds)) return "0:00.00";
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${rest}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getClipTrimStart(clip) {
  return clamp(clip.trimStart || 0, 0, clip.duration || 0);
}

function getClipTrimEnd(clip) {
  return clamp(clip.trimEnd ?? clip.duration ?? 0, 0, clip.duration || 0);
}

function getClipTrimDuration(clip) {
  return Math.max(0, getClipTrimEnd(clip) - getClipTrimStart(clip));
}

function formatTrimValue(seconds) {
  return Number.isFinite(seconds) ? seconds.toFixed(2) : "0.00";
}

function formatMs(value) {
  return `${Math.round(value)}ms`;
}

function percentToDecimal(value) {
  return clamp(value, 0, 100) / 100;
}

function presetNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return clamp(Number.isFinite(parsed) ? parsed : fallback, min, max);
}

function presetBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function presetVideoFitMode(value, fallback = DEFAULT_VIDEO_FIT_MODE) {
  return VIDEO_FIT_MODES.has(value) ? value : fallback;
}

function isTextEntryTarget(target) {
  const tagName = target?.tagName;
  return target?.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function getIncomingWarmFrameTime(clip, sourceFrameStepMs) {
  const trimStart = getClipTrimStart(clip);
  const trimEnd = getClipTrimEnd(clip);
  return clamp(trimStart + sourceFrameStepMs / 1000, trimStart, trimEnd);
}

function getIncomingPlaybackStart(clip, sourceFrameStepMs) {
  const trimStart = getClipTrimStart(clip);
  const trimEnd = getClipTrimEnd(clip);
  return clamp(trimStart + (sourceFrameStepMs * 2) / 1000, trimStart, trimEnd);
}

function getClipPlaybackStart(clip, index, settings) {
  if (index > 0 && settings.useSwitchEffect) {
    return getIncomingPlaybackStart(clip, settings.sourceFrameStepMs);
  }

  return getClipTrimStart(clip);
}

function getClipPlaybackDuration(clip, index, settings) {
  const trimEnd = getClipTrimEnd(clip);
  const playbackStart = getClipPlaybackStart(clip, index, settings);
  return Math.max(0, trimEnd - playbackStart);
}

function getStillFrameTime(clip, seconds) {
  const trimStart = getClipTrimStart(clip);
  const trimEnd = getClipTrimEnd(clip);
  return clamp(seconds, trimStart, Math.max(trimStart, trimEnd - 0.001));
}

function buildTimeline(clips, settings) {
  const segments = [];
  let cursor = 0;

  clips.forEach((clip, index) => {
    const trimStart = getClipTrimStart(clip);
    const trimEnd = getClipTrimEnd(clip);

    if (index > 0 && settings.useSwitchEffect) {
      const lowDuration = Math.max(0, settings.lowFrameHoldMs) / 1000;
      if (lowDuration > 0) {
        segments.push({
          type: "low",
          clipIndex: index,
          start: cursor,
          end: cursor + lowDuration,
          sourceTime: getStillFrameTime(clip, trimStart),
        });
        cursor += lowDuration;
      }

      const warmDuration = Math.max(0, settings.warmFrameHoldMs) / 1000;
      if (warmDuration > 0) {
        segments.push({
          type: "warm",
          clipIndex: index,
          start: cursor,
          end: cursor + warmDuration,
          sourceTime: getStillFrameTime(clip, getIncomingWarmFrameTime(clip, settings.sourceFrameStepMs)),
        });
        cursor += warmDuration;
      }
    }

    const sourceStart = getClipPlaybackStart(clip, index, settings);
    const playDuration = Math.max(0, trimEnd - sourceStart);
    if (playDuration > 0) {
      segments.push({
        type: "play",
        clipIndex: index,
        start: cursor,
        end: cursor + playDuration,
        sourceStart,
      });
      cursor += playDuration;
    }

    if (index < clips.length - 1 && settings.useSwitchEffect) {
      const freezeDuration = Math.max(0, settings.outgoingFreezeMs) / 1000;
      if (freezeDuration > 0) {
        segments.push({
          type: "freeze",
          clipIndex: index,
          start: cursor,
          end: cursor + freezeDuration,
          sourceTime: getStillFrameTime(clip, trimEnd),
        });
        cursor += freezeDuration;
      }
    }
  });

  return {
    segments,
    totalDuration: cursor,
  };
}

function resolveTimelineTime(timeline, seconds) {
  const segments = timeline.segments;
  if (segments.length === 0) return null;

  const target = clamp(seconds, 0, Math.max(0, timeline.totalDuration));
  const segment =
    segments.find((item) => target >= item.start && target < item.end) || segments[segments.length - 1];
  const localTime = clamp(target - segment.start, 0, Math.max(0, segment.end - segment.start));
  const sourceTime = segment.type === "play" ? segment.sourceStart + localTime : segment.sourceTime;

  return {
    ...segment,
    localTime,
    sourceTime,
  };
}

function getExportFormatForMime(mimeType) {
  return mimeType.toLowerCase().includes("mp4")
    ? { extension: "mp4", label: "MP4" }
    : { extension: "webm", label: "WebM" };
}

function getBestRecordingFormat() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find(({ mimeType }) => MediaRecorder.isTypeSupported(mimeType)) || null;
}

function kerningBetween(left, right, fontSize) {
  return (CAPTION_KERNING_PAIRS[`${left}${right}`] || 0) * fontSize;
}

function settleWithTimeout(promise, milliseconds) {
  return Promise.race([
    promise.then(() => true).catch(() => false),
    new Promise((resolve) => {
      window.setTimeout(() => resolve(false), milliseconds);
    }),
  ]);
}

function waitForMetadata(video) {
  return new Promise((resolve, reject) => {
    const done = () => resolve(video);
    const fail = () => reject(new Error("Could not load video metadata."));

    if (video.readyState >= 1 && Number.isFinite(video.duration)) {
      done();
      return;
    }

    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("error", fail, { once: true });
  });
}

function seekVideo(video, seconds) {
  return new Promise((resolve, reject) => {
    const done = () => resolve(video);
    const fail = () => reject(new Error("Could not seek video."));

    if (Math.abs(video.currentTime - seconds) < 0.02) {
      done();
      return;
    }

    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.currentTime = seconds;
  });
}

function waitForDrawableVideoFrame(video) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("canplay", done);
      video.removeEventListener("error", fail);
    };
    const done = () => {
      cleanup();
      resolve(video);
    };
    const fail = () => {
      cleanup();
      reject(new Error("Could not load a video frame."));
    };

    if (video.readyState >= 2) {
      requestAnimationFrame(done);
      return;
    }

    if (typeof video.requestVideoFrameCallback === "function") {
      timeoutId = window.setTimeout(done, 500);
      video.requestVideoFrameCallback(done);
      return;
    }

    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("canplay", done, { once: true });
    video.addEventListener("error", fail, { once: true });
  });
}

function loadDuration(clip) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = clip.url;
    video.onloadedmetadata = () => resolve(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => resolve(null);
  });
}

function drawVideoFit(ctx, video, width, height, brightness = 1, fitMode = DEFAULT_VIDEO_FIT_MODE) {
  const videoWidth = video.videoWidth || width;
  const videoHeight = video.videoHeight || height;
  const normalizedFitMode = presetVideoFitMode(fitMode);
  const scale =
    normalizedFitMode === "contain"
      ? Math.min(width / videoWidth, height / videoHeight)
      : Math.max(width / videoWidth, height / videoHeight);
  const drawWidth = normalizedFitMode === "stretch" ? width : videoWidth * scale;
  const drawHeight = normalizedFitMode === "stretch" ? height : videoHeight * scale;
  const x = normalizedFitMode === "stretch" ? 0 : (width - drawWidth) / 2;
  const y = normalizedFitMode === "stretch" ? 0 : (height - drawHeight) / 2;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.filter = brightness < 1 ? `brightness(${brightness})` : "none";
  ctx.drawImage(video, x, y, drawWidth, drawHeight);
  ctx.filter = "none";
}

function captureVideoFrame(video) {
  if (!video.videoWidth || !video.videoHeight) return "";

  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    return "";
  }
}

function measureTrackedText(ctx, text, trackingPx, fontSize) {
  const chars = Array.from(text);
  if (chars.length === 0) return 0;

  return chars.reduce((width, char, index) => {
    const next = chars[index + 1];
    const spacing = next ? trackingPx + kerningBetween(char, next, fontSize) : 0;
    return width + ctx.measureText(char).width + spacing;
  }, 0);
}

function drawTrackedText(ctx, text, centerX, y, trackingPx, fontSize) {
  const chars = Array.from(text);
  const totalWidth = measureTrackedText(ctx, text, trackingPx, fontSize);
  let x = centerX - totalWidth / 2;

  chars.forEach((char, index) => {
    const next = chars[index + 1];
    ctx.fillText(char, x, y);
    x += ctx.measureText(char).width;
    if (next) {
      x += trackingPx + kerningBetween(char, next, fontSize);
    }
  });
}

function wrapCaption(ctx, text, maxWidth, trackingPx, fontSize) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines = [];
  let line = "";

  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (measureTrackedText(ctx, test, trackingPx, fontSize) <= maxWidth || !line) {
      line = test;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function drawCaption(ctx, text, fontSize, topPercent, width, height) {
  const caption = text.trim();
  if (!caption) return;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";

  const paddingX = CAPTION_HORIZONTAL_PADDING;
  const paddingY = Math.round(fontSize * CAPTION_VERTICAL_PADDING_RATIO);
  const lineHeight = Math.round(fontSize * CAPTION_LINE_HEIGHT_RATIO);
  const bandWidth = width;
  const x = 0;

  const trackingPx = fontSize * CAPTION_TRACKING_EM;

  ctx.font = `${CAPTION_FONT_WEIGHT} ${fontSize}px ${CAPTION_FONT_FAMILY}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const lines = wrapCaption(ctx, caption, bandWidth - paddingX * 2, trackingPx, fontSize);
  const bandHeight = Math.round(lines.length * lineHeight + paddingY * 2);
  const y = Math.round(height * (topPercent / 100) - bandHeight / 2);

  ctx.fillStyle = `rgba(0, 0, 0, ${CAPTION_BAR_ALPHA})`;
  ctx.fillRect(x, y, bandWidth, bandHeight);

  ctx.fillStyle = "#fff";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  lines.forEach((line, index) => {
    const textY = y + paddingY + lineHeight / 2 + index * lineHeight;
    drawTrackedText(ctx, line, width / 2, textY, trackingPx, fontSize);
  });
  ctx.restore();
}

function drawFrame(ctx, video, options, effects = {}) {
  const { caption, captionSize, captionTop, videoFitMode, width, height } = options;
  const { brightness = 1, warmth = 0 } = effects;
  drawVideoFit(ctx, video, width, height, brightness, videoFitMode);
  if (warmth > 0) {
    ctx.fillStyle = `rgba(255, 212, 92, ${percentToDecimal(warmth)})`;
    ctx.fillRect(0, 0, width, height);
  }
  drawCaption(ctx, caption, captionSize, captionTop, width, height);
}

function drawVideoSegment(video, ctx, options, startTime, endTime, onProgress) {
  return new Promise((resolve, reject) => {
    let frameId = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frameId);
      drawFrame(ctx, video, options);
      resolve();
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frameId);
      reject(new Error("A clip failed while rendering."));
    };

    const tick = () => {
      const elapsed = Math.max(0, video.currentTime - startTime);
      drawFrame(ctx, video, options);
      onProgress(elapsed);

      if (video.ended || video.currentTime >= endTime - 0.03) {
        finish();
        return;
      }

      frameId = requestAnimationFrame(tick);
    };

    video.addEventListener("ended", finish, { once: true });
    video.addEventListener("error", fail, { once: true });
    frameId = requestAnimationFrame(tick);
  });
}

function drawStillFramePause(video, ctx, options, milliseconds, onProgress, effects = {}) {
  return new Promise((resolve) => {
    if (milliseconds <= 0) {
      drawFrame(ctx, video, options, effects);
      onProgress(1);
      resolve();
      return;
    }

    const startedAt = performance.now();

    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / milliseconds);
      drawFrame(ctx, video, options, effects);
      onProgress(progress);

      if (progress >= 1) {
        resolve();
        return;
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  });
}

async function renderSequence({
  clips,
  caption,
  captionSize,
  captionTop,
  videoFitMode,
  useSwitchEffect,
  outgoingFreezeMs,
  sourceFrameStepMs,
  lowFrameHoldMs,
  lowExposurePercent,
  warmFrameHoldMs,
  warmTint,
  keepAudio,
  onStatus,
  onProgress,
}) {
  const recordingFormat = getBestRecordingFormat();

  if (!recordingFormat) {
    throw new Error("This browser does not support MediaRecorder video export.");
  }

  const mimeType = recordingFormat.mimeType;

  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_WIDTH;
  canvas.height = OUTPUT_HEIGHT;
  const ctx = canvas.getContext("2d", { alpha: false });
  const videoStream = canvas.captureStream(OUTPUT_FPS);
  const streamTracks = [...videoStream.getVideoTracks()];
  let audioContext = null;
  let audioDestination = null;
  let recordAudio = keepAudio;

  if (recordAudio) {
    audioContext = new AudioContext();
    const audioReady = await settleWithTimeout(audioContext.resume(), 900);

    if (audioReady && audioContext.state === "running") {
      audioDestination = audioContext.createMediaStreamDestination();
      streamTracks.push(...audioDestination.stream.getAudioTracks());
    } else {
      await audioContext.close();
      audioContext = null;
      recordAudio = false;
      onStatus("Audio unavailable; rendering silent video");
    }
  }

  const mediaStream = new MediaStream(streamTracks);
  const recorder = new MediaRecorder(mediaStream, { mimeType });
  const chunks = [];
  const options = {
    caption,
    captionSize,
    captionTop,
    videoFitMode,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
  };
  const switchSettings = {
    useSwitchEffect,
    outgoingFreezeMs,
    sourceFrameStepMs,
    lowFrameHoldMs,
    warmFrameHoldMs,
  };
  const timeline = buildTimeline(clips, switchSettings);
  const playbackDurations = clips.map((clip, index) => getClipPlaybackDuration(clip, index, switchSettings));
  const totalDuration = Math.max(0.001, timeline.totalDuration);
  let completedSeconds = 0;
  let recorderStarted = false;

  const startRecorder = () => {
    if (recorderStarted) return;
    recorder.start(250);
    recorderStarted = true;
  };

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = () => reject(new Error("Recorder failed while exporting."));
  });

  try {
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index];
      const trimStart = getClipTrimStart(clip);
      const trimEnd = getClipTrimEnd(clip);
      onStatus(`Rendering ${index + 1} of ${clips.length}`);

      const video = document.createElement("video");
      video.src = clip.url;
      video.preload = "auto";
      video.playsInline = true;
      video.muted = !recordAudio;

      let audioSource = null;
      if (recordAudio && audioContext && audioDestination) {
        audioSource = audioContext.createMediaElementSource(video);
        audioSource.connect(audioDestination);
      }

      await waitForMetadata(video);
      await seekVideo(video, trimStart);

      if (index > 0 && useSwitchEffect) {
        onStatus("Holding low-exposure frame");
        await drawStillFramePause(video, ctx, options, lowFrameHoldMs, (settleProgress) => {
          const settleSeconds = (settleProgress * lowFrameHoldMs) / 1000;
          onProgress(Math.min(1, (completedSeconds + settleSeconds) / totalDuration));
        }, { brightness: percentToDecimal(lowExposurePercent) });
        completedSeconds += lowFrameHoldMs / 1000;

        onStatus("Holding warm frame");
        await seekVideo(video, getIncomingWarmFrameTime(clip, sourceFrameStepMs));
        await drawStillFramePause(video, ctx, options, warmFrameHoldMs, (warmProgress) => {
          const warmSeconds = (warmProgress * warmFrameHoldMs) / 1000;
          onProgress(Math.min(1, (completedSeconds + warmSeconds) / totalDuration));
        }, { warmth: warmTint });
        completedSeconds += warmFrameHoldMs / 1000;
      }

      const playbackStart = getClipPlaybackStart(clip, index, switchSettings);
      await seekVideo(video, playbackStart);
      await waitForDrawableVideoFrame(video);

      if (playbackStart < trimEnd - 0.005) {
        await video.play();
        drawFrame(ctx, video, options);
        startRecorder();
        await drawVideoSegment(video, ctx, options, playbackStart, trimEnd, (clipSeconds) => {
          onProgress(Math.min(1, (completedSeconds + clipSeconds) / totalDuration));
        });
      } else {
        drawFrame(ctx, video, options);
        startRecorder();
      }

      completedSeconds += playbackDurations[index] || 0;
      video.pause();

      if (audioSource) {
        audioSource.disconnect();
      }

      if (index < clips.length - 1 && useSwitchEffect) {
        onStatus("Holding last frame");
        await drawStillFramePause(video, ctx, options, outgoingFreezeMs, (transitionProgress) => {
          const transitionSeconds = (transitionProgress * outgoingFreezeMs) / 1000;
          onProgress(Math.min(1, (completedSeconds + transitionSeconds) / totalDuration));
        });
        completedSeconds += outgoingFreezeMs / 1000;
      }
    }
  } finally {
    if (recorderStarted && recorder.state !== "inactive") {
      recorder.stop();
    }
    streamTracks.forEach((track) => track.stop());
    if (audioContext) await audioContext.close();
  }

  if (recorderStarted) {
    await stopped;
  }
  const recordedMimeType = recorder.mimeType || mimeType;
  const recordedFormat = getExportFormatForMime(recordedMimeType);
  return {
    blob: new Blob(chunks, { type: recordedMimeType }),
    mimeType: recordedMimeType,
    extension: recordedFormat.extension,
    label: recordedFormat.label,
  };
}

function DropZone({ onFiles }) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    onFiles([...event.dataTransfer.files]);
  };

  return (
    <section
      className={`drop-zone ${dragging ? "is-dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div>
        <h2>Add Clips</h2>
        <p>Paste video files, drag them here, or choose them from disk.</p>
      </div>
      <label className="file-button">
        Choose videos
        <input type="file" accept="video/*" multiple onChange={(event) => onFiles([...event.target.files])} />
      </label>
    </section>
  );
}

function ClipList({ clips, onRemove, onMove, onOpenTrim, onTrimReset, onClear }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Clips</h2>
        <button type="button" onClick={onClear} disabled={clips.length === 0}>
          Clear
        </button>
      </div>
      <ol className="clip-list">
        {clips.length === 0 ? (
          <li className="empty-row">No videos yet.</li>
        ) : (
          clips.map((clip, index) => (
            <li className="clip-row" key={clip.id}>
              <span className="clip-index">{index + 1}</span>
              <span className="clip-meta">
                <strong>{clip.name}</strong>
                <small>
                  {formatDuration(getClipTrimDuration(clip))} selected / {formatDuration(clip.duration)} total / {formatBytes(clip.size)}
                </small>
              </span>
              <span className="clip-actions">
                <button
                  type="button"
                  onClick={() => onMove(clip.id, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${clip.name} up`}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => onMove(clip.id, 1)}
                  disabled={index === clips.length - 1}
                  aria-label={`Move ${clip.name} down`}
                  title="Move down"
                >
                  ↓
                </button>
                <button type="button" onClick={() => onRemove(clip.id)} aria-label={`Remove ${clip.name}`}>
                  Remove
                </button>
              </span>
              <span className="clip-trim">
                <span>
                  {formatTimestamp(getClipTrimStart(clip))} - {formatTimestamp(getClipTrimEnd(clip))}
                </span>
                <button type="button" onClick={() => onOpenTrim(clip.id)} disabled={!Number.isFinite(clip.duration)}>
                  Trim
                </button>
                <button type="button" onClick={() => onTrimReset(clip.id)} disabled={!Number.isFinite(clip.duration)}>
                  Reset
                </button>
              </span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

function TrimDialog({ clip, onClose, onApply }) {
  const videoRef = useRef(null);
  const timelineRef = useRef(null);
  const duration = clip?.duration || 0;
  const minDuration = Math.min(MIN_TRIM_DURATION, duration || MIN_TRIM_DURATION);
  const [draftStart, setDraftStart] = useState(0);
  const [draftEnd, setDraftEnd] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!clip) return;
    const nextStart = getClipTrimStart(clip);
    const nextEnd = getClipTrimEnd(clip);
    setDraftStart(nextStart);
    setDraftEnd(nextEnd);
    setPlayhead(nextStart);
    setPlaying(false);
  }, [clip]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key === " " && !isTextEntryTarget(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        if (playing) {
          pauseSelection();
        } else {
          playSelection();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, playing]);

  if (!clip) return null;

  const timeFromPointer = (clientX) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
  };

  const seekPreview = (seconds) => {
    const next = clamp(seconds, 0, duration);
    setPlayhead(next);
    if (videoRef.current && Number.isFinite(next)) {
      videoRef.current.currentTime = next;
    }
  };

  const playBounds = (start, end, seconds) => {
    const video = videoRef.current;
    if (!video) return;

    const next = clamp(seconds, start, Math.max(start, end - 0.02));
    video.currentTime = next;
    setPlayhead(next);
    video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  const playSelection = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.currentTime < draftStart || video.currentTime >= draftEnd - 0.02) {
      video.currentTime = draftStart;
      setPlayhead(draftStart);
    }

    video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  const pauseSelection = () => {
    if (videoRef.current) videoRef.current.pause();
    setPlaying(false);
  };

  const resetDraft = () => {
    setDraftStart(0);
    setDraftEnd(duration);
    seekPreview(0);
  };

  const beginTimelineDrag = (mode, event) => {
    event.preventDefault();
    event.stopPropagation();

    const initialTime = timeFromPointer(event.clientX);
    const initialStart = draftStart;
    const initialEnd = draftEnd;
    const initialLength = Math.max(minDuration, initialEnd - initialStart);
    let finalStart = initialStart;
    let finalEnd = initialEnd;
    pauseSelection();

    let lastPreviewTime = initialTime;

    const applyDrag = (clientX) => {
      const pointerTime = timeFromPointer(clientX);

      if (mode === "start") {
        const nextStart = clamp(pointerTime, 0, Math.max(0, draftEnd - minDuration));
        setDraftStart(nextStart);
        seekPreview(nextStart);
        finalStart = nextStart;
        finalEnd = draftEnd;
        lastPreviewTime = nextStart;
        return;
      }

      if (mode === "end") {
        const nextEnd = clamp(pointerTime, Math.min(duration, draftStart + minDuration), duration);
        setDraftEnd(nextEnd);
        seekPreview(nextEnd);
        finalStart = draftStart;
        finalEnd = nextEnd;
        lastPreviewTime = Math.max(draftStart, nextEnd - 0.2);
        return;
      }

      if (mode === "range") {
        const delta = pointerTime - initialTime;
        const nextStart = clamp(initialStart + delta, 0, Math.max(0, duration - initialLength));
        const nextEnd = Math.min(duration, nextStart + initialLength);
        setDraftStart(nextStart);
        setDraftEnd(nextEnd);
        seekPreview(nextStart);
        finalStart = nextStart;
        finalEnd = nextEnd;
        lastPreviewTime = nextStart;
        return;
      }

      seekPreview(pointerTime);
      finalStart = draftStart;
      finalEnd = draftEnd;
      lastPreviewTime = pointerTime;
    };

    const handleMove = (moveEvent) => {
      applyDrag(moveEvent.clientX);
    };

    const handleUp = (upEvent) => {
      applyDrag(upEvent.clientX);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.setTimeout(
        () => playBounds(finalStart, finalEnd, mode === "scrub" ? lastPreviewTime : finalStart),
        0,
      );
    };

    applyDrag(event.clientX);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };

  const handleApply = () => {
    onApply(clip.id, draftStart, draftEnd);
    onClose();
  };

  const trimStyle = {
    "--trim-start": `${duration ? (draftStart / duration) * 100 : 0}%`,
    "--trim-end": `${duration ? (draftEnd / duration) * 100 : 100}%`,
    "--playhead": `${duration ? (playhead / duration) * 100 : 0}%`,
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="trim-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Trim ${clip.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="trim-header">
          <div>
            <h2>Trim Clip</h2>
            <p>{clip.name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close trim dialog">
            Close
          </button>
        </div>

        <div className="trim-preview">
          <video
            ref={videoRef}
            src={clip.url}
            playsInline
            muted
            onLoadedMetadata={() => seekPreview(draftStart)}
            onTimeUpdate={(event) => {
              const current = event.currentTarget.currentTime;
              setPlayhead(current);
              if (current >= draftEnd - 0.02) {
                event.currentTarget.currentTime = draftStart;
                setPlayhead(draftStart);
                event.currentTarget.play().catch(() => setPlaying(false));
              }
            }}
            onPause={() => setPlaying(false)}
          />
        </div>

        <div className="trim-readout">
          <span>Start {formatTimestamp(draftStart)}</span>
          <strong>{formatTimestamp(Math.max(0, draftEnd - draftStart))} selected</strong>
          <span>End {formatTimestamp(draftEnd)}</span>
        </div>

        <div className="trim-editor">
          <div
            ref={timelineRef}
            className="trim-timeline"
            style={trimStyle}
            onPointerDown={(event) => beginTimelineDrag("scrub", event)}
          >
            <span className="trim-rail" />
            <span
              className="trim-window"
              onPointerDown={(event) => beginTimelineDrag("range", event)}
              role="slider"
              aria-label="Selected clip range"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={draftStart}
              tabIndex={0}
            />
            <button
              className="trim-handle trim-handle-start"
              type="button"
              aria-label="Drag trim start"
              onPointerDown={(event) => beginTimelineDrag("start", event)}
            />
            <button
              className="trim-handle trim-handle-end"
              type="button"
              aria-label="Drag trim end"
              onPointerDown={(event) => beginTimelineDrag("end", event)}
            />
            <button
              className="trim-playhead"
              type="button"
              aria-label="Drag playhead"
              onPointerDown={(event) => beginTimelineDrag("scrub", event)}
            />
          </div>
          <div className="trim-scale" aria-hidden="true">
            <span>0:00.00</span>
            <span>{formatTimestamp(duration)}</span>
          </div>
        </div>

        <div className="trim-actions">
          <button type="button" onClick={playing ? pauseSelection : playSelection}>
            {playing ? "Pause" : "Play selected"}
          </button>
          <button type="button" onClick={resetDraft}>
            Reset
          </button>
        </div>

        <div className="trim-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={handleApply}>
            Apply trim
          </button>
        </div>
      </section>
    </div>
  );
}

function PhonePreview({
  clips,
  caption,
  captionTop,
  videoFitMode,
  timeline,
  scrubTime,
  onScrubTimeChange,
  keyboardDisabled,
  useSwitchEffect,
  outgoingFreezeMs,
  sourceFrameStepMs,
  lowFrameHoldMs,
  lowExposurePercent,
  warmFrameHoldMs,
  warmTint,
}) {
  const videoRef = useRef(null);
  const timeoutRef = useRef(null);
  const settleTimeoutRef = useRef(null);
  const warmTimeoutRef = useRef(null);
  const transitionPendingRef = useRef(false);
  const settleStartedRef = useRef(false);
  const activeIndexRef = useRef(0);
  const pendingFrameRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [holdingFrame, setHoldingFrame] = useState(false);
  const [settlingFrame, setSettlingFrame] = useState(false);
  const [incomingEffect, setIncomingEffect] = useState("");
  const [holdFrameUrl, setHoldFrameUrl] = useState("");
  const activeClip = clips[activeIndex] || null;

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const applyPendingFrame = useCallback(() => {
    const pendingFrame = pendingFrameRef.current;
    const video = videoRef.current;

    if (!pendingFrame || !video || video.readyState < 1 || activeIndexRef.current !== pendingFrame.clipIndex) {
      return false;
    }

    video.pause();
    video.currentTime = pendingFrame.sourceTime;
    pendingFrameRef.current = null;
    return true;
  }, []);

  const stopPreview = useCallback(() => {
    clearTimeout(timeoutRef.current);
    clearTimeout(settleTimeoutRef.current);
    clearTimeout(warmTimeoutRef.current);
    transitionPendingRef.current = false;
    settleStartedRef.current = false;
    setPlaying(false);
    setHoldingFrame(false);
    setSettlingFrame(false);
    setIncomingEffect("");
    setHoldFrameUrl("");
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, []);

  const showResolvedFrame = useCallback(
    (resolved) => {
      if (!resolved) return;

      clearTimeout(timeoutRef.current);
      clearTimeout(settleTimeoutRef.current);
      clearTimeout(warmTimeoutRef.current);
      transitionPendingRef.current = false;
      settleStartedRef.current = false;
      pendingFrameRef.current = resolved;
      setPlaying(false);
      setHoldingFrame(false);
      setSettlingFrame(false);
      setHoldFrameUrl("");
      setIncomingEffect(resolved.type === "low" || resolved.type === "warm" ? resolved.type : "");
      setActiveIndex(resolved.clipIndex);
      window.setTimeout(() => applyPendingFrame(), 0);
    },
    [applyPendingFrame],
  );

  useEffect(() => stopPreview, [stopPreview]);

  useEffect(() => {
    applyPendingFrame();
  }, [activeIndex, activeClip, applyPendingFrame]);

  useEffect(() => {
    if (activeIndex >= clips.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, clips.length]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip || !playing || holdingFrame || settlingFrame || transitionPendingRef.current) return;
    if (video.readyState < 1) return;

    const start =
      settlingFrame && useSwitchEffect
        ? getClipTrimStart(activeClip)
        : getClipPlaybackStart(activeClip, activeIndex, { useSwitchEffect, sourceFrameStepMs });
    const end = getClipTrimEnd(activeClip);
    if (video.currentTime < start - 0.02 || video.currentTime > end) {
      video.currentTime = start;
      return;
    }
    video.play().catch(() => setPlaying(false));
  }, [activeClip, activeIndex, holdingFrame, playing, settlingFrame, sourceFrameStepMs, useSwitchEffect]);

  const playPreview = () => {
    if (clips.length === 0) return;
    clearTimeout(timeoutRef.current);
    clearTimeout(settleTimeoutRef.current);
    clearTimeout(warmTimeoutRef.current);
    transitionPendingRef.current = false;
    settleStartedRef.current = false;
    setActiveIndex(0);
    setHoldingFrame(false);
    setSettlingFrame(false);
    setIncomingEffect("");
    setHoldFrameUrl("");
    onScrubTimeChange(0);
    pendingFrameRef.current = resolveTimelineTime(timeline, 0);
    setPlaying(true);
    window.setTimeout(() => applyPendingFrame(), 0);
  };

  const pausePreview = () => {
    if (videoRef.current) videoRef.current.pause();
    setPlaying(false);
  };

  const resumePreview = () => {
    if (clips.length === 0) return;
    if (!activeClip) {
      playPreview();
      return;
    }

    setPlaying(true);
    if (videoRef.current && !holdingFrame && !settlingFrame) {
      videoRef.current.play().catch(() => setPlaying(false));
    }
  };

  const togglePreview = () => {
    if (playing) {
      pausePreview();
    } else {
      resumePreview();
    }
  };

  useEffect(() => {
    if (keyboardDisabled) return undefined;

    const handleKeyDown = (event) => {
      if (event.key !== " " || isTextEntryTarget(event.target)) return;
      event.preventDefault();
      togglePreview();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keyboardDisabled, playing, activeClip, clips.length, holdingFrame, settlingFrame]);

  const advancePreview = () => {
    if (transitionPendingRef.current) return;

    if (activeIndex >= clips.length - 1) {
      stopPreview();
      return;
    }

    const nextIndex = activeIndex + 1;
    if (!useSwitchEffect) {
      const nextSegment = timeline.segments.find((segment) => segment.type === "play" && segment.clipIndex === nextIndex);
      if (nextSegment) onScrubTimeChange(nextSegment.start);
      setActiveIndex(nextIndex);
      return;
    }

    transitionPendingRef.current = true;
    settleStartedRef.current = false;
    setIncomingEffect("");
    const freezeSegment = timeline.segments.find((segment) => segment.type === "freeze" && segment.clipIndex === activeIndex);
    if (freezeSegment) onScrubTimeChange(freezeSegment.start);
    const frozenFrame = videoRef.current ? captureVideoFrame(videoRef.current) : "";
    setHoldFrameUrl(frozenFrame);
    setHoldingFrame(true);
    timeoutRef.current = window.setTimeout(() => {
      setActiveIndex((index) => index + 1);
      setSettlingFrame(true);
    }, outgoingFreezeMs);
  };

  const handleEnded = () => {
    advancePreview();
  };

  function seekPreviewFrame(video, seconds, callback) {
    const target = Number.isFinite(seconds) ? seconds : 0;
    if (Math.abs(video.currentTime - target) < 0.015) {
      callback();
      return;
    }

    const done = () => callback();
    video.addEventListener("seeked", done, { once: true });
    video.currentTime = target;
  }

  function finishSettle() {
    const video = videoRef.current;
    if (!video || !activeClip || !playing || !settlingFrame || settleStartedRef.current) return;

    if (!useSwitchEffect) {
      setSettlingFrame(false);
      transitionPendingRef.current = false;
      settleStartedRef.current = false;
      video.play().catch(() => setPlaying(false));
      return;
    }

    settleStartedRef.current = true;
    clearTimeout(settleTimeoutRef.current);
    clearTimeout(warmTimeoutRef.current);
    setHoldingFrame(false);
    setHoldFrameUrl("");
    setIncomingEffect("low");
    const lowSegment = timeline.segments.find((segment) => segment.type === "low" && segment.clipIndex === activeIndex);
    const warmSegment = timeline.segments.find((segment) => segment.type === "warm" && segment.clipIndex === activeIndex);
    const playSegment = timeline.segments.find((segment) => segment.type === "play" && segment.clipIndex === activeIndex);
    if (lowSegment) onScrubTimeChange(lowSegment.start);

    settleTimeoutRef.current = window.setTimeout(() => {
      seekPreviewFrame(video, getIncomingWarmFrameTime(activeClip, sourceFrameStepMs), () => {
        setIncomingEffect("warm");
        if (warmSegment) onScrubTimeChange(warmSegment.start);

        warmTimeoutRef.current = window.setTimeout(() => {
          seekPreviewFrame(video, getIncomingPlaybackStart(activeClip, sourceFrameStepMs), () => {
            setIncomingEffect("");
            setSettlingFrame(false);
            transitionPendingRef.current = false;
            settleStartedRef.current = false;
            if (playSegment) onScrubTimeChange(playSegment.start);
            video.play().catch(() => setPlaying(false));
          });
        }, warmFrameHoldMs);
      });
    }, lowFrameHoldMs);
  }

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video || !activeClip) return;

    if (applyPendingFrame()) return;

    const start = getClipPlaybackStart(activeClip, activeIndex, { useSwitchEffect, sourceFrameStepMs });
    if (Math.abs(video.currentTime - start) < 0.02) {
      if (settlingFrame) {
        finishSettle();
      } else if (playing) {
        video.play().catch(() => setPlaying(false));
      }
      return;
    }

    video.currentTime = start;
  };

  const handleSeeked = () => {
    const video = videoRef.current;
    if (!video || !activeClip) return;

    if (settlingFrame) {
      finishSettle();
      return;
    }

    if (playing && !holdingFrame) {
      video.play().catch(() => setPlaying(false));
    }
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !activeClip || !playing || holdingFrame || settlingFrame) return;

    const playSegment = timeline.segments.find((segment) => segment.type === "play" && segment.clipIndex === activeIndex);
    if (playSegment) {
      const nextTime = playSegment.start + Math.max(0, video.currentTime - playSegment.sourceStart);
      onScrubTimeChange(clamp(nextTime, 0, timeline.totalDuration));
    }

    if (video.currentTime >= getClipTrimEnd(activeClip) - 0.03) {
      video.pause();
      advancePreview();
    }
  };

  const captionStyle = {
    fontSize: `${Math.max(17, Math.round(CAPTION_FONT_SIZE / 4.25))}px`,
    top: `${captionTop}%`,
    fontFamily: CAPTION_FONT_FAMILY,
    fontWeight: CAPTION_FONT_WEIGHT,
    letterSpacing: `${CAPTION_TRACKING_EM}em`,
  };
  const hasCaption = caption.trim().length > 0;
  const videoClassName = incomingEffect === "low" ? "is-exposure-down" : "";
  const phoneStyle = {
    "--caption-top": `${captionTop}%`,
    "--low-brightness": percentToDecimal(lowExposurePercent),
  };
  const mediaFitStyle = {
    objectFit: videoFitMode === "contain" ? "contain" : videoFitMode === "stretch" ? "fill" : "cover",
  };
  const scrubMax = Math.max(0, timeline.totalDuration);

  const handleScrubChange = (event) => {
    const nextTime = clamp(Number(event.target.value), 0, scrubMax);
    stopPreview();
    onScrubTimeChange(nextTime);
    showResolvedFrame(resolveTimelineTime(timeline, nextTime));
  };

  return (
    <section className="preview-shell" aria-label="Video preview">
      <div className="preview-scrubber">
        <div className="scrub-times">
          <span>{formatTimestamp(scrubTime)}</span>
          <span>{formatTimestamp(scrubMax)}</span>
        </div>
        <input
          type="range"
          min="0"
          max={scrubMax}
          step="0.01"
          value={clamp(scrubTime, 0, scrubMax)}
          disabled={scrubMax <= 0}
          onChange={handleScrubChange}
          aria-label="Preview timeline"
        />
      </div>
      <div className="phone-frame" style={phoneStyle}>
        {activeClip ? (
          <video
            ref={videoRef}
            className={videoClassName}
            style={mediaFitStyle}
            src={activeClip.url}
            muted
            playsInline
            onLoadedMetadata={handleLoadedMetadata}
            onSeeked={handleSeeked}
            onEnded={handleEnded}
            onTimeUpdate={handleTimeUpdate}
          />
        ) : (
          <div className={`preview-empty ${hasCaption ? "has-caption" : ""}`}>Add at least two clips</div>
        )}
        {holdFrameUrl ? (
          <img className="held-frame" style={mediaFitStyle} src={holdFrameUrl} alt="" aria-hidden="true" />
        ) : null}
        {incomingEffect === "warm" ? (
          <div className="warm-frame-overlay" style={{ opacity: percentToDecimal(warmTint) }} aria-hidden="true" />
        ) : null}
        {hasCaption ? (
          <div className="caption-band" style={captionStyle}>
            {caption}
          </div>
        ) : null}
      </div>
      <div className="preview-controls">
        <button type="button" onClick={playPreview} disabled={clips.length === 0 || playing}>
          Preview
        </button>
        <button type="button" onClick={() => stopPreview()} disabled={!playing && !holdingFrame && !settlingFrame}>
          Stop
        </button>
      </div>
    </section>
  );
}

function FineRangeControl({ label, description, value, onChange, min, max, step, unit, formatValue, disabled = false }) {
  const updateValue = (nextValue) => {
    if (disabled) return;
    if (!Number.isFinite(nextValue)) return;
    onChange(clamp(nextValue, min, max));
  };
  const valueLabel = formatValue ? formatValue(value) : `${value}${unit ? unit : ""}`;

  return (
    <label className="field">
      {label}
      <div className="fine-control">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => updateValue(Number(event.target.value))}
        />
        <input
          className="fine-number"
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => updateValue(Number(event.target.value))}
        />
      </div>
      <span>{valueLabel}</span>
      {description ? <small>{description}</small> : null}
    </label>
  );
}

function RenderPanel({
  canRender,
  caption,
  setCaption,
  captionTop,
  setCaptionTop,
  videoFitMode,
  setVideoFitMode,
  useSwitchEffect,
  setUseSwitchEffect,
  outgoingFreezeMs,
  setOutgoingFreezeMs,
  sourceFrameStepMs,
  setSourceFrameStepMs,
  lowFrameHoldMs,
  setLowFrameHoldMs,
  lowExposurePercent,
  setLowExposurePercent,
  warmFrameHoldMs,
  setWarmFrameHoldMs,
  warmTint,
  setWarmTint,
  keepAudio,
  setKeepAudio,
  outputUrl,
  outputLabel,
  outputExtension,
  isRendering,
  renderProgress,
  renderStatus,
  onRender,
  presetJson,
  setPresetJson,
  presetError,
  onExportPreset,
  onLoadPreset,
}) {
  return (
    <section className="panel render-panel">
      <h2>Frame</h2>
      <label className="field">
        Video fit
        <select value={videoFitMode} onChange={(event) => setVideoFitMode(event.target.value)}>
          <option value="cover">Fill frame, crop edges</option>
          <option value="contain">Fit inside, black bars</option>
          <option value="stretch">Stretch to frame</option>
        </select>
        <small>Controls how each source video is placed inside the vertical 9:16 output frame.</small>
      </label>
      <h2>Caption</h2>
      <label className="field">
        Text
        <textarea value={caption} maxLength={120} onChange={(event) => setCaption(event.target.value)} />
      </label>
      <FineRangeControl
        label="Bar position"
        value={captionTop}
        onChange={setCaptionTop}
        min={20}
        max={80}
        step={0.1}
        formatValue={(value) => `${value.toFixed(1)}%`}
        description="Moves the Snapchat-style caption bar up and down in the output."
      />
      <h2>Switch</h2>
      <label className="check-row check-row-stacked">
        <span>
          <input
            type="checkbox"
            checked={useSwitchEffect}
            onChange={(event) => setUseSwitchEffect(event.target.checked)}
          />
          Use switch frames
        </span>
        <small>Turn this off for hard cuts between clips with no freeze, low frame, warm frame, or skipped incoming frames.</small>
      </label>
      <FineRangeControl
        label="Last-frame freeze"
        value={outgoingFreezeMs}
        onChange={setOutgoingFreezeMs}
        min={0}
        max={300}
        step={1}
        formatValue={formatMs}
        disabled={!useSwitchEffect}
        description="How long the outgoing clip holds on its final visible frame before switching."
      />
      <FineRangeControl
        label="Incoming source frame step"
        value={sourceFrameStepMs}
        onChange={setSourceFrameStepMs}
        min={1}
        max={120}
        step={1}
        formatValue={formatMs}
        disabled={!useSwitchEffect}
        description="How far apart the first low frame, second warm frame, and normal playback start are inside the incoming clip."
      />
      <FineRangeControl
        label="Low frame hold"
        value={lowFrameHoldMs}
        onChange={setLowFrameHoldMs}
        min={0}
        max={300}
        step={1}
        formatValue={formatMs}
        disabled={!useSwitchEffect}
        description="How long the first incoming frame is held before the warm frame appears."
      />
      <FineRangeControl
        label="Low exposure brightness"
        value={lowExposurePercent}
        onChange={setLowExposurePercent}
        min={10}
        max={100}
        step={1}
        formatValue={(value) => `${value}%`}
        disabled={!useSwitchEffect}
        description="Brightness for the first incoming frame. Lower values make the simulated exposure dip darker."
      />
      <FineRangeControl
        label="Warm frame hold"
        value={warmFrameHoldMs}
        onChange={setWarmFrameHoldMs}
        min={0}
        max={300}
        step={1}
        formatValue={formatMs}
        disabled={!useSwitchEffect}
        description="How long the second incoming frame stays yellow/warm before normal playback starts."
      />
      <FineRangeControl
        label="Warm tint"
        value={warmTint}
        onChange={setWarmTint}
        min={0}
        max={45}
        step={1}
        formatValue={(value) => `${value}%`}
        disabled={!useSwitchEffect}
        description="Amount of yellow warmth over the second incoming frame."
      />
      <label className="check-row">
        <input type="checkbox" checked={keepAudio} onChange={(event) => setKeepAudio(event.target.checked)} />
        Preserve source audio
      </label>
      <h2>Preset</h2>
      <div className="preset-actions">
        <button type="button" onClick={onExportPreset}>
          Copy preset JSON
        </button>
        <button type="button" onClick={onLoadPreset} disabled={presetJson.trim().length === 0}>
          Paste preset
        </button>
      </div>
      <label className="field">
        Preset JSON
        <textarea
          className="preset-textarea"
          value={presetJson}
          onChange={(event) => setPresetJson(event.target.value)}
          placeholder='{"version":1,"caption":"quick check"}'
        />
        <small>Exports and loads the right-side caption, switch, and audio settings. Clips are not included.</small>
        {presetError ? <strong className="field-error">{presetError}</strong> : null}
      </label>
      <button className="render-button" type="button" onClick={onRender} disabled={!canRender || isRendering}>
        {isRendering ? "Rendering" : "Render clip"}
      </button>
      <div className="render-status" aria-live="polite">
        <span>{renderStatus}</span>
        <progress max="1" value={renderProgress} />
      </div>
      {outputUrl ? (
        <a className="download-link" href={outputUrl} download={`snapad-captioned.${outputExtension}`}>
          Download {outputLabel}
        </a>
      ) : null}
    </section>
  );
}

export default function App() {
  const [clips, setClips] = useState([]);
  const [caption, setCaption] = useState(DEFAULT_CAPTION);
  const [captionTop, setCaptionTop] = useState(DEFAULT_CAPTION_TOP);
  const [videoFitMode, setVideoFitMode] = useState(DEFAULT_VIDEO_FIT_MODE);
  const [useSwitchEffect, setUseSwitchEffect] = useState(true);
  const [outgoingFreezeMs, setOutgoingFreezeMs] = useState(DEFAULT_OUTGOING_FREEZE_MS);
  const [sourceFrameStepMs, setSourceFrameStepMs] = useState(DEFAULT_SOURCE_FRAME_STEP_MS);
  const [lowFrameHoldMs, setLowFrameHoldMs] = useState(DEFAULT_LOW_FRAME_HOLD_MS);
  const [lowExposurePercent, setLowExposurePercent] = useState(DEFAULT_LOW_EXPOSURE_PERCENT);
  const [warmFrameHoldMs, setWarmFrameHoldMs] = useState(DEFAULT_WARM_FRAME_HOLD_MS);
  const [warmTint, setWarmTint] = useState(DEFAULT_WARM_TINT);
  const [keepAudio, setKeepAudio] = useState(true);
  const [outputUrl, setOutputUrl] = useState("");
  const [outputLabel, setOutputLabel] = useState("MP4");
  const [outputExtension, setOutputExtension] = useState("mp4");
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState("Ready");
  const [scrubTime, setScrubTime] = useState(0);
  const [presetJson, setPresetJson] = useState("");
  const [presetError, setPresetError] = useState("");
  const [trimClipId, setTrimClipId] = useState(null);
  const clipsRef = useRef([]);
  const outputUrlRef = useRef("");

  const canRender = clips.length >= MIN_CLIPS && clips.every((clip) => getClipTrimDuration(clip) > 0) && !isRendering;

  const switchSettings = useMemo(
    () => ({
      useSwitchEffect,
      outgoingFreezeMs,
      sourceFrameStepMs,
      lowFrameHoldMs,
      warmFrameHoldMs,
    }),
    [useSwitchEffect, outgoingFreezeMs, sourceFrameStepMs, lowFrameHoldMs, warmFrameHoldMs],
  );

  const timeline = useMemo(() => buildTimeline(clips, switchSettings), [clips, switchSettings]);
  const totalDuration = timeline.totalDuration;
  const trimClip = clips.find((clip) => clip.id === trimClipId) || null;

  useEffect(() => {
    setScrubTime((current) => clamp(current, 0, Math.max(0, totalDuration)));
  }, [totalDuration]);

  const addFiles = useCallback((files) => {
    const videoFiles = files.filter((file) => file.type.startsWith("video/"));
    if (videoFiles.length === 0) return;

    const nextClips = videoFiles.map(createClip);
    setClips((current) => [...current, ...nextClips]);
    setRenderStatus(`${nextClips.length} clip${nextClips.length === 1 ? "" : "s"} added`);

    nextClips.forEach(async (clip) => {
      const duration = await loadDuration(clip);
      setClips((current) =>
        current.map((item) =>
          item.id === clip.id
            ? {
                ...item,
                duration,
                trimStart: 0,
                trimEnd: duration,
              }
            : item,
        ),
      );
    });
  }, []);

  useEffect(() => {
    const handlePaste = (event) => {
      const files = [...event.clipboardData.files];
      if (files.some((file) => file.type.startsWith("video/"))) {
        event.preventDefault();
        addFiles(files);
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [addFiles]);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    outputUrlRef.current = outputUrl;
  }, [outputUrl]);

  useEffect(() => {
    return () => {
      clipsRef.current.forEach((clip) => URL.revokeObjectURL(clip.url));
      if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
    };
  }, []);

  const removeClip = (id) => {
    if (trimClipId === id) setTrimClipId(null);
    setClips((current) => {
      const removed = current.find((clip) => clip.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      return current.filter((clip) => clip.id !== id);
    });
  };

  const moveClip = (id, direction) => {
    setClips((current) => {
      const index = current.findIndex((clip) => clip.id === id);
      const nextIndex = index + direction;

      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const applyClipTrim = (id, start, end) => {
    setClips((current) =>
      current.map((clip) => {
        if (clip.id !== id || !Number.isFinite(clip.duration)) return clip;

        const duration = clip.duration;
        const minDuration = Math.min(MIN_TRIM_DURATION, duration);
        const nextStart = clamp(start, 0, Math.max(0, duration - minDuration));
        const nextEnd = clamp(end, Math.min(duration, nextStart + minDuration), duration);

        return {
          ...clip,
          trimStart: nextStart,
          trimEnd: nextEnd,
        };
      }),
    );
  };

  const resetClipTrim = (id) => {
    setClips((current) =>
      current.map((clip) =>
        clip.id === id && Number.isFinite(clip.duration)
          ? {
              ...clip,
              trimStart: 0,
              trimEnd: clip.duration,
            }
          : clip,
      ),
    );
  };

  const clearClips = () => {
    clips.forEach((clip) => URL.revokeObjectURL(clip.url));
    setClips([]);
    setRenderProgress(0);
    setRenderStatus("Ready");
    setScrubTime(0);
    setTrimClipId(null);
  };

  const createPreset = () => ({
    version: PRESET_VERSION,
    caption,
    captionTop,
    videoFitMode,
    useSwitchEffect,
    outgoingFreezeMs,
    sourceFrameStepMs,
    lowFrameHoldMs,
    lowExposurePercent,
    warmFrameHoldMs,
    warmTint,
    keepAudio,
  });

  const handleExportPreset = async () => {
    const json = JSON.stringify(createPreset(), null, 2);
    setPresetJson(json);

    try {
      await navigator.clipboard.writeText(json);
      setPresetError("");
      setRenderStatus("Preset copied to clipboard");
    } catch {
      setPresetError("Could not copy automatically. The preset JSON is ready in the box.");
      setRenderStatus("Preset ready to copy");
    }
  };

  const handleLoadPreset = () => {
    try {
      const preset = JSON.parse(presetJson);
      setCaption(typeof preset.caption === "string" ? preset.caption.slice(0, 120) : DEFAULT_CAPTION);
      setCaptionTop(presetNumber(preset.captionTop, DEFAULT_CAPTION_TOP, 20, 80));
      setVideoFitMode(presetVideoFitMode(preset.videoFitMode));
      setUseSwitchEffect(presetBoolean(preset.useSwitchEffect, true));
      setOutgoingFreezeMs(presetNumber(preset.outgoingFreezeMs, DEFAULT_OUTGOING_FREEZE_MS, 0, 300));
      setSourceFrameStepMs(presetNumber(preset.sourceFrameStepMs, DEFAULT_SOURCE_FRAME_STEP_MS, 1, 120));
      setLowFrameHoldMs(presetNumber(preset.lowFrameHoldMs, DEFAULT_LOW_FRAME_HOLD_MS, 0, 300));
      setLowExposurePercent(presetNumber(preset.lowExposurePercent, DEFAULT_LOW_EXPOSURE_PERCENT, 10, 100));
      setWarmFrameHoldMs(presetNumber(preset.warmFrameHoldMs, DEFAULT_WARM_FRAME_HOLD_MS, 0, 300));
      setWarmTint(presetNumber(preset.warmTint, DEFAULT_WARM_TINT, 0, 45));
      setKeepAudio(presetBoolean(preset.keepAudio, true));
      setPresetError("");
      setRenderStatus("Preset loaded");
    } catch {
      setPresetError("Could not read that preset JSON.");
    }
  };

  const handleRender = async () => {
    if (!canRender) return;

    if (outputUrl) {
      URL.revokeObjectURL(outputUrl);
      setOutputUrl("");
    }

    setIsRendering(true);
    setRenderProgress(0);
    setRenderStatus("Preparing render");

    try {
      const result = await renderSequence({
        clips,
        caption,
        captionSize: CAPTION_FONT_SIZE,
        captionTop,
        videoFitMode,
        useSwitchEffect,
        outgoingFreezeMs,
        sourceFrameStepMs,
        lowFrameHoldMs,
        lowExposurePercent,
        warmFrameHoldMs,
        warmTint,
        keepAudio,
        onStatus: setRenderStatus,
        onProgress: setRenderProgress,
      });
      setOutputUrl(URL.createObjectURL(result.blob));
      setOutputLabel(result.label);
      setOutputExtension(result.extension);
      setRenderProgress(1);
      setRenderStatus(`Rendered ${(result.blob.size / 1024 / 1024).toFixed(1)} MB ${result.label}`);
    } catch (error) {
      setRenderStatus(error.message);
    } finally {
      setIsRendering(false);
    }
  };

  return (
    <main className="app-shell">
      <div className="workspace">
        <aside className="left-rail">
          <DropZone onFiles={addFiles} />
          <ClipList
            clips={clips}
            onRemove={removeClip}
            onMove={moveClip}
            onOpenTrim={setTrimClipId}
            onTrimReset={resetClipTrim}
            onClear={clearClips}
          />
        </aside>

        <PhonePreview
          clips={clips}
          caption={caption}
          captionTop={captionTop}
          videoFitMode={videoFitMode}
          timeline={timeline}
          scrubTime={scrubTime}
          onScrubTimeChange={setScrubTime}
          keyboardDisabled={Boolean(trimClip)}
          useSwitchEffect={useSwitchEffect}
          outgoingFreezeMs={outgoingFreezeMs}
          sourceFrameStepMs={sourceFrameStepMs}
          lowFrameHoldMs={lowFrameHoldMs}
          lowExposurePercent={lowExposurePercent}
          warmFrameHoldMs={warmFrameHoldMs}
          warmTint={warmTint}
        />

        <RenderPanel
          canRender={canRender}
          caption={caption}
          setCaption={setCaption}
          captionTop={captionTop}
          setCaptionTop={setCaptionTop}
          videoFitMode={videoFitMode}
          setVideoFitMode={setVideoFitMode}
          useSwitchEffect={useSwitchEffect}
          setUseSwitchEffect={setUseSwitchEffect}
          outgoingFreezeMs={outgoingFreezeMs}
          setOutgoingFreezeMs={setOutgoingFreezeMs}
          sourceFrameStepMs={sourceFrameStepMs}
          setSourceFrameStepMs={setSourceFrameStepMs}
          lowFrameHoldMs={lowFrameHoldMs}
          setLowFrameHoldMs={setLowFrameHoldMs}
          lowExposurePercent={lowExposurePercent}
          setLowExposurePercent={setLowExposurePercent}
          warmFrameHoldMs={warmFrameHoldMs}
          setWarmFrameHoldMs={setWarmFrameHoldMs}
          warmTint={warmTint}
          setWarmTint={setWarmTint}
          keepAudio={keepAudio}
          setKeepAudio={setKeepAudio}
          outputUrl={outputUrl}
          outputLabel={outputLabel}
          outputExtension={outputExtension}
          isRendering={isRendering}
          renderProgress={renderProgress}
          renderStatus={renderStatus}
          onRender={handleRender}
          presetJson={presetJson}
          setPresetJson={setPresetJson}
          presetError={presetError}
          onExportPreset={handleExportPreset}
          onLoadPreset={handleLoadPreset}
        />
      </div>
      <TrimDialog clip={trimClip} onClose={() => setTrimClipId(null)} onApply={applyClipTrim} />
    </main>
  );
}
