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
