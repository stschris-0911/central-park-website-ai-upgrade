import { bearingDegrees, distanceMeters, type LatLon } from "./beacon";

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const value = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return value.AudioContext ?? value.webkitAudioContext ?? null;
}

function smooth(param: AudioParam, value: number, time: number) {
  param.setTargetAtTime(value, time, 0.12);
}

const BEACON_PULSE_SECONDS = 0.08;
const ARRIVAL_CHIME_SECONDS = 0.22;
const FINAL_CHIME_SECONDS = 0.3;
const FACING_THRESHOLD_DEGREES = 15;

export type BeaconFeedbackMode = "calm" | "drum-left" | "drum-right";

type BeaconFeedback = {
  angleDiff: number;
  distanceMeters: number;
  bearing: number;
  heading: number;
};

export class AudioBeaconEngine {
  private ctx: AudioContext | null = null;
  private panner: PannerNode | StereoPannerNode | null = null;
  private distanceGain: GainNode | null = null;
  private master: GainNode | null = null;
  private beaconPulseGain = 0.18;
  private facingTarget = true;
  private feedbackMode: BeaconFeedbackMode = "calm";
  private pulseIntervalMs = 1200;
  private lastBeaconPulseAt = 0;
  private running = false;

  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }

    const Ctor = getAudioContextCtor();
    if (!Ctor) throw new Error("Spatial audio is not available on this device.");

    this.ctx = new Ctor();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(this.ctx.destination);

    this.distanceGain = this.ctx.createGain();
    this.distanceGain.gain.value = 1;
    this.distanceGain.connect(this.master);

    this.panner = this.createPanner();
    this.panner.connect(this.distanceGain);
  }

  start() {
    if (!this.ctx || !this.panner || this.running) return;
    this.running = true;
  }

  stop() {
    this.running = false;
  }

  close() {
    this.stop();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }

  setUserPose(user: LatLon, beacon: LatLon, headingDeg: number, accuracyMeters?: number | null) {
    if (!this.ctx || !this.panner || !this.distanceGain) return;

    const time = this.ctx.currentTime;
    const beaconBearing = bearingDegrees(user, beacon);
    const offAxis = ((beaconBearing - headingDeg + 540) % 360) - 180;
    const offRad = (offAxis * Math.PI) / 180;
    const alignment = Math.max(0, Math.cos(offRad));
    const distance = distanceMeters(user, beacon);
    this.facingTarget = Math.abs(offAxis) <= FACING_THRESHOLD_DEGREES;

    if (this.panner instanceof PannerNode) {
      const relativeX = Math.sin(offRad) * Math.min(8, Math.max(2, distance / 4));
      const relativeZ = -Math.cos(offRad) * Math.min(8, Math.max(2, distance / 4));
      smooth(this.panner.positionX, relativeX, time);
      smooth(this.panner.positionY, 0, time);
      smooth(this.panner.positionZ, relativeZ, time);

      const listener = this.ctx.listener;
      if ("forwardX" in listener) {
        smooth(listener.positionX, 0, time);
        smooth(listener.positionY, 0, time);
        smooth(listener.positionZ, 0, time);
        smooth(listener.forwardX, 0, time);
        smooth(listener.forwardY, 0, time);
        smooth(listener.forwardZ, -1, time);
        smooth(listener.upX, 0, time);
        smooth(listener.upY, 1, time);
        smooth(listener.upZ, 0, time);
      }
    } else {
      smooth(this.panner.pan, Math.sin(offRad), time);
    }

    const distanceGain = Math.max(0.35, 25 / (25 + 0.35 * Math.max(0, distance - 25)));
    const accuracyGain =
      accuracyMeters == null || !Number.isFinite(accuracyMeters)
        ? 1
        : accuracyMeters <= 10
          ? 1
          : accuracyMeters >= 40
            ? 0.35
            : 1 - ((accuracyMeters - 10) / 30) * 0.65;

    this.beaconPulseGain = 0.06 + alignment * 0.2;
    smooth(this.distanceGain.gain, distanceGain * accuracyGain, time);
  }

  updateBeaconFeedback(feedback: BeaconFeedback): BeaconFeedbackMode {
    if (!this.ctx || !this.panner || !this.distanceGain) return "calm";

    const time = this.ctx.currentTime;
    const angleDiff = ((feedback.angleDiff + 540) % 360) - 180;
    const absAngle = Math.abs(angleDiff);
    const offRad = (angleDiff * Math.PI) / 180;
    const pan = absAngle <= FACING_THRESHOLD_DEGREES ? Math.sin(offRad) * 0.35 : angleDiff < 0 ? -1 : 1;
    const intensity =
      absAngle <= FACING_THRESHOLD_DEGREES
        ? 0.18
        : absAngle <= 45
          ? 0.16
          : absAngle <= 90
            ? 0.25
            : 0.34;

    this.feedbackMode =
      absAngle <= FACING_THRESHOLD_DEGREES ? "calm" : angleDiff < 0 ? "drum-left" : "drum-right";
    this.facingTarget = this.feedbackMode === "calm";
    this.beaconPulseGain = intensity;
    this.pulseIntervalMs =
      feedback.distanceMeters > 25 ? 1800 : feedback.distanceMeters >= 10 ? 1200 : 700;

    if (this.panner instanceof PannerNode) {
      this.setPannerAngle(angleDiff, feedback.distanceMeters, time);
    } else {
      smooth(this.panner.pan, pan, time);
    }

    const distanceGain = Math.max(
      0.38,
      25 / (25 + 0.35 * Math.max(0, feedback.distanceMeters - 25))
    );
    smooth(this.distanceGain.gain, distanceGain, time);

    return this.feedbackMode;
  }

  playBeaconMode(mode: BeaconFeedbackMode, angleDiff: number, distanceMeters: number): boolean {
    if (!this.ctx || !this.panner || !this.running) return false;

    const now = this.ctx.currentTime;
    this.feedbackMode = mode;
    this.facingTarget = mode === "calm";
    this.beaconPulseGain =
      mode === "calm"
        ? 0.24
        : Math.abs(angleDiff) <= 45
          ? 0.24
          : Math.abs(angleDiff) <= 90
            ? 0.32
            : 0.42;

    const directionalAngle =
      mode === "calm" ? angleDiff : mode === "drum-left" ? Math.min(-35, angleDiff) : Math.max(35, angleDiff);
    this.setPannerAngle(directionalAngle, distanceMeters, now);

    if (mode === "calm") {
      this.playCalmPulse(now);
    } else {
      this.playDrumPulse(now);
    }

    return true;
  }

  pulseBeacon(force = false): boolean {
    if (!this.ctx || !this.panner || !this.running) return false;

    const nowMs = performance.now();
    if (!force && nowMs - this.lastBeaconPulseAt < this.pulseIntervalMs) return false;
    this.lastBeaconPulseAt = nowMs;

    const now = this.ctx.currentTime;
    if (this.feedbackMode !== "calm") {
      this.playDrumPulse(now);
      return true;
    }

    this.playCalmPulse(now);
    return true;
  }

  private playCalmPulse(now: number) {
    if (!this.ctx || !this.panner) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(this.beaconPulseGain, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + BEACON_PULSE_SECONDS);
    osc.connect(gain);
    gain.connect(this.panner);
    osc.start(now);
    osc.stop(now + BEACON_PULSE_SECONDS + 0.02);
  }

  private playDrumPulse(now: number) {
    if (!this.ctx || !this.panner) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(210, now);
    osc.frequency.exponentialRampToValueAtTime(72, now + 0.11);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(680, now);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(this.beaconPulseGain, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.panner);
    osc.start(now);
    osc.stop(now + 0.18);
  }
  async playTestCalm() {
    await this.init();
    this.start();

    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.facingTarget = true;
    this.feedbackMode = "calm";
    this.beaconPulseGain = 0.22;
    this.setPannerAngle(0, 8, now);
    this.playCalmPulse(now);
  }

  async playTestDrumLeft() {
    await this.init();
    this.start();

    if (!this.ctx || !this.panner) return;

    const now = this.ctx.currentTime;

    this.facingTarget = false;
    this.feedbackMode = "drum-left";
    this.beaconPulseGain = 0.28;
    this.setPannerAngle(-80, 8, now);
    this.playDrumPulse(now);
  }

  async playTestDrumRight() {
    await this.init();
    this.start();

    if (!this.ctx || !this.panner) return;

    const now = this.ctx.currentTime;

    this.facingTarget = false;
    this.feedbackMode = "drum-right";
    this.beaconPulseGain = 0.28;
    this.setPannerAngle(80, 8, now);
    this.playDrumPulse(now);
  }
  playArrival() {
    this.playSuccessChime();
  }

  playFinal() {
    this.playChime([523, 659, 784, 1047], FINAL_CHIME_SECONDS, 0.32);
  }

  private playSuccessChime() {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const notes = [659, 880, 1319];

    notes.forEach((frequency, index) => {
      const start = now + index * 0.055;
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.3, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.001, start + ARRIVAL_CHIME_SECONDS);
      osc.connect(gain);
      gain.connect(this.master!);
      osc.start(start);
      osc.stop(start + ARRIVAL_CHIME_SECONDS + 0.03);
    });
  }

  private playChime(frequencies: number[], duration: number, peakGain = 0.26) {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;

    frequencies.forEach((frequency, index) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.012 + index * 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration + index * 0.025);
      osc.connect(gain);
      gain.connect(this.master!);
      osc.start(now + index * 0.02);
      osc.stop(now + duration + index * 0.03);
    });
  }

  private setPannerAngle(angleDiff: number, distanceMeters: number, time: number) {
    if (!this.panner) return;
    const angleRad = (angleDiff * Math.PI) / 180;
    const radius = Math.min(8, Math.max(2, distanceMeters / 4));

    if (this.panner instanceof PannerNode) {
      smooth(this.panner.positionX, Math.sin(angleRad) * radius, time);
      smooth(this.panner.positionY, 0, time);
      smooth(this.panner.positionZ, -Math.cos(angleRad) * radius, time);
    } else {
      smooth(this.panner.pan, Math.max(-1, Math.min(1, Math.sin(angleRad))), time);
    }
  }

  private createPanner(): PannerNode | StereoPannerNode {
    if (!this.ctx) throw new Error("Audio context is not ready.");

    if (typeof this.ctx.createPanner === "function") {
      const panner = this.ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 1;
      panner.maxDistance = 20;
      panner.rolloffFactor = 0;
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      return panner;
    }

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = 0;
    return panner;
  }
}
