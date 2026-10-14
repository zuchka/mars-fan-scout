import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  readdir,
  unlink,
} from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { clipRegion } from "../public/geometry.js";
import type { Region } from "../public/types.js";
import type { RegionImage, SourceMeta } from "./types.js";
const exec = promisify(execFile);
export const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export class SourceStore {
  root: string;
  directory: string;
  orbitPath: string | undefined;
  python: string;
  pending: Map<string, Promise<unknown>>;
  uploadQueue: Promise<unknown>;
  maxSourceBytes: number;

  constructor(root: string, directory: string, options: { orbitPath?: string; python?: string; maxSourceBytes?: number } = {}) {
    this.root = root;
    this.directory = directory;
    this.orbitPath = options.orbitPath;
    this.python = options.python || "python3";
    this.pending = new Map();
    this.uploadQueue = Promise.resolve();
    this.maxSourceBytes = options.maxSourceBytes ?? 2 * 1024 ** 3;
    if (!Number.isSafeInteger(this.maxSourceBytes) || this.maxSourceBytes < 1)
      throw new Error(
        "Source storage quota must be a positive integer number of bytes",
      );
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    if (this.orbitPath) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(this.orbitPath))
        hash.update(chunk);
      const meta = await this.meta("orbit");
      if (hash.digest("hex") !== meta.original_sha256)
        throw new Error(
          "SCOUT_ORBIT_PATH must match the prepared observation manifest",
        );
    }
    await this.pruneCache();
  }
  async usage(directory = this.directory): Promise<number> {
    let size = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "orbit-cache") size += await this.usage(path);
      } else if (entry.isFile()) size += (await stat(path)).size;
    }
    return size;
  }
  async pruneCache() {
    const dir = join(this.directory, "orbit-cache");
    await mkdir(dir, { recursive: true });
    const files = await Promise.all(
      (await readdir(dir))
        .filter((name) => /^[a-f0-9]{64}\.png$/.test(name))
        .map(async (name) => ({ name, ...(await stat(join(dir, name))) })),
    );
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    for (const [i, file] of files.entries()) {
      bytes += file.size;
      if (i >= 48 || bytes > 256 * 1024 ** 2)
        await unlink(join(dir, file.name)).catch(() => {});
    }
  }
  async meta(id: string): Promise<SourceMeta> {
    if (["sample", "orbit"].includes(id)) {
      if (id === "orbit" && !this.orbitPath)
        throw new Error("Full observation is not configured on this server");
      return JSON.parse(
        await readFile(join(this.root, "public/sources", `${id}.json`), "utf8"),
      ) as SourceMeta;
    }
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Unknown source");
    return JSON.parse(
      await readFile(join(this.directory, id, "manifest.json"), "utf8"),
    ) as SourceMeta;
  }
  add(bytes: Buffer, name: string): Promise<SourceMeta> {
    const next = this.uploadQueue
      .catch(() => {})
      .then(() => this.addOriginal(bytes, name));
    this.uploadQueue = next;
    return next;
  }
  async addOriginal(bytes: Buffer, name: string): Promise<SourceMeta> {
    if (bytes.length > 32 * 1024 * 1024)
      throw new Error("Choose an image under 32 MiB");
    const info = await sharp(bytes, {
      limitInputPixels: 16_777_216,
    }).metadata();
    if (
      !info.format || !["png", "jpeg", "webp"].includes(info.format) ||
      (info.pages ?? 1) > 1 ||
      !info.width || !info.height || info.width < 256 ||
      info.height < 256 ||
      info.width * info.height > 16_777_216
    )
      throw new Error(
        "Choose a single JPG, PNG, or WebP image, 256 pixels or more per side, up to 16 megapixels",
      );
    const id = sha(bytes),
      dir = join(this.directory, id);
    if (existsSync(join(dir, "manifest.json"))) return this.meta(id);
    if (
      (await this.usage()) +
        bytes.length +
        info.width * info.height * 4 +
        2 * 1024 ** 2 >
      this.maxSourceBytes
    )
      throw new Error(
        "Source storage is full. Existing originals are retained; ask the operator to expand storage",
      );
    await mkdir(dir, { recursive: true });
    // Original bytes are immutable; orientation is applied only to derived assets.
    await writeFile(join(dir, "original"), bytes, { flag: "w", mode: 0o600 });
    const display = await sharp(bytes, { limitInputPixels: 16_777_216 })
      .rotate()
      .removeAlpha()
      .toColourspace("srgb")
      .png()
      .toBuffer({ resolveWithObject: true });
    await writeFile(join(dir, "display.png"), display.data, { mode: 0o600 });
    await sharp(display.data)
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 92 })
      .toFile(join(dir, "preview.jpg"));
    const meta: SourceMeta & Record<string, unknown> = {
      id,
      name: String(name || "Uploaded Mars crop").slice(0, 160),
      width: display.info.width,
      height: display.info.height,
      original_width: info.width,
      original_height: info.height,
      orientation: info.orientation || 1,
      bit_depth: info.depth === "ushort" ? 16 : 8,
      pixel_scale_m: null,
      observation: null,
      original_sha256: id,
      original_format: info.format,
      display_sha256: sha(display.data),
      normalization: {
        method:
          "decoder colour conversion to sRGB; EXIF orientation applied; 8-bit display",
        output_bits: 8,
      },
      coordinate_convention:
        "pixel edges; x right, y down; auto-oriented display source coordinates",
      source_note: "User-provided source, original bytes retained",
      preview: `/api/scout/sources/${id}/preview`,
      original: `/api/scout/sources/${id}/original`,
    };
    await writeFile(join(dir, "manifest.tmp"), JSON.stringify(meta, null, 2), {
      mode: 0o600,
    });
    await rename(join(dir, "manifest.tmp"), join(dir, "manifest.json"));
    return meta;
  }
  async original(id: string): Promise<string> {
    await this.meta(id);
    return id === "sample"
      ? join(this.root, "assets/scout-native-16.png")
      : id === "orbit"
        ? this.orbitPath!
        : join(this.directory, id, "original");
  }
  async preview(id: string): Promise<Buffer> {
    const meta = await this.meta(id);
    return readFile(
      ["sample", "orbit"].includes(id)
        ? join(this.root, "public", meta.preview)
        : join(this.directory, id, "preview.jpg"),
    );
  }
  async region(id: string, requested: Region, max = 1024, { analysisScale = 1 }: { analysisScale?: number } = {}): Promise<RegionImage> {
    const meta = await this.meta(id),
      region = clipRegion(requested, meta);
    if (!Number.isInteger(max) || max < 64 || max > 2048)
      throw new Error("Region output must be between 64 and 2048 pixels");
    if (![1, 2, 4].includes(analysisScale))
      throw new Error("Invalid analysis scale");
    const scale = Math.min(
      1 / analysisScale,
      max / Math.max(region.width, region.height),
    );
    const output = {
      width: Math.max(1, Math.round(region.width * scale)),
      height: Math.max(1, Math.round(region.height * scale)),
    };
    let input: Buffer;
    if (id === "orbit") {
      const key = sha(
          Buffer.from(
            JSON.stringify({
              source: meta.original_sha256,
              decoder: "aligned-v3",
              region,
              output,
              normalization: meta.normalization,
            }),
          ),
        ),
        path = join(this.directory, "orbit-cache", `${key}.png`);
      await mkdir(join(this.directory, "orbit-cache"), { recursive: true });
      if (!existsSync(path)) {
        if (!this.pending.has(key)) {
          if (this.pending.size >= 2)
            throw new Error("Image decoder is busy; try again shortly");
          this.pending.set(
            key,
            exec(
              this.python,
              [
                join(this.root, "scripts/read_native_region.py"),
                this.orbitPath!,
                path,
                JSON.stringify(region),
                String(Math.max(output.width, output.height)),
                JSON.stringify(meta.normalization),
                JSON.stringify(output),
              ],
              { timeout: 45000, maxBuffer: 1024 * 1024 },
            ).finally(() => this.pending.delete(key)),
          );
        }
        await this.pending.get(key);
      }
      input = await readFile(path);
      void this.pruneCache().catch(() => {});
    } else {
      const path =
        id === "sample"
          ? join(this.root, "public/sources/sample-native.png")
          : join(this.directory, id, "display.png");
      input = await sharp(path)
        .extract({
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height,
        })
        .resize(output.width, output.height)
        .png()
        .toBuffer();
    }
    return {
      bytes: input,
      region,
      output,
      encoding: "png",
      sha256: sha(input),
      normalization: meta.normalization,
    };
  }
}
