// Every SoraLab app: what it's called, what it's like, its tile colours, and the sizes offered when starting something new.
// Editors (doc: true) keep their work as SoraLab projects; tools work on files directly.
// Names and tiles follow the SoraLab brand sheet (tile = artwork in public/sora/; apps without one get a drawn tile).

const P = (label, width, height, extra = {}) => ({ label, width, height, ...extra });

export const APPS = [
  {
    id: 'photo', name: 'Sora Kōsaku', kana: 'ソラコウサク', role: 'Image crafting', tile: '/sora/tile-photo.png', letters: 'Sk', like: 'Photoshop', doc: true, colors: ['#0a2a4a', '#31a8ff'],
    tagline: 'Edit photos and compose images with layers, masks, selections and filters.',
    unit: 'px', presets: [
      P('Full HD', 1920, 1080), P('4K UHD', 3840, 2160), P('Instagram post', 1080, 1350), P('Square', 1080, 1080), P('Story / Reel', 1080, 1920),
      P('Tsunami thumbnail', 1280, 720), P('A4 @ 300 ppi', 2480, 3508), P('Letter @ 300 ppi', 2550, 3300), P('Web banner', 1500, 500),
    ],
  },
  {
    id: 'paint', name: 'Sora Paint', role: 'Digital painting', letters: 'Pt', like: 'Fresco', doc: true, colors: ['#3a1030', '#ff6fa8'],
    tagline: 'Draw and paint with pressure-sensitive brushes, watercolour, ink and layers.',
    unit: 'px', presets: [P('Sketch', 2048, 2048), P('Portrait canvas', 2400, 3200), P('Landscape canvas', 3200, 2400), P('Wallpaper 4K', 3840, 2160), P('Phone wallpaper', 1290, 2796)],
  },
  {
    id: 'develop', name: 'Sora Hikari', kana: 'ソラヒカリ', role: 'Photo / light management', tile: '/sora/tile-develop.png', letters: 'Hi', like: 'Lightroom', doc: true, colors: ['#0b2440', '#5fb7ff'],
    tagline: 'Organise and develop photos: light, colour, curves, presets and batch export.', start: 'import',
  },
  {
    id: 'vector', name: 'Sora Eshi', kana: 'ソラエシ', role: 'Illustration', tile: '/sora/tile-vector.png', letters: 'Se', like: 'Illustrator', doc: true, colors: ['#3a1e00', '#ff9a00'],
    tagline: 'Logos, icons and illustrations with the pen, shapes, paths and artboards.',
    unit: 'px', presets: [P('Logo / icon', 1024, 1024), P('Letter', 816, 1056), P('A4', 794, 1123), P('Poster 18×24 in', 1728, 2304), P('Business card', 336, 192), P('Web 1920', 1920, 1080)],
  },
  {
    id: 'express', name: 'Sora Express', role: 'Quick design', letters: 'Ex', like: 'Adobe Express', doc: true, colors: ['#2b0b3a', '#ff5ec8'],
    tagline: 'Quick social posts, flyers, thumbnails and invites from templates.',
    unit: 'px', presets: [P('Instagram post', 1080, 1350), P('Instagram story', 1080, 1920), P('Tsunami thumbnail', 1280, 720), P('Flyer (Letter)', 1275, 1650), P('Invitation', 1500, 2100), P('Banner', 1500, 500), P('Presentation 16:9', 1920, 1080)],
  },
  {
    id: 'proto', name: 'Sora UI/UX', kana: 'ソラユーアイユーエックス', role: 'Interface design', tile: '/sora/tile-proto.png', letters: 'Ui', like: 'XD', doc: true, colors: ['#2e0a3a', '#ff61f6'],
    tagline: 'Design screens for apps and websites, then click through them as a prototype.',
    unit: 'px', presets: [P('iPhone 15', 393, 852), P('Android', 412, 915), P('iPad', 820, 1180), P('Web 1440', 1440, 1024), P('Web 1920', 1920, 1080), P('Watch', 198, 242)],
  },
  {
    id: 'layout', name: 'Sora Keishiki', kana: 'ソラケイシキ', role: 'Layout / publishing', tile: '/sora/tile-layout.png', letters: 'Ke', like: 'InDesign', doc: true, colors: ['#3a0a1e', '#ff3366'],
    tagline: 'Books, magazines, brochures and print layouts with pages, masters and styles.',
    unit: 'pt', presets: [P('Letter', 612, 792, { pages: 1 }), P('A4', 595, 842, { pages: 1 }), P('A5', 420, 595, { pages: 2 }), P('Tabloid', 792, 1224, { pages: 1 }), P('Trifold brochure', 792, 612, { pages: 2 }), P('Magazine 8.5×11', 612, 792, { pages: 8, facing: true }), P('Book 6×9', 432, 648, { pages: 16, facing: true })],
  },
  {
    id: 'pdf', name: 'Sora PDF', role: 'PDF documents', letters: 'Pf', like: 'Acrobat', doc: true, colors: ['#3a0505', '#ff2d2d'],
    tagline: 'Read, comment, fill and sign, organise pages, merge and split PDFs.', start: 'open-pdf',
  },
  {
    id: 'cut', name: 'Sora Eizō', kana: 'ソラエイゾウ', role: 'Video editing', tile: '/sora/tile-cut.png', letters: 'Ez', like: 'Premiere Pro', doc: true, colors: ['#1a0b3a', '#9a8cff'],
    tagline: 'Edit video on a multitrack timeline with titles, transitions, colour and sound.',
    unit: 'px', presets: [P('1080p 30 fps', 1920, 1080, { fps: 30 }), P('1080p 60 fps', 1920, 1080, { fps: 60 }), P('4K 30 fps', 3840, 2160, { fps: 30 }), P('4K 24 fps', 3840, 2160, { fps: 24 }), P('Vertical 1080×1920', 1080, 1920, { fps: 30 }), P('Square 1080', 1080, 1080, { fps: 30 }), P('720p 30 fps', 1280, 720, { fps: 30 })],
  },
  {
    id: 'motion', name: 'Sora Ugoki', kana: 'ソラウゴキ', role: 'Motion graphics', tile: '/sora/tile-motion.png', letters: 'Ug', like: 'After Effects', doc: true, colors: ['#10093a', '#c79bff'],
    tagline: 'Motion graphics and visual effects with keyframes, shapes, text and masks.',
    unit: 'px', presets: [P('1080p 30 fps · 10 s', 1920, 1080, { fps: 30, duration: 10 }), P('4K 30 fps · 10 s', 3840, 2160, { fps: 30, duration: 10 }), P('Square · 6 s', 1080, 1080, { fps: 30, duration: 6 }), P('Vertical · 15 s', 1080, 1920, { fps: 30, duration: 15 }), P('Lower third · 5 s', 1920, 1080, { fps: 30, duration: 5 })],
  },
  {
    id: 'animate', name: 'Sora ANI', kana: 'ソラアニメ', role: 'Animation', tile: '/sora/tile-animate.png', letters: 'An', like: 'Animate', doc: true, colors: ['#2a1300', '#ff7b00'],
    tagline: 'Frame-by-frame and tweened 2D animation with onion skinning; export video or GIF.',
    unit: 'px', presets: [P('1080p 24 fps', 1920, 1080, { fps: 24 }), P('720p 24 fps', 1280, 720, { fps: 24 }), P('Square 12 fps', 1080, 1080, { fps: 12 }), P('Sticker 512', 512, 512, { fps: 12 })],
  },
  {
    id: 'audio', name: 'Sora Audio', role: 'Audio editing', letters: 'Au', like: 'Audition', doc: true, colors: ['#00262a', '#00e4bb'],
    tagline: 'Record, edit, mix and clean up sound: podcasts, voice-overs and music.',
    presets: [{ label: 'Multitrack 48 kHz', sampleRate: 48000 }, { label: 'Multitrack 44.1 kHz', sampleRate: 44100 }, { label: 'Podcast (voice)', sampleRate: 48000, template: 'podcast' }],
  },
  {
    id: 'encoder', name: 'Sora Encoder', role: 'Media conversion', letters: 'En', like: 'Media Encoder', doc: false, colors: ['#08172e', '#4d9cff'],
    tagline: 'Convert video and audio in batches with presets; watch the render queue.',
  },
];

// The eight apps on the brand sheet first, in its order.
const ORDER = ['photo', 'vector', 'cut', 'motion', 'develop', 'proto', 'layout', 'animate', 'paint', 'express', 'pdf', 'audio', 'encoder'];
APPS.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

export const TOOLS = [
  { id: 'files', name: 'Files', like: 'Bridge', path: '/files', tagline: 'Every project, upload and export in one place.' },
  { id: 'libraries', name: 'Libraries', like: 'Creative Cloud Libraries', path: '/libraries', tagline: 'Colours, styles and graphics you use everywhere.' },
  { id: 'fonts', name: 'Fonts', like: 'Adobe Fonts', path: '/fonts', tagline: 'Built-in fonts and your own.' },
  { id: 'color', name: 'Color', like: 'Adobe Color', path: '/color', tagline: 'Build palettes with colour harmony rules, or pull them from photos.' },
];

export const appById = (id) => APPS.find((a) => a.id === id);
export const appPath = (id, docId) => (docId ? `/${id}/${docId}` : `/${id}`);
