// Mixdown and export. The session is rendered in the browser with OfflineAudioContext (every effect included); WAV is
// written here. FLAC/MP3/M4A/Opus: the mix is saved as a WAV asset and the server transcodes it (a 'transcode' job, which
// the export dialog follows and then downloads / saves to Cloud / sends to Tsunami).
import { saveBlob } from '../../lib/api.js';
import { encodeWav, fromBuffer, normalizeLoudness, peak, limit } from './dsp.js';
import { sessionEnd } from './model.js';

const common = (doc) => [
  { key: 'range', label: 'Range', type: 'select', default: 'all', choices: [['all', 'Whole session'], ['loop', 'Loop region'], ['selection', 'Time selection']] },
  { key: 'sampleRate', label: 'Sample rate', type: 'select', default: doc.sampleRate, choices: [[44100, '44.1 kHz'], [48000, '48 kHz'], [96000, '96 kHz']] },
  { key: 'normalize', label: 'Normalize loudness', type: 'toggle', default: false },
  { key: 'lufs', label: 'Target', type: 'number', default: -16, min: -30, max: -6, step: 0.5, unit: 'LUFS', hint: '−16 podcasts and voice · −14 streaming music · −23 broadcast. Peaks are limited at −1 dBFS.' },
];

export function exportConfig({ engine, getDoc, getTimeSel, docId, name }) {
  const doc = getDoc();
  const serverNote = 'Encoded by the server from a lossless mix made in your browser.';
  const note48 = 'Encoded by the server from a lossless mix made in your browser. MP3 and AAC go up to 48 kHz.';
  return {
    formats: [
      { id: 'wav', label: 'WAV (uncompressed)', ext: 'wav', kind: 'audio', options: [{ key: 'bits', label: 'Bit depth', type: 'select', default: 24, choices: [[16, '16-bit (dithered)'], [24, '24-bit'], [32, '32-bit float']] }, ...common(doc)] },
      { id: 'flac', label: 'FLAC (lossless)', ext: 'flac', kind: 'audio', options: common(doc), note: serverNote },
      { id: 'mp3', label: 'MP3 320 kbps', ext: 'mp3', kind: 'audio', options: common(doc), note: note48 },
      { id: 'm4a', label: 'AAC 256 kbps (M4A)', ext: 'm4a', kind: 'audio', options: common(doc), note: note48 },
      { id: 'opus', label: 'Opus 160 kbps (OGG)', ext: 'ogg', kind: 'audio', options: common(doc), note: 'Encoded by the server from a lossless mix made in your browser. Opus is always 48 kHz.' },
    ],
    render: async (fid, o, { onProgress }) => {
      const d = getDoc();
      const [from, to] = rangeFor(d, o.range, getTimeSel());
      if (to - from < 0.01) throw new Error(o.range === 'all' ? 'The session is empty — add some clips first.' : 'That range is empty.');
      onProgress?.(0, 'Mixing down…');
      const buf = await engine.render(d, { from, to, sampleRate: fid === 'wav' ? Number(o.sampleRate) : Math.max(44100, Number(o.sampleRate)), onProgress });
      const a = fromBuffer(buf);
      if (o.normalize) { onProgress?.(0.95, 'Normalizing…'); normalizeLoudness(a, Number(o.lufs), -1); }
      else if (fid !== 'wav' || o.bits !== 32) { if (peak(a) > 1) limit(a, -0.1); } // integer formats can't hold overs
      const wav = encodeWav(a, fid === 'wav' ? Number(o.bits) : 24);
      if (fid === 'wav') return wav;
      onProgress?.(0, 'Uploading the mix…');
      const asset = await saveBlob(wav, `${name || 'Mixdown'}.wav`, { docId, isExport: false, autosave: true, onProgress: (p) => onProgress?.(p, 'Uploading the mix…') });
      return { job: { kind: 'transcode', name, spec: { asset_id: asset.id, preset: fid, output: { sample_rate: Number(o.sampleRate) } } } };
    },
  };
}

export function rangeFor(doc, which, timeSel) {
  if (which === 'loop' && doc.loop && doc.loop.end > doc.loop.start) return [doc.loop.start, doc.loop.end];
  if (which === 'selection' && timeSel && timeSel.end > timeSel.start) return [timeSel.start, timeSel.end];
  if (which !== 'all') throw new Error(which === 'loop' ? 'Set a loop region first (drag in the strip at the top of the ruler).' : 'Make a time selection first (drag across empty space in the tracks).');
  return [0, sessionEnd(doc)];
}
