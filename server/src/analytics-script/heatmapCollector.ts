import type { HeatmapBatch, HeatmapEvent, HeatmapGeometry, HeatmapSnapshotRequest } from "@rybbit/shared";
import { HEATMAP_MAX_SNAPSHOT_BYTES, HEATMAP_WIDTH_BUCKETS, heatmapWidthBucket } from "@rybbit/shared/dist/heatmaps.js";
import type { ScriptConfig } from "./types.js";
import { reserveKeepalive } from "./keepalive.js";
import { PageCapture } from "./pageCapture.js";
import { getTrackedPage, getTrackedPathname } from "./url.js";
import type { FeatureRuntime } from "./featureTypes.js";

const SAMPLE_TTL_MS = 30 * 60_000;
const FLUSH_INTERVAL_MS = 5000;
const SCROLL_INTERVAL_MS = 100;
const ROUTE_SETTLE_MS = 100;
const SAMPLE_SAVE_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
export const HEATMAP_MAX_BATCH_BYTES = 48 * 1024 - 1;
const MAX_BATCH_EVENTS = 100;
const MAX_BUFFERED_EVENTS = 1000;
const RETRY_RETENTION_MS = 15 * 60_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_DIMENSION = 0xffffffff;
const MAX_VIEWPORT_DIMENSION = 0xffff;

type SampleDecision = { sampled: boolean; expiresAt: number; rate: number };
const memorySamples = new Map<string, SampleDecision>();
type Page = { key: string; pageVisitId: string; hostname: string; pathname: string };
type Reach = HeatmapGeometry & { type: "scroll"; maxDepth: number };
type Chunk = {
  batchId: string;
  body: string;
  bytes: number;
  eventCount: number;
  attempts: number;
  expiresAt: number;
  retryAt: number;
  normalSending?: boolean;
  exitSending?: boolean;
};
type Transition = {
  generation: number;
  startedAt: number;
  documentWidth?: number;
  documentHeight?: number;
  interacted: boolean;
  maxReachedY?: number;
};
type ScrollGeometry = {
  geometry: HeatmapGeometry;
  root: HTMLElement;
  body: HTMLElement | null;
  scroller: Element | null;
  extents: { element: Element; width: number; height: number }[];
};
let exitBytes = 0;

function randomId(): string {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function scopeId(scope: string): string {
  let hash = 2166136261;
  for (let i = 0; i < scope.length; i++) hash = Math.imul(hash ^ scope.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function sampleKey(config: ScriptConfig): string {
  const host = new URL(config.analyticsHost, window.location.href).href.replace(/\/+$/, "");
  return `rybbit-heatmaps:${encodeURIComponent(host)}:${encodeURIComponent(config.siteId)}`;
}

function saveSample(key: string, decision: SampleDecision): void {
  memorySamples.set(key, decision);
  try {
    sessionStorage.setItem(key, JSON.stringify(decision));
  } catch {}
}

function sample(config: ScriptConfig, key: string): boolean {
  const rate = config.heatmapSampleRate ?? 15;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) return false;
  const now = Date.now();
  let decision = memorySamples.get(key);
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) decision = JSON.parse(stored);
  } catch {}
  if (
    !decision ||
    typeof decision.sampled !== "boolean" ||
    !Number.isFinite(decision.expiresAt) ||
    decision.expiresAt <= now ||
    decision.expiresAt > now + SAMPLE_TTL_MS ||
    decision.rate !== rate
  ) {
    decision = { sampled: rate >= 100 || Math.random() * 100 < rate, expiresAt: now + SAMPLE_TTL_MS, rate };
  }
  decision = { ...decision, expiresAt: now + SAMPLE_TTL_MS };
  // Bound the fallback even on pages embedding many independently configured trackers.
  for (const [storedKey, storedDecision] of memorySamples) {
    if (storedDecision.expiresAt <= now) memorySamples.delete(storedKey);
  }
  if (memorySamples.size >= 128 && !memorySamples.has(key)) memorySamples.delete(memorySamples.keys().next().value!);
  saveSample(key, decision);
  return decision.sampled;
}

