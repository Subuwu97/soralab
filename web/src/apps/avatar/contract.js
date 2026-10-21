// Sora Ningyō (the VTuber avatar app): what its parts agree on. The app shell, the 2D rig and face tracking live in this
// folder; the 3D side lives in ./three/ and plugs in through the interface below.

/**
 * A project's saved document: { version: 1, kind: '2d' | '3d' | 'live2d', name, ... }
 *   '2d'     — our own open rig (layers, meshes, deformers, parameters, physics), see ./two/
 *   'live2d' — an imported Cubism model (.model3.json + .moc3 and textures, kept as assets), played with Cubism Core
 *              that the person adds themselves (it can't ship with SoraLab)
 *   '3d'     — a VRM / glTF avatar plus our edits (expressions, spring bones, materials, tracking mapping), see ./three/
 */
export const KINDS = ['2d', 'live2d', '3d'];

/**
 * Tracking output, produced every frame by ./tracking/ (webcam face, plus hands where enabled) and consumed by every
 * renderer. Angles in degrees, everything else 0..1 unless noted. Missing values mean "not tracked".
 */
export const POSE_KEYS = [
  'headYaw', 'headPitch', 'headRoll',       // degrees, −30..30-ish
  'bodyYaw', 'bodyPitch', 'bodyRoll',       // degrees, derived from head + shoulders
  'headX', 'headY', 'headZ',                // position offsets, −1..1 (z: closer is positive)
  'eyeLOpen', 'eyeROpen',                   // 0 closed .. 1 open
  'eyeX', 'eyeY',                           // gaze, −1..1
  'browL', 'browR',                         // −1 down .. 1 up
  'mouthOpen', 'mouthForm',                 // 0..1; form −1 frown .. 1 smile
  'mouthA', 'mouthI', 'mouthU', 'mouthE', 'mouthO', // visemes from the mic or the face, 0..1
  'cheek', 'tongue',
  'breath',                                 // 0..1 idle breathing, generated
];
// The 52 ARKit / MediaPipe blendshape names are passed through too, as pose.blend = { eyeBlinkLeft: 0.3, ... },
// so 3D models with ARKit "perfect sync" shapes can use them directly.

/**
 * The 3D side's module (./three/index.jsx) exports:
 *   Editor3D({ project, history, canEdit })          — the editing workspace (import, rig/humanoid mapping, expressions,
 *                                                      spring bones, materials, tracking mapping), rendered inside the
 *                                                      app's EditorShell by ../index.jsx
 *   createStage3D(canvas, doc, { assetUrl })         — a renderer for performing/output: returns
 *                                                      { setPose(pose), resize(w, h), setBackground(css|null), snapshot(): Promise<Blob>, dispose() }
 *   empty3D(projectDoc)                              — a new empty '3d' document
 *   exportConfig3D({ getDoc, ... })                  — export formats for EditorShell (VRM, glTF, PNG)
 * The 2D side (./two/) exports the same shapes with 2D in the names, and the Live2D player (./live2d/) exports
 * createStageLive2D with the same stage interface.
 */
export const STAGE_METHODS = ['setPose', 'resize', 'setBackground', 'snapshot', 'dispose'];
