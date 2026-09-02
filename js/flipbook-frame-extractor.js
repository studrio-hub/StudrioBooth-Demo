/*
 * FLIPBOOK-FRAME-EXTRACTOR.JS
 *
 * Converts a single recorded video (Blob) into FLIPBOOK_TOTAL_FRAMES (19)
 * evenly-distributed still frames, using an off-DOM <video> + <canvas>
 * seek-and-draw loop. Runs entirely client-side — no server/ffmpeg needed.
 *
 * Only called AFTER the guest has picked their one video on Page
 * "flipbook-select" (per spec: "Generate the 19 frames only after video
 * selection" — never on all 3 recorded clips).
 */

const flipbookFrameExtractor = {
  /*
   * extractFrames(videoBlob, frameCount = FLIPBOOK_TOTAL_FRAMES)
   * → Promise<Blob[]>  (JPEG blobs, one per frame, in playback order)
   *
   * Frames are sampled at evenly spaced timestamps across the clip's
   * actual duration (not a hardcoded 4s) so extraction still works
   * correctly if a clip runs slightly long/short.
   */
  async extractFrames(videoBlob, frameCount = FLIPBOOK_TOTAL_FRAMES) {
    if (!videoBlob) throw new Error("flipbookFrameExtractor: no video blob provided");

    const url = URL.createObjectURL(videoBlob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    try {
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Failed to load video for frame extraction"));
      });

      const duration = video.duration && isFinite(video.duration) ? video.duration : 4;

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");

      const frames = [];
      for (let i = 0; i < frameCount; i++) {
        // Evenly distribute across the clip, staying just inside the
        // boundaries so the very first/last requested time isn't clipped
        // by rounding (e.g. never seek to exactly `duration`).
        const t = ((i + 0.5) / frameCount) * duration;
        await this._seekTo(video, t);

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Bake in the same filter used during Photo Taking (photobooth.cube
        // LUT, GPU path with automatic CPU fallback — see app.js's
        // cameraFilterManager.applyLutToCanvasGL). No-ops safely if no
        // filter is currently active.
        if (typeof cameraFilterManager !== "undefined") {
          cameraFilterManager.applyLutToCanvasGL(canvas);
        }

        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.92)
        );
        frames.push(blob);
      }

      return frames;
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  _seekTo(video, time) {
    return new Promise((resolve, reject) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        reject(new Error("Video seek failed during frame extraction"));
      };
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onError);
      video.currentTime = Math.min(time, Math.max(0, video.duration - 0.01));
    });
  }
};