function dimension(value: number): number | null {
  return Number.isFinite(value) && value > 0 && value <= MAX_DIMENSION ? Math.ceil(value) : null;
}

function compatible(a: HeatmapGeometry, b: HeatmapGeometry): boolean {
  return (
    a.pageVisitId === b.pageVisitId &&
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight &&
    a.documentWidth === b.documentWidth &&
    a.documentHeight === b.documentHeight
  );
}

/** Compact interactions, with a lazy static background only when the server nominates this visit. */
export class HeatmapCollector {
  private active = false;
  private monitoring = false;
  private page: Page | null = null;
  private pageKey = "";
  private userId: string;
  private events: HeatmapEvent[] = [];
  private reach: Reach | null = null;
  private reachDirty = false;
  private pendingReach: Reach | null = null;
  private chunks: Chunk[] = [];
  private sending?: Promise<void>;
  private batchTimer?: number;
  private scrollTimer?: number;
  private resizeObserver?: ResizeObserver;
  private mutationObserver?: MutationObserver;
  private readonly batchPrefix: string;
  private readonly samplingKey: string;
  private sampleSaveTimer?: number;
  private lastSampleSave = 0;
  private lastHref = "";
  private cachedPage: { key: string; hostname: string; pathname: string } | null = null;
  private cachedPageKey = "";
  private cachedGeometry: HeatmapGeometry | null = null;
  private scrollGeometry: ScrollGeometry | null = null;
  private routeGeneration = 0;
  private transition: Transition | null = null;
  private routeTimer?: number;
  private suspended = false;
  private snapshotInFlight = false;
  private readonly pageCapture: PageCapture;
  private readonly ownsPageCapture: boolean;
  private readonly reserveKeepalive: typeof reserveKeepalive;
  private handledSnapshotRequests = new Set<string>();

  constructor(
    private config: ScriptConfig,
    userId = "",
    pageCapture?: PageCapture,
    runtime?: FeatureRuntime
  ) {
    this.userId = userId;
    this.pageCapture = pageCapture ?? new PageCapture(config, runtime?.pageAlreadyClicked, runtime?.capture);
    this.ownsPageCapture = !pageCapture;
    this.reserveKeepalive = runtime?.reserveKeepalive ?? reserveKeepalive;
    this.samplingKey = sampleKey(config);
    this.batchPrefix = scopeId(this.samplingKey);
  }

