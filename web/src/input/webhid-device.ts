/**
 * Phase 3.1: WebHID device manager.
 *
 * Flow: requestDevice() (needs a user gesture) → open() → derive a profile from
 * the report descriptor, falling back to the spec default → route inputreport
 * events through HidReportParser → push pen samples into the shared InputRing
 * and emit dial/keys events to subscribers.
 *
 * Also handles reconnection: WebHID fires navigator.hid "connect" for devices
 * the origin was already granted, so a tablet unplugged and replugged resumes
 * without a new permission prompt.
 *
 * Fallback: when WebHID is absent (Safari, Firefox) or the OS claims the tablet
 * as a system digitizer, PointerEventSource feeds the same ring from Pointer
 * Events, which already carry pressure, tiltX/Y, and twist. Rate is then bound
 * by the browser (typically display refresh, with getCoalescedEvents() to
 * recover intermediate samples).
 */

import { DEFAULT_PROFILE, HidReportParser, profileFromCollections, type InputEvent, type PenSample, type ReportProfile } from "./hid-parser.js";
import { InputRing } from "./ring-buffer.js";

export type InputListener = (ev: InputEvent) => void;

export interface DeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

/** Digitizer usage page (0x0D), Pen (0x02) and Digitizer (0x01) usages. */
export const DIGITIZER_FILTERS: DeviceFilter[] = [
  { usagePage: 0x0d, usage: 0x02 },
  { usagePage: 0x0d, usage: 0x01 },
];

