// Sora Ningyō (the VTuber avatar app): what its parts agree on. The app shell, the 2D rig and face tracking live in this
// folder; the 3D side lives in ./three/ and plugs in through the interface below.

/**
 * A project's saved document: { version: 1, kind: '2d' | '3d' | 'live2d', name, ... }
 *   '2d'     — our own open rig (layers, meshes, deformers, parameters, physics), see ./two/
 *   'live2d' — an imported Cubism model (.model3.json + .moc3 and textures, kept as assets), played with Cubism Core
 *              that the person adds themselves (it can't ship with SoraLab)
 *   '3d'     — a VRM / glTF avatar plus our edits (expressions, spring bones, materials, tracking mapping), see ./three/
 * Every kind also keeps doc.tracking (the tracker's settings, ./tracking/pose.js) and doc.perform (./Perform.jsx):
 * background, framing, output size, expression hotkeys { exprId: { key, mode } } and hand-gesture triggers
 * { exprId: { gesture, hand: 'any' | 'L' | 'R', mode: 'hold' | 'toggle' } } (gesture names: see HAND_KEYS below).
 */
export const KINDS = ['2d', 'live2d', '3d'];

/**
 * Tracking output, produced every frame by ./tracking/ (webcam face, plus hands where enabled, see HAND_KEYS) and
 * consumed by every renderer. Expressions turned on by hotkeys or hand gestures arrive as pose.expr = { id: weight }. Angles in degrees, everything else 0..1 unless noted. Missing values mean "not tracked".
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
 * Hands (only when hand tracking is on in Perform, see ./tracking/hands.js). Sides are the AVATAR's: with mirroring on
 * (the default) the person's right hand is handL. Screen space: x toward the screen's right (= the avatar's left),
 * y up, z toward the viewer. Positions are in arm lengths (shoulder to wrist) from the middle of the shoulders, so each
 * renderer scales them to its own avatar; the hanging rest position of handL is about { x: 0.34, y: -1, z: 0.05 }.
 *
 *   pose.handL = pose.handR = {
 *     visible,             0..1: 1 while seen; held ~0.3 s after the hand is lost, then eases to 0 (blend to rest by it)
 *     tracked,             seen this moment
 *     x, y, z,             wrist position (arm lengths, see above)
 *     rotX, rotY, rotZ,    degrees: rotZ fingers leaning toward the screen's right (0 = pointing up), rotX fingers toward
 *                          the viewer, rotY the thumb side turning toward the viewer
 *     dir: [x, y, z],      unit vector wrist → middle knuckle (where the fingers point), and
 *     side: [x, y, z],     unit vector toward the thumb side (little-finger knuckle → index knuckle), at right angles to dir
 *     curl: [thumb, index, middle, ring, little],   0 straight .. 1 fully bent
 *     spread,              0 fingers together .. 1 wide apart
 *     gesture,             'open' | 'fist' | 'peace' | 'thumbsUp' | 'point' | 'wave' | 'none' (wave is detected over time)
 *     armA, armB, wrist,   a flat 2D arm solved in the screen plane (degrees, outward positive for both sides):
 *                          upper arm from hanging down, forearm from the upper arm's line, hand from the forearm's line
 *   }
 * The same values as flat numbers for parameter bindings (2D rigs, Live2D), already eased to rest by `visible`
 * (so they read 0 when the hand isn't there):
 */
export const HAND_KEYS = ['L', 'R'].flatMap((S) => [
  `arm${S}A`, `arm${S}B`,                    // degrees: upper arm, forearm (see armA/armB above)
  `hand${S}Angle`,                           // degrees: wrist turn from the forearm's line
  `hand${S}X`, `hand${S}Y`, `hand${S}Z`,     // wrist offset from its hanging rest position, arm lengths (~−1..1)
  `hand${S}Fist`, `hand${S}Spread`,          // 0..1: mean curl of the four fingers; spread
  `hand${S}Peace`, `hand${S}Point`, `hand${S}ThumbUp`, `hand${S}Wave`, // 0..1 gesture weights (eased)
  `hand${S}Visible`,                         // 0..1
]);

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