  initialize(): void {
    const rate = this.config.heatmapSampleRate ?? 15;
    if (this.monitoring || !this.config.enableHeatmaps || !Number.isFinite(rate) || rate <= 0 || rate > 100) return;
    this.monitoring = true;
    this.active = sample(this.config, this.samplingKey);
    this.lastSampleSave = Date.now();
    document.addEventListener("click", this.onClick, { capture: true, passive: true });
    window.addEventListener("scroll", this.onScroll, { passive: true });
    // Unsampled sessions renew their decision on activity, without measuring or
    // observing the document. Page loads must not change an active session's draw.
    if (!this.active) return;
    this.pageCapture.initialize();
    this.resetPage();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("resize", this.onResize, { passive: true });
    window.addEventListener("load", this.onResize);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    window.addEventListener("wheel", this.onScrollIntent, { passive: true });
    window.addEventListener("touchmove", this.onScrollIntent, { passive: true });
    window.addEventListener("keydown", this.onScrollIntent);
    document.addEventListener("freeze", this.onFreeze);
    document.addEventListener("resume", this.onResume);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      for (const element of new Set([document.documentElement, document.body, document.scrollingElement])) {
        if (element) this.resizeObserver.observe(element);
      }
    }
    if (typeof MutationObserver !== "undefined") {
      this.mutationObserver = new MutationObserver(this.onMutation);
      this.mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    }
    this.batchTimer = window.setInterval(() => {
      if (this.suspended) return;
      this.captureReach();
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  isActive(): boolean {
    return this.active;
  }

  private debug(message: string, error?: unknown): void {
    if (this.config.debug) console.warn(`[Rybbit heatmaps] ${message}`, error ?? "");
  }

  private currentPage(): { key: string; hostname: string; pathname: string } | null {
    if (this.lastHref === window.location.href) return this.cachedPage;
    this.lastHref = window.location.href;
    const url = new URL(window.location.href);
    const rawPath = getTrackedPathname(url, this.config.trackUrlFragments);
    const page = getTrackedPage(url, this.config);
    // A hash router can put query values inside the tracked pathname. Keep the
    // ordinary skip/mask policy, but never include those values in geometry data.
    const pathname = page?.pathname === rawPath ? rawPath.split("?")[0] : page?.pathname;
    this.cachedPageKey = `${url.hostname}\0${rawPath.split("?")[0]}\0${page ? pathname : "<skipped>"}`;
    this.cachedPage =
      !page || !pathname || pathname.length > 2048 || page.hostname.length > 253
        ? null
        : { key: this.cachedPageKey, hostname: page.hostname, pathname };
    return this.cachedPage;
  }

  private touchSample(): void {
    const decision = memorySamples.get(this.samplingKey);
    if (!decision) return;
    memorySamples.set(this.samplingKey, { ...decision, expiresAt: Date.now() + SAMPLE_TTL_MS });
    if (Date.now() - this.lastSampleSave >= SAMPLE_SAVE_INTERVAL_MS) this.persistSample();
    else if (this.sampleSaveTimer === undefined) {
      this.sampleSaveTimer = window.setTimeout(() => this.persistSample(), SAMPLE_SAVE_INTERVAL_MS);
    }
  }

  private persistSample(): void {
    if (this.sampleSaveTimer !== undefined) window.clearTimeout(this.sampleSaveTimer);
    this.sampleSaveTimer = undefined;
    const decision = memorySamples.get(this.samplingKey);
    if (decision) saveSample(this.samplingKey, decision);
    this.lastSampleSave = Date.now();
  }

  private resetPage(): void {
    if (this.routeTimer !== undefined) window.clearTimeout(this.routeTimer);
    this.transition = null;
    this.routeGeneration++;
    const page = this.currentPage();
    this.pageKey = this.cachedPageKey;
    this.page = page ? { ...page, pageVisitId: randomId() } : null;
    this.reach = null;
    this.reachDirty = false;
    this.pendingReach = null;
    this.cachedGeometry = null;
    this.scrollGeometry = null;
    this.captureReach(false);
  }

  private ensurePage(): void {
    this.onPageChange();
  }

  private geometry(target?: EventTarget | null): HeatmapGeometry | null {
    if (!this.page) return null;
    const viewportWidth = window.innerWidth <= MAX_VIEWPORT_DIMENSION ? dimension(window.innerWidth) : null;
    const viewportHeight = window.innerHeight <= MAX_VIEWPORT_DIMENSION ? dimension(window.innerHeight) : null;
    if (!viewportWidth || !viewportHeight) return null;
    let width = viewportWidth;
    let height = viewportHeight;
    for (const element of new Set([document.documentElement, document.body, document.scrollingElement])) {
      if (!element) continue;
      for (const candidate of [element.scrollWidth, element.clientWidth, (element as HTMLElement).offsetWidth]) {
        if (Number.isFinite(candidate) && candidate >= 0) width = Math.max(width, candidate);
      }
      for (const candidate of [element.scrollHeight, element.clientHeight, (element as HTMLElement).offsetHeight]) {
        if (Number.isFinite(candidate) && candidate >= 0) height = Math.max(height, candidate);
      }
    }
    if (target instanceof Element) {
      const bounds = target.getBoundingClientRect();
      if (Number.isFinite(bounds.right)) width = Math.max(width, bounds.right + Math.max(0, window.scrollX));
      if (Number.isFinite(bounds.bottom)) height = Math.max(height, bounds.bottom + Math.max(0, window.scrollY));
    }
    const documentWidth = dimension(width);
    const documentHeight = dimension(height);
    if (!documentWidth || !documentHeight) return null;
    return {
      timestamp: Date.now(),
      pageVisitId: this.page.pageVisitId,
      hostname: this.page.hostname,
      pathname: this.page.pathname,
      viewportWidth,
      viewportHeight,
      documentWidth,
      documentHeight,
    };
  }

  private geometryForScroll(): HeatmapGeometry | null {
    const cached = this.scrollGeometry;
    // Keep a cheap live extent check: CSS overflow can grow without an observer
    // callback. Reuse the full scan only inside this burst while all extents,
    // viewport dimensions, DOM roots and page attribution remain unchanged.
    if (
      this.scrollTimer !== undefined &&
      cached &&
      cached.geometry.pageVisitId === this.page?.pageVisitId &&
      cached.root === document.documentElement &&
      cached.body === document.body &&
      cached.scroller === document.scrollingElement &&
      cached.geometry.viewportWidth === window.innerWidth &&
      cached.geometry.viewportHeight === window.innerHeight &&
      cached.extents.every(
        ({ element, width, height }) => element.scrollWidth === width && element.scrollHeight === height
      )
    )
      return cached.geometry;
    const geometry = this.geometry();
    this.scrollGeometry = geometry
      ? {
          geometry,
          root: document.documentElement,
          body: document.body,
          scroller: document.scrollingElement,
          extents: [...new Set([document.documentElement, document.body, document.scrollingElement])]
            .filter((element): element is Element => Boolean(element))
            .map(element => ({ element, width: element.scrollWidth, height: element.scrollHeight })),
        }
      : null;
    return geometry;
  }

  private measureReach(geometry = this.geometry()): Reach | null {
    if (!geometry || !Number.isFinite(window.scrollY)) return null;
    this.cachedGeometry = geometry;
    return {
      ...geometry,
      timestamp: Date.now(),
      type: "scroll",
      maxDepth: Math.max(
        0,
        Math.min(100, ((Math.max(0, window.scrollY) + geometry.viewportHeight) / geometry.documentHeight) * 100)
      ),
    };
  }

  private captureReach(checkPage = true): void {
    if (!this.active) return;
    if (checkPage) this.ensurePage();
    if (this.transition) return;
    const reach = this.measureReach();
    if (reach) this.mergeReach(reach);
  }

  private mergeReach(reach: Reach): void {
    if (this.reach && compatible(this.reach, reach)) {
      if (reach.maxDepth <= this.reach.maxDepth) return;
    } else {
      this.checkpointReach();
    }
    this.reach = reach;
    this.reachDirty = true;
  }

  private checkpointReach(): void {
    if (this.reach && this.reachDirty) {
      this.reachDirty = false;
      this.enqueue(this.reach);
    }
  }

  private consumePendingReach(): void {
    if (this.scrollTimer !== undefined) window.clearTimeout(this.scrollTimer);
    this.scrollTimer = undefined;
    const pending = this.pendingReach;
    this.pendingReach = null;
    if (pending) this.mergeReach(pending);
  }

  private onClick = (event: MouseEvent): void => {
    if (!this.monitoring || this.suspended || !event.isTrusted || event.button !== 0) return;
    this.touchSample();
    if (!this.active) return;
    this.ensurePage();
    const geometry = this.geometry(event.target);
    if (
      !geometry ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY) ||
      !Number.isFinite(window.scrollX) ||
      !Number.isFinite(window.scrollY) ||
      event.clientX < 0 ||
      event.clientX > geometry.viewportWidth ||
      event.clientY < 0 ||
      event.clientY > geometry.viewportHeight
    )
      return;
    const pageX = event.clientX + Math.max(0, window.scrollX);
    const pageY = event.clientY + Math.max(0, window.scrollY);
    if (pageX > geometry.documentWidth || pageY > geometry.documentHeight) return;
    this.markRouteInteraction();
    this.enqueue({ ...geometry, type: "click", clientX: event.clientX, clientY: event.clientY, pageX, pageY });
  };

  private onScroll = (): void => {
    if (!this.monitoring || this.suspended) return;
    this.touchSample();
    if (!this.active) return;
    this.ensurePage();
    if (this.transition) {
      this.captureTransitionPosition();
      this.scheduleRouteSettle();
      return;
    }
    const reach = this.measureReach(this.geometryForScroll());
    if (!reach) return;
    // Save capture-time geometry before deferring processing: an SPA may replace
    // both the URL and document before this throttle's trailing callback runs.
    if (this.pendingReach && compatible(this.pendingReach, reach)) {
      if (reach.maxDepth > this.pendingReach.maxDepth) this.pendingReach = reach;
    } else {
      this.consumePendingReach();
      this.pendingReach = reach;
    }
    if (this.scrollTimer === undefined) {
      this.scrollTimer = window.setTimeout(() => {
        this.consumePendingReach();
        this.captureReach();
      }, SCROLL_INTERVAL_MS);
    }
  };

  private onScrollIntent = (event: Event): void => {
    if (!this.monitoring || !this.active || this.suspended || !event.isTrusted) return;
    if (
      event.type === "keydown" &&
      !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Space"].includes((event as KeyboardEvent).code)
    )
      return;
    this.ensurePage();
    this.markRouteInteraction();
  };

  private markRouteInteraction(): void {
    const transition = this.transition;
    if (!transition) return;
    transition.interacted = true;
    this.captureTransitionPosition();
    const remaining = ROUTE_SETTLE_MS - (Date.now() - transition.startedAt);
    if (remaining > 0) this.scheduleRouteSettle(remaining);
    else this.settleRoute(transition.generation);
  }

  private captureTransitionPosition(): void {
    const transition = this.transition;
    if (!transition?.interacted || !Number.isFinite(window.scrollY) || !Number.isFinite(window.innerHeight)) return;
    // Preserve input-time extrema without measuring a possibly stale document.
    transition.maxReachedY = Math.max(transition.maxReachedY || 0, Math.max(0, window.scrollY) + window.innerHeight);
  }

  private onResize = (): void => {
    if (this.suspended) return;
    this.consumePendingReach();
    this.cachedGeometry = null;
    this.scrollGeometry = null;
    if (this.transition) {
      this.scheduleRouteSettle();
      return;
    }
    this.captureReach();
  };

  private onMutation = (): void => {
    this.cachedGeometry = null;
    this.scrollGeometry = null;
    if (this.transition) {
      this.scheduleRouteSettle();
    } else if (!this.resizeObserver && this.scrollTimer === undefined) {
      this.scrollTimer = window.setTimeout(this.onResize, SCROLL_INTERVAL_MS);
    }
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.flushForExit();
    } else if (!this.suspended) {
      void this.flush();
    }
  };

