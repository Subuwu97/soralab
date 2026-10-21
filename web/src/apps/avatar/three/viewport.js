// A WebGL view of an avatar: renderer, camera, lighting presets, optional room environment, framing presets
// (face / bust-up / waist-up / full body / custom), transparent background and PNG snapshots. The editor adds orbit
// controls and helpers on top; the stage (OBS / Perform output) uses it as is.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class Viewport {
  constructor(canvas, { alpha = false } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    this.camera.position.set(0, 1.4, 2);
    this.target = new THREE.Vector3(0, 1.3, 0);
    this.lights = new THREE.Group();
    this.scene.add(this.lights);
    this.helpers = new THREE.Group(); // editor overlays, never exported
    this.scene.add(this.helpers);
    this.alpha = alpha;
    this.bg = null;
    this.setBackground(alpha ? null : '#2b2f3a');
    this.setLook({});
    this.width = 1; this.height = 1;
  }

  setBackground(css) {
    this.bg = css;
    const c = parseColor(css);
    if (c) { this.renderer.setClearColor(c, 1); this.canvas.style.background = ''; }
    else {
      // Transparent (OBS keys nothing — the browser source composites the alpha), or a CSS background behind it.
      this.renderer.setClearColor(0x000000, 0);
      this.canvas.style.background = css || '';
    }
  }

  setLook(look) {
    const key = JSON.stringify([look.light, look.env, look.exposure]);
    if (key === this.lookKey) return;
    this.lookKey = key;
    this.lights.clear();
    const ex = look.exposure ?? 1; // no tone mapping (it washes out toon shading), so exposure scales the lights
    const L = (type, color, i, pos) => {
      const intensity = i * ex;
      const l = type === 'dir' ? new THREE.DirectionalLight(color, intensity) : type === 'hemi' ? new THREE.HemisphereLight(color, pos, intensity) : new THREE.AmbientLight(color, intensity);
      if (type === 'dir') { l.position.set(...pos); this.lights.add(l.target); }
      this.lights.add(l);
    };
    switch (look.light || 'studio') {
      case 'soft': L('hemi', '#ffffff', 1.6, '#8a8fa6'); L('dir', '#ffffff', 1.2, [0.5, 2, 3]); break;
      case 'sunset': L('amb', '#6d5a8a', 0.8); L('dir', '#ffb27a', 2.6, [2.5, 1.6, 2]); L('dir', '#7aa6ff', 0.9, [-2.5, 1.2, 1]); L('dir', '#ff7ab8', 1.4, [0, 2, -3]); break;
      case 'night': L('amb', '#3a4170', 0.9); L('dir', '#a9bcff', 1.3, [1, 2, 2.5]); L('dir', '#c48bff', 2.2, [-1.5, 1.5, -2.5]); break;
      case 'flat': L('amb', '#ffffff', 2.2); L('dir', '#ffffff', 0.6, [0, 1, 3]); break;
      default: L('hemi', '#ffffff', 1.0, '#565c74'); L('dir', '#fff6ec', 2.4, [1.2, 2.2, 2.4]); L('dir', '#d6e4ff', 0.8, [-2, 1.2, 1.5]); L('dir', '#ffffff', 1.3, [0, 2.5, -3]);
    }
    if (look.env && !this.envTex) {
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    this.scene.environment = look.env ? this.envTex : null;
    this.scene.environmentIntensity = 0.6 * ex;
  }

  resize(w, h, dpr) {
    this.width = Math.max(1, Math.round(w)); this.height = Math.max(1, Math.round(h));
    if (dpr) this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Places the camera for a framing preset, using the avatar's head and feet. cam = doc.camera
   * ({ framing, fov, zoom, x, y, turn, custom: { position, target } }).
   */
  frame(avatar, cam = {}) {
    const c = this.camera;
    c.fov = cam.fov || 30;
    if (cam.framing === 'custom' && cam.custom) {
      c.position.fromArray(cam.custom.position); this.target.fromArray(cam.custom.target);
      c.lookAt(this.target); c.updateProjectionMatrix();
      return;
    }
    const f = framingBox(avatar, cam.framing || 'bust');
    const zoom = cam.zoom || 1;
    const halfH = f.height / 2 / zoom;
    const fit = Math.max(halfH, (f.width / 2 / zoom) / Math.max(0.3, c.aspect));
    const dist = fit / Math.tan((c.fov * Math.PI) / 360);
    const turn = ((cam.turn || 0) * Math.PI) / 180;
    this.target.set(f.center.x + (cam.x || 0) * f.height, f.center.y + (cam.y || 0) * f.height, f.center.z);
    c.position.set(this.target.x + Math.sin(turn) * dist, this.target.y, this.target.z + Math.cos(turn) * dist);
    c.near = Math.max(0.01, dist / 100); c.far = dist * 50;
    c.lookAt(this.target);
    c.updateProjectionMatrix();
  }

  render() { this.renderer.render(this.scene, this.camera); }

  /** PNG of the current view. Renders and reads in the same task, so no preserveDrawingBuffer is needed. */
  snapshot({ width, height, type = 'image/png' } = {}) {
    const w0 = this.width; const h0 = this.height; const dpr = this.renderer.getPixelRatio();
    if (width && height) this.resize(width, height, 1);
    this.render();
    const p = new Promise((resolve, reject) => this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t make the image.'))), type));
    if (width && height) { this.resize(w0, h0, dpr); this.render(); }
    return p;
  }

  /** loseContext: also drop the WebGL context — only for canvases we made (a page's canvas may get a new stage). */
  dispose({ loseContext = false } = {}) {
    this.envTex?.dispose();
    this.renderer.dispose();
    if (loseContext) this.renderer.forceContextLoss?.();
  }
}

/** The box a framing preset shows, from humanoid bones when there are any, else the bounding box. */
export function framingBox(avatar, framing) {
  const H = avatar?.height || 1.6;
  const box = avatar?.box || new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.2), new THREE.Vector3(0.3, 1.6, 0.2));
  const cx = (box.min.x + box.max.x) / 2; const cz = (box.min.z + box.max.z) / 2;
  const headNode = avatar?.humanoid?.getRawBoneNode('head');
  const head = headNode ? headNode.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(cx, box.max.y - H * 0.1, cz);
  const top = box.max.y;
  const headTop = Math.max(head.y + H * 0.05, top);
  const faceZ = head.z + H * 0.02;
  switch (framing) {
    case 'face': return { center: new THREE.Vector3(head.x, (head.y + headTop) / 2, faceZ), height: (headTop - head.y) * 1.7, width: H * 0.2 };
    case 'waist': { const lo = box.min.y + H * 0.42; return { center: new THREE.Vector3(cx, (lo + headTop) / 2, cz), height: (headTop - lo) * 1.12, width: H * 0.45 }; }
    case 'full': return { center: new THREE.Vector3(cx, (box.min.y + top) / 2, cz), height: H * 1.08, width: (box.max.x - box.min.x) * 0.8 };
    default: { const lo = head.y - H * 0.2; return { center: new THREE.Vector3(head.x, (lo + headTop) / 2 + H * 0.005, cz), height: (headTop - lo) * 1.15, width: H * 0.32 }; }
  }
}

function parseColor(css) {
  if (!css || typeof css !== 'string') return null;
  if (!/^(#[0-9a-f]{3,8}|rgb\(|hsl\(|[a-z]+$)/i.test(css.trim()) || /transparent|none/i.test(css)) return null;
  try { const c = new THREE.Color(); c.setStyle(css.trim()); return c; } catch { return null; }
}
