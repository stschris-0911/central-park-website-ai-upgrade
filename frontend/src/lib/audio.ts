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
const BEACON_PULSE_COOLDOWN_MS = 1100;
const ARRIVAL_CHIME_SECONDS = 0.11;
const FINAL_CHIME_SECONDS = 0.18;

export class AudioBeaconEngine {
  private ctx: AudioContext | null = null;
  private panner: StereoPannerNode | PannerNode | null = null;
  private distanceGain: GainNode | null = null;
  private master: GainNode | null = null;
  private beaconPulseGain = 0.18;
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

    if (this.panner instanceof StereoPannerNode) {
      smooth(this.panner.pan, Math.sin(offRad), time);
    } else {
      const lat0 = (user[0] * Math.PI) / 180;
      const eastMeters =
        (((beacon[1] - user[1]) * Math.PI) / 180) * 6378137 * Math.cos(lat0);
      const northMeters = (((beacon[0] - user[0]) * Math.PI) / 180) * 6378137;
      smooth(this.panner.positionX, eastMeters, time);
      smooth(this.panner.positionY, 0, time);
      smooth(this.panner.positionZ, -northMeters, time);

      const headingRad = (headingDeg * Math.PI) / 180;
      const listener = this.ctx.listener;
      if ("forwardX" in listener) {
        smooth(listener.positionX, 0, time);
        smooth(listener.positionY, 0, time);
        smooth(listener.positionZ, 0, time);
        smooth(listener.forwardX, Math.sin(headingRad), time);
        smooth(listener.forwardY, 0, time);
        smooth(listener.forwardZ, -Math.cos(headingRad), time);
        smooth(listener.upX, 0, time);
        smooth(listener.upY, 1, time);
        smooth(listener.upZ, 0, time);
      }
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

  pulseBeacon(force = false): boolean {
    if (!this.ctx || !this.panner || !this.running) return false;

    const nowMs = performance.now();
    if (!force && nowMs - this.lastBeaconPulseAt < BEACON_PULSE_COOLDOWN_MS) return false;
    this.lastBeaconPulseAt = nowMs;

    const now = this.ctx.currentTime;
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
    return true;
  }

  playArrival() {
    this.playChime([880, 1174], ARRIVAL_CHIME_SECONDS);
  }

  playFinal() {
    this.playChime([523, 659, 784], FINAL_CHIME_SECONDS);
  }

  private playChime(frequencies: number[], duration: number) {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;

    frequencies.forEach((frequency, index) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.26, now + 0.012 + index * 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration + index * 0.025);
      osc.connect(gain);
      gain.connect(this.master!);
      osc.start(now + index * 0.02);
      osc.stop(now + duration + index * 0.03);
    });
  }

  private createPanner(): StereoPannerNode | PannerNode {
    if (!this.ctx) throw new Error("Audio context is not ready.");

    const panner = this.ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "linear";
    panner.refDistance = 1;
    panner.maxDistance = 10000;
    panner.rolloffFactor = 0;
    return panner;
  }
}