  private onPageHide = (): void => {
    this.flushForExit();
    this.suspended = true;
  };

  private onFreeze = (): void => {
    this.flushForExit();
    this.suspended = true;
  };

  private onResume = (): void => {
    if (!this.monitoring || !this.active) return;
    this.suspended = false;
    this.cachedGeometry = null;
    this.scrollGeometry = null;
    if (this.transition) this.scheduleRouteSettle();
    this.captureReach();
    void this.flush();
  };

  private onPageShow = (): void => this.onResume();

  private bufferedEvents(): number {
    return this.events.length + this.chunks.reduce((count, chunk) => count + chunk.eventCount, 0);
  }

  private enqueue(event: HeatmapEvent): void {
    if (this.userId.length > 256) {
      this.debug("Interaction discarded because identified user ID exceeds 256 characters");
      return;
    }
    if (this.bufferedEvents() >= MAX_BUFFERED_EVENTS) {
      this.debug("Buffer full; interaction discarded after upload failures");
      return;
    }
    this.events.push(event);
    if (this.events.length >= MAX_BATCH_EVENTS) void this.flush();
  }

  private queueChunks(): void {
    if (!this.events.length) return;
    const events = this.events;
    this.events = [];
    const userId = this.userId || undefined;
    const encoder = new TextEncoder();
    let batch: HeatmapBatch = {
      batchId: `${this.batchPrefix}-${randomId()}`,
      events: [],
      ...(userId ? { userId } : {}),
    };
    const seal = () => {
      if (!batch.events.length) return;
      this.chunks.push({
        batchId: batch.batchId,
        body: JSON.stringify(batch),
        bytes: encoder.encode(JSON.stringify(batch)).byteLength,
        eventCount: batch.events.length,
        attempts: 0,
        expiresAt: Date.now() + RETRY_RETENTION_MS,
        retryAt: 0,
      });
      batch = { batchId: `${this.batchPrefix}-${randomId()}`, events: [], ...(userId ? { userId } : {}) };
    };
    for (const event of events) {
      batch.events.push(event);
      if (encoder.encode(JSON.stringify(batch)).byteLength > HEATMAP_MAX_BATCH_BYTES) {
        batch.events.pop();
        seal();
        batch.events.push(event);
        if (encoder.encode(JSON.stringify(batch)).byteLength > HEATMAP_MAX_BATCH_BYTES) {
          batch.events.pop();
          this.debug("Oversized interaction discarded");
        }
      }
      if (batch.events.length >= MAX_BATCH_EVENTS) seal();
    }
    seal();
  }

