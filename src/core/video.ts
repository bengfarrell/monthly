export interface VideoSource {
  readonly url: string;
  readonly duration: number;
  capture(time: number): Promise<CapturedThumbnail>;
  destroy(): void;
}

const VIDEO_TIMEOUT = 15000;
const POSTER_MAX_DIMENSION = 1280;

export async function openVideo(file: Blob, signal?: AbortSignal): Promise<VideoSource> {
  if (typeof document === "undefined") throw new Error("Video uploads require a browser that can decode the video.");
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  const abort = new AbortController();
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    abort.abort();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  };
  signal?.addEventListener("abort", dispose, { once: true });
  if (signal?.aborted) dispose();
  const waitFor = (event: string, start: () => void) => new Promise<void>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      video.removeEventListener(event, success);
      video.removeEventListener("error", failure);
      abort.signal.removeEventListener("abort", cancelled);
    };
    const success = () => { clean(); resolve(); };
    const failure = () => { clean(); reject(new Error("This browser cannot decode this video. Use a supported video format before uploading.")); };
    const cancelled = () => { clean(); reject(new Error("Video preparation cancelled.")); };
    const timer = setTimeout(() => {
      clean();
      reject(new Error("Video decoding timed out. This video cannot be uploaded from this browser."));
    }, VIDEO_TIMEOUT);
    video.addEventListener(event, success, { once: true });
    video.addEventListener("error", failure, { once: true });
    abort.signal.addEventListener("abort", cancelled, { once: true });
    if (abort.signal.aborted) { cancelled(); return; }
    try { start(); }
    catch (error) { clean(); reject(error); }
  });
  try {
    await waitFor("loadeddata", () => { video.src = url; video.load(); });
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
      throw new Error("This video has no decodable video frames or valid duration.");
    }
    return {
      url, duration: video.duration, destroy: dispose,
      async capture(time) {
        if (!Number.isFinite(time) || time < 0 || time >= video.duration) throw new Error("Choose a frame within the video.");
        if (abort.signal.aborted) throw new Error("Video preparation cancelled.");
        if (video.currentTime !== time || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          await waitFor("seeked", () => { video.currentTime = time; });
        }
        if (video.error || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) throw new Error("This browser cannot decode the selected video frame.");
        return captureThumbnail(video, video.videoWidth, video.videoHeight, POSTER_MAX_DIMENSION, abort.signal);
      },
    };
  } catch (error) { dispose(); throw error; }
}
import { captureThumbnail, type CapturedThumbnail } from "./thumbnail.js";
