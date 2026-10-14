// GLSL for the develop pipeline. One fragment pass does everything per output pixel (geometry → white balance →
// exposure → tone → colour → effects), so a slider drag costs a single draw. Low-frequency inputs (the local
// "base" brightness used by highlights/shadows, clarity and dehaze) come from two small pre-blurred copies of the
// source made once per photo.

export const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Downsample + separable gaussian blur (used for the base-brightness textures).
export const BLUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSize;     // target size
uniform vec2 uDir;      // (1,0) or (0,1) in texels of uTex; (0,0) = plain resample
uniform float uSigma;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  if (uDir == vec2(0.0)) { o = vec4(texture(uTex, uv).rgb, 1.0); return; }
  vec2 px = uDir / vec2(textureSize(uTex, 0));
  float r = ceil(uSigma * 3.0);
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = -48; i <= 48; i++) {
    float fi = float(i);
    if (abs(fi) > r) continue;
    float w = exp(-0.5 * fi * fi / (uSigma * uSigma));
    acc += texture(uTex, uv + px * fi).rgb * w; wsum += w;
  }
  o = vec4(acc / wsum, 1.0);
}`;

export const MAX_MASKS = 8;

export const MAIN_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uSrc, uBlurM, uBlurL, uCurve, uB0, uB1, uB2, uB3;
uniform sampler3D uLut3;
uniform float uLutAmt, uLutN;
uniform vec3 uQx, uQy;          // fragment px → q (crop space 0..1)
uniform vec3 uSx, uSy;          // q → source uv
uniform vec2 uDx, uDy;          // source uv step per output pixel (x, y)
uniform vec2 uSrcSize, uOutSize;
uniform float uPxScale;         // output px per source px
uniform float uSplit;           // q.x below this shows the original ("before")
uniform int uMode;              // 0 normal, 1 colour-only (LUT export)
uniform int uDraft;
uniform int uClip;              // clipping warnings
uniform int uShowMask;          // index of the mask whose overlay is shown, or -1

uniform float uG[12];           // exposure, contrast, highlights, shadows, whites, blacks, temp, tint, saturation, texture, clarity, dehaze
uniform float uVib;
uniform int uBW;
uniform float uHslH[8], uHslS[8], uHslL[8], uGray[8];
uniform vec3 uGrShT, uGrMiT, uGrHiT, uGrGlT;   // colour-grading tints (already scaled)
uniform vec4 uGrL;                              // their luminance offsets (sh, mid, hi, global)
uniform vec2 uGrBB;                             // blending 0..1, balance -1..1
uniform vec4 uSharp;                            // amount, radius (src px), detail, masking
uniform vec2 uNR;                               // luminance, colour (0..1)
uniform vec2 uLens;                             // lens vignette amount, midpoint
uniform vec4 uVig;                              // amount, midpoint, roundness, feather
uniform float uVigHi;
uniform vec3 uGrain;                            // amount, size, roughness

uniform int uMaskN;
uniform int uMType[${MAX_MASKS}];
uniform vec4 uMG[${MAX_MASKS}];
uniform vec4 uMH[${MAX_MASKS}];
uniform float uMInv[${MAX_MASKS}];
uniform float uMAmt[${MAX_MASKS}];
uniform int uMCh[${MAX_MASKS}];
uniform float uMA[${MAX_MASKS * 12}];

out vec4 o;

const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
float lum(vec3 c) { return dot(c, LW); }
vec3 toGam(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float toGam1(float c) { c = max(c, 0.0); return c < 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }

vec2 UV;
vec3 S(vec2 off) { return textureGrad(uSrc, UV + off, uDx, uDy).rgb; }

float maskW(int i, vec2 uv) {
  vec2 P = uv * uSrcSize; float w = 0.0;
  int t = uMType[i];
  if (t == 0) {
    vec2 a = uMG[i].xy; vec2 d = uMG[i].zw - a;
    float k = dot(P - a, d) / max(dot(d, d), 1e-6);
    w = 1.0 - smoothstep(0.0, 1.0, k);
  } else if (t == 1) {
    vec2 d = P - uMG[i].xy; float c = cos(uMH[i].x); float s = sin(uMH[i].x);
    vec2 r = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / max(uMG[i].zw, vec2(1.0));
    float f = max(uMH[i].y, 0.002);
    w = 1.0 - smoothstep(1.0 - f, 1.0, length(r));
  } else {
    int ch = uMCh[i];
    w = ch == 0 ? textureLod(uB0, uv, 0.0).r : ch == 1 ? textureLod(uB1, uv, 0.0).r : ch == 2 ? textureLod(uB2, uv, 0.0).r : textureLod(uB3, uv, 0.0).r;
  }
  if (uMInv[i] > 0.5) w = 1.0 - w;
  return clamp(w * uMAmt[i], 0.0, 1.0);
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
// Weight of each of the 8 hue bands (piecewise linear between band centres, so they sum to 1).
const float BC[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);
void bandWeights(float hDeg, out float w[8]) {
  for (int i = 0; i < 8; i++) w[i] = 0.0;
  for (int i = 0; i < 8; i++) {
    if (hDeg >= BC[i] && hDeg < BC[i + 1]) {
      float t = (hDeg - BC[i]) / (BC[i + 1] - BC[i]);
      w[i] = 1.0 - t; w[(i + 1) % 8] += t;
    }
  }
}

float curveAt(float x, int ch) {
  float f = clamp(x, 0.0, 1.0) * 1023.0;
  int i = int(floor(f)); float t = f - float(i);
  vec4 a = texelFetch(uCurve, ivec2(i, 0), 0); vec4 b = texelFetch(uCurve, ivec2(min(i + 1, 1023), 0), 0);
  return mix(a[ch], b[ch], t);
}

float shoulder(float x) { const float k = 0.82; return x < k ? x : k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k))); }

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 q = vec2(dot(uQx, vec3(fc, 1.0)), dot(uQy, vec3(fc, 1.0)));
  if (uMode == 1) q = fc / uOutSize;
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { o = vec4(0.0); return; }
  vec2 uv = vec2(dot(uSx, vec3(q, 1.0)), dot(uSy, vec3(q, 1.0)));
  if (uMode == 1) uv = q;
  if (uv.x < -0.0005 || uv.y < -0.0005 || uv.x > 1.0005 || uv.y > 1.0005) { o = vec4(0.0); return; }
  UV = uv;
  vec3 c = uMode == 1 ? texelFetch(uSrc, ivec2(fc), 0).rgb : S(vec2(0.0));
  if (q.x < uSplit) { o = vec4(toGam(c), 1.0); return; }
  bool spatial = uMode == 0;

  // ---- noise reduction: small bilateral filter in gamma space (skipped while dragging)
  if (spatial && uDraft == 0 && (uNR.x > 0.0 || uNR.y > 0.0)) {
    vec3 cg = toGam(c); float L0 = lum(cg);
    vec3 accL = vec3(0.0); float wL = 0.0; vec3 accC = vec3(0.0); float wC = 0.0;
    float sig = mix(0.02, 0.16, uNR.x);
    for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
      vec3 n = toGam(S(uDx * float(i) + uDy * float(j)));
      float d = lum(n) - L0; float sp = exp(-float(i * i + j * j) / 4.5);
      float w = sp * exp(-d * d / (2.0 * sig * sig));
      accL += n * w; wL += w; accC += n * sp; wC += sp;
    }
    vec3 lumSm = accL / wL;
    vec3 outg = mix(cg, lumSm, uNR.x);
    // colour noise: keep this pixel's brightness, take the neighbourhood's colour
    vec3 chroma = accC / wC; chroma = chroma - lum(chroma) + lum(outg);
    outg = mix(outg, chroma, uNR.y * 0.9);
    c = pow((max(outg, 0.0) + 0.055) / 1.055, vec3(2.4));
  }

  // ---- per-pixel parameters: global + local masks
  float P[12];
  for (int k = 0; k < 12; k++) P[k] = uG[k];
  float wSel = 0.0;
  if (spatial) for (int i = 0; i < ${MAX_MASKS}; i++) {
    if (i >= uMaskN) break;
    float w = maskW(i, uv);
    if (i == uShowMask) wSel = w;
    if (w <= 0.0) continue;
    for (int k = 0; k < 12; k++) P[k] += w * uMA[i * 12 + k];
  }
  float exposure = P[0], contrast = P[1], highs = P[2], shads = P[3], whites = P[4], blacks = P[5];
  float temp = P[6], tint = P[7], satur = P[8], texture_ = P[9], clarity = P[10], dehaze = P[11];

  // ---- white balance and exposure (linear light)
  vec3 gains = exp(vec3(0.55 * temp, -0.45 * tint, -0.55 * temp));
  gains /= lum(gains);
  float ex = exp2(exposure);
  c *= gains * ex;
  // lens vignette correction (relative to the original frame)
  if (uLens.x != 0.0) {
    vec2 d = (uv - 0.5) * 2.0; d.x *= uSrcSize.x / max(uSrcSize.x, uSrcSize.y); d.y *= uSrcSize.y / max(uSrcSize.x, uSrcSize.y);
    float r = clamp(length(d) / 1.4142, 0.0, 1.0);
    c *= max(0.0, 1.0 + uLens.x * 1.4 * pow(r, mix(4.0, 1.2, uLens.y)));
  }

  // ---- local base brightness (pre-blurred copies of the source)
  vec3 bmLin = spatial ? textureLod(uBlurM, uv, 0.0).rgb * gains * ex : c;
  vec3 blLin = spatial ? textureLod(uBlurL, uv, 0.0).rgb * gains * ex : c;

  // dehaze: remove (or add) an airlight estimated from the large-scale dark channel
  if (dehaze != 0.0) {
    float A = min(blLin.r, min(blLin.g, blLin.b));
    if (dehaze > 0.0) { float t = dehaze * 0.85 * clamp(A, 0.0, 0.9); c = max(c - t, 0.0) / max(1.0 - t, 0.15); bmLin = max(bmLin - t, 0.0) / max(1.0 - t, 0.15); blLin = max(blLin - t, 0.0) / max(1.0 - t, 0.15); }
    else { vec3 haze = vec3(lum(blLin) * 0.5 + 0.35); c = mix(c, haze, -dehaze * 0.45); }
  }

  // ---- tone (gamma space)
  vec3 g = toGam(c);
  float Lb = toGam1(lum(bmLin)); float LL = toGam1(lum(blLin));
  // shadows / highlights act on the local base, so detail inside the region is kept
  float wS = pow(1.0 - smoothstep(0.0, 0.62, Lb), 2.0);
  float wH = pow(smoothstep(0.32, 1.0, Lb), 1.6);
  g *= exp2(shads * 1.3 * wS + highs * 1.1 * wH);
  // whites / blacks: move the ends
  g += whites * 0.28 * g * smoothstep(0.3, 1.05, g);
  g += blacks * 0.14 * (1.0 - smoothstep(0.0, 0.5, g));
  g = vec3(shoulder(g.r), shoulder(g.g), shoulder(g.b));
  g = clamp(g, 0.0, 1.0);
  // contrast: S-curve around the midpoint
  vec3 sc = mix(2.0 * g * g, 1.0 - 2.0 * (1.0 - g) * (1.0 - g), step(0.5, g));
  g = clamp(g + contrast * 0.9 * (sc - g), 0.0, 1.0);

  float L = lum(g);
  float midw = 1.0 - pow(abs(2.0 * L - 1.0), 2.0);
  if (spatial) {
    // clarity: large-radius local contrast; texture: medium detail; sharpening: fine detail
    g += clarity * 0.9 * (L - LL) * midw;
    if (texture_ != 0.0 || uSharp.x > 0.0) {
      float st = max(1.0, 2.5 * uPxScale);
      vec2 ax = uDx * st; vec2 ay = uDy * st;
      float Lc = lum(toGam(S(vec2(0.0))));
      float Lt = (lum(toGam(S(ax))) + lum(toGam(S(-ax))) + lum(toGam(S(ay))) + lum(toGam(S(-ay)))) * 0.15
        + (lum(toGam(S(ax + ay))) + lum(toGam(S(ax - ay))) + lum(toGam(S(-ax + ay))) + lum(toGam(S(-ax - ay)))) * 0.1;
      if (texture_ != 0.0) g += texture_ * 1.4 * (Lc - Lt) * midw;
      if (uSharp.x > 0.0) {
        float sr = max(1.0, uSharp.y * uPxScale);
        vec2 bx = uDx * sr; vec2 by = uDy * sr;
        float n1 = lum(toGam(S(bx))); float n2 = lum(toGam(S(-bx))); float n3 = lum(toGam(S(by))); float n4 = lum(toGam(S(-by)));
        float blur = (n1 + n2 + n3 + n4 + Lc * 4.0) / 8.0;
        float edge = abs(n1 - n2) + abs(n3 - n4);
        float m = smoothstep(uSharp.w * 0.12, uSharp.w * 0.12 + 0.02, edge);
        float d = Lc - blur;
        d = sign(d) * pow(abs(d), mix(1.25, 0.85, uSharp.z));   // detail: how much fine texture is boosted
        g += uSharp.x * 2.2 * d * m * min(1.0, uPxScale * 1.5);
      }
    }
  }
  g = clamp(g, 0.0, 1.0);

  // ---- colour: vibrance / saturation
  L = lum(g);
  float mx = max(g.r, max(g.g, g.b)); float mn = min(g.r, min(g.g, g.b)); float sat = mx - mn;
  vec3 hsv0 = rgb2hsv(g);
  float skin = 1.0 - smoothstep(0.0, 0.08, abs(hsv0.x - 0.07)) * 0.5;
  float vib = uVib * (1.0 - sat) * skin;
  g = L + (g - L) * max(0.0, 1.0 + satur + vib + max(dehaze, 0.0) * 0.2);
  g = clamp(g, 0.0, 1.0);

  // ---- HSL / colour mixer
  vec3 hsv = rgb2hsv(g);
  float bw[8]; bandWeights(hsv.x * 360.0, bw);
  float dh = 0.0; float ds = 0.0; float dl = 0.0; float dg = 0.0;
  for (int i = 0; i < 8; i++) { dh += bw[i] * uHslH[i]; ds += bw[i] * uHslS[i]; dl += bw[i] * uHslL[i]; dg += bw[i] * uGray[i]; }
  if (uBW == 1) {
    float gl = lum(g) * (1.0 + dg * 0.9 * hsv.y);
    g = vec3(clamp(gl, 0.0, 1.0));
  } else if (dh != 0.0 || ds != 0.0 || dl != 0.0) {
    hsv.x = fract(hsv.x + dh * 30.0 / 360.0);
    hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
    hsv.z = clamp(hsv.z * (1.0 + dl * 0.6 * hsv.y), 0.0, 1.0);
    g = hsv2rgb(hsv);
  }

  // ---- tone curve (parametric → RGB point curve → per channel)
  g = vec3(curveAt(g.r, 0), curveAt(g.g, 1), curveAt(g.b, 2));

  // ---- colour grading
  L = lum(g);
  float pivot = 0.5 - uGrBB.y * 0.25; float bl = mix(0.15, 0.95, uGrBB.x);
  float wSh = 1.0 - smoothstep(max(0.0, pivot - bl * 0.5), pivot + bl * 0.25, L);
  float wHi = smoothstep(pivot - bl * 0.25, min(1.0, pivot + bl * 0.5), L);
  float wMi = clamp(1.0 - wSh - wHi, 0.0, 1.0) + min(wSh, wHi);
  g += wSh * (uGrShT + uGrL.x) + wMi * (uGrMiT + uGrL.y) + wHi * (uGrHiT + uGrL.z) + uGrGlT + uGrL.w;
  g = clamp(g, 0.0, 1.0);

  // ---- profile LUT (.cube)
  if (uLutAmt > 0.0) {
    vec3 lc = texture(uLut3, g * ((uLutN - 1.0) / uLutN) + 0.5 / uLutN).rgb;
    g = mix(g, lc, uLutAmt);
  }

  if (spatial) {
    // ---- post-crop vignette
    if (uVig.x != 0.0) {
      vec2 p = (q - 0.5) * 2.0;
      float ar = uOutSize.x / uOutSize.y;
      if (uVig.z > 0.0) p = mix(p, p * vec2(max(ar, 1.0), max(1.0 / ar, 1.0)) / max(max(ar, 1.0 / ar), 1.0), uVig.z) * mix(1.0, 1.0, uVig.z);
      float e = uVig.z < 0.0 ? mix(2.0, 8.0, -uVig.z) : 2.0;
      float d = pow(pow(abs(p.x), e) + pow(abs(p.y), e), 1.0 / e);
      float start = mix(0.1, 1.15, uVig.y) * (1.0 - uVig.w * 0.4);
      float v = smoothstep(start, start + 0.02 + uVig.w * 1.0, d);
      if (uVig.x < 0.0) {
        vec3 dark = g * (1.0 + uVig.x * v);
        g = mix(dark, g, uVigHi * smoothstep(0.55, 1.0, lum(g)) * v);
      } else g = mix(g, vec3(1.0), uVig.x * v);
    }
    // ---- grain (in source-pixel units, so it looks the same at every export size)
    if (uGrain.x > 0.0) {
      vec2 gp = q * uOutSize / (0.6 + uGrain.y * 3.0);
      float n = vnoise(gp) * (1.0 - uGrain.z * 0.6) + vnoise(gp * 2.7 + 17.0) * uGrain.z * 0.6;
      L = lum(g);
      g += (n - 0.5) * uGrain.x * 0.32 * (1.0 - abs(2.0 * L - 1.0) * 0.6);
    }
  }
  g = clamp(g, 0.0, 1.0);
  if (uClip == 1) {
    if (max(g.r, max(g.g, g.b)) >= 0.999) g = vec3(1.0, 0.1, 0.1);
    else if (max(g.r, max(g.g, g.b)) <= 0.002) g = vec3(0.1, 0.35, 1.0);
  }
  if (uShowMask >= 0) g = mix(g, vec3(1.0, 0.18, 0.12), wSel * 0.55);
  o = vec4(g, 1.0);
}`;