  flush(): Promise<void> {
    this.consumePendingReach();
    this.checkpointReach();
    this.queueChunks();
    if (!this.sending && this.chunks.length) {
      this.sending = this.sendChunks().finally(() => {
        this.sending = undefined;
        if (
          !this.suspended &&
          this.chunks.some(chunk => !chunk.normalSending && !chunk.exitSending && chunk.retryAt <= Date.now())
        ) {
          return this.flush();
        }
      });
    }
    return this.sending || Promise.resolve();
  }

  private async sendChunks(): Promise<void> {
    while (!this.suspended) {
      this.pruneExpiredChunks();
      const chunk = this.chunks.find(
        chunk => !chunk.normalSending && !chunk.exitSending && chunk.retryAt <= Date.now()
      );
      if (!chunk) return;
      chunk.normalSending = true;
      await this.sendChunk(chunk, false);
      chunk.normalSending = false;
    }
  }

  private pruneExpiredChunks(): void {
    this.chunks = this.chunks.filter(chunk => {
      if (chunk.expiresAt > Date.now()) return true;
      this.debug(`Expired retry batch ${chunk.batchId}`);
      return false;
    });
  }

  private removeChunk(chunk: Chunk): void {
    const index = this.chunks.indexOf(chunk);
    if (index >= 0) this.chunks.splice(index, 1);
  }

