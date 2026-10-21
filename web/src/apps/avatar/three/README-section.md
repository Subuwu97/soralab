### 3D avatars

A 3D project is a VRM, glTF / GLB or FBX model that you set up for VTubing, much like VRoid Studio's export settings plus VSeeFace's
avatar setup. The model file stays in Files as an asset. The project keeps the asset id and your changes, so a 50 MB VRM isn't copied
into every save. The tabs on the left of the 3D editor are:

- **Model.** Import a model (VRM 0.x or 1.0, glTF / GLB or FBX), or choose one from Files. For a .gltf or .fbx with separate textures,
  pick the model and its texture files together. You can also start from the **starter avatar**, a simple stylised figure built in code.
  It has a skeleton, blink and mouth shapes, emotions and spring-bone hair, and you can change its colours and hair length. FBX files
  in centimetres are scaled to a person's height automatically. VRM 0.x models are turned to face forward, as in VRM 1.0.
- **Rig & bones.**
  - *Humanoid bones:* a table maps the VRM humanoid bones to the model's bones. Auto-map reads Mixamo, VRoid, Blender / Rigify, Unity
    and 3ds Max names, and works out the spine and fingers from the bone chain. You can fix a bone from its list, or click its joint in
    the skeleton view.
  - *Auto-rig* for meshes with no skeleton: drag the pink markers onto the chin, shoulders, elbows, wrists, hips, knees and ankles (left
    and right are mirrored), then build the skeleton. Skin weights come from bone heat: inverse-distance weights over the bones each
    vertex can "see", smoothed with a few dozen heat-diffusion sweeps.
  - *Weight paint:* Add, Remove and Smooth brushes, with a bend test. Painted or auto-rigged weights are saved as a new GLB in Files.
    Undo brings back the old one.
- **Expressions.**
  - All the VRM presets: happy, angry, sad, relaxed, surprised, aa / ih / ou / ee / oh, blink / blinkLeft / blinkRight,
    lookUp / Down / Left / Right and neutral.
  - Custom expressions. Each one moves one or more shapes (morph targets) by a weight, can be on/off only, and can block or fade
    blinking, mouth shapes and eye look while it's on.
  - Drag a row to preview it.
  - Empty presets can be filled in by guessing from shape names (VRoid `Fcl_*`, VRChat visemes, MMD, ARKit).
  - **Perfect sync:** models with the 52 ARKit shapes have them driven straight from face tracking (Auto turns this on at 40 or more).
- **Spring bones.**
  - Chains for hair, skirts, ears and tails, with stiffness, gravity (power and direction), drag and hit radius, plus presets.
  - Add chains from a bone (one chain per branch), or let the editor find bones named like hair / skirt / ears / tail.
  - Sphere and capsule colliders sit on bones and are grouped. "Body set" adds head, chest, hips, arm and thigh colliders sized to the
    avatar.
  - **Wiggle** shakes the head to test the springs.
- **Look & materials.**
  - Each material can stay as it is or become MToon (toon), Unlit or Standard.
  - You can change its colour, shade colour, toon sharpness and shade amount, outline width and colour, rim light, glow, and swap its
    texture for an image from Files.
  - Lighting presets (Studio, Soft, Sunset, Night, Flat), brightness, and room reflections for Standard materials.
- **Tracking.**
  - A head turn is shared between the head, neck and upper body.
  - Also set here: body lean, leaning with head position, gaze through eye bones or the look expressions, blink thresholds, mouth,
    smile → happy, and eyebrows (custom `browUp` / `browDown` expressions, or a touch of surprised / angry).
  - T-posed arms are lowered automatically.
  - When tracking is lost, the avatar breathes, sways and blinks on its own.
  - **Try a pose** has sliders for testing without a camera.
  - These settings are saved in the project as `doc.drive`. The tracker's own per-key tuning and mirroring stay in `doc.tracking`.
  - Hands aren't driven yet.
- **Stage camera.** Face, bust-up, waist-up, full body, or the current view, with zoom, offset, turn and lens. Perform and the OBS output
  use this framing, with Perform's own zoom on top.
- **Info & licence.** The VRM 1.0 meta: name, authors, version, copyright, contact, references, and the licence choices (avatar use,
  commercial use, credit, modification, redistribution, violent / sexual / political / antisocial use, other licence URL), plus a
  thumbnail. If you don't choose a thumbnail, export uses a bust-up snapshot.

**Export** (File → Export):

- **VRM 1.0** with humanoid, expressions, look-at, spring bones, colliders, MToon materials and meta. Three-vrm can't write VRM, so
  SoraLab writes the `VRMC_vrm`, `VRMC_springBone` and `VRMC_materials_mtoon` extensions itself on top of three.js's GLTFExporter.
  Each export is checked by loading it back with three-vrm. A toast says how many bones, expressions and spring joints came back.
  VRM 0.x models are exported as 1.0, and the open-ended 0.x spring chains get tail nodes.
- **GLB / glTF.**
- **PNG snapshot** in any framing, optionally with a transparent background.

The stage (`createStage3D`) is used for Perform and the OBS browser source. It has:

- a transparent (premultiplied) or coloured background
- poses eased between tracking frames
- `pose.expr` hotkey expressions
- `setFraming()`, `expressions()`, `snapshot()` (PNG) and `setDoc()`

three.js and three-vrm only load when a 3D project, stage or export needs them, and GPU memory is freed when the editor or stage closes.

**Where it's approximate:**

- Auto-rig visibility is checked on a voxel grid at about 1% of the avatar's height, so very thin, touching parts can share weights.
- Fingers aren't rigged; each hand is one bone.
- The heat solve is a few dozen sweeps, not a full solve.
- Expression material-colour and UV binds from a VRM file play in SoraLab but aren't written back on export.
- Node constraints and first-person settings from a VRM file aren't exported.
- Spring settings are per chain: a VRM with different settings per joint keeps the first joint's.
- No VRM 0.x export.

**Libraries:** [three.js](https://threejs.org) 0.186 (MIT) and [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) 3.5 (MIT).
No third-party models ship with SoraLab. The starter avatar is generated in code.
