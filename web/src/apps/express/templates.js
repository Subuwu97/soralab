// Built-in Sora Express templates, made from the bundled fonts and shapes. Each builds the children of one page
// (coordinates from the page's top-left corner) plus its size and background.
import { make, solid, linear, radial, strokeOf, uid } from '../_vector/model.js';
import { translate, rotate, mul } from '../_vector/geom.js';

const F = (f) => (f === null ? null : typeof f === 'string' ? solid(f) : f);
const R = (x, y, w, h, fill, o = {}) => ({ ...make.rect({ x, y, w, h, fill: F(fill), stroke: null }), ...o });
const E = (x, y, w, h, fill, o = {}) => ({ ...make.ellipse({ x, y, w, h, fill: F(fill), stroke: null }), ...o });
const Star = (x, y, s, fill, o = {}) => ({ ...make.star({ x, y, w: s, h: s, points: o.points || 5, inner: o.inner || 0.45, fill: F(fill), stroke: null }), ...o });
/** Area text box: x, y, width; font: [family, weight, size, extra]. */
const T = (x, y, w, text, [family, weight, size, extra = {}], color, o = {}) => ({
  ...make.text({ x, y, w, h: 0, text, mode: 'area', font: { family, weight, size, align: 'center', tracking: 0, leading: 0, ...extra }, fill: F(color) }), name: o.name || text.split('\n')[0].slice(0, 24), ...o,
});
const L = (x1, y1, x2, y2, color, width = 4, o = {}) => ({ ...make.line({ x1, y1, x2, y2 }), stroke: strokeOf(color, width, { cap: 'round' }), ...o });
const shadow = (y = 12, blur = 30, color = '#00000040') => [{ type: 'shadow', x: 0, y, blur, color, on: true }];
/** A photo frame: drop or Replace an image into it. */
const Frame = (shape, placeholder = '#d9d9e3') => {
  const bg = { ...shape, id: uid(), fill: F(placeholder), name: 'Placeholder' };
  return make.group([bg, { ...shape, id: uid(), fill: null, stroke: null, name: 'Frame shape' }], { clip: true, frame: true, name: 'Photo frame' });
};
const turn = (n, deg) => { const b = { x: n.t[4] + (n.w || 0) / 2, y: n.t[5] + (n.h || 0) / 2 }; return { ...n, t: mul(rotate(deg, b.x, b.y), n.t) }; };
const blob = (x, y, s, fill, o = {}) => ({ ...make.path({ d: 'M0.5 0C0.78 0 1 0.2 0.98 0.48C0.96 0.78 0.74 1 0.47 0.98C0.2 0.96 0 0.76 0.02 0.47C0.04 0.2 0.22 0 0.5 0Z' }), fill: F(fill), stroke: null, ...o, _scale: { x, y, s } });
// Paths given in a unit box are scaled into place.
function place(n) {
  if (!n._scale) return n;
  const { x, y, s } = n._scale;
  const { _scale, ...rest } = n;
  return { ...rest, subpaths: rest.subpaths.map((sp) => ({ ...sp, pts: sp.pts.map((p) => ({ x: x + p.x * s, y: y + p.y * s, ix: x + p.ix * s, iy: y + p.iy * s, ox: x + p.ox * s, oy: y + p.oy * s })) })) };
}

