import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_PIXELS = 60_000_000;
const MIN_PHOTO_SIDE = 320;
const supportedFormats = new Set(["jpeg", "png", "webp"]);

export type PhotoVariant = "original" | "landscape" | "portrait";

export interface ProcessedPhoto {
  original: Buffer;
  landscape: Buffer;
  portrait: Buffer;
  width: number;
  height: number;
  mimeType: "image/webp";
}

export interface StoredPhoto {
  storageKey: string;
  originalUrl: string;
  landscapeUrl: string;
  portraitUrl: string;
}

export interface PhotoStorage {
  save(photo: ProcessedPhoto): Promise<StoredPhoto>;
  read(storageKey: string, variant: PhotoVariant): Promise<Buffer | null>;
  remove(storageKey: string): Promise<void>;
}

export class PhotoUploadError extends Error {
  readonly statusCode = 400;

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function orientedDimensions(width: number, height: number, orientation: number | undefined): [number, number] {
  return orientation && orientation >= 5 ? [height, width] : [width, height];
}

export async function processPhoto(buffer: Buffer): Promise<ProcessedPhoto> {
  if (!buffer.length) throw new PhotoUploadError("PHOTO_EMPTY", "Выберите непустой файл фотографии.");
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new PhotoUploadError("PHOTO_TOO_LARGE", "Фотография должна весить не больше 12 МБ.");
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
  } catch {
    throw new PhotoUploadError("PHOTO_INVALID", "Файл не удалось распознать как фотографию.");
  }
  if (!metadata.format || !supportedFormats.has(metadata.format) || !metadata.width || !metadata.height) {
    throw new PhotoUploadError("PHOTO_FORMAT_UNSUPPORTED", "Поддерживаются фотографии JPEG, PNG и WebP.");
  }
  const [width, height] = orientedDimensions(metadata.width, metadata.height, metadata.orientation);
  if (Math.min(width, height) < MIN_PHOTO_SIDE) {
    throw new PhotoUploadError("PHOTO_TOO_SMALL", "Минимальный размер фотографии: 320 пикселей по короткой стороне.");
  }

  const source = () => sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).rotate();
  const [original, landscape, portrait] = await Promise.all([
    source().resize(2400, 2400, { fit: "inside", withoutEnlargement: true }).webp({ quality: 88, effort: 4 }).toBuffer(),
    source().resize(1600, 1000, { fit: "cover", position: sharp.strategy.attention }).webp({ quality: 86, effort: 4 }).toBuffer(),
    source().resize(1080, 1350, { fit: "cover", position: sharp.strategy.attention }).webp({ quality: 86, effort: 4 }).toBuffer(),
  ]);
  return { original, landscape, portrait, width, height, mimeType: "image/webp" };
}

function validStorageKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function variantUrl(storageKey: string, variant: PhotoVariant): string {
  return `/media/${storageKey}/${variant}.webp`;
}

export class LocalPhotoStorage implements PhotoStorage {
  constructor(private readonly root: string) {}

  async save(photo: ProcessedPhoto): Promise<StoredPhoto> {
    const storageKey = randomUUID();
    const directory = resolve(this.root, storageKey);
    await mkdir(directory, { recursive: true });
    try {
      await Promise.all(([
        ["original", photo.original],
        ["landscape", photo.landscape],
        ["portrait", photo.portrait],
      ] as const).map(([variant, data]) => writeFile(resolve(directory, `${variant}.webp`), data, { flag: "wx" })));
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      storageKey,
      originalUrl: variantUrl(storageKey, "original"),
      landscapeUrl: variantUrl(storageKey, "landscape"),
      portraitUrl: variantUrl(storageKey, "portrait"),
    };
  }

  async read(storageKey: string, variant: PhotoVariant): Promise<Buffer | null> {
    if (!validStorageKey(storageKey)) return null;
    try {
      return await readFile(resolve(this.root, storageKey, `${variant}.webp`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(storageKey: string): Promise<void> {
    if (!validStorageKey(storageKey)) return;
    await rm(resolve(this.root, storageKey), { recursive: true, force: true });
  }
}

export class MemoryPhotoStorage implements PhotoStorage {
  private readonly files = new Map<string, Record<PhotoVariant, Buffer>>();

  async save(photo: ProcessedPhoto): Promise<StoredPhoto> {
    const storageKey = randomUUID();
    this.files.set(storageKey, {
      original: Buffer.from(photo.original),
      landscape: Buffer.from(photo.landscape),
      portrait: Buffer.from(photo.portrait),
    });
    return {
      storageKey,
      originalUrl: variantUrl(storageKey, "original"),
      landscapeUrl: variantUrl(storageKey, "landscape"),
      portraitUrl: variantUrl(storageKey, "portrait"),
    };
  }

  async read(storageKey: string, variant: PhotoVariant): Promise<Buffer | null> {
    const buffer = this.files.get(storageKey)?.[variant];
    return buffer ? Buffer.from(buffer) : null;
  }

  async remove(storageKey: string): Promise<void> {
    this.files.delete(storageKey);
  }
}
