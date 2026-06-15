# SnapAd

A small local Vite app for combining two or more pasted video clips, adding a centered Snapchat-style caption band, and exporting the result with a short camera-flip pause between clips.

## Run

```bash
npm install
npm run dev
```

Open the printed local URL, paste/drag/select at least two video files, enter a caption, then render.

## Export Notes

Rendering happens in the browser with `canvas.captureStream()` and `MediaRecorder`, so the default export is WebM. Source audio is preserved best-effort by connecting each clip to a browser audio stream during render.
