/**
 * ClimateSpiral -- daily ERA5 global temperature anomalies drawn as a spiral,
 * one loop per year, radius growing with the anomaly.
 *
 * The `openness` parameter interpolates continuously between two views:
 *   0 -- every year stacked in the same plane, seen from directly above
 *   1 -- years pulled apart along a time axis, forming a tilted funnel
 *
 * Rendered with Canvas 2D and a hand-rolled perspective projection; no
 * dependencies.
 *
 * @module climate-spiral
 */

/** Anomaly range mapped to the radius, in degC.
 *
 *  The cold end barely moves release over release -- the coldest day on
 *  record sits at -0.40 -- so A_MIN stays a fixed constant.
 *
 *  The hot end does not: it is the one still climbing as data is appended
 *  year over year. A_MAX is therefore computed per instance in #precompute(),
 *  as the largest of this floor and (actual data max + headroom). It only
 *  ever grows, and only when the data genuinely exceeds today's range, so
 *  the current look (max +2.04) is reproduced exactly -- extending it is a
 *  fallback for future data, not the normal case.
 */
const A_MIN = -0.6;
const A_MAX_FLOOR = 2.2;
const A_MAX_HEADROOM = 0.15;

/** Radius of the inner hole, as a fraction of the outer radius. Keeps the
 *  coldest days from collapsing onto a single point. */
const R_INNER = 0.2;

/** Camera. Distances are multiples of the base radius.
 *  The tilt is negative so the stack opens upwards: 1940 stays the narrow far
 *  end but projects to the bottom, and the current year flares out at the top.
 *  Flipping the sign here keeps the depth order intact -- 1940 remains the
 *  furthest plane -- unlike flipping the sign of z, which would put the wide
 *  mouth at the back. */
const TILT_MAX = (-58 * Math.PI) / 180;
const SPREAD_TOTAL = 2.3; // depth of the whole 1940->today stack
const FOCAL = 4.6;
const VIEW_SCALE_OPEN = 0.58; // shrink when open, so the funnel still fits

/** Number of quantised colours. Segments are batched per bucket, so fewer
 *  buckets means longer same-colour runs and fewer subpaths to rasterise. */
const BUCKETS = 32;

/** Capacity of the per-year scratch buffers: 366 days plus the bridge. */
const SCRATCH = 400;

/** Opacity ramp from the oldest year to the newest. Pale strokes wash out
 *  faster on a light background, so the floor is lifted there. */
const ALPHA = {
  dark: { old: 0.34, new: 0.95 },
  light: { old: 0.5, new: 1.0 },
};

const RING_VALUES = [0, 1.5, 2];
const DEFAULT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const OPENNESS_TRANSITION_MS = 900;

/**
 * Colour ramps, sampled into `BUCKETS` steps at init. Stops are
 * `[position 0..1, '#rrggbb']`, position being the normalised anomaly.
 */
const RAMPS = {
  dark: [
    [0.0, '#101d33'], [0.16, '#1f4368'], [0.34, '#43769c'], [0.48, '#7d97a6'],
    [0.58, '#c19a55'], [0.66, '#e8801c'], [0.78, '#ef4b12'], [0.9, '#f01a08'],
    [1.0, '#ff2a10'],
  ],
  light: [
    [0.0, '#93aac2'], [0.16, '#4c7fae'], [0.34, '#5d8ba8'], [0.48, '#8d9a96'],
    [0.58, '#b78a30'], [0.66, '#d96e0c'], [0.78, '#cf3a08'], [0.9, '#b81505'],
    [1.0, '#9c0f04'],
  ],
};