  private async sendChunk(chunk: Chunk, keepalive: boolean): Promise<void> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${this.config.analyticsHost}/heatmaps/record/${encodeURIComponent(this.config.siteId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chunk.body,
          mode: "cors",
          credentials: "omit",
          keepalive,
          signal: controller.signal,
        }
      );
      if (response.ok) {
        this.removeChunk(chunk);
        // Background capture must not hold or retry a successfully stored interaction batch.
        if (!keepalive) void this.handleSnapshotResponse(response);
        return;
      }
      const retryAfter = response.headers?.get("Retry-After");
      const seconds = retryAfter ? Number(retryAfter) : NaN;
      const retryDate = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : retryDate - Date.now();
      if (response.status === 503 && retryAfter !== null && retryAfter !== undefined) {
        chunk.retryAt =
          Date.now() +
          Math.max(FLUSH_INTERVAL_MS, Math.min(RETRY_RETENTION_MS, Number.isFinite(delay) ? delay : FLUSH_INTERVAL_MS));
        return;
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        this.debug(`Batch ${chunk.batchId} rejected with HTTP ${response.status}`);
        this.removeChunk(chunk);
        return;
      }
      if (Number.isFinite(delay))
        chunk.retryAt = Date.now() + Math.max(FLUSH_INTERVAL_MS, Math.min(RETRY_RETENTION_MS, delay));
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      // A failed insert can hold the server claim for ten minutes. Bounded time
      // retention, rather than three attempts, lets that lease expire safely.
      chunk.attempts++;
      chunk.retryAt = Math.max(
        chunk.retryAt,
        Date.now() + Math.min(MAX_RETRY_DELAY_MS, FLUSH_INTERVAL_MS * 2 ** Math.min(chunk.attempts - 1, 4))
      );
      this.debug(`Upload failed for batch ${chunk.batchId} (attempt ${chunk.attempts})`, error);
    } finally {
      window.clearTimeout(timer);
    }
  }

  private snapshotGeometry(request: HeatmapSnapshotRequest): HeatmapGeometry | null {
    if (!this.active || !this.monitoring || this.suspended) return null;
    this.ensurePage();
    // Never capture the prior route's DOM while an asynchronous SPA render is settling.
    if (this.transition || !this.pageCapture.canCapture()) return null;
    const geometry = this.geometry();
    if (
      !geometry ||
      geometry.pageVisitId !== request.pageVisitId ||
      geometry.hostname !== request.hostname ||
      geometry.pathname !== request.pathname ||
      heatmapWidthBucket(geometry.viewportWidth) !== request.bucket
    )
      return null;
    return geometry;
  }

  private async handleSnapshotResponse(response: Response): Promise<void> {
    if (this.snapshotInFlight || typeof response.json !== "function") return;
    try {
      const body: unknown = await response.json();
      if (!body || typeof body !== "object") return;
      const request = (body as { snapshotRequest?: HeatmapSnapshotRequest }).snapshotRequest;
      if (
        !request ||
        typeof request.key !== "string" ||
        !request.key ||
        request.key.length > 1024 ||
        typeof request.token !== "string" ||
        !request.token ||
        request.token.length > 1024 ||
        typeof request.pageVisitId !== "string" ||
        typeof request.hostname !== "string" ||
        typeof request.pathname !== "string" ||
        !HEATMAP_WIDTH_BUCKETS.includes(request.bucket) ||
        !this.snapshotGeometry(request)
      )
        return;
      const requestId = `${request.key}:${request.token}`;
      if (this.snapshotInFlight || this.handledSnapshotRequests.has(requestId)) return;
      if (this.handledSnapshotRequests.size >= 128) {
        this.handledSnapshotRequests.delete(this.handledSnapshotRequests.values().next().value!);
      }
      this.handledSnapshotRequests.add(requestId);
      this.snapshotInFlight = true;
      try {
        const capture = await this.pageCapture.capture(() => Boolean(this.snapshotGeometry(request)));
        const geometry = this.snapshotGeometry(request);
        if (
          !capture ||
          !geometry ||
          Object.entries(capture.context).some(
            ([key, value]) => geometry[key as keyof typeof capture.context] !== value
          )
        )
          return;
        // A recording checkpoint is indexed by the replay ingest service.
        // Only standalone captures upload a separate DOM tree.
        if (capture.source === "replay") return;
        const payload = JSON.stringify({ key: request.key, token: request.token, ...geometry, node: capture.node });
        if (new TextEncoder().encode(payload).byteLength > HEATMAP_MAX_SNAPSHOT_BYTES) return;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          await fetch(`${this.config.analyticsHost}/heatmaps/snapshot/${encodeURIComponent(this.config.siteId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            mode: "cors",
            credentials: "omit",
            keepalive: false,
            signal: controller.signal,
          });
        } finally {
          window.clearTimeout(timer);
        }
      } finally {
        this.snapshotInFlight = false;
      }
    } catch (error) {
      this.debug("Background capture failed", error);
    }
  }

  flushForExit(): void {
    if (!this.monitoring) return;
    this.persistSample();
    if (!this.active) return;
    this.captureReach();
    this.consumePendingReach();
    this.checkpointReach();
    this.queueChunks();
    this.pruneExpiredChunks();
    // Prioritize newly captured interactions over old retries. Issue requests
    // now, even if an ordinary fetch is pending. Same IDs make duplicates safe.
    for (const chunk of [...this.chunks].reverse()) {
      if (chunk.exitSending || exitBytes + chunk.bytes > HEATMAP_MAX_BATCH_BYTES) continue;
      const release = this.reserveKeepalive(chunk.body);
      if (!release) continue;
      exitBytes += chunk.bytes;
      chunk.exitSending = true;
      void this.sendChunk(chunk, true).finally(() => {
        release();
        exitBytes -= chunk.bytes;
        chunk.exitSending = false;
        if (!this.suspended) void this.flush();
      });
    }
    // Excess stays bounded in memory for a resumed/BFCache page. A terminated
    // document cannot guarantee delivery beyond the browser keepalive budget.
  }

  updateUserId(userId: string): void {
    if (userId === this.userId) return;
    if (this.active) void this.flush();
    this.userId = userId;
    if (this.active) this.resetPage();
  }

  onPageChange(): void {
    if (!this.monitoring) return;
    this.pageCapture.onPageChange();
    if (!this.active) {
      this.touchSample();
      return;
    }
    const page = this.currentPage();
    if (this.pageKey === this.cachedPageKey) return;
    this.touchSample();
    // Flush stored old-route geometry, never measure the new DOM as the old page.
    void this.flush();
    const previous = this.reach || this.cachedGeometry || this.transition;
    this.pageKey = this.cachedPageKey;
    this.page = page ? { ...page, pageVisitId: randomId() } : null;
    this.reach = null;
    this.reachDirty = false;
    this.transition = {
      generation: ++this.routeGeneration,
      startedAt: Date.now(),
      documentWidth: previous?.documentWidth,
      documentHeight: previous?.documentHeight,
      interacted: false,
    };
    this.scheduleRouteSettle();
  }

  private scheduleRouteSettle(delay?: number): void {
    if (!this.transition) return;
    if (this.routeTimer !== undefined) window.clearTimeout(this.routeTimer);
    const generation = this.transition.generation;
    const wait =
      delay ??
      (this.transition.interacted
        ? Math.max(0, ROUTE_SETTLE_MS - (Date.now() - this.transition.startedAt))
        : ROUTE_SETTLE_MS);
    this.routeTimer = window.setTimeout(() => this.settleRoute(generation), wait);
  }

  private settleRoute(generation: number): void {
    const transition = this.transition;
    if (!transition || transition.generation !== generation || this.suspended) return;
    this.routeTimer = undefined;
    // History changes commonly precede an async render and scroll reset. Do
    // not credit the previous document to the new visit without evidence.
    const next = this.geometry();
    const layoutChanged =
      next &&
      transition.documentHeight !== undefined &&
      (transition.documentHeight !== next.documentHeight || transition.documentWidth !== next.documentWidth);
    if (!transition.interacted && !(layoutChanged && window.scrollY <= 0)) return;
    this.transition = null;
    this.cachedGeometry = null;
    this.captureReach(false);
    if (transition.maxReachedY !== undefined && next) {
      this.mergeReach({
        ...next,
        type: "scroll",
        maxDepth: Math.max(0, Math.min(100, (transition.maxReachedY / next.documentHeight) * 100)),
      });
    }
  }

  cleanup(): void {
    if (!this.monitoring) return;
    if (this.active) {
      this.captureReach();
      void this.flush();
    }
    this.active = false;
    this.monitoring = false;
    if (this.ownsPageCapture) this.pageCapture.cleanup();
    this.persistSample();
    if (this.batchTimer !== undefined) window.clearInterval(this.batchTimer);
    if (this.scrollTimer !== undefined) window.clearTimeout(this.scrollTimer);
    if (this.routeTimer !== undefined) window.clearTimeout(this.routeTimer);
    this.transition = null;
    this.batchTimer = undefined;
    this.scrollTimer = undefined;
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("load", this.onResize);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    window.removeEventListener("wheel", this.onScrollIntent);
    window.removeEventListener("touchmove", this.onScrollIntent);
    window.removeEventListener("keydown", this.onScrollIntent);
    document.removeEventListener("freeze", this.onFreeze);
    document.removeEventListener("resume", this.onResume);
  }
}
