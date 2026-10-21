// Live tracking for performing: webcam face (MediaPipe in a worker), optional hands, mic lip-sync, and a mouse /
// keyboard "puppet" when there's no camera. Produces the shared pose (../contract.js) every animation frame.
//
//   const tr = new Tracker({ onPose(pose, info) {}, onStatus(s) {} })
//   await tr.startCamera(deviceId)   tr.stopCamera()     tr.video  (the <video> for a preview)
//   await tr.startMic(deviceId)      tr.stopMic()
//   tr.setPuppet(true)               mouse = head and eyes, hold the mouse button = talk, B = blink, ←/→ = tilt
//   tr.settings = withTrackingDefaults(doc.tracking)       tr.neutral() → values for settings.neutral
//   tr.inject({ blend, matrix })     feeds a face result by hand (tests, recorded data)
//   tr.dispose()
import { rawPose, PoseShaper, setNeutral, withTrackingDefaults } from './pose.js';
import { MicLipSync } from './mic.js';

export { withTrackingDefaults, defaultTracking, KEY_INFO, setNeutral, packPose, rawPose, PoseShaper } from './pose.js';

export class Tracker {
  constructor({ onPose, onStatus } = {}) {
    this.onPose = onPose; this.onStatus = onStatus;
    this.settings = withTrackingDefaults(null);
    this.shaper = new PoseShaper();
    this.mic = new MicLipSync();
    this.status = { camera: 'off', message: '', fps: 0, delegate: '', mic: false, puppet: false };
    this.raw = null; this.rawAt = 0; this.landmarks = null; this.hands = null;
    this.puppet = { on: false, x: 0, y: 0, talk: false, blinkUntil: 0, nextBlink: 0, roll: 0 };
    this.expr = {}; // expression weights from hotkeys, passed through as pose.expr
    this.alive = true;
    const loop = () => { if (!this.alive) return; this.tick(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  setStatus(p) { this.status = { ...this.status, ...p }; this.onStatus?.(this.status); }

  // ---------------------------------------------------------------- camera
  async startCamera(deviceId) {
    this.stopCamera();
    this.setStatus({ camera: 'loading', message: 'Starting the camera…' });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
    } catch (e) {
      this.setStatus({ camera: 'error', message: e?.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in the browser’s address bar, or use the mouse puppet.' : 'No camera found. You can use the mouse puppet and the mic instead.' });
      return false;
    }
    const v = this.video || (this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true }));
    v.srcObject = this.stream;
    await v.play().catch(() => {});
    this.setStatus({ camera: 'loading', message: 'Loading face tracking…' });
    try { await this.startWorker(); } catch (e) {
      this.setStatus({ camera: 'error', message: `Face tracking couldn’t start: ${e.message}` });
      return false;
    }
    this.pump();
    return true;
  }
  stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.raw = null; this.landmarks = null;
    if (this.status.camera !== 'off') this.setStatus({ camera: 'off', message: '', fps: 0 });
  }
  startWorker() {
    if (this.workerReady) return this.syncHands();
    if (!this.worker) {
      this.worker = new Worker(new URL('./face.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => this.onWorker(data);
    }
    return new Promise((resolve, reject) => {
      this.readyWait = { resolve, reject };
      this.worker.onerror = (e) => { e.preventDefault?.(); reject(new Error(e.message || 'the tracking worker failed')); };
      this.worker.postMessage({ t: 'init', origin: location.origin, withHands: !!this.settings.hands });
    });
  }
  syncHands() {
    if (this.handsOn === !!this.settings.hands || !this.worker) return Promise.resolve();
    this.handsOn = !!this.settings.hands;
    this.worker.postMessage({ t: 'init', origin: location.origin, withHands: this.handsOn });
    return Promise.resolve();
  }
  onWorker(d) {
    if (d.t === 'ready') {
      this.workerReady = true; this.handsOn = d.hands;
      this.setStatus({ delegate: d.delegate, camera: this.stream ? 'searching' : this.status.camera, message: this.stream ? 'Looking for your face…' : '' });
      this.readyWait?.resolve(); this.readyWait = null;
    } else if (d.t === 'error') {
      this.busy = false;
      if (this.readyWait) { this.readyWait.reject(new Error(d.message)); this.readyWait = null; } else console.warn('[tracking]', d.message);
    } else if (d.t === 'result') {
      this.busy = false;
      const now = performance.now();
      this.frames = (this.frames || 0) + 1;
      if (now - (this.fpsAt || 0) > 1000) { this.setStatus({ fps: Math.round((this.frames * 1000) / (now - (this.fpsAt || now - 1000))) }); this.fpsAt = now; this.frames = 0; }
      this.hands = d.hands;
      if (d.face) this.useFace(d.face);
      else if (this.status.camera === 'tracking' && now - this.rawAt > 600) this.setStatus({ camera: 'searching', message: 'Looking for your face…' });
    }
  }
  /** Sends the newest video frame to the worker whenever it's free (frames that arrive while it's busy are skipped). */
  pump() {
    const v = this.video;
    if (!v || !this.stream) return;
    const send = async () => {
      if (!this.stream) return;
      if (!this.busy && this.workerReady && v.readyState >= 2 && v.videoWidth) {
        this.busy = true;
        try {
          const frame = typeof VideoFrame !== 'undefined' ? new VideoFrame(v, { timestamp: Math.round(performance.now() * 1000) }) : await createImageBitmap(v);
          this.worker.postMessage({ t: 'frame', frame, ts: performance.now() }, [frame]);
        } catch { this.busy = false; }
      }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(send); else setTimeout(send, 33);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(send); else setTimeout(send, 33);
  }
  useFace(face) {
    this.landmarks = face.landmarks || null;
    this.raw = rawPose(face);
    if (this.hands) this.raw.hands = this.hands;
    this.rawAt = performance.now();
    if (this.status.camera !== 'tracking') this.setStatus({ camera: 'tracking', message: '' });
  }
  /** For tests and recorded data: use this face result as if the camera saw it. */
  inject(face) { this.useFace(face); }
  /** The current raw values as a neutral calibration (null when nothing is tracked). */
  neutral() { return this.raw ? setNeutral(this.raw) : null; }

  // ---------------------------------------------------------------- mic
  async startMic(deviceId) {
    try { await this.mic.start(deviceId); this.setStatus({ mic: true }); return true; } catch { this.setStatus({ mic: false }); return false; }
  }
  stopMic() { this.mic.stop(); this.setStatus({ mic: false }); }

  // ---------------------------------------------------------------- puppet (mouse and keyboard)
  setPuppet(on) {
    if (on === this.puppet.on) return;
    this.puppet.on = on;
    if (on) {
      this.pm = (e) => { this.puppet.x = (e.clientX / innerWidth) * 2 - 1; this.puppet.y = (e.clientY / innerHeight) * 2 - 1; };
      this.pd = (e) => { if (e.button === 0 && e.target?.closest?.('[data-puppet-area]')) this.puppet.talk = true; };
      this.pu = () => { this.puppet.talk = false; };
      this.kd = (e) => {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
        if (e.key === 'b' || e.key === 'B') this.puppet.blinkUntil = performance.now() + 160;
        if (e.key === 'ArrowLeft') this.puppet.roll = -15; if (e.key === 'ArrowRight') this.puppet.roll = 15;
      };
      this.ku = (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') this.puppet.roll = 0; };
      addEventListener('pointermove', this.pm); addEventListener('pointerdown', this.pd); addEventListener('pointerup', this.pu); addEventListener('keydown', this.kd); addEventListener('keyup', this.ku);
    } else {
      removeEventListener('pointermove', this.pm); removeEventListener('pointerdown', this.pd); removeEventListener('pointerup', this.pu); removeEventListener('keydown', this.kd); removeEventListener('keyup', this.ku);
    }
    this.setStatus({ puppet: on });
  }
  puppetPose(now) {
    const p = this.puppet;
    if (this.settings.autoBlink && now > p.nextBlink) { p.blinkUntil = now + 140; p.nextBlink = now + 2500 + Math.random() * 3500; }
    const blink = now < p.blinkUntil ? 0 : 1;
    // already in screen terms (mouse right → look right), so the mirror setting doesn't flip it
    return {
      noMirror: true, headYaw: p.x * 25, headPitch: -p.y * 18, headRoll: p.roll, eyeX: p.x * 0.8, eyeY: -p.y * 0.8,
      eyeLOpen: blink, eyeROpen: blink, mouthOpen: p.talk ? 0.75 + 0.25 * Math.sin(now / 70) : 0, mouthForm: 0.3, browL: 0, browR: 0,
    };
  }

  // ---------------------------------------------------------------- every frame
  tick() {
    const now = performance.now();
    const s = this.settings;
    const fresh = this.raw && now - this.rawAt < 700;
    let raw = fresh ? this.raw : this.puppet.on ? this.puppetPose(now) : null;
    const m = this.mic.on ? this.mic.sample(s.mic) : null;
    if (m) {
      raw = { ...(raw || { eyeLOpen: 1, eyeROpen: 1 }) };
      // the mic opens the mouth at least as far as it hears; visemes come from the mic when the camera's are weak
      raw.mouthOpen = Math.max(raw.mouthOpen || 0, m.mouthOpen);
      if (s.mic.visemes) for (const k of ['mouthA', 'mouthI', 'mouthU', 'mouthE', 'mouthO']) raw[k] = Math.max(raw[k] || 0, m[k] || 0);
    }
    if (!raw) { this.onPose?.(this.idle(now), { source: 'idle', mic: m?.level || 0 }); return; }
    const shaped = this.shaper.shape(raw.noMirror ? { ...raw } : raw, raw.noMirror ? { ...s, mirror: false, neutral: {} } : s, now / 1000);
    if (Object.keys(this.expr).length) shaped.expr = { ...this.expr };
    this.onPose?.(shaped, { source: fresh ? 'camera' : this.puppet.on ? 'puppet' : 'mic', mic: m?.level || 0 });
  }
  /** Nothing tracked: just breathe (and keep expressions). */
  idle(now) {
    const p = this.shaper.shape({}, { ...this.settings, bodyFollow: 0 }, now / 1000);
    if (Object.keys(this.expr).length) p.expr = { ...this.expr };
    return p;
  }

  dispose() {
    this.alive = false; cancelAnimationFrame(this.raf);
    this.stopCamera(); this.stopMic(); this.setPuppet(false);
    this.worker?.terminate(); this.worker = null;
  }
}