export const TEMPLATES = [
  {
    id: 'summer-sale', name: 'Summer sale', category: 'Instagram post', w: 1080, h: 1350, bg: '#ff7a59',
    build: () => [
      R(0, 0, 1080, 1350, linear(120, '#ffb347', '#ff5e62', '#d4146a'), { name: 'Background', locked: true }),
      E(-200, -160, 620, 620, '#ffffff22'), E(700, 950, 560, 560, '#ffffff1f'), E(820, 120, 160, 160, '#ffd86b'),
      T(80, 230, 920, 'SUMMER', ['Bebas Neue', 400, 260, { tracking: 20 }], '#ffffff', { effects: shadow(10, 0, '#00000033') }),
      T(80, 470, 920, 'SALE', ['Bebas Neue', 400, 380, { tracking: 40, leading: 330 }], '#fff3c4', { effects: shadow(12, 0, '#00000033') }),
      E(370, 860, 340, 340, '#1c1240'), T(370, 935, 340, 'UP TO\n50%\nOFF', ['Montserrat', 800, 64, { leading: 66 }], '#ffd86b'),
      R(340, 1235, 400, 70, '#ffffff', { r: 35 }), T(340, 1251, 400, 'SHOP NOW', ['Montserrat', 700, 32, { tracking: 80 }], '#d4146a'),
      T(80, 110, 920, 'LIMITED TIME ONLY', ['Montserrat', 600, 34, { tracking: 300 }], '#ffffffcc'),
    ],
  },
  {
    id: 'quote-card', name: 'Quote card', category: 'Instagram post', w: 1080, h: 1350, bg: '#10162f',
    build: () => [
      R(60, 60, 960, 1230, null, { stroke: strokeOf('#c9a96e', 3), name: 'Border' }),
      T(90, 150, 900, '“', ['Playfair Display', 700, 320, { leading: 260 }], '#c9a96e'),
      T(130, 450, 820, 'The sky is not the limit.\nIt is only the view.', ['Playfair Display', 400, 76, { style: 'italic', leading: 104 }], '#f4efe6'),
      L(440, 830, 640, 830, '#c9a96e', 3),
      T(140, 870, 800, 'SORA LAB STUDIO', ['Montserrat', 600, 30, { tracking: 400 }], '#c9a96e'),
      Star(510, 1150, 60, '#c9a96e', { inner: 0.4, points: 4 }),
    ],
  },
  {
    id: 'neon-nights', name: 'Neon nights event', category: 'Instagram story', w: 1080, h: 1920, bg: '#120024',
    build: () => [
      R(0, 0, 1080, 1920, linear(160, '#2b0057', '#120024', '#00172e'), { name: 'Background', locked: true }),
      E(-300, 200, 900, 900, radial('#ff2fd388', '#ff2fd300')), E(500, 1000, 900, 900, radial('#00e5ff77', '#00e5ff00')),
      R(140, 340, 800, 800, null, { r: 400, stroke: strokeOf('#ff2fd3', 8), effects: [{ type: 'shadow', x: 0, y: 0, blur: 40, color: '#ff2fd3', on: true }], name: 'Neon ring' }),
      T(90, 560, 900, 'NEON\nNIGHTS', ['Orbitron', 900, 150, { tracking: 60, leading: 170 }], '#ffffff', { effects: [{ type: 'shadow', x: 0, y: 0, blur: 30, color: '#00e5ff', on: true }] }),
      T(90, 1240, 900, 'SAT · 18 OCT · 10 PM', ['Montserrat', 700, 54, { tracking: 120 }], '#00e5ff'),
      T(90, 1340, 900, 'Warehouse 9, Harbour Road', ['Montserrat', 400, 40], '#d9c8ff'),
      R(290, 1560, 500, 110, linear(0, '#ff2fd3', '#7a5cff'), { r: 55, effects: shadow(10, 40, '#ff2fd366') }),
      T(290, 1590, 500, 'GET TICKETS', ['Montserrat', 800, 42, { tracking: 120 }], '#ffffff'),
    ],
  },
  {
    id: 'tips-thumb', name: 'Video tips thumbnail', category: 'Tsunami thumbnail', w: 1280, h: 720, bg: '#ffd400',
    build: () => [
      R(0, 0, 1280, 720, '#ffd400', { name: 'Background', locked: true }),
      turn(R(700, -120, 760, 1000, '#111111'), 12),
      Frame(E(760, 120, 460, 460)),
      E(1080, 470, 150, 150, '#ff3b30', { effects: shadow(8, 20) }), T(1080, 512, 150, 'NEW', ['Bebas Neue', 400, 60], '#ffffff'),
      T(60, 70, 700, '10', ['Bebas Neue', 400, 340, { align: 'left', leading: 300 }], '#111111'),
      T(60, 380, 680, 'TIPS YOU\nNEED TO KNOW', ['Bebas Neue', 400, 120, { align: 'left', leading: 110 }], '#111111'),
      R(60, 640, 320, 8, '#111111'),
    ],
  },
  {
    id: 'grand-opening', name: 'Grand opening flyer', category: 'Flyer', w: 1275, h: 1650, bg: '#f6efe3',
    build: () => [
      R(50, 50, 1175, 1550, null, { stroke: strokeOf('#1f3b2d', 4), name: 'Frame' }),
      R(70, 70, 1135, 1510, null, { stroke: strokeOf('#1f3b2d', 1.5), name: 'Inner frame' }),
      T(100, 180, 1075, 'YOU’RE INVITED TO OUR', ['Montserrat', 600, 38, { tracking: 400 }], '#1f3b2d'),
      T(100, 270, 1075, 'Grand\nOpening', ['Playfair Display', 800, 210, { leading: 210 }], '#1f3b2d'),
      Star(560, 760, 60, '#d4a24c', { points: 8, inner: 0.5 }), L(260, 790, 520, 790, '#d4a24c', 3), L(660, 790, 1020, 790, '#d4a24c', 3),
      T(150, 880, 975, 'Fresh bread, local coffee and live music.\nFirst 50 guests get a free pastry.', ['Lora', 400, 46, { leading: 70 }], '#3b4a40'),
      R(337, 1150, 600, 210, '#1f3b2d', { r: 16 }),
      T(337, 1180, 600, 'SATURDAY 12 APRIL', ['Montserrat', 700, 44, { tracking: 120 }], '#f6efe3'),
      T(337, 1260, 600, '9 AM – 4 PM · 22 Mill Street', ['Lora', 400, 36], '#d4a24c'),
      T(100, 1450, 1075, 'THE MILL BAKERY', ['Montserrat', 800, 40, { tracking: 500 }], '#1f3b2d'),
    ],
  },
  {
    id: 'wedding', name: 'Wedding invitation', category: 'Invitation', w: 1500, h: 2100, bg: '#fbf3ee',
    build: () => [
      E(-250, -250, 800, 800, '#f3d7cf'), E(1000, 1600, 800, 800, '#f3d7cf'), E(1150, -120, 420, 420, '#e9c3b8aa'), E(-120, 1800, 400, 400, '#e9c3b8aa'),
      R(130, 130, 1240, 1840, null, { stroke: strokeOf('#b07d62', 3), r: 20, name: 'Border' }),
      T(150, 330, 1200, 'TOGETHER WITH THEIR FAMILIES', ['Montserrat', 500, 36, { tracking: 400 }], '#8a6a5a'),
      T(150, 500, 1200, 'Hana\n&\nKenji', ['Dancing Script', 700, 220, { leading: 230 }], '#7a4a3a'),
      T(150, 1260, 1200, 'request the pleasure of your company\nat the celebration of their marriage', ['Lora', 400, 50, { style: 'italic', leading: 80 }], '#6b5348'),
      L(550, 1470, 950, 1470, '#b07d62', 2),
      T(150, 1530, 1200, 'SATURDAY, THE FOURTH OF MAY\nAT FOUR O’CLOCK', ['Montserrat', 600, 44, { tracking: 200, leading: 70 }], '#7a4a3a'),
      T(150, 1720, 1200, 'Cherry Blossom Gardens · Kyoto', ['Lora', 400, 46], '#8a6a5a'),
    ],
  },
  {
    id: 'channel-banner', name: 'Channel banner', category: 'Banner', w: 1500, h: 500, bg: '#5AB4FF',
    build: () => [
      R(0, 0, 1500, 500, linear(0, '#5AB4FF', '#8B7CFF', '#FF8FB1'), { name: 'Background', locked: true }),
      E(1150, -120, 420, 420, '#ffffff22'), E(1300, 260, 300, 300, '#ffffff1a'), E(-80, 300, 300, 300, '#ffffff1a'),
      T(100, 150, 1300, 'SORA DAILY', ['Montserrat', 900, 120, { tracking: 80 }], '#ffffff', { effects: shadow(6, 20, '#0000002a') }),
      T(100, 300, 1300, 'Design · Code · Coffee — new videos every Tuesday', ['Poppins', 500, 38], '#ffffffdd'),
    ],
  },
  {
    id: 'title-slide', name: 'Title slide', category: 'Presentation', w: 1920, h: 1080, bg: '#ffffff',
    build: () => [
      R(0, 0, 24, 1080, '#5856d6', { name: 'Accent bar' }), E(1350, -250, 900, 900, linear(135, '#8B7CFF', '#5AB4FF')), E(1600, 650, 300, 300, '#FF8FB1'),
      T(160, 330, 1200, 'QUARTERLY REVIEW', ['Montserrat', 700, 36, { align: 'left', tracking: 400 }], '#5856d6'),
      T(160, 400, 1200, 'Building the\nnext chapter', ['Montserrat', 800, 130, { align: 'left', leading: 140 }], '#14142b'),
      T(160, 740, 1100, 'Product team · October 2026', ['Inter', 400, 40, { align: 'left' }], '#6b6b80'),
    ],
  },
  {
    id: 'new-arrival', name: 'New arrival', category: 'Instagram post', w: 1080, h: 1350, bg: '#ece6dd',
    build: () => [
      Frame(R(90, 90, 900, 860, null, { r: 40 }), '#cfc6b8'),
      T(90, 470, 900, 'Drop your product photo here', ['Inter', 500, 34], '#8a8070', { name: 'Hint' }),
      T(90, 1000, 900, 'NEW ARRIVAL', ['Bebas Neue', 400, 150, { tracking: 40 }], '#2d2a26'),
      T(90, 1160, 900, 'The Linen Collection — now in store and online', ['Poppins', 400, 36], '#5c554c'),
      R(820, 60, 200, 200, '#2d2a26', { r: 100 }), T(820, 118, 200, '-20%', ['Montserrat', 800, 52], '#ece6dd'),
    ],
  },
  {
    id: 'birthday', name: 'Birthday wishes', category: 'Instagram story', w: 1080, h: 1920, bg: '#fff0f6',
    build: () => [
      R(0, 0, 1080, 1920, linear(180, '#fff0f6', '#ffe1ec'), { name: 'Background', locked: true }),
      ...[[120, 200, 60, '#ff6fa8'], [880, 300, 40, '#ffc36b'], [200, 1500, 50, '#8B7CFF'], [900, 1600, 70, '#5AB4FF'], [500, 140, 30, '#34c759'], [760, 1200, 36, '#ff6fa8'], [140, 900, 28, '#ffc36b'], [960, 820, 26, '#8B7CFF']].map(([x, y, s, c]) => E(x, y, s, s, c)),
      ...[[300, 330, 50, '#ffc36b'], [800, 520, 60, '#ff6fa8'], [150, 1280, 46, '#5AB4FF']].map(([x, y, s, c]) => Star(x, y, s, c)),
      T(80, 620, 920, 'Happy\nBirthday', ['Pacifico', 400, 170, { leading: 230 }], '#e0457b', { effects: shadow(8, 0, '#ffc36b') }),
      T(80, 1140, 920, 'MAYA', ['Montserrat', 800, 90, { tracking: 600 }], '#2b2b5a'),
      T(80, 1280, 920, 'Wishing you a year as bright as you are', ['Poppins', 400, 40], '#6b4a6b'),
    ],
  },
  {
    id: 'level-up', name: 'Gaming thumbnail', category: 'Tsunami thumbnail', w: 1280, h: 720, bg: '#0b0e1a',
    build: () => [
      R(0, 0, 1280, 720, linear(135, '#0b0e1a', '#1a0b3a'), { name: 'Background', locked: true }),
      turn(R(-100, 420, 1500, 120, '#7cff4f'), -8), turn(R(-100, 560, 1500, 40, '#00e5ff'), -8),
      T(40, 110, 1200, 'LEVEL UP', ['Orbitron', 900, 150, { tracking: 20 }], '#ffffff', { effects: [{ type: 'shadow', x: 8, y: 8, blur: 0, color: '#ff2fd3', on: true }] }),
      T(40, 330, 1200, 'Beginner to pro in 7 days', ['Montserrat', 800, 60], '#7cff4f'),
      Star(1100, 40, 130, '#ffd400', { points: 6, inner: 0.5 }),
    ],
  },
  {
    id: 'workshop', name: 'Workshop flyer', category: 'Flyer', w: 1275, h: 1650, bg: '#0f5132',
    build: () => [
      R(0, 0, 1275, 1650, '#0f5132', { name: 'Background', locked: true }),
      place(blob(700, -200, 800, '#198754')), place(blob(-250, 1150, 700, '#146c43')),
      T(100, 160, 1075, 'FREE COMMUNITY WORKSHOP', ['Montserrat', 700, 40, { align: 'left', tracking: 300 }], '#b7f5c8'),
      T(100, 240, 1000, 'Grow your\nown herbs', ['Poppins', 800, 160, { align: 'left', leading: 170 }], '#ffffff'),
      T(100, 640, 900, '• Pick the right pots and soil\n• Light, water and feeding\n• Harvest without harming the plant\n• Take a seedling home', ['Poppins', 400, 46, { align: 'left', leading: 80 }], '#e8fff0'),
      R(100, 1110, 1075, 3, '#b7f5c8'),
      T(100, 1170, 1075, 'SUNDAY 3 PM · CITY LIBRARY GARDEN', ['Montserrat', 700, 46, { align: 'left', tracking: 100 }], '#ffd86b'),
      R(100, 1300, 520, 110, '#ffd86b', { r: 55 }), T(100, 1330, 520, 'Save your seat', ['Poppins', 700, 44], '#0f5132'),
    ],
  },
  {
    id: 'monday', name: 'Monday motivation', category: 'Instagram post', w: 1080, h: 1350, bg: '#fefbf3',
    build: () => [
      place(blob(140, 170, 800, linear(135, '#FFC36B', '#FF8FB1'))),
      T(140, 380, 800, 'Small steps\nevery day', ['Playfair Display', 800, 110, { leading: 120 }], '#1d1b2e'),
      T(140, 700, 800, '#MondayMotivation', ['Poppins', 600, 40], '#1d1b2e'),
      T(140, 1180, 800, '@sorastudio', ['Inter', 500, 32, { tracking: 100 }], '#9a8f80'),
    ],
  },
  {
    id: 'flash-sale-banner', name: 'Flash sale banner', category: 'Banner', w: 1500, h: 500, bg: '#111111',
    build: () => [
      R(0, 0, 1500, 500, '#111111', { name: 'Background', locked: true }),
      turn(R(950, -200, 300, 900, '#ff3b30'), 20), turn(R(1220, -200, 120, 900, '#ffcc00'), 20),
      T(80, 110, 900, 'FLASH SALE', ['Bebas Neue', 400, 200, { align: 'left', tracking: 30 }], '#ffffff'),
      T(80, 320, 900, 'Everything 30% off · ends midnight', ['Montserrat', 600, 44, { align: 'left' }], '#ffcc00'),
    ],
  },
];

