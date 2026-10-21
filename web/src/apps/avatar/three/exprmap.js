// Guesses VRM expressions from a model's morph target names: VRoid (Fcl_EYE_Close, Fcl_MTH_A…), VRChat visemes
// (vrc.v_aa…), MMD (まばたき, あ…), ARKit (eyeBlinkLeft, jawOpen…) and common English names (Blink_L, Smile, MouthOpen).
// Returns document-form expressions: { happy: { binds: [{ mesh, morph, weight }], … }, … }.

const norm = (s) => String(s).toLowerCase().replace(/^.*[.:|]/, '').replace(/[\s_\-.]+/g, '');
// Per preset: a list of [regex on the normalised name, weight]. The first preset rule that matches any morph wins;
// several morphs can match (left + right halves, a morph on each primitive).
const RULES = {
  blink: [[/^(fcleyeclose|blink|blinks|eyesclosed?|eyeclose|まばたき|vrcblink|closeeyes)$/, 1]],
  blinkLeft: [[/^(fcleyecloseleft|fcleyeclosel|blinkl|blinkleft|lefteyeclose|eyecloseleft|eyeclosel|ウィンク|eyeblinkleft)$/, 1]],
  blinkRight: [[/^(fcleyecloseright|fcleyecloser|blinkr|blinkright|righteyeclose|eyecloseright|eyecloser|ウィンク右|eyeblinkright)$/, 1]],
  aa: [[/^(fclmtha|a|aa|あ|vrcvaa|mouthopen|mouth_?a|vaa|mtha|jawopen)$/, 1]],
  ih: [[/^(fclmthi|i|ih|い|vrcvih|mouthi|vih|mthi)$/, 1], [/^mouthstretch(left|right)$/, 1], [/^jawopen$/, 0.25]],
  ou: [[/^(fclmthu|u|ou|う|vrcvou|mouthu|vou|mthu|mouthpucker)$/, 1]],
  ee: [[/^(fclmthe|e|ee|え|vrcve|mouthe|ve|mthe)$/, 1], [/^mouthstretch(left|right)$/, 0.7], [/^jawopen$/, 0.45]],
  oh: [[/^(fclmtho|o|oh|お|vrcvoh|moutho|voh|mtho|mouthfunnel)$/, 1]],
  happy: [[/^(fclalljoy|joy|happy|smile|笑い|にこり|fun)$/, 1], [/^mouthsmile(left|right)$/, 1], [/^eyesquint(left|right)$/, 0.6]],
  angry: [[/^(fclallangry|angry|anger|怒り)$/, 1], [/^browdown(left|right)$/, 1]],
  sad: [[/^(fclallsorrow|sorrow|sad|悲しい|困る)$/, 1], [/^mouthfrown(left|right)$/, 1], [/^browinnerup$/, 0.7]],
  relaxed: [[/^(fclallfun|relaxed|relax|calm|なごみ)$/, 1], [/^mouthsmile(left|right)$/, 0.4], [/^eyesquint(left|right)$/, 0.5]],
  surprised: [[/^(fclallsurprised|surprised|surprise|驚き|びっくり)$/, 1], [/^eyewide(left|right)$/, 1], [/^browinnerup$/, 1]],
  lookUp: [[/^(lookup|eyelookup)$/, 1], [/^eyelookup(left|right)$/, 1]],
  lookDown: [[/^(lookdown|eyelookdown)$/, 1], [/^eyelookdown(left|right)$/, 1]],
  lookLeft: [[/^(lookleft|eyelookleft)$/, 1], [/^(eyelookoutleft|eyelookinright)$/, 1]],
  lookRight: [[/^(lookright|eyelookright)$/, 1], [/^(eyelookoutright|eyelookinleft)$/, 1]],
};
// ARKit-only models: build blink from the two halves when there's no single blink shape.
const FALLBACK = { blink: [/^eyeblink(left|right)$/, 1] };

export function guessExpressions(morphList) {
  const out = {};
  for (const [preset, rules] of Object.entries(RULES)) {
    let binds = [];
    for (const [ri, [re, weight]] of rules.entries()) {
      const found = [];
      for (const { mesh, morphs } of morphList) for (const m of morphs) if (re.test(norm(m))) found.push({ mesh, morph: m, weight });
      // Named emotion shapes (Fcl_ALL_Joy) win outright; part shapes (smile halves, squints) add up.
      if (found.length && ri === 0) { binds = found; break; }
      binds.push(...found);
    }
    if (!binds.length && FALLBACK[preset]) {
      const [re, weight] = FALLBACK[preset];
      for (const { mesh, morphs } of morphList) for (const m of morphs) if (re.test(norm(m))) binds.push({ mesh, morph: m, weight });
    }
    out[preset] = { binds, isBinary: false, overrideBlink: ['happy', 'surprised', 'angry', 'sad'].includes(preset) && binds.length ? 'blend' : 'none', overrideMouth: 'none', overrideLookAt: 'none' };
  }
  out.neutral = { binds: [], isBinary: false, overrideBlink: 'none', overrideMouth: 'none', overrideLookAt: 'none' };
  return out;
}
