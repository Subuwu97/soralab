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
- **Admin**: for Mirai admins. Usage, people, the render encoder, live render jobs, the storage cleanup and Live2D's Cubism Core.

## Working with projects

- **Saving:** projects save automatically, keep a version history (with named versions), and can be duplicated, starred and trashed.
- **Sharing:** share a project with other Mirai users as viewer, commenter or editor, and leave comments. People you share with can open every photo, clip and file the project uses.
- **Minami Cloud:** open files from Cloud, save exports to Cloud, or pick a Cloud folder as the destination of a render.
- **Tsunami:** video exports can be published straight to your Tsunami channel.
- **Exports:**
  - Image, vector, layout and PDF exports are made in your browser.
  - Video, audio and conversions are rendered on the server with ffmpeg. They use the same GPU detection as Tsunami (NVIDIA NVENC, Intel Quick Sync, AMD AMF, VA-API on Linux, Apple VideoToolbox), and fall back to the CPU if the GPU fails partway.
- **Notifications:** finished renders and shares show up in the suite's notification bell.
- **Storage cleanup:** some editors save their working files as they go. Sora Kōsaku and Sora Paint store each changed layer as a new PNG, Sora Audio keeps each edited take, and Sora Eizō renders its titles to PNGs. The old copies are cleaned up:
  - A file is removed only when all of these hold:
    - an editor saved it for itself (marked *autosave*), or it's a project's file from before that marking existed;
    - it isn't an export, kept in Files, or used by a library item;
    - no project uses it: not the current contents of any project (anyone's, including shared projects and the trash), nor any kept version of one;
    - it's older than the grace period (24 hours), counted from when it was made and from the last save that used it, so saves in progress and layers that Undo may bring back are never touched.
  - It runs a few minutes after the server starts and then every 6 hours, and logs every file it removes.
  - **Admin** shows the unused storage (files and MB), the last run, and *Clean up now*.
  - In **Files**, the storage breakdown shows your own unused files and *Free up space*.
  - API: `GET /api/storage/unused`, `POST /api/storage/cleanup`, and for admins `GET /api/admin/storage` and `POST /api/admin/storage/cleanup`. Send `{ "dry_run": true }` to list what would go without removing anything.
  - Deleting a project for good keeps the files that another project (a duplicate, say) still uses.

## Sora Ningyō (VTuber avatars)

Sora Ningyō (人形, "puppet") makes and performs VTuber avatars. New projects start as one of three kinds:

- **2D avatar (from a PSD):** SoraLab's own open rig, in the style of Live2D Cubism.
  - Import a layered PSD (or loose PNGs): every layer becomes a part in place, PSD groups become part groups, clipping layers become clipping masks. Layer names like "Eye L white", "Iris R", "Mouth upper" or 前髪 are recognised, and a checklist shows which face parts are still missing.
  - Separate layers: split a part with the lasso, auto-crop, and "fill behind" (paint where hidden colour is needed, e.g. skin under the hair; the edge colours grow into it).
  - Meshes are made automatically from each part's outline (adjustable density). Add, move, delete and pin vertices.
  - Warp (grid) and rotation deformers in a hierarchy, and parameters (ParamAngleX/Y/Z, ParamEyeLOpen, ParamMouthOpenY, ParamBreath…) with keyforms: at each key value, record vertex and deformer positions, opacity and draw order. Up to two parameters combine in a grid, like Cubism. Mirror a keyform to the opposite key, or copy it to the part on the other side.
  - **Auto-rig face** sets up head angles, blinking, eyeballs, brows, mouth open and smile, breathing and hair sway as a starting point.
    If there are layers named for arms and hands ("Upper arm L", "Forearm R", "Hand L", 腕, 手…, also in the checklist), it adds
    rotation deformers at the shoulder, elbow and wrist on the arm parameters (ParamArmLA/RA upper arm, ParamArmLB/RB forearm,
    ParamHandL/R wrist). Hand layers named for a gesture ("Hand L peace", "fist", "point", "thumb") swap in while that gesture is seen.
  - Pendulum physics for hair and accessories, expressions (sets of parameter overrides), and the tracking → parameter table. Hand
    tracking adds rows for the arm angles, wrist, hand closed, peace / point / thumbs-up weights and hand X/Y (ParamHandLX/LY…);
    they read 0 when a hand isn't seen.
  - Export a PNG, a `.sora-avatar` file (the rig as JSON plus PNG textures, zipped), or an Inochi2D puppet (`.inp`; deformers are baked into per-key mesh offsets, physics and expressions aren't carried over). Live2D's own `.moc3`/`.cmo3` formats are proprietary, so SoraLab can't write them.
- **Open a Live2D model:** import a Cubism model (a zip of its folder, or its `.model3.json`, `.moc3`, textures, motions, expressions, pose and physics). Tracking drives the standard Cubism parameters. Playback follows the published behaviour of Live2D's open-source Cubism Framework:
  - **Physics** from `.physics3.json`.
  - **Motions** (`.motion3.json`):
    - Each motion fades in and out (the model3.json's `FadeInTime` / `FadeOutTime`, else the motion's own, else 1 s), and curves can have their own fades.
    - Starting a motion crossfades from the one playing.
    - Priorities work as in Cubism: Idle, then Normal (starts only when nothing of its priority or higher plays), then Force (always starts).
    - The idle group plays a random motion whenever nothing else does. Choose the idle group in Edit, or turn it off.
    - Perform lists every motion with a ▶ button and a hotkey. *Interrupt* plays it as Force; *If free* plays it as Normal. Hotkeys reach the OBS output too.
  - **Expressions** (`.exp3.json`):
    - `Add`, `Multiply` and `Overwrite` blending.
    - Each expression fades in and out over its own `FadeInTime` / `FadeOutTime` (1 s if not set). Turning one off fades it out.
    - Several can be on at once. Where two set the same parameter, the one turned on later wins.
  - **Pose** (`.pose3.json`):
    - In each group of parts, only one shows (say, arms down or arms up).
    - Motions choose which one with their PartOpacity curves. It fades in over the pose's `FadeInTime` (0.5 s if not set) while the others fade out along Cubism's curve, which never lets more than 15 % of the background show through.
    - Linked parts follow their part.
  - Live2D's **Cubism Core** (`live2dcubismcore.min.js`) can't be included with SoraLab. A server admin downloads the Cubism SDK for Web from Live2D, accepts its licence, and uploads `Core/live2dcubismcore.min.js`, either on the **Admin** page or from any Live2D project. Admin shows whether it's installed, its version and size, and can replace or remove it. It is stored on the server (`data/avatar/`) and served only to signed-in people and to OBS output links.
- **3D avatar (VRM):** a VRM, glTF / GLB or FBX model set up for VTubing (see *3D avatars* below).

**Perform** mode works the same for every kind:
- Webcam face tracking in the browser with MediaPipe Face Landmarker (blendshapes and head pose), in a background worker. Nothing leaves your computer.
- **Hand tracking** (Sources → "Track hands too"; off by default because it roughly doubles the tracking work) uses MediaPipe Hand
  Landmarker in the same worker:
  - Left and right are sorted out (MediaPipe labels hands as if the picture were mirrored), with a confidence threshold and the
    same One Euro smoothing as the face (plus a "Hand steadiness" setting).
  - A lost hand holds its pose briefly (longer when tracking runs slowly), then eases back to rest.
  - Each hand gives its wrist position relative to the shoulders (estimated from the face), wrist rotation, per-finger curl and
    spread, and a gesture: open, fist, peace, thumbs up, point, or wave (detected over time). The camera preview draws the hands.
  - 3D avatars reach with their arms, 2D rigs move the arm parameters, and Live2D models can bind the same values.
- **Gesture triggers:** any expression can be turned on by a gesture of either hand or a chosen hand, while it's shown or as a
  toggle. Set this next to its hotkey in Perform, or in the 2D / 3D expression panels. It's saved in the project.
- "Set neutral" calibration; per value sensitivity, dead zone, range, invert and smoothing (One Euro filter), all saved with the project. Breathing is added automatically.
- No camera? A mouse/keyboard puppet (the mouse moves the head and eyes, hold the button to talk, B blinks), and mic lip-sync (loudness opens the mouth, vowel shapes from the voice).
- Expression hotkeys (toggle or hold) and gesture triggers, a background colour, chroma green or transparent, PNG snapshots and WebM recording (with transparency).
- **OBS:** copy the output link into an OBS *Browser Source*. The page has a transparent background and follows the Perform page live through a small WebSocket relay on the SoraLab server (about 30 poses a second, rate-limited). The link holds a random key, which the owner can reset; it needs no sign-in. "Pop-out window" opens the same view in a window for *Window Capture*.
- **Go live on Tsunami** (needs the Mirai suite: `TSUNAMI_URL` and `SUITE_SECRET`; the panel is hidden without them): stream the avatar straight to Tsunami Live from the browser, no OBS needed.
  - Choose the channel (your own or a brand channel you own), the title, Public / Unlisted / Private, live chat on or off, and 720p (3 Mbps) or 1080p (6 Mbps), 30 fps.
  - Video can't be transparent, so the avatar is drawn on a background: a colour or a picture from your files. The panel shows what viewers see, and the stage shows the same background while you're live.
  - Sound: your mic (on/off and which mic; both can change while live) and, if you like, the sound of a tab or the whole desktop ("Add tab or desktop sound…", then tick *Share audio* in the browser's dialog).
  - While live: a timer, the bitrate and frame rate, dropped frames, a health light (Good / Unsteady / Poor) and a link to the live page on Tsunami. *End stream* ends it on Tsunami, and the recording becomes a video there as usual.
  - How it works: the page records the picture and sound with MediaRecorder (WebM, or H.264 where the browser has it) and sends it over a WebSocket to the SoraLab server. There ffmpeg re-encodes it to H.264/AAC (on the GPU when there is one, like renders; H.264 from the browser is sent as it is) with a keyframe every 2 s, and pushes it to Tsunami's RTMP ingest with a one-time stream key from Tsunami. So the channel's own OBS key never leaves Tsunami, and Tsunami's usual checks (suspended channels, live streaming turned off) apply.
  - Only editors of the project can stream it, and each person can run one stream at a time. If anything stops it (the encoder, the network, Tsunami, a closed tab), the panel says why in plain words.
  - Keep the tab visible while you're live: browsers pause drawing in background tabs, and the stream would freeze.

**Your avatar as a camera in Hikari:** with the suite, Hikari's Settings → Voice & Video → *Camera source* can send a Sora Ningyō avatar instead of your webcam.
- Hikari lists your own avatar projects (it asks SoraLab with your sign-in, which works because both apps are on the same host). You can also paste an avatar's output link.
- The avatar runs inside Hikari's page from SoraLab's embeddable module, `/embed/ningyo.js`. Hikari passes it the webcam, which is used only for face (and optional hand) tracking on your device. The call gets the avatar drawn on a canvas, never the camera picture.
- The project's own tracking settings, neutral pose, framing and gesture triggers apply. The avatar and its files load through the project's output key, as with the OBS link, so resetting that key stops Hikari using it too.
- Video can't be see-through, so the avatar stands on a solid colour or on "room colours" (the camera shrunk to a few pixels and blurred, so nothing in it can be recognised).
- For developers: `const { mount } = await import('<SoraLab>/embed/ningyo.js')`, then `mount({ canvas, link | projectId + key, video, onStatus, background, hands })`. It returns `{ stream, setBackground, setSize, stats, dispose }`, where `stream` is `canvas.captureStream(30)`. The module is a second Vite build (see `web/vite.config.js`) into `dist/embed/`. Its chunks, worker and wasm resolve against the module's own address, so they load from SoraLab wherever it's imported.
- Only the origins in `SUITE_ORIGINS` (written by the suite's setup) can load the module, its files, the models and the key routes, or call `GET /api/avatar/mine`. That endpoint returns your avatar projects with their output keys. It is owner-only and needs credentials. Other sites are refused.

The face and hand models (`web/public/models/`, Apache 2.0, about 11.5 MB) and the MediaPipe runtime come with SoraLab, so tracking works on a home network without internet. See `web/public/models/NOTICE.txt`.

### 3D avatars

A 3D project is a VRM, glTF / GLB or FBX model that you set up for VTubing, much like VRoid Studio's export settings plus VSeeFace's
avatar setup. The model file stays in Files as an asset. The project keeps the asset id and your changes, so a 50 MB VRM isn't copied
into every save. The tabs on the left of the 3D editor are:

- **Model.** Import a model (VRM 0.x or 1.0, glTF / GLB or FBX), or choose one from Files. For a .gltf or .fbx with separate textures,
  pick the model and its texture files together. You can also start from the **starter avatar**, a simple stylised figure built in code.
  It has a skeleton (with finger bones), blink and mouth shapes, emotions and spring-bone hair, and you can change its colours and hair length. FBX files
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
  - **Hands and arms:** with hand tracking on, a two-bone IK moves the upper arm and forearm so the wrist reaches the tracked
    position. Elbows point down, a little out and back, and hands are kept out of the torso and head. Wrists turn (within a
    wrist's range), and finger bones curl and spread on models that have them; the starter avatar has finger bones. A lost hand
    eases back to the relaxed arms-down idle pose. *Reach* and *Finger curl* sliders, and test hands (open, fist, peace,
    thumbs up, point, wave) in *Try a pose*.
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
| `TSUNAMI_RTMP_URL` | Tsunami's RTMP ingest for Sora Ningyō's *Go live*, e.g. `rtmp://127.0.0.1:1935/live`. The suite's setup writes it. If it's empty, SoraLab uses Tsunami's internal host and the RTMP port Tsunami reports. |
| `DATA_DIR` | Where projects, uploads, fonts and the database are kept (default `server/data`). |
| `MAX_UPLOAD_MB`, `MAX_DOC_MB` | Largest upload (default 4096 MB) and largest saved project (default 512 MB). |
| `STORAGE_GB_PER_USER` | Storage limit per person. `0` means no limit. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | ffmpeg and ffprobe, if they aren't on the PATH. |
| `VIDEO_ENCODER` | `auto` (default) picks the GPU encoder if one works. You can also choose `nvenc`, `qsv`, `amf`, `vaapi`, `videotoolbox` or `cpu`. |
| `RENDER_JOBS` | How many renders run at the same time (default 1). |
| `VERSIONS_PER_DOC` | Automatic versions kept per project (default 50; named versions are always kept). |
| `CLEANUP_EVERY_HOURS`, `CLEANUP_GRACE_HOURS` | Storage cleanup: how often it runs (default 6; `0` = only from Admin or Files) and how old an unused autosaved file must be before it goes (default 24, at least 1). |
| `SUITE_ORIGINS` (or `HIKARI_URL`) | Comma-separated web addresses of suite apps whose pages may use Sora Ningyō avatars, for Hikari's avatar camera. The suite's setup writes Hikari's address, its http:// network address and its localhost ports. Leave it empty to allow none. |
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
