// Runs MediaPipe's Face Landmarker (and optionally Hand Landmarker) off the main thread, so tracking never stalls
// editing or rendering. The page sends video frames (VideoFrame / ImageBitmap, transferred); we answer with the
// blendshapes, the facial transformation matrix and the landmarks. The wasm comes from the npm package (bundled by
// Vite, the ES-module build that works in module workers); the models are served from /models/ (no internet needed).
import { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';

let face = null; let hands = null; let delegate = 'GPU';
const fileset = () => ({ wasmLoaderPath: new URL(loaderUrl, self.location.href).href, wasmBinaryPath: new URL(wasmUrl, self.location.href).href });

// MediaPipe's loader sets self.ModuleFactory when its script first runs and clears it after making a task; in a
// module worker the script is imported (cached) only once, so we keep the factory and put it back for each task.
let factory = null;
async function make(Task, model, opts) {
  factory ||= (await import(/* @vite-ignore */ fileset().wasmLoaderPath)).default;
  // GPU (WebGL in an OffscreenCanvas) is much faster; fall back to the CPU when it isn't available.
  for (const d of delegate === 'GPU' ? ['GPU', 'CPU'] : ['CPU']) {
    self.ModuleFactory = factory;
    try {
      const t = await Task.createFromOptions(fileset(), { baseOptions: { modelAssetPath: model, delegate: d }, runningMode: 'VIDEO', ...opts });
      delegate = d;
      return t;
    } catch (e) { if (d === 'CPU') throw e; }
  }
  return null;
}

// Hands are optional (they cost about as much CPU/GPU as the face again). The confidence threshold is the
// detector's own: below it a hand counts as not there, rather than guessed at.
let handConf = 0.5;
async function init({ origin, withHands, handConfidence }) {
  if (!face) face = await make(FaceLandmarker, `${origin}/models/face_landmarker.task`, { numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true });
  const conf = Math.min(0.95, Math.max(0.1, Number(handConfidence) || 0.5));
  const opts = { minHandDetectionConfidence: conf, minHandPresenceConfidence: conf, minTrackingConfidence: Math.max(0.3, conf - 0.1) };
  if (withHands && !hands) { hands = await make(HandLandmarker, `${origin}/models/hand_landmarker.task`, { numHands: 2, ...opts }); handConf = conf; }
  else if (withHands && hands && conf !== handConf) { await hands.setOptions(opts); handConf = conf; }
  if (!withHands && hands) { hands.close(); hands = null; }
}

let lastTs = 0;
self.onmessage = async ({ data }) => {
  try {
    if (data.t === 'init') { await init(data); self.postMessage({ t: 'ready', delegate, hands: !!hands }); return; }
    if (data.t === 'frame') {
      const { frame } = data;
      const ts = Math.max(lastTs + 1, Math.round(data.ts)); lastTs = ts; // MediaPipe needs increasing timestamps
      const out = { t: 'result', ts: data.ts, face: null, hands: null, size: [frame.displayWidth || frame.width || 0, frame.displayHeight || frame.height || 0] };
      if (face) {
        const r = face.detectForVideo(frame, ts);
        if (r.faceLandmarks?.length) {
          const lm = r.faceLandmarks[0]; const pts = new Float32Array(lm.length * 3);
          for (let i = 0; i < lm.length; i++) { pts[i * 3] = lm[i].x; pts[i * 3 + 1] = lm[i].y; pts[i * 3 + 2] = lm[i].z; }
          const blend = {};
          for (const c of r.faceBlendshapes?.[0]?.categories || []) blend[c.categoryName] = c.score;
          out.face = { blend, matrix: r.facialTransformationMatrixes?.[0]?.data ? Float32Array.from(r.facialTransformationMatrixes[0].data) : null, landmarks: pts };
        }
      }
      if (hands) {
        const r = hands.detectForVideo(frame, ts);
        // handedness is labelled as if the picture were mirrored; ../tracking/hands.js sorts that out
        out.hands = (r.landmarks || []).map((l, i) => ({ label: r.handedness?.[i]?.[0]?.categoryName || '', score: r.handedness?.[i]?.[0]?.score ?? 1, pts: l.map((p) => [p.x, p.y, p.z]), world: r.worldLandmarks?.[i]?.map((p) => [p.x, p.y, p.z]) || null }));
      }
      frame.close?.();
      self.postMessage(out);
    }
  } catch (e) {
    data.frame?.close?.();
    self.postMessage({ t: 'error', message: String(e?.message || e) });
  }
};
