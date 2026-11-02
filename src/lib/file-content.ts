import { ApiError } from "./errors";
import { IMAGE_TYPES } from "./constants";

/** Do not trust an image's extension or a multipart MIME header. */
export function imageContentType(bytes: Uint8Array): string | null {
  const at = (offset: number, signature: number[]) => signature.every((value, i) => bytes[offset + i] === value);
  if (at(0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (at(0, [255, 216, 255])) return "image/jpeg";
  if (at(0, [71, 73, 70, 56]) && [55, 57].includes(bytes[4]) && bytes[5] === 97) return "image/gif";
  if (at(0, [82, 73, 70, 70]) && at(8, [87, 69, 66, 80])) return "image/webp";
  return null;
}

export function validateImage(bytes: Uint8Array, extension: string) {
  if (!IMAGE_TYPES.has(extension)) return;
  const detected = imageContentType(bytes);
  const expected = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`;
  if (detected !== expected) throw new ApiError(415, "图片内容与扩展名不匹配，请上传有效的 PNG、JPG、WebP 或 GIF 图片");
}

export type ByteRange = { start: number; end: number };

export function parseByteRange(header: string | null, length: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || length === 0) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, length - suffix);
    end = length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start) return "invalid";
    end = Math.min(end, length - 1);
  }
  return { start, end };
}
