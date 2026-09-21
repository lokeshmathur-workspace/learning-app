// Client-side photo prep before upload — downscale + EXIF-orientation
// correction (plan Phase G / review finding I4: a naive canvas draw can
// silently ignore EXIF rotation and store a sideways page). createImageBitmap
// with imageOrientation:"from-image" bakes the correct rotation into the
// decoded bitmap, so nothing downstream needs to special-case orientation.
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;

// file: a File from <input type=file>. Returns a Blob (JPEG), always
// upright and no larger than MAX_EDGE on its longest side.
export async function prepPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't process that photo."))),
      "image/jpeg",
      JPEG_QUALITY
    );
  });
}

// Preps a whole batch and reports per-file failures without throwing away
// the ones that succeeded, so the caller can decide (per plan Phase G
// decision #11, all-or-nothing: any failure here means the caller shows one
// error and uploads nothing).
export async function prepPhotoBatch(files) {
  const results = [];
  for (const file of files) {
    try {
      results.push({ file, blob: await prepPhoto(file), ok: true });
    } catch (e) {
      results.push({ file, ok: false, error: e.message || "Couldn't process that photo." });
    }
  }
  return results;
}
