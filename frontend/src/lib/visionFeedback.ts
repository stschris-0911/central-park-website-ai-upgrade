import type { VisionAnalysisResponse } from "./visionApi";

type FeedbackUrgency = "mild" | "medium" | "high";

type FeedbackEvent = {
  key: string;
  pan: number;
  urgency: FeedbackUrgency;
  kind: "continue" | "turn" | "warning";
  repeat: boolean;
  intervalMs: number;
};

type WebkitAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export class VisionFeedbackController {
  private audioContext: AudioContext | null = null;
  private enabled = false;
  private activeEvent: FeedbackEvent | null = null;
  private loopTimer: number | null = null;
  private lastOneShotKey = "";
  private lastOneShotAt = 0;

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) {
      this.stopLoop();
      this.activeEvent = null;
      return;
    }
    await this.ensureAudioContext();
  }

  reset(): void {
    this.stopLoop();
    this.activeEvent = null;
    this.lastOneShotKey = "";
    this.lastOneShotAt = 0;
  }

  async close(): Promise<void> {
    this.reset();
    this.enabled = false;
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }

  notify(result: VisionAnalysisResponse): void {
    if (!this.enabled) return;
    const event = eventFromVisionResult(result);
    if (!event) {
      this.reset();
      return;
    }

    if (event.repeat) {
      const changed = this.activeEvent?.key !== event.key || this.activeEvent?.intervalMs !== event.intervalMs;
      this.activeEvent = event;
      if (changed || this.loopTimer === null) {
        this.stopLoop();
        this.play(event);
        this.vibrate(event);
        this.scheduleLoop(event.intervalMs);
      }
      return;
    }

    this.stopLoop();
    this.activeEvent = null;
    const now = performance.now();
    const cooldown = event.urgency === "high" ? 900 : event.urgency === "medium" ? 1400 : 3200;
    if (event.key === this.lastOneShotKey && now - this.lastOneShotAt < cooldown) return;
    this.lastOneShotKey = event.key;
    this.lastOneShotAt = now;
    this.play(event);
    this.vibrate(event);
  }

  private scheduleLoop(intervalMs: number): void {
    if (!this.enabled || !this.activeEvent) return;
    this.loopTimer = window.setTimeout(() => {
      this.loopTimer = null;
      if (!this.enabled || !this.activeEvent) return;
      this.play(this.activeEvent);
      this.scheduleLoop(this.activeEvent.intervalMs);
    }, intervalMs);
  }

  private stopLoop(): void {
    if (this.loopTimer !== null) {
      window.clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  private async ensureAudioContext(): Promise<AudioContext | null> {
    const AudioContextClass = window.AudioContext || (window as WebkitAudioWindow).webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!this.audioContext) {
      this.audioContext = new AudioContextClass();
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  private play(event: FeedbackEvent): void {
    void this.ensureAudioContext().then((context) => {
      if (!context) return;
      if (event.kind === "warning") {
        const base = event.urgency === "high" ? 185 : event.urgency === "medium" ? 220 : 260;
        this.playPulse(context, base, 0.105, event.pan, "square", 0.22);
        if (event.urgency === "high") {
          window.setTimeout(() => this.playPulse(context, base * 0.82, 0.105, event.pan, "square", 0.22), 120);
        }
        return;
      }

      if (event.kind === "turn") {
        this.playPulse(context, 300, 0.14, event.pan, "triangle", 0.18);
        window.setTimeout(() => this.playPulse(context, 360, 0.10, event.pan, "triangle", 0.14), 130);
        return;
      }

      this.playPulse(context, 620, 0.08, 0, "sine", 0.12);
      window.setTimeout(() => this.playPulse(context, 820, 0.08, 0, "sine", 0.10), 90);
    });
  }

  private playPulse(
    context: AudioContext,
    frequency: number,
    durationSeconds: number,
    pan: number,
    type: OscillatorType,
    peakGain: number
  ): void {
    const start = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, start + durationSeconds);

    const stereoContext = context as AudioContext & { createStereoPanner?: () => StereoPannerNode };
    if (typeof stereoContext.createStereoPanner === "function") {
      const panner = stereoContext.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), start);
      oscillator.connect(gain);
      gain.connect(panner);
      panner.connect(context.destination);
    } else {
      oscillator.connect(gain);
      gain.connect(context.destination);
    }

    oscillator.start(start);
    oscillator.stop(start + durationSeconds + 0.02);
  }

  private vibrate(event: FeedbackEvent): void {
    if (!("vibrate" in navigator)) return;
    if (event.kind === "warning") {
      navigator.vibrate(event.urgency === "high" ? [70, 35, 70] : event.urgency === "medium" ? [45, 35, 45] : 35);
    } else if (event.kind === "turn") {
      navigator.vibrate(event.urgency === "medium" ? [35, 30, 35] : 30);
    }
  }
}

export function eventFromVisionResult(result: VisionAnalysisResponse): FeedbackEvent | null {
  if (result.curb_warning?.active) {
    const fanPosition = result.curb_warning.fan_position;
    const pan = fanPosition === "left" ? -0.88 : fanPosition === "right" ? 0.88 : 0;
    const fanZone = result.curb_warning.fan_zone ?? 5;
    const isNear = fanZone >= 0 && fanZone <= 2;
    const high = result.curb_warning.severity === "high" || isNear;
    return {
      key: `curb:${fanPosition}:${result.curb_warning.severity}:${fanZone}`,
      pan,
      urgency: high ? "high" : result.curb_warning.severity === "medium" ? "medium" : "mild",
      kind: "warning",
      repeat: true,
      intervalMs: high ? 260 : result.curb_warning.severity === "medium" ? 540 : 900
    };
  }

  if (result.direction === "stop" || result.traversable?.best_direction === "stop") {
    return {
      key: "stop:no-path",
      pan: 0,
      urgency: "high",
      kind: "warning",
      repeat: true,
      intervalMs: 220
    };
  }

  const direction = result.traversable?.best_direction || result.direction;
  if (direction === "left" || direction === "slight_left") {
    return {
      key: `path:${direction}`,
      pan: -0.78,
      urgency: direction === "left" ? "medium" : "mild",
      kind: "turn",
      repeat: false,
      intervalMs: 0
    };
  }
  if (direction === "right" || direction === "slight_right") {
    return {
      key: `path:${direction}`,
      pan: 0.78,
      urgency: direction === "right" ? "medium" : "mild",
      kind: "turn",
      repeat: false,
      intervalMs: 0
    };
  }
  if (direction === "center" || result.direction === "continue") {
    return {
      key: "path:center",
      pan: 0,
      urgency: "mild",
      kind: "continue",
      repeat: false,
      intervalMs: 0
    };
  }

  return null;
}

export function createVisionFeedbackController(): VisionFeedbackController {
  return new VisionFeedbackController();
}
