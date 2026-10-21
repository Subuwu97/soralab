# SoraLab by Mirai Creative Suite

SoraLab (空, "sky") is a set of creative apps that run in the browser on your own server: photo editing, illustration, video, motion graphics, layout, interface design, animation, audio and PDF. It is part of the [Mirai suite](https://github.com/Subuwu97/mirai), kept in its own repo. You sign in with your Mirai Account.

## The apps

| App | For | Like |
|---|---|---|
| **Sora Kōsaku** | Image crafting: layers, masks, adjustment layers, selections, retouching, filters, text | Photoshop |
| **Sora Eshi** | Illustration: pen and shapes, Pathfinder, gradients, symbols, artboards, text on a path | Illustrator |
| **Sora Hikari** | Photo/light management: library with ratings and collections, develop sliders, curves, masks, presets, batch export | Lightroom |
| **Sora Eizō** | Video editing: multitrack timeline, trimming tools, titles, transitions, keyframes, colour, audio mixing | Premiere Pro |
| **Sora Ugoki** | Motion graphics: keyframes with easing and expressions, shapes with trim paths, text animators, track mattes, templates | After Effects |
| **Sora ANI** | Animation: frame-by-frame drawing, onion skin, classic and shape tweens, symbols | Animate |
| **Sora Ningyō** | VTuber avatars: rig a 2D avatar from a PSD, set up a 3D VRM, or play a Live2D model, then perform it live with your webcam and stream it to OBS | Live2D Cubism / VRoid |
| **Sora Keishiki** | Layout/publishing: pages, parent pages, threaded text frames, paragraph and character styles, text wrap | InDesign |
| **Sora UI/UX** | Interface design: device screens, components, repeat grids, clickable prototypes with a shareable preview | XD |
| **Sora Paint** | Digital painting: pressure-sensitive brushes, smudge, symmetry, canvas rotation, time-lapse | Fresco |
| **Sora Express** | Quick designs from templates: social posts, flyers, thumbnails, invites, "Resize for…" | Adobe Express |
| **Sora PDF** | Read, highlight, comment, fill forms, sign, redact, organise, merge and split PDFs | Acrobat |
| **Sora Audio** | Multitrack recording and mixing, effects, noise reduction, spectrogram, loudness matching | Audition |
| **Sora Encoder** | Convert video and audio in batches with presets; the render queue | Media Encoder |

Around them:
- **Files**: every project, upload and export in one place, with previews, "Open in…" any app, and Save to Minami Cloud or publish to Tsunami.
- **Libraries**: colours, gradients, text styles and graphics to reuse across apps.
- **Fonts**: 14 built-in families, plus fonts you upload.
- **Color**: harmony rules, colours from photos, a contrast checker and a colour-blindness preview.
- **Admin**: for Mirai admins. Usage, people, the render encoder and live render jobs.

## Working with projects

- **Saving:** projects save automatically, keep a version history (with named versions), and can be duplicated, starred and trashed.
- **Sharing:** share a project with other Mirai users as viewer, commenter or editor, and leave comments. People you share with can open every photo, clip and file the project uses.
- **Minami Cloud:** open files from Cloud, save exports to Cloud, or pick a Cloud folder as the destination of a render.
- **Tsunami:** video exports can be published straight to your Tsunami channel.
- **Exports:**
  - Image, vector, layout and PDF exports are made in your browser.
  - Video, audio and conversions are rendered on the server with ffmpeg. They use the same GPU detection as Tsunami (NVIDIA NVENC, Intel Quick Sync, AMD AMF, VA-API on Linux, Apple VideoToolbox), and fall back to the CPU if the GPU fails partway.
- **Notifications:** finished renders and shares show up in the suite's notification bell.

## Sora Ningyō (VTuber avatars)

Sora Ningyō (人形, "puppet") makes and performs VTuber avatars. New projects start as one of three kinds:

- **2D avatar (from a PSD):** SoraLab's own open rig, in the style of Live2D Cubism.
  - Import a layered PSD (or loose PNGs): every layer becomes a part in place, PSD groups become part groups, clipping layers become clipping masks. Layer names like "Eye L white", "Iris R", "Mouth upper" or 前髪 are recognised, and a checklist shows which face parts are still missing.
  - Separate layers: split a part with the lasso, auto-crop, and "fill behind" (paint where hidden colour is needed, e.g. skin under the hair; the edge colours grow into it).
  - Meshes are made automatically from each part's outline (adjustable density). Add, move, delete and pin vertices.
  - Warp (grid) and rotation deformers in a hierarchy, and parameters (ParamAngleX/Y/Z, ParamEyeLOpen, ParamMouthOpenY, ParamBreath…) with keyforms: at each key value, record vertex and deformer positions, opacity and draw order. Up to two parameters combine in a grid, like Cubism. Mirror a keyform to the opposite key, or copy it to the part on the other side.
  - **Auto-rig face** sets up head angles, blinking, eyeballs, brows, mouth open and smile, breathing and hair sway as a starting point.
  - Pendulum physics for hair and accessories, expressions (sets of parameter overrides), and the tracking → parameter table.
  - Export a PNG, a `.sora-avatar` file (the rig as JSON plus PNG textures, zipped), or an Inochi2D puppet (`.inp`; deformers are baked into per-key mesh offsets, physics and expressions aren't carried over). Live2D's own `.moc3`/`.cmo3` formats are proprietary, so SoraLab can't write them.
- **Open a Live2D model:** import a Cubism model (a zip of its folder, or its `.model3.json`, `.moc3`, textures, motions, expressions and physics). It plays with its own physics, expressions and idle motion, and tracking drives the standard Cubism parameters.
  - Live2D's **Cubism Core** (`live2dcubismcore.min.js`) can't be included with SoraLab. A server admin downloads the Cubism SDK for Web from Live2D, accepts its licence, and uploads `Core/live2dcubismcore.min.js` once from any Live2D project. It is stored on the server (`data/avatar/`) and served only to signed-in people and to OBS output links.
- **3D avatar (VRM):** a VRM, glTF / GLB or FBX model set up for VTubing (see *3D avatars* below).

**Perform** mode works the same for every kind:
- Webcam face tracking in the browser with MediaPipe Face Landmarker (blendshapes and head pose), in a background worker; optional hand tracking. Nothing leaves your computer.
- "Set neutral" calibration; per value sensitivity, dead zone, range, invert and smoothing (One Euro filter), all saved with the project. Breathing is added automatically.
- No camera? A mouse/keyboard puppet (the mouse moves the head and eyes, hold the button to talk, B blinks), and mic lip-sync (loudness opens the mouth, vowel shapes from the voice).
- Expression hotkeys (toggle or hold), a background colour, chroma green or transparent, PNG snapshots and WebM recording (with transparency).
- **OBS:** copy the output link into an OBS *Browser Source*. The page has a transparent background and follows the Perform page live through a small WebSocket relay on the SoraLab server (about 30 poses a second, rate-limited). The link holds a random key, which the owner can reset; it needs no sign-in. "Pop-out window" opens the same view in a window for *Window Capture*.

The face and hand models (`web/public/models/`, Apache 2.0, about 11.5 MB) and the MediaPipe runtime come with SoraLab, so tracking works on a home network without internet. See `web/public/models/NOTICE.txt`.

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

## With the Mirai suite (recommended)

Clone SoraLab **next to** the `mirai` folder and run the suite's setup again:

```
cd ..  &&  git clone https://github.com/Subuwu97/soralab  &&  cd mirai
npm run setup
npm start
```

What setup does:
- registers SoraLab with Mirai Account;
- writes `soralab/server/.env`;
- installs and builds SoraLab;
- includes it in `npm start`, `npm run dev`, `npm run backup` and every app's launcher.

SoraLab then runs on port **4800**. On your home network it's served on **https://&lt;server-ip&gt;:4843**, with the suite's own certificate, so microphone recording works on every device. See "HTTPS on your home network" in the Mirai README for trusting the certificate on phones and PCs.

## On its own

You need Node.js 20.19 or newer, and **ffmpeg** with ffprobe on the PATH for video and audio.

```
npm run install-all
npm run build
cp server/.env.example server/.env   # then fill it in, see below
npm start                            # http://localhost:4800
```

For development, run `npm run dev:server` and `npm run dev:web` (Vite on port 5180, which forwards `/api` and `/auth` to the server).

## Settings (`server/.env`)

| Variable | What it's for |
|---|---|
| `PORT`, `HOST`, `PUBLIC_URL` | Where SoraLab listens and the address people use. |
| `ACCOUNTS_URL`, `CLIENT_ID`, `CLIENT_SECRET` | Sign-in with Mirai Account (register the app with `node scripts/register-client.js` in `mirai/accounts`). |
| `SESSION_SECRET` | Signs sign-in cookies. Any long random string. |
| `SUITE_SECRET` | Shared with the suite. Turns on Minami Cloud, Tsunami publishing and notifications. |
| `CLOUD_URL`, `TSUNAMI_URL`, `PHOTOS_URL` | Where the other suite apps are. Leave these empty to turn those features off. |
| `DATA_DIR` | Where projects, uploads, fonts and the database are kept (default `server/data`). |
| `MAX_UPLOAD_MB`, `MAX_DOC_MB` | Largest upload (default 4096 MB) and largest saved project (default 512 MB). |
| `STORAGE_GB_PER_USER` | Storage limit per person. `0` means no limit. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | ffmpeg and ffprobe, if they aren't on the PATH. |
| `VIDEO_ENCODER` | `auto` (default) picks the GPU encoder if one works. You can also choose `nvenc`, `qsv`, `amf`, `vaapi`, `videotoolbox` or `cpu`. |
| `RENDER_JOBS` | How many renders run at the same time (default 1). |
| `VERSIONS_PER_DOC` | Automatic versions kept per project (default 50; named versions are always kept). |
| `HTTPS_PORT`, `TLS_CERT`, `TLS_KEY`, `LAN_CA_CERT` | HTTPS on your network. The suite's setup fills these in. |
| `COOKIE_SECURE`, `TRUST_PROXY` | Set both to `true` behind an HTTPS reverse proxy such as Caddy. |

Back up `DATA_DIR`. With the suite, `npm run backup` does it for you.

## Browsers

- **Recommended:** a current Chrome, Edge, Firefox or Safari.
- **Graphics:** Sora Hikari and Sora Ugoki use WebGL2 and WebCodecs where available.
- **Pen pressure and tilt:** work with any pointer-events stylus (Apple Pencil, Wacom, Surface Pen).

## Updating the shared suite pieces

SoraLab keeps its own copy of a few suite pieces in `suite/`: the notification client, the bell and the install helpers. That's what lets it build on its own. To refresh them from a Mirai checkout:

```
npm run sync-suite -- ../mirai
```

## Licence

GPL-3.0. Bundled fonts are under the SIL Open Font License.
