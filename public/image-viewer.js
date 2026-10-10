import { clipRegion } from "./geometry.js";
export class ImageViewer {
  constructor(frame, canvas, overlay, fetchRegion, onChange) {
    Object.assign(this, { frame, canvas, overlay, fetchRegion, onChange });
    this.ctx = canvas.getContext("2d");
    this.token = 0;
    this.zoom = 1;
    this.offset = { x: 0, y: 0 };
    new ResizeObserver(() => {
      if (this.source) {
        this.clamp();
        this.draw();
        this.queue();
      }
    }).observe(frame);
    frame.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = frame.getBoundingClientRect();
        this.scaleAt(
          e.deltaY < 0 ? 1.25 : 0.8,
          e.clientX - r.left,
          e.clientY - r.top,
        );
      },
      { passive: false },
    );
    frame.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      frame.setPointerCapture(e.pointerId);
      this.drag = {
        x: e.clientX,
        y: e.clientY,
        ox: this.offset.x,
        oy: this.offset.y,
      };
    });
    frame.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      this.offset = {
        x: this.drag.ox - (e.clientX - this.drag.x) / this.zoom,
        y: this.drag.oy - (e.clientY - this.drag.y) / this.zoom,
      };
      this.clamp();
      this.draw();
      this.queue();
    });
    const end = () => (this.drag = null);
    frame.addEventListener("pointerup", end);
    frame.addEventListener("pointercancel", end);
    frame.addEventListener("keydown", (e) => {
      if (!this.source) return;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        this.offset.x +=
          ({ ArrowLeft: -100, ArrowRight: 100 }[e.key] || 0) / this.zoom;
        this.offset.y +=
          ({ ArrowUp: -100, ArrowDown: 100 }[e.key] || 0) / this.zoom;
        this.clamp();
        this.draw();
        this.queue();
      }
    });
  }
  async setSource(source, preview) {
    this.token++;
    this.source = source;
    this.preview?.close();
    this.preview = preview;
    this.regionImage?.bitmap.close();
    this.regionImage = null;
    this.fit();
  }
  fit() {
    if (!this.source) return;
    this.zoom = Math.min(
      this.frame.clientWidth / this.source.width,
      this.frame.clientHeight / this.source.height,
    );
    this.offset = { x: 0, y: 0 };
    this.clamp();
    this.draw();
    this.queue();
  }
  native(point) {
    if (!this.source) return;
    const center = point || {
      x: this.offset.x + this.frame.clientWidth / this.zoom / 2,
      y: this.offset.y + this.frame.clientHeight / this.zoom / 2,
    };
    if (!point && this.zoom < 0.05 && this.source.native_focus)
      Object.assign(center, this.source.native_focus);
    this.zoom = 1;
    this.offset = {
      x: center.x - this.frame.clientWidth / 2,
      y: center.y - this.frame.clientHeight / 2,
    };
    this.clamp();
    this.draw();
    this.queue();
  }
  scaleAt(
    factor,
    x = this.frame.clientWidth / 2,
    y = this.frame.clientHeight / 2,
  ) {
    if (!this.source) return;
    const px = this.offset.x + x / this.zoom,
      py = this.offset.y + y / this.zoom;
    const min = Math.min(
      this.frame.clientWidth / this.source.width,
      this.frame.clientHeight / this.source.height,
    );
    this.zoom = Math.max(min, Math.min(8, this.zoom * factor));
    this.offset = { x: px - x / this.zoom, y: py - y / this.zoom };
    this.clamp();
    this.draw();
    this.queue();
  }
  clamp() {
    const vw = this.frame.clientWidth / this.zoom,
      vh = this.frame.clientHeight / this.zoom;
    this.offset.x =
      vw > this.source.width
        ? (this.source.width - vw) / 2
        : Math.max(0, Math.min(this.source.width - vw, this.offset.x));
    this.offset.y =
      vh > this.source.height
        ? (this.source.height - vh) / 2
        : Math.max(0, Math.min(this.source.height - vh, this.offset.y));
  }
  visible() {
    return clipRegion(
      {
        x: this.offset.x,
        y: this.offset.y,
        width: this.frame.clientWidth / this.zoom,
        height: this.frame.clientHeight / this.zoom,
      },
      this.source,
    );
  }
  draw() {
    if (!this.source || !this.preview) return;
    const w = this.frame.clientWidth,
      h = this.frame.clientHeight,
      dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#080b0c";
    c.fillRect(0, 0, w, h);
    c.scale(this.zoom, this.zoom);
    c.translate(-this.offset.x, -this.offset.y);
    c.drawImage(this.preview, 0, 0, this.source.width, this.source.height);
    if (this.regionImage) {
      const { bitmap, region } = this.regionImage;
      c.drawImage(bitmap, region.x, region.y, region.width, region.height);
    }
    this.overlay.setAttribute(
      "viewBox",
      `${this.offset.x} ${this.offset.y} ${w / this.zoom} ${h / this.zoom}`,
    );
    this.overlay.setAttribute("preserveAspectRatio", "none");
    this.onChange?.();
  }
  queue() {
    clearTimeout(this.timer);
    const token = ++this.token;
    this.timer = setTimeout(() => this.loadRegion(token), 180);
  }
  async loadRegion(token, attempt = 0) {
    if (token !== this.token) return;
    // One in-flight viewport decode per viewer; subsequent pans replace the target.
    if (this.loading) {
      this.timer = setTimeout(() => this.loadRegion(token, attempt), 250);
      return;
    }
    this.loading = true;
    const region = this.visible();
    try {
      const blob = await this.fetchRegion(
        region,
        Math.min(
          2048,
          Math.max(
            512,
            Math.ceil(
              Math.max(this.frame.clientWidth, this.frame.clientHeight) *
                (window.devicePixelRatio || 1),
            ),
          ),
        ),
      );
      const bitmap = await createImageBitmap(blob);
      if (token !== this.token) {
        bitmap.close();
        return;
      }
      this.regionImage?.bitmap.close();
      this.regionImage = { bitmap, region };
      this.draw();
    } catch (error) {
      if (token === this.token) {
        this.onChange?.(error.message);
        if (attempt < 2)
          this.timer = setTimeout(
            () => this.loadRegion(token, attempt + 1),
            750,
          );
      }
    } finally {
      this.loading = false;
    }
  }
}