/** Chrome colours, overridable from CSS custom properties on the canvas. */
const CHROME = {
  dark: { ring: 'rgba(226,232,240,0.16)', ringAccent: 'rgba(255,196,140,0.5)', label: 'rgba(226,232,240,0.45)' },
  light: { ring: 'rgba(30,41,59,0.14)', ringAccent: 'rgba(190,90,20,0.55)', label: 'rgba(30,41,59,0.5)' },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Sample a stop list into `count` `rgb()` strings. */
function sampleRamp(stops, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    const a = hexToRgb(c0);
    const b = hexToRgb(c1);
    out[i] = `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},`
      + `${Math.round(a[1] + (b[1] - a[1]) * f)},`
      + `${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  }
  return out;
}

export class ClimateSpiral {
  #canvas; #ctx; #layer; #layerCtx;
  #meta; #years; #yearLabels;
  // Per-day arrays, indexed by global day number.
  #ux; #uy; #anom; #yearIdx; #bucket; #yearStart;
  #count; #yearCount;
  // Per-year arrays.
  #yearAlpha; #yearZ;
  // Widest anomaly of the first and last year, used to frame the open funnel.
  #farAnom = 0; #nearAnom = 0;
  // Hot end of the radius/colour scale, extended past A_MAX_FLOOR only if
  // the data demands it. See the comment on A_MAX_FLOOR.
  #aMax = A_MAX_FLOOR;
  // Scratch space for one year's projected points (366 days + bridge).
  #sx = new Float32Array(SCRATCH); #sy = new Float32Array(SCRATCH); #sb = new Uint8Array(SCRATCH);
  // Segment slots grouped by colour bucket, filled in a single pass.
  #bucketSlots = new Int16Array(BUCKETS * SCRATCH);
  #bucketCount = new Uint16Array(BUCKETS);
  #colors; #chrome; #theme; #months;
  // View state.
  #cursor = 0; #playing = false; #loop = false; #speed = 180;
  #openness = 0; #opennessFrom = 0; #opennessTo = 0; #transitionStart = 0;
  #cameraDirty = true; #layerYears = 0; #frameId = null; #lastTime = 0;
  #width = 0; #height = 0; #dpr = 1;
  #listeners = new Map();
  #observer = null;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{meta: object, years: Record<string, number[]>}} data
   *        Anomalies in milli-degrees, as produced by scripts/build_data.py.
   * @param {object} [options]
   */
  constructor(canvas, data, options = {}) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    this.#meta = data.meta;
    this.#years = data.years;
    this.#theme = options.theme || 'dark';
    this.#months = options.monthLabels || DEFAULT_MONTHS;
    this.#speed = options.speed ?? 180;
    this.#loop = options.loop ?? false;
    this.#openness = this.#opennessTo = this.#opennessFrom = options.openness ?? 0;

    this.#precompute();
    this.#applyTheme();

    this.#layer = document.createElement('canvas');
    this.#layerCtx = this.#layer.getContext('2d');

    this.#observer = new ResizeObserver(() => this.#resize());
    this.#observer.observe(canvas);
    this.#resize();

    this.#cursor = options.index ?? 0;
    this.requestRender();
  }

  // ---------------------------------------------------------------- setup

  #precompute() {
    this.#yearLabels = Object.keys(this.#years).sort();
    this.#yearCount = this.#yearLabels.length;
    this.#count = this.#yearLabels.reduce((n, y) => n + this.#years[y].length, 0);

    const n = this.#count;
    this.#ux = new Float32Array(n);
    this.#uy = new Float32Array(n);
    this.#anom = new Float32Array(n);
    this.#yearIdx = new Uint16Array(n);
    this.#bucket = new Uint8Array(n);
    this.#yearStart = new Int32Array(this.#yearCount + 1);
    this.#yearAlpha = new Float32Array(this.#yearCount);
    this.#yearZ = new Float32Array(this.#yearCount);

    // The colour bucket needs the final A_MAX, which in turn needs the
    // data's actual peak -- so anomalies are collected in this pass, and
    // buckets are assigned in a second one below, once that peak is known.
    let i = 0;
    let dataMax = -Infinity;

    for (let k = 0; k < this.#yearCount; k++) {
      const label = this.#yearLabels[k];
      const values = this.#years[label];
      this.#yearStart[k] = i;

      // Full-year length, so a partial final year keeps the same angular
      // pacing as the others instead of stretching over the whole circle.
      const daysInYear = isLeap(Number(label)) ? 366 : 365;

      for (let d = 0; d < values.length; d++, i++) {
        // Start at the top, run clockwise on screen (canvas y points down).
        const theta = (2 * Math.PI * d) / daysInYear - Math.PI / 2;
        this.#ux[i] = Math.cos(theta);
        this.#uy[i] = Math.sin(theta);
        const a = values[d] / 1000;
        this.#anom[i] = a;
        this.#yearIdx[i] = k;
        if (a > dataMax) dataMax = a;
      }

      // 1940 sits at the far end of the funnel, today at the near end, so
      // chronological drawing order is also back-to-front painter order.
      this.#yearZ[k] = (this.#yearCount - 1) / 2 - k;
    }
    this.#yearStart[this.#yearCount] = i;

    this.#aMax = Math.max(A_MAX_FLOOR, dataMax + A_MAX_HEADROOM);
    const span = this.#aMax - A_MIN;
    for (let j = 0; j < n; j++) {
      this.#bucket[j] = clamp(Math.floor(((this.#anom[j] - A_MIN) / span) * BUCKETS), 0, BUCKETS - 1);
    }

    const maxOf = (k) => {
      let m = -Infinity;
      for (let j = this.#yearStart[k]; j < this.#yearStart[k + 1]; j++) {
        if (this.#anom[j] > m) m = this.#anom[j];
      }
      return m;
    };
    this.#farAnom = maxOf(0);
    this.#nearAnom = maxOf(this.#yearCount - 1);
  }

  #applyTheme() {
    this.#colors = sampleRamp(RAMPS[this.#theme] || RAMPS.dark, BUCKETS);

    const alpha = ALPHA[this.#theme] || ALPHA.dark;
    for (let k = 0; k < this.#yearCount; k++) {
      const t = this.#yearCount === 1 ? 1 : k / (this.#yearCount - 1);
      this.#yearAlpha[k] = alpha.old + (alpha.new - alpha.old) * t;
    }

    const fallback = CHROME[this.#theme] || CHROME.dark;
    const style = getComputedStyle(this.#canvas);
    const read = (name, dflt) => {
      const v = style.getPropertyValue(name).trim();
      return v || dflt;
    };
    this.#chrome = {
      ring: read('--cs-ring', fallback.ring),
      ringAccent: read('--cs-ring-accent', fallback.ringAccent),
      label: read('--cs-label', fallback.label),
    };
  }

  #resize() {
    const rect = this.#canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (w === this.#canvas.width && h === this.#canvas.height) return;

    this.#canvas.width = this.#layer.width = w;
    this.#canvas.height = this.#layer.height = h;
    this.#width = w;
    this.#height = h;
    this.#dpr = dpr;
    this.#cameraDirty = true;
    this.requestRender();
  }

  // ------------------------------------------------------------ public API

  get length() { return this.#count; }
  get index() { return Math.min(Math.floor(this.#cursor), this.#count - 1); }
  get playing() { return this.#playing; }
  get openness() { return this.#opennessTo; }
  get meta() { return this.#meta; }

  play() {
    if (this.#playing) return;
    // Restart from the beginning rather than sitting on the last frame.
    if (this.index >= this.#count - 1) this.#cursor = 0;
    this.#playing = true;
    this.#lastTime = 0;
    this.#emit();
    this.#ensureFrame();
  }

  pause() {
    if (!this.#playing) return;
    this.#playing = false;
    this.#emit();
  }

  toggle() { this.#playing ? this.pause() : this.play(); }

  /** @param {number} i global day index */
  seekToIndex(i) {
    this.#cursor = clamp(i, 0, this.#count - 1);
    this.#emit();
    this.requestRender();
  }

  /** @param {number} year jump to 1 January of that year */
  seekToYear(year) {
    const k = this.#yearLabels.indexOf(String(year));
    if (k >= 0) this.seekToIndex(this.#yearStart[k]);
  }

  /**
   * Move by whole years. Stepping forward from anywhere inside a year lands on
   * 1 January of the next one, so the year just left is fully drawn.
   * @param {number} delta
   */
  stepYear(delta) {
    const current = this.#yearIdx[this.index];
    const k = clamp(current + delta, 0, this.#yearCount - 1);
    this.pause();
    // Already in the outermost year: run to that end rather than jumping back
    // to its 1 January, which would move the cursor the wrong way.
    if (k === current) {
      this.seekToIndex(delta > 0 ? this.#count - 1 : 0);
      return;
    }
    this.seekToIndex(this.#yearStart[k]);
  }

  /**
   * @param {number} value 0 = flat overhead, 1 = open funnel
   * @param {boolean} [animate=true]
   */
  setOpenness(value, animate = true) {
    const target = clamp(value, 0, 1);
    if (target === this.#opennessTo && this.#openness === target) return;
    this.#opennessTo = target;
    if (animate) {
      this.#opennessFrom = this.#openness;
      this.#transitionStart = performance.now();
      this.#ensureFrame();
    } else {
      this.#openness = this.#opennessFrom = target;
      this.#cameraDirty = true;
      this.requestRender();
    }
    this.#emit();
  }

  /** @param {number} daysPerSecond */
  setSpeed(daysPerSecond) { this.#speed = Math.max(1, daysPerSecond); this.#emit(); }

  /** @param {boolean} value */
  setLoop(value) { this.#loop = !!value; this.#emit(); }

  /** @param {'dark'|'light'} theme */
  setTheme(theme) {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#applyTheme();
    this.#cameraDirty = true;
    this.requestRender();
    this.#emit();
  }

  /** Current state, as passed to `change` listeners. */
  get state() {
    const i = this.index;
    const k = this.#yearIdx[i];
    const day = i - this.#yearStart[k];
    const date = new Date(Date.UTC(Number(this.#yearLabels[k]), 0, day + 1));
    return {
      index: i,
      year: Number(this.#yearLabels[k]),
      month: date.getUTCMonth(),
      date,
      anomalyC: this.#anom[i],
      playing: this.#playing,
      openness: this.#opennessTo,
      loop: this.#loop,
      speed: this.#speed,
      theme: this.#theme,
    };
  }

  on(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) { this.#listeners.get(type)?.delete(fn); }

  destroy() {
    if (this.#frameId !== null) cancelAnimationFrame(this.#frameId);
    this.#frameId = null;
    this.#observer?.disconnect();
    this.#listeners.clear();
  }

  #emit() {
    const listeners = this.#listeners.get('change');
    if (!listeners || !listeners.size) return;
    const state = this.state;
    for (const fn of listeners) fn(state);
  }

  // ----------------------------------------------------------- frame loop

  requestRender() { this.#ensureFrame(); }

  #ensureFrame() {
    if (this.#frameId !== null) return;
    this.#frameId = requestAnimationFrame((t) => this.#frame(t));
  }

  #frame(now) {
    this.#frameId = null;
    let animating = false;

    if (this.#openness !== this.#opennessTo) {
      const t = clamp((now - this.#transitionStart) / OPENNESS_TRANSITION_MS, 0, 1);
      const eased = easeInOutCubic(t);
      this.#openness = this.#opennessFrom + (this.#opennessTo - this.#opennessFrom) * eased;
      this.#cameraDirty = true;
      if (t < 1) animating = true;
      else this.#openness = this.#opennessTo;
    }

    if (this.#playing) {
      const dt = this.#lastTime ? Math.min(now - this.#lastTime, 100) : 0;
      this.#lastTime = now;
      this.#cursor += (this.#speed * dt) / 1000;
      if (this.#cursor >= this.#count - 1) {
        if (this.#loop) {
          this.#cursor = 0;
        } else {
          this.#cursor = this.#count - 1;
          this.#playing = false;
        }
      }
      this.#emit();
      animating = this.#playing || animating;
    }

    this.#render();
    if (animating) this.#ensureFrame();
  }

  // -------------------------------------------------------------- drawing

  /** Camera constants for the current frame, in device pixels. */
  #camera() {
    const base = Math.min(this.#width, this.#height) * 0.42;
    const o = this.#openness;
    const cam = {
      base,
      cx: this.#width / 2,
      cy: this.#height / 2,
      cosT: Math.cos(o * TILT_MAX),
      sinT: Math.sin(o * TILT_MAX),
      spread: (o * SPREAD_TOTAL * base) / Math.max(1, this.#yearCount - 1),
      focal: FOCAL * base,
      scale: 1 + (VIEW_SCALE_OPEN - 1) * o,
      rInner: base * R_INNER,
      rSpan: base * (1 - R_INNER),
      labelFade: 1 - o,
      yShift: 0,
    };

    // The near plane is magnified by the perspective divide and the far plane
    // shrunk, so the tilted funnel drifts off centre. Re-centre it on the
    // midpoint of its vertical extent. The far plane (1940) sits lowest, so
    // its extreme is its own bottom edge; the near plane's is its top edge.
    const zEdge = ((this.#yearCount - 1) / 2) * cam.spread;
    const lowest = this.#planeY(this.#radiusPx(this.#farAnom, cam), zEdge, cam);
    const highest = this.#planeY(-this.#radiusPx(this.#nearAnom, cam), -zEdge, cam);
    cam.yShift = -((lowest + highest) / 2) * cam.scale;
    return cam;
  }

  /** Vertical position of a point in view space, before scale and shift. */
  #planeY(y, z, cam) {
    return (y * cam.cosT - z * cam.sinT) * this.#perspective(y, z, cam);
  }

  #radiusPx(anomaly, cam) {
    return cam.rInner + ((anomaly - A_MIN) / (this.#aMax - A_MIN)) * cam.rSpan;
  }

  /** Perspective scale for a point already rotated into view space. */
  #perspective(y, z, cam) {
    return cam.focal / (cam.focal + y * cam.sinT + z * cam.cosT);
  }

  /**
   * Project one day onto the canvas, writing into the scratch arrays.
   * Returns the perspective factor, used for line widths.
   */
  #project(i, cam, slot) {
    const r = this.#radiusPx(this.#anom[i], cam);
    const x = this.#ux[i] * r;
    const y = this.#uy[i] * r;
    const z = this.#yearZ[this.#yearIdx[i]] * cam.spread;
    const s = this.#perspective(y, z, cam);
    this.#sx[slot] = cam.cx + x * s * cam.scale;
    this.#sy[slot] = cam.cy + (y * cam.cosT - z * cam.sinT) * s * cam.scale + cam.yShift;
    this.#sb[slot] = this.#bucket[i];
    return s;
  }

  /**
   * Stroke the polyline through days `from`..`to`, batching by colour bucket
   * so a year costs a handful of `stroke()` calls instead of one per segment.
   *
   * Two details matter for speed, both worth ~4x on a full redraw:
   * segments are bucketed in a single pass rather than rescanning the year
   * once per bucket, and consecutive same-bucket segments are emitted as one
   * subpath -- isolated subpaths would each need two line caps rasterised.
   */
  #strokeRange(ctx, from, to, cam, alpha, widthScale) {
    if (to <= from) return;
    const slots = this.#bucketSlots;
    const counts = this.#bucketCount;
    counts.fill(0);

    let sPeak = 0;
    for (let i = from, slot = 0; i <= to; i++, slot++) {
      const s = this.#project(i, cam, slot);
      if (s > sPeak) sPeak = s;
      if (slot > 0) {
        const b = this.#sb[slot];
        slots[b * SCRATCH + counts[b]++] = slot;
      }
    }

    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(0.6, this.#dpr * widthScale * sPeak);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    for (let b = 0; b < BUCKETS; b++) {
      const count = counts[b];
      if (!count) continue;
      const base = b * SCRATCH;
      ctx.beginPath();
      let previous = -2;
      for (let j = 0; j < count; j++) {
        const slot = slots[base + j];
        if (slot !== previous + 1) ctx.moveTo(this.#sx[slot - 1], this.#sy[slot - 1]);
        ctx.lineTo(this.#sx[slot], this.#sy[slot]);
        previous = slot;
      }
      ctx.strokeStyle = this.#colors[b];
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Draw whole year `k`. Starts one day early so the line stays continuous
   * across the new-year boundary; that bridging segment belongs to year `k`.
   */
  #strokeYear(ctx, k, cam) {
    const from = Math.max(0, this.#yearStart[k] - 1);
    this.#strokeRange(ctx, from, this.#yearStart[k + 1] - 1, cam, this.#yearAlpha[k], 0.9);
  }

  /**
   * Keep the offscreen layer holding every year before `wantYears` in sync.
   * Advancing by a year appends to it; moving backwards or a camera change
   * forces a rebuild.
   */
  #syncLayer(wantYears, cam) {
    if (this.#cameraDirty || wantYears < this.#layerYears) {
      this.#layerCtx.clearRect(0, 0, this.#width, this.#height);
      this.#layerYears = 0;
    }
    for (let k = this.#layerYears; k < wantYears; k++) this.#strokeYear(this.#layerCtx, k, cam);
    this.#layerYears = wantYears;
    this.#cameraDirty = false;
  }

  #render() {
    if (!this.#width || !this.#height) return;
    const cam = this.#camera();
    const ctx = this.#ctx;
    const i = this.index;
    const k = this.#yearIdx[i];

    this.#syncLayer(k, cam);

    ctx.clearRect(0, 0, this.#width, this.#height);
    ctx.drawImage(this.#layer, 0, 0);

    // Current year, drawn live up to the cursor.
    this.#strokeRange(ctx, Math.max(0, this.#yearStart[k] - 1), i, cam, 1, 1.15);
    this.#drawHead(ctx, i, cam);
    this.#drawRings(ctx, k, cam);
  }

  #drawHead(ctx, i, cam) {
    const r = this.#radiusPx(this.#anom[i], cam);
    const y = this.#uy[i] * r;
    const z = this.#yearZ[this.#yearIdx[i]] * cam.spread;
    const s = this.#perspective(y, z, cam);
    const x = cam.cx + this.#ux[i] * r * s * cam.scale;
    const yy = cam.cy + (y * cam.cosT - z * cam.sinT) * s * cam.scale + cam.yShift;
    const glow = Math.max(6, 9 * this.#dpr * s);

    const gradient = ctx.createRadialGradient(x, yy, 0, x, yy, glow);
    gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
    gradient.addColorStop(0.35, this.#colors[this.#bucket[i]]);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, yy, glow, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, yy, Math.max(1.5, 2.1 * this.#dpr * s), 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Reference rings and month labels, placed in the plane of the year being
   * drawn -- so when the funnel is open they sit at its leading face, where
   * the current loop is punching through +1.5 degC.
   */
  #drawRings(ctx, k, cam) {
    const z = this.#yearZ[k] * cam.spread;
    const steps = 96;
    // Text is only legible face-on, and would sit across the funnel's mouth
    // once tilted, so it fades out as the view opens. The rings stay.
    const fade = cam.labelFade;
    ctx.font = `${Math.round(10 * this.#dpr)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';

    for (const value of RING_VALUES) {
      const r = this.#radiusPx(value, cam);
      ctx.beginPath();
      for (let p = 0; p <= steps; p++) {
        const theta = (2 * Math.PI * p) / steps - Math.PI / 2;
        const y = Math.sin(theta) * r;
        const s = this.#perspective(y, z, cam);
        const px = cam.cx + Math.cos(theta) * r * s * cam.scale;
        const py = cam.cy + (y * cam.cosT - z * cam.sinT) * s * cam.scale + cam.yShift;
        p === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      const accent = value === 1.5;
      ctx.strokeStyle = accent ? this.#chrome.ringAccent : this.#chrome.ring;
      ctx.lineWidth = (accent ? 1.4 : 1) * this.#dpr;
      if (!accent) ctx.setLineDash([4 * this.#dpr, 6 * this.#dpr]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (fade <= 0.05) continue;
      const y0 = -r;
      const s0 = this.#perspective(y0, z, cam);
      ctx.globalAlpha = fade;
      ctx.fillStyle = accent ? this.#chrome.ringAccent : this.#chrome.label;
      ctx.textBaseline = 'bottom';
      ctx.fillText(
        `${value > 0 ? '+' : ''}${value.toFixed(1)}°C`,
        cam.cx,
        cam.cy + (y0 * cam.cosT - z * cam.sinT) * s0 * cam.scale + cam.yShift - 3 * this.#dpr,
      );
      ctx.globalAlpha = 1;
    }

    if (fade <= 0.05) return;

    // Month labels, just outside the widest ring.
    const rLabel = this.#radiusPx(this.#aMax, cam) * 1.06;
    ctx.globalAlpha = fade;
    ctx.fillStyle = this.#chrome.label;
    ctx.textBaseline = 'middle';
    for (let m = 0; m < 12; m++) {
      const theta = (2 * Math.PI * (m + 0.5)) / 12 - Math.PI / 2;
      const y = Math.sin(theta) * rLabel;
      const s = this.#perspective(y, z, cam);
      ctx.fillText(
        this.#months[m],
        cam.cx + Math.cos(theta) * rLabel * s * cam.scale,
        cam.cy + (y * cam.cosT - z * cam.sinT) * s * cam.scale + cam.yShift,
      );
    }
    ctx.globalAlpha = 1;
  }
}

export default ClimateSpiral;