export class WebHidInputSource {
  readonly ring: InputRing;
  #device: HIDDevice | null = null;
  #parser: HidReportParser = new HidReportParser(DEFAULT_PROFILE);
  readonly #listeners = new Set<InputListener>();
  #reportCount = 0;
  #windowStart = 0;
  #windowCount = 0;
  #rateHz = 0;

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "hid" in navigator;
  }

  constructor(ring: InputRing) {
    this.ring = ring;
    if (WebHidInputSource.isSupported()) {
      navigator.hid.addEventListener("connect", (e) => void this.#onConnect(e as HIDConnectionEvent));
      navigator.hid.addEventListener("disconnect", (e) => this.#onDisconnect(e as HIDConnectionEvent));
    }
  }

  get device(): HIDDevice | null {
    return this.#device;
  }
  get profile(): ReportProfile {
    return this.#parser.profile;
  }
  get reportCount(): number {
    return this.#reportCount;
  }
  /** Measured input report rate over the last 1 s window. */
  get rateHz(): number {
    return this.#rateHz;
  }

  subscribe(fn: InputListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Must be called from a user gesture handler. */
  async requestAndOpen(filters: DeviceFilter[] = DIGITIZER_FILTERS, forcedProfile?: ReportProfile): Promise<HIDDevice> {
    if (!WebHidInputSource.isSupported()) throw new Error("WebHID not supported");
    const devices = await navigator.hid.requestDevice({ filters });
    const dev = devices[0];
    if (!dev) throw new Error("no device selected");
    await this.#attach(dev, forcedProfile);
    return dev;
  }

  /** Reopens any previously granted device without a prompt (call at startup). */
  async reopenGranted(forcedProfile?: ReportProfile): Promise<HIDDevice | null> {
    if (!WebHidInputSource.isSupported()) return null;
    const granted = await navigator.hid.getDevices();
    const dev = granted[0];
    if (!dev) return null;
    await this.#attach(dev, forcedProfile);
    return dev;
  }

  /** Attach an already-opened device (also used by tests with a fake HIDDevice). */
  async attachDevice(dev: HIDDevice, forcedProfile?: ReportProfile): Promise<void> { await this.#attach(dev, forcedProfile); }

  async close(): Promise<void> {
    if (!this.#device) return;
    this.#device.removeEventListener("inputreport", this.#onReport);
    if (this.#device.opened) await this.#device.close();
    this.#device = null;
  }

  async #attach(dev: HIDDevice, forcedProfile?: ReportProfile): Promise<void> {
    await this.close();
    if (!dev.opened) await dev.open();
    const profile = forcedProfile ?? profileFromCollections(dev.collections) ?? DEFAULT_PROFILE;
    this.#parser = new HidReportParser(profile);
    this.#device = dev;
    dev.addEventListener("inputreport", this.#onReport);
  }

  readonly #onReport = (ev: Event): void => {
    const e = ev as HIDInputReportEvent;
    const now = performance.now();
    this.#reportCount++;
    this.#windowCount++;
    if (now - this.#windowStart >= 1000) {
      this.#rateHz = (this.#windowCount * 1000) / (now - this.#windowStart || 1);
      this.#windowStart = now;
      this.#windowCount = 0;
    }
    for (const out of this.#parser.parse(e.reportId, e.data, now)) {
      if (out.kind === "pen") this.ring.push(out);
      for (const l of this.#listeners) l(out);
    }
  };

  async #onConnect(e: HIDConnectionEvent): Promise<void> {
    if (this.#device) return;
    try {
      await this.#attach(e.device);
    } catch {
      // device may be claimed by the OS; PointerEventSource remains the fallback
    }
  }

  #onDisconnect(e: HIDConnectionEvent): void {
    if (this.#device === e.device) {
      this.#device.removeEventListener("inputreport", this.#onReport);
      this.#device = null;
    }
  }
}

/**
 * Pointer Events fallback. Maps the browser's normalized stylus fields onto the
 * same PenSample shape so the C++ core sees one input format.
 */
export class PointerEventSource {
  readonly ring: InputRing;
  readonly #target: HTMLElement;
  readonly #listeners = new Set<InputListener>();
  #width = 1;
  #height = 1;

  constructor(target: HTMLElement, ring: InputRing) {
    this.#target = target;
    this.ring = ring;
    const rect = target.getBoundingClientRect();
    this.#width = rect.width || 1;
    this.#height = rect.height || 1;
    target.style.touchAction = "none";
    target.addEventListener("pointerdown", this.#onPointer);
    target.addEventListener("pointermove", this.#onPointer);
    target.addEventListener("pointerup", this.#onPointer);
    target.addEventListener("pointercancel", this.#onPointer);
    target.addEventListener("pointerrawupdate" as "pointermove", this.#onPointer);
  }

  subscribe(fn: InputListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  destroy(): void {
    for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerrawupdate"]) {
      this.#target.removeEventListener(t, this.#onPointer as EventListener);
    }
  }

  readonly #onPointer = (ev: PointerEvent): void => {
    if (ev.pointerType !== "pen") return;
    const rect = this.#target.getBoundingClientRect();
    this.#width = rect.width || 1;
    this.#height = rect.height || 1;
    const events = typeof ev.getCoalescedEvents === "function" && ev.type === "pointermove" ? ev.getCoalescedEvents() : [ev];
    for (const e of events.length ? events : [ev]) {
      const sample = this.#toSample(e, rect);
      this.ring.push(sample);
      for (const l of this.#listeners) l(sample);
    }
  };

  #toSample(e: PointerEvent, rect: DOMRect): PenSample {
    const tip = e.type !== "pointerup" && e.type !== "pointercancel" && (e.buttons & 1) !== 0;
    const inRange = e.type !== "pointercancel";
    const twist = (e as PointerEvent & { twist?: number }).twist;
    return {
      kind: "pen",
      timestampMs: e.timeStamp,
      tip,
      barrel1: (e.buttons & 2) !== 0,
      barrel2: (e.buttons & 4) !== 0,
      eraser: (e.buttons & 32) !== 0,
      inRange,
      rawX: e.clientX - rect.left,
      rawY: e.clientY - rect.top,
      x: (e.clientX - rect.left) / this.#width,
      y: (e.clientY - rect.top) / this.#height,
      rawPressure: Math.round(e.pressure * 16_383),
      pressure: e.pressure,
      tiltXDeg: e.tiltX,
      tiltYDeg: e.tiltY,
      rotationDeg: typeof twist === "number" ? twist : null,
      status: e.buttons,
    };
  }
}
