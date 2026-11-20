import { DEFAULT_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_SIZE } from "../shared/media-types.js";

export interface CapturedThumbnail { blob: Blob; width: number; height: number }
export interface ImageSource {
  readonly width: number;
  readonly height: number;
  capture(maxDimension: number): Promise<CapturedThumbnail>;
  destroy(): void;
}

export async function captureThumbnail(
  source: CanvasImageSource, width: number, height: number,
  maxDimension = DEFAULT_THUMBNAIL_DIMENSION, signal?: AbortSignal,
): Promise<CapturedThumbnail> {
  if (typeof document === "undefined") throw new Error("Image thumbnails require a browser.");
  if (!Number.isInteger(maxDimension) || maxDimension < 1 || maxDimension > 2048 ||
      !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Choose a thumbnail size between 1 and 2048 pixels.");
  }
  if (signal?.aborted) throw new Error("Thumbnail preparation cancelled.");
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot create a thumbnail.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (signal?.aborted) reject(new Error("Thumbnail preparation cancelled."));
      else if (!blob?.size) reject(new Error("The thumbnail could not be saved as an image."));
      else if (blob.size > MAX_THUMBNAIL_SIZE) reject(new Error("The thumbnail exceeds 1 MiB. Choose a smaller thumbnail size."));
      else resolve(blob);
    }, "image/jpeg", 0.82);
  });
  return { blob, width: canvas.width, height: canvas.height };
}

export async function openImage(file: Blob, signal?: AbortSignal): Promise<ImageSource> {
  if (typeof document === "undefined") throw new Error("Image thumbnails require a browser that can decode the image.");
  const image = document.createElement("img");
  const url = URL.createObjectURL(file);
  const abort = new AbortController();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    abort.abort();
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  };
  signal?.addEventListener("abort", dispose, { once: true });
  if (signal?.aborted) dispose();
  try {
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        image.onload = image.onerror = null;
        abort.signal.removeEventListener("abort", cancelled);
      };
      const cancelled = () => { clean(); reject(new Error("Thumbnail preparation cancelled.")); };
      const timer = setTimeout(() => { clean(); reject(new Error("Image decoding timed out. Disable its thumbnail or use a supported image format.")); }, 15000);
      image.onload = () => { clean(); resolve(); };
      image.onerror = () => { clean(); reject(new Error("This browser cannot decode this image for a thumbnail. Disable its thumbnail or use a supported image format.")); };
      abort.signal.addEventListener("abort", cancelled, { once: true });
      if (abort.signal.aborted) { cancelled(); return; }
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("This image has no decodable pixels.");
    return { width: image.naturalWidth, height: image.naturalHeight, destroy: dispose,
      capture: maxDimension => captureThumbnail(image, image.naturalWidth, image.naturalHeight, maxDimension, abort.signal) };
  } catch (error) { dispose(); throw error; }
}