/** The page contents for a template, moved to the page's position. */
export function buildTemplate(tpl, ab) {
  return tpl.build().map(place).map((n) => moveDeep(n, ab.x, ab.y));
}
function moveDeep(n, dx, dy) {
  if (!dx && !dy) return n;
  if (n.children) return { ...n, children: n.children.map((c) => moveDeep(c, dx, dy)) };
  if (n.type === 'path') return { ...n, subpaths: n.subpaths.map((sp) => ({ ...sp, pts: sp.pts.map((p) => ({ x: p.x + dx, y: p.y + dy, ix: p.ix + dx, iy: p.iy + dy, ox: p.ox + dx, oy: p.oy + dy })) })) };
  return { ...n, t: mul(translate(dx, dy), n.t) };
}

/** Heading / subheading / body presets and font pairings for the Text panel. */
export const TEXT_PRESETS = [
  { label: 'Add a heading', font: ['Montserrat', 800, 0.085], sample: 'Add a heading' },
  { label: 'Add a subheading', font: ['Montserrat', 600, 0.045], sample: 'Add a subheading' },
  { label: 'Add a little body text', font: ['Inter', 400, 0.028], sample: 'Add a little bit of body text' },
];
export const PAIRINGS = [
  { head: ['Playfair Display', 800], body: ['Lora', 400], sample: ['Elegant', 'Classic serif pairing'] },
  { head: ['Bebas Neue', 400], body: ['Montserrat', 500], sample: ['BOLD NEWS', 'Loud and clear'] },
  { head: ['Pacifico', 400], body: ['Poppins', 400], sample: ['Hello there', 'Friendly and fun'] },
  { head: ['Orbitron', 800], body: ['Inter', 400], sample: ['FUTURE', 'Tech and gaming'] },
  { head: ['Dancing Script', 700], body: ['Lora', 400], sample: ['With love', 'Invitations and cards'] },
  { head: ['Oswald', 700], body: ['Roboto', 400], sample: ['HEADLINE', 'Editorial and posters'] },
];
export const GRADIENTS = [
  ['#5AB4FF', '#8B7CFF', '#FF8FB1'], ['#ffb347', '#ff5e62'], ['#43e97b', '#38f9d7'], ['#fa709a', '#fee140'], ['#30cfd0', '#330867'], ['#a18cd1', '#fbc2eb'], ['#ff9a9e', '#fecfef'], ['#0f2027', '#2c5364'],
];
