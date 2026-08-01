// NIGHTLOOP road surface — the hero shader.
// Multi-scale procedural asphalt with wetness as a first-class surface state.
// PERIODIC INFINITE grid + motorway rows: MUST match src/city/cityPlan.js.
#include<sceneUboDeclaration>
#include<nlCommon>

varying vWorldPos : vec3f;
varying vNormal : vec3f;

uniform sunDir : vec3f;
uniform sunColor : vec3f;          // pre-multiplied by intensity
uniform ambientSky : vec3f;
uniform ambientGround : vec3f;
uniform fogColor : vec3f;
uniform fogDensity : f32;
uniform fogHeightFalloff : f32;
uniform wetness : f32;             // base wetness 0..1 (weather)
uniform puddleLevel : f32;         // 0..1 how full depressions are
uniform rainRate : f32;
uniform time : f32;
uniform glintIntensity : f32;
uniform reflStrength : f32;
uniform markingWear : f32;
uniform sunShadowMatrix : mat4x4<f32>;
uniform shadowMapSize : f32;
uniform shadowDV : vec2f;          // (shadowMinZ, shadowMaxZ) of the sun
uniform lightCount : f32;
uniform stateCenter : vec4f;       // xy = state buffer world center, z = half-extent, w = enabled
uniform headlight0 : vec4f;        // xyz pos, w intensity (0 = off)
uniform headlight1 : vec4f;
uniform headlightTip0 : vec4f;     // beam target point
uniform headlightTip1 : vec4f;

var asphaltAlbedo : texture_2d<f32>;
var asphaltAlbedoSampler : sampler;
var asphaltNormal : texture_2d<f32>;
var asphaltNormalSampler : sampler;
var asphaltRough : texture_2d<f32>;
var asphaltRoughSampler : sampler;
var mirrorTex : texture_2d<f32>;
var mirrorTexSampler : sampler;
var sunShadowMap : texture_2d<f32>;   // FILTER_NONE float map, depth metric in R (textureLoad only)
var stateTex : texture_2d<f32>;    // r: water cleared, g: unused, b: damp, a: rubber
var stateTexSampler : sampler;

struct RoadLight { posRadius : vec4f, colorIntensity : vec4f };
var<storage, read> roadLights : array<RoadLight>;

// ---- city plan constants (keep in sync with cityPlan.js) ----
const NL_PX : f32 = 200.0;
const NL_PZ : f32 = 160.0;
const NL_FACE : f32 = 4.45;
const NL_ROAD_HALF : f32 = 4.0;
const NL_MWAY_FACE : f32 = 12.45;
const NL_MWAY_HALF : f32 = 12.0;
const NL_MEDIAN : f32 = 1.0;
const NL_LANE_W : f32 = 3.5;
const NL_CORNER_R : f32 = 5.5;

struct RS {
  tA : f32, tB : f32,   // signed lateral offset from nearest N-S / E-W street
  sA : f32, sB : f32,   // along-street coordinate
  dA : f32, dB : f32,
  faceB : f32,          // E-W street curb face (motorways are wide)
  d : f32,              // SDF beyond curb face (<0 on asphalt)
  wB : f32,             // dominance of E-W street
  mwayB : f32,          // 1 when the E-W street is a motorway
  intT : f32,           // 0 far from crossing, 1 inside
};

fn isMwayRow(j : f32) -> f32 {
  let m = j - 4.0 * floor(j / 4.0);
  return select(0.0, 1.0, abs(m - 2.0) < 0.5);
}

// street curvature: world → grid domain warp (MUST match cityPlan.js warpOf)
fn nlWarp(p : vec2f) -> vec2f {
  let wx = 4.5 * sin(p.y * 0.0146126 + 0.9) + 2.0 * sin(p.y * 0.0299199 + 4.1);
  let wz = 4.0 * sin(p.x * 0.0161107 + 2.3) + 2.0 * sin(p.x * 0.0363201 + 0.7);
  return vec2f(p.x + wx, p.y + wz);
}

fn roadSpace(pw : vec2f) -> RS {
  var rs : RS;
  let p = nlWarp(pw);
  let iA = round(p.x / NL_PX);
  let iB = round(p.y / NL_PZ);
  rs.tA = p.x - iA * NL_PX; rs.sA = p.y;
  rs.tB = p.y - iB * NL_PZ; rs.sB = p.x;
  rs.mwayB = isMwayRow(iB);
  rs.faceB = mix(NL_FACE, NL_MWAY_FACE, rs.mwayB);
  let dA = abs(rs.tA) - NL_FACE;
  let dB = abs(rs.tB) - rs.faceB;
  rs.dA = dA; rs.dB = dB;
  var d = min(dA, dB);
  if (dA < NL_CORNER_R && dB < NL_CORNER_R && dA > 0.0 && dB > 0.0) {
    let fd = NL_CORNER_R - length(vec2f(NL_CORNER_R - dA, NL_CORNER_R - dB));
    d = min(d, fd);
  }
  rs.d = d;
  let aIn = (NL_FACE - abs(rs.tA)) / NL_FACE;
  let bIn = (rs.faceB - abs(rs.tB)) / rs.faceB;
  rs.wB = clamp(0.5 + (bIn - aIn) * 1.1, 0.0, 1.0);
  // in a periodic grid, distance to the crossing ALONG a street is just the
  // other street's lateral offset
  let ia = 1.0 - smoothstep(rs.faceB, rs.faceB + 2.0, abs(rs.tB));
  let ib = 1.0 - smoothstep(NL_FACE, NL_FACE + 2.0, abs(rs.tA));
  rs.intT = min(ia, ib);
  return rs;
}

// wheel-track wear, normal street (two lanes, tracks |t| = 1.2 and 2.8)
fn trackMask(at : f32) -> f32 {
  let d1 = at - 1.2;
  let d2 = at - 2.8;
  return exp(-d1 * d1 * 8.16) + exp(-d2 * d2 * 8.16);
}

// wheel-track wear, motorway: three lanes per carriageway, tracks ±0.8
// around each lane centre (lane u = 0..3.5 within the carriageway span)
fn trackMaskM(at : f32) -> f32 {
  if (at < NL_MEDIAN || at > NL_MWAY_HALF) { return 0.0; }
  let u = fract((at - NL_MEDIAN) / NL_LANE_W) * NL_LANE_W;
  let d1 = u - 0.95;
  let d2 = u - 2.55;
  return exp(-d1 * d1 * 8.16) + exp(-d2 * d2 * 8.16);
}

fn laneStain(at : f32) -> f32 {
  let d = at - 2.0;
  return exp(-d * d * 4.9); // oily band at lane centre
}

fn laneStainM(at : f32) -> f32 {
  if (at < NL_MEDIAN || at > NL_MWAY_HALF) { return 0.0; }
  let u = fract((at - NL_MEDIAN) / NL_LANE_W) * NL_LANE_W;
  let d = u - 1.75;
  return exp(-d * d * 4.9);
}

// ---- markings ----------------------------------------------------------
// Normal street markings. t across, s along, tX = crossing street's lateral
// offset (distance to the crossing), faceX its curb face, allowZebra kills
// crosswalks at motorway junctions.
fn axisMarkings(t : f32, s : f32, tX : f32, faceX : f32, inRoad : f32, erosion : f32, allowZebra : f32) -> f32 {
  if (inRoad < 0.001) { return 0.0; }
  let asInt = abs(tX);
  let notInt = smoothstep(faceX + 0.9, faceX + 2.2, asInt);
  var m = 0.0;
  // centre dashes: 2m dash / 4m gap, 0.12m wide
  let dash = step(fract(s / 6.0), 0.3333);
  m = max(m, (1.0 - smoothstep(0.05, 0.075, abs(t))) * dash * notInt);
  // edge lines at |t| = 3.72, 0.10m wide
  m = max(m, (1.0 - smoothstep(0.04, 0.062, abs(abs(t) - 3.72))) * notInt);
  // stop lines: 0.45m band on the approach half, just before the crossing
  let stopC = faceX + 1.97;
  let stopBand = 1.0 - smoothstep(0.0, 0.06, abs(asInt - stopC) - 0.225);
  let approachPos = step(0.0, tX) * step(0.2, -t) * step(-3.8, -abs(t));
  let approachNeg = step(0.0, -tX) * step(0.2, t) * step(-3.8, -abs(t));
  m = max(m, stopBand * (approachPos + approachNeg));
  // crosswalk zebra just outside the crossing
  let cwC = faceX + 0.25;
  let cw = step(cwC, asInt) * step(asInt, cwC + 1.4) * allowZebra;
  let zebra = step(fract(t / 0.9), 0.61);
  m = max(m, cw * zebra * step(abs(t), 3.9));
  return clamp(m - erosion, 0.0, 1.0);
}

// Motorway markings: lane-divider dashes (3m/6m) between the three lanes,
// solid edge lines beside median and outer gutter. No zebras, no stop lines.
fn mwayMarkings(t : f32, s : f32, tX : f32, erosion : f32) -> f32 {
  let at = abs(t);
  if (at < NL_MEDIAN - 0.2 || at > NL_MWAY_FACE) { return 0.0; }
  let notInt = smoothstep(NL_FACE + 0.9, NL_FACE + 2.2, abs(tX));
  var m = 0.0;
  // solid edges: median side 1.35, outer 11.65
  m = max(m, 1.0 - smoothstep(0.05, 0.075, abs(at - 1.35)));
  m = max(m, 1.0 - smoothstep(0.05, 0.075, abs(at - 11.65)));
  // lane dividers at |t| = 4.5 and 8.0, dashed 3m/6m
  let dash = step(fract(s / 9.0), 0.3333) * notInt;
  m = max(m, (1.0 - smoothstep(0.05, 0.075, abs(at - 4.5))) * dash);
  m = max(m, (1.0 - smoothstep(0.05, 0.075, abs(at - 8.0))) * dash);
  return clamp(m - erosion, 0.0, 1.0);
}

// ---- shadow ------------------------------------------------------------
fn shadowTap(ip : vec2<i32>, refM : f32) -> f32 {
  let stored = textureLoad(sunShadowMap, ip, 0).r;
  return select(0.0, 1.0, refM <= stored + 0.0011);
}

fn sampleSunShadow(wp : vec3f) -> f32 {
  let sp = uniforms.sunShadowMatrix * vec4f(wp, 1.0);
  let uv = vec2f(sp.x, sp.y) * 0.5 + vec2f(0.5);
  if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) { return 1.0; }
  let viewZ = sp.z * (uniforms.shadowDV.y - uniforms.shadowDV.x) + uniforms.shadowDV.x;
  let refM = (viewZ + uniforms.shadowDV.x) / (uniforms.shadowDV.x + uniforms.shadowDV.y);
  let sz = uniforms.shadowMapSize;
  let ip = vec2<i32>(uv * sz);
  var s = 0.0;
  s += shadowTap(ip, refM);
  s += shadowTap(ip + vec2<i32>( 1,  0), refM);
  s += shadowTap(ip + vec2<i32>(-1,  1), refM);
  s += shadowTap(ip + vec2<i32>(-1, -1), refM);
  s += shadowTap(ip + vec2<i32>( 1, -1), refM);
  s += shadowTap(ip + vec2<i32>( 2,  2), refM);
  s += shadowTap(ip + vec2<i32>(-2,  0), refM);
  s += shadowTap(ip + vec2<i32>( 0,  2), refM);
  s += shadowTap(ip + vec2<i32>( 0, -2), refM);
  return s / 9.0;
}

// ---- BRDF helpers ------------------------------------------------------
fn ggxIso(NdH : f32, a : f32) -> f32 {
  let a2 = a * a;
  let d = NdH * NdH * (a2 - 1.0) + 1.0;
  return min(a2 / max(3.14159 * d * d, 1e-6), 4000.0);
}

// anisotropic GGX along tangent/bitangent (clamped: HDR buffers are half-float,
// anything above ~6.5e4 becomes Inf and poisons the bloom chain)
fn ggxAniso(TdH : f32, BdH : f32, NdH : f32, at : f32, ab : f32) -> f32 {
  let d = TdH * TdH / (at * at) + BdH * BdH / (ab * ab) + NdH * NdH;
  return min(1.0 / max(3.14159 * at * ab * d * d, 1e-5), 4000.0);
}

fn fresnel(f0 : f32, VdH : f32) -> f32 {
  return f0 + (1.0 - f0) * pow(1.0 - VdH, 5.0);
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let wp = fragmentInputs.vWorldPos;
  let camPos = scene.vEyePosition.xyz;
  let V = normalize(camPos - wp);
  let dist = length(camPos - wp);
  let rs = roadSpace(wp.xz);

  let atA = abs(rs.tA);
  let atB = abs(rs.tB);
  let roadHalfB = rs.faceB - 0.45;
  let inA = 1.0 - smoothstep(NL_ROAD_HALF - 0.2, NL_FACE, atA);
  let inB = 1.0 - smoothstep(roadHalfB - 0.2, rs.faceB, atB);

  // ------------------------------------------------ masks
  let detailFade = 1.0 - smoothstep(14.0, 48.0, dist);   // fine detail gate
  let wearB = mix(trackMask(atB), trackMaskM(atB), rs.mwayB);
  let wear = clamp(trackMask(atA) * inA * (1.0 - rs.wB) + wearB * inB * rs.wB
             + rs.intT * 0.35, 0.0, 1.2);
  let stainB = mix(laneStain(atB), laneStainM(atB), rs.mwayB);
  let stain = laneStain(atA) * inA * (1.0 - rs.wB) + stainB * inB * rs.wB;
  let gutter = smoothstep(-0.5, -0.05, rs.d);            // near the curb line
  let edgeRavel = smoothstep(-1.1, -0.25, rs.d);         // coarser aggregate near edge

  // motorway median island (raised concrete, outside junctions)
  let medianMask = rs.mwayB * (1.0 - smoothstep(NL_MEDIAN - 0.15, NL_MEDIAN, atB))
                 * (1.0 - rs.intT) * inB;

  // patches: hashed rectangles in road space of the dominant street
  var sDom = rs.sA; var tDom = rs.tA;
  if (rs.wB > 0.5) { sDom = rs.sB; tDom = rs.tB; }
  let pcell = floor(sDom / 13.0);
  let pr = nlHash2v(vec2<i32>(i32(pcell), i32(select(0.0, 7.0, rs.wB > 0.5))));
  var patchM = 0.0;
  if (pr.x < 0.42) {
    let ps0 = pcell * 13.0 + 1.5 + pr.y * 4.0;
    let ps1 = ps0 + 3.5 + pr.x * 12.0;
    let pt0 = -3.9 + pr.y * 4.5;
    let pt1 = pt0 + 2.2 + pr.x * 3.5;
    let inS = step(ps0, sDom) * step(sDom, ps1);
    let inT = step(pt0, tDom) * step(tDom, pt1);
    patchM = inS * inT;
    let eS = min(sDom - ps0, ps1 - sDom);
    let eT = min(tDom - pt0, pt1 - tDom);
    let eb = 1.0 - smoothstep(0.0, 0.14, min(eS, eT));
    patchM = patchM * (1.0 + eb * 1.4);
  }
  patchM = patchM * (1.0 - rs.intT);

  // ------------------------------------------------ textures (multi-scale)
  let uv1 = wp.xz * 0.71;        // aggregate ~1.4 m tile
  let uv2 = wp.xz * 0.113;       // macro mottling ~8.8 m tile
  var baseCol = pow(textureSample(asphaltAlbedo, asphaltAlbedoSampler, uv1).rgb, vec3f(2.2));
  let macroCol = pow(textureSample(asphaltAlbedo, asphaltAlbedoSampler, uv2).rgb, vec3f(2.2));
  baseCol = mix(baseCol, macroCol, 0.55);
  var roughTex = textureSample(asphaltRough, asphaltRoughSampler, uv1).r;
  roughTex = mix(roughTex, textureSample(asphaltRough, asphaltRoughSampler, uv2).r, 0.4);

  // macro tone variation
  let tone = nlFbm3(wp.xz * 0.023);
  baseCol = baseCol * (0.72 + tone * 0.5);

  // ------------------------------------------------ albedo composition
  // desaturate the scan toward neutral asphalt grey, slight cool bias
  var albedo = mix(baseCol, vec3f(nlLuma(baseCol)), 0.55) * vec3f(0.88, 0.94, 1.06) * 0.92;
  albedo = albedo * (1.0 - wear * 0.28);                       // burnished tracks darker
  albedo = mix(albedo, albedo * vec3f(0.52, 0.5, 0.5), clamp(stain, 0.0, 1.0) * 0.75);
  albedo = mix(albedo, albedo * 0.62 + vec3f(0.012), clamp(patchM, 0.0, 1.0) * 0.8);
  albedo = mix(albedo, albedo * vec3f(0.78, 0.76, 0.72) + vec3f(0.02, 0.018, 0.014), gutter * 0.7); // gritty gutter
  // rubber / cleared-water / damp state buffer
  var stateS = vec4f(0.0);
  if (uniforms.stateCenter.w > 0.5) {
    let suv = (wp.xz - uniforms.stateCenter.xy) / uniforms.stateCenter.z * 0.5 + 0.5;
    stateS = textureSample(stateTex, stateTexSampler, suv);
    let inState = step(abs(suv.x - 0.5), 0.49) * step(abs(suv.y - 0.5), 0.49);
    stateS = stateS * inState;
    // NaN scrub — a poisoned texel must never black out the road
    stateS = select(stateS, vec4f(0.0), stateS != stateS);
  }
  albedo = mix(albedo, albedo * vec3f(0.32, 0.32, 0.34), clamp(stateS.a, 0.0, 1.0));

  // markings
  let erosionN = nlFbm3(wp.xz * 1.9);
  let erosion = clamp(uniforms.markingWear * (0.35 + wear * 0.9) * (0.4 + erosionN * 1.2), 0.0, 0.95);
  let allowZebra = 1.0 - rs.mwayB;
  let mA = axisMarkings(rs.tA, rs.sA, rs.tB, rs.faceB, inA * (1.0 - rs.wB * 0.7), erosion, allowZebra);
  let mBn = axisMarkings(rs.tB, rs.sB, rs.tA, NL_FACE, inB * (1.0 - (1.0 - rs.wB) * 0.7), erosion, allowZebra);
  let mBm = mwayMarkings(rs.tB, rs.sB, rs.tA, erosion) * inB;
  let mB = mix(mBn, mBm, rs.mwayB);
  let paint = max(mA, mB) * (1.0 - medianMask);
  let paintCol = vec3f(0.62, 0.62, 0.58);
  albedo = mix(albedo, paintCol, paint * 0.92);

  // median island: pale worn concrete
  albedo = mix(albedo, vec3f(0.30, 0.30, 0.29) * (0.8 + 0.4 * tone), medianMask * 0.9);

  // ------------------------------------------------ wetness / water
  // depression proxy — matches the CPU heightfield's settle + cross profile
  let settleN = (nlFbm3(wp.xz * 0.085) - 0.5) * 2.0;           // ±1
  var crossRel = 0.0;
  {
    let ca = clamp(atA, 0.0, NL_ROAD_HALF) / NL_ROAD_HALF;
    let hA = (1.0 - ca * ca) * inA * 0.055;
    // normal row crown OR motorway crossfall + raised median
    let cb = clamp(atB, 0.0, NL_ROAD_HALF) / NL_ROAD_HALF;
    let hBn = (1.0 - cb * cb) * 0.055;
    let run = clamp((atB - NL_MEDIAN) / (NL_MWAY_HALF - NL_MEDIAN), 0.0, 1.0);
    let hBm = 0.075 * (1.0 - run) + medianMask * 0.16;
    let hB = mix(hBn, hBm, rs.mwayB) * inB;
    crossRel = max(hA, hB);
  }
  let gutterDepth = gutter * 0.020;
  let potential = settleN * 0.028 + crossRel - gutterDepth;     // local relative height
  let waterLevel = uniforms.puddleLevel * 0.062 - 0.024;
  var waterDepth = clamp(waterLevel - potential, 0.0, 0.08);
  // state buffer: tyres clear water out of their path
  waterDepth = clamp(waterDepth * (1.0 - stateS.r), 0.0, 0.09);
  let waterMask = smoothstep(0.0015, 0.0075, waterDepth);
  let dampHalo = smoothstep(-0.012, 0.0015, waterLevel - potential) - waterMask; // damp rim around puddles

  var wet = clamp(uniforms.wetness + stateS.b, 0.0, 1.0);
  // patchy drying: crown sheds water first, gutters hold it, tracks keep film
  let dryVar = nlFbm3(wp.xz * 0.16 + vec2f(7.3, 2.9));
  wet = wet * (0.62 + 0.55 * dryVar);
  wet = clamp(wet - crossRel * 3.2 * (1.0 - wet * 0.5), 0.0, 1.0);
  wet = clamp(wet + gutter * 0.30 + dampHalo * 0.55 + wear * wet * 0.35, 0.0, 1.0);
  let wetF = smoothstep(0.05, 0.75, wet);

  // wet darkening (porosity absorption), stronger in gutter grime
  albedo = albedo * mix(1.0, 0.40, wetF * (1.0 - paint * 0.55));
  // standing water: absorption tint of substrate seen through depth
  let absorb = exp(-waterDepth * vec3f(34.0, 30.0, 26.0));
  albedo = mix(albedo, albedo * absorb * vec3f(0.85, 0.92, 1.0), waterMask);
  // damp halo grit
  albedo = mix(albedo, albedo * vec3f(0.72, 0.7, 0.68), clamp(dampHalo, 0.0, 1.0) * 0.4);

  // ------------------------------------------------ normal composition
  var N = normalize(fragmentInputs.vNormal);
  // texture samples hoisted out of branches (WGSL uniform-control-flow rule)
  var tnS = textureSample(asphaltNormal, asphaltNormalSampler, uv1).rgb * 2.0 - 1.0;
  let tn2S = textureSample(asphaltNormal, asphaltNormalSampler, wp.xz * 0.31).rgb * 2.0 - 1.0;
  if (detailFade > 0.01) {
    // shader-only micro undulation (2 mm @ ~45 cm)
    let e = 0.22;
    let h0 = nlValueNoise(wp.xz * 2.2);
    let hx = nlValueNoise((wp.xz + vec2f(e, 0.0)) * 2.2);
    let hz = nlValueNoise((wp.xz + vec2f(0.0, e)) * 2.2);
    let mAmp = 0.010 * detailFade * (1.0 - wear * 0.5);
    N = normalize(N + vec3f(-(hx - h0) / e * mAmp, 0.0, -(hz - h0) / e * mAmp));
    // aggregate normal map, two scales
    let tn = normalize(vec3f(tnS.xy + tn2S.xy * 0.6, tnS.z));
    var aggStr = 0.55 * detailFade;
    aggStr = aggStr * (1.0 - wear * 0.55);          // polished tracks
    aggStr = aggStr * (1.0 - paint * 0.75);         // paint fills aggregate
    aggStr = aggStr * (1.0 + edgeRavel * 0.5 + gutter * 0.4);
    aggStr = aggStr * (1.0 - wetF * 0.45);          // water fills pores
    aggStr = aggStr * (1.0 - waterMask);
    aggStr = aggStr * (1.0 - medianMask * 0.6);     // concrete is finer
    N = normalize(N + vec3f(tn.x, 0.0, tn.y) * aggStr);
  }

  // water surface normal: ripples + rain rings, replaces N where standing
  if (waterMask > 0.001) {
    var wn = vec2f(0.0);
    let flowDir = select(vec2f(1.0, 0.0), vec2f(0.0, 1.0), rs.wB < 0.5); // along street
    let fp = wp.xz * 3.1 + flowDir * uniforms.time * 0.35;
    let e2 = 0.16;
    let w0 = nlValueNoise(fp);
    wn = vec2f(nlValueNoise(fp + vec2f(e2, 0.0)) - w0, nlValueNoise(fp + vec2f(0.0, e2)) - w0) / e2;
    var rippleAmp = 0.025 + uniforms.rainRate * 0.08;
    // rain impact rings
    if (uniforms.rainRate > 0.01) {
      let cell = floor(wp.xz * 2.6);
      let rr = nlHash2v(vec2<i32>(cell));
      let phase = fract(uniforms.time * (0.8 + uniforms.rainRate * 1.8) + rr.x * 7.13);
      let ctr = (vec2f(rr.x, rr.y) - 0.5) * 0.36 + (cell + 0.5) / 2.6;
      let rd = length(wp.xz - ctr);
      let ringR = phase * 0.17;
      let ring = exp(-abs(rd - ringR) * 90.0) * (1.0 - phase) * step(rr.y, uniforms.rainRate);
      let rDir = normalize(wp.xz - ctr + vec2f(1e-4));
      wn = wn + rDir * ring * 6.0;
      rippleAmp = rippleAmp + 0.02;
    }
    let waterN = normalize(vec3f(wn.x * rippleAmp, 1.0, wn.y * rippleAmp));
    N = normalize(mix(N, waterN, waterMask));
  }

  // ------------------------------------------------ roughness / F0
  var rough = clamp(0.55 + roughTex * 0.45, 0.0, 1.0);
  rough = rough * (1.0 - wear * 0.30);
  rough = mix(rough, 0.62, patchM * 0.3);
  rough = mix(rough, rough * 0.75, paint);                  // paint slightly smoother
  rough = mix(rough, 0.10, wetF * (1.0 - paint * 0.3));     // wet collapse
  rough = mix(rough, 0.035, waterMask);                     // standing water
  rough = mix(rough, 0.30, clamp(stateS.a, 0.0, 1.0) * (1.0 - wetF)); // rubber glossier when dry
  rough = mix(rough, 0.85, medianMask * (1.0 - wetF));      // concrete island stays matte
  rough = clamp(rough + uniforms.rainRate * waterMask * 0.06, 0.03, 1.0);
  let f0 = mix(0.038, 0.021, waterMask);

  let NdV = clamp(dot(N, V), 1e-3, 1.0);
  let fresnelV = fresnel(f0, NdV);

  // ------------------------------------------------ lighting
  var col = vec3f(0.0);
  let L = -normalize(uniforms.sunDir);
  let NdL = clamp(dot(N, L), 0.0, 1.0);
  var shadow = 1.0;
  if (NdL > 0.001) { shadow = sampleSunShadow(wp); }

  // sun diffuse + spec
  col = col + albedo * uniforms.sunColor * NdL * shadow;
  {
    let H = normalize(L + V);
    let NdH = clamp(dot(N, H), 0.0, 1.0);
    let VdH = clamp(dot(V, H), 0.0, 1.0);
    let a = max(rough * rough, 0.002);
    let spec = ggxIso(NdH, a) * fresnel(f0, VdH) * NdL * shadow;
    col = col + uniforms.sunColor * spec * 0.25;
  }

  // hemisphere ambient
  let hemi = mix(uniforms.ambientGround, uniforms.ambientSky, N.y * 0.5 + 0.5);
  col = col + albedo * hemi;

  // ------------------------------------------------ planar reflection
  {
    let clip = scene.viewProjection * vec4f(wp, 1.0);
    var ruv = clip.xy / clip.w * vec2f(0.5, 0.5) + vec2f(0.5);
    // distort by surface normal (ripples bend the mirror)
    ruv = ruv + N.xz * (0.06 + waterMask * 0.10);
    let smoothT = 1.0 - smoothstep(0.05, 0.62, rough);
    if (smoothT > 0.002) {
      let lod = clamp(rough * 9.0 + dist * 0.006, 0.0, 6.5);
      var refl = textureSampleLevel(mirrorTex, mirrorTexSampler, ruv, lod).rgb;
      // slight vertical smear for the wet look
      refl = refl * 0.6 + textureSampleLevel(mirrorTex, mirrorTexSampler, ruv + vec2f(0.0, 0.018 * rough), lod + 1.2).rgb * 0.4;
      // NaN/garbage scrub — a poisoned mirror mip must never black a puddle
      refl = clamp(select(refl, vec3f(0.0), refl != refl), vec3f(0.0), vec3f(120.0));
      let w = fresnelV * smoothT * uniforms.reflStrength * (0.30 + 0.35 * wetF + 0.35 * waterMask);
      col = col + refl * w;
    }
  }

  // ------------------------------------------------ city lights
  var bestGlint = 0.0;
  var bestGlintDir = L;
  var bestGlintCol = uniforms.sunColor * shadow;
  // tangent frame for streak anisotropy: stretch along view azimuth
  let Bz = normalize(vec3f(V.x, 0.0, V.z) + vec3f(1e-4));
  let T = normalize(cross(vec3f(0.0, 1.0, 0.0), Bz));
  let count = i32(uniforms.lightCount);
  let streakAb = clamp(0.30 + (1.0 - wetF) * 0.5, 0.05, 1.0);   // wetter = longer streaks
  let streakAt = max(rough * rough * 0.6, 0.004);
  for (var i = 0; i < count; i = i + 1) {
    let lp = roadLights[i].posRadius;
    let lc = roadLights[i].colorIntensity;
    let toL = lp.xyz - wp;
    let d2 = dot(toL, toL);
    let radius = lp.w;
    if (d2 > radius * radius) { continue; }
    let ld = sqrt(d2);
    let Ln = toL / ld;
    let att = pow(1.0 - ld / radius, 2.2) / (1.0 + d2 * 0.035);
    let NdLl = clamp(dot(N, Ln), 0.0, 1.0);
    let lcol = lc.rgb * lc.w;
    // diffuse pool
    col = col + albedo * lcol * NdLl * att * 26.0;
    // wet streak specular (anisotropic GGX stretched along view azimuth)
    if (wetF > 0.02 || rough < 0.5) {
      let H = normalize(Ln + V);
      let NdH = clamp(dot(N, H), 0.0, 1.0);
      let TdH = dot(T, H);
      let BdH = dot(Bz, H);
      let spec = ggxAniso(TdH, BdH, NdH, streakAt, streakAb) * fresnel(f0, clamp(dot(V, H), 0.0, 1.0));
      let sc = spec * NdLl * att * (0.25 + wetF * 1.6);
      col = col + lcol * sc * 1.6;
      let g = nlLuma(lcol) * att * NdLl;
      if (g > bestGlint) { bestGlint = g; bestGlintDir = Ln; bestGlintCol = lcol * att; }
    }
  }

  // headlights: pools + retroreflective paint response
  for (var hi = 0; hi < 2; hi = hi + 1) {
    var hl : vec4f;
    var tip : vec4f;
    if (hi == 0) { hl = uniforms.headlight0; tip = uniforms.headlightTip0; }
    else { hl = uniforms.headlight1; tip = uniforms.headlightTip1; }
    if (hl.w < 0.01) { continue; }
    let toL = hl.xyz - wp;
    let ld = length(toL);
    if (ld > 42.0) { continue; }
    let Ln = toL / ld;
    let beamDir = normalize(tip.xyz - hl.xyz);
    let cone = pow(clamp(dot(-Ln, beamDir), 0.0, 1.0), 14.0);
    let att = cone * hl.w / (1.0 + ld * ld * 0.05);
    let NdLl = clamp(dot(N, Ln), 0.0, 1.0);
    let hcol = vec3f(1.0, 0.92, 0.78);
    col = col + albedo * hcol * NdLl * att * 2.0;
    // retroreflection: glass-bead paint lights up when viewer ≈ source
    let retroAlign = pow(clamp(dot(V, Ln), 0.0, 1.0), 60.0);
    col = col + hcol * paint * retroAlign * att * NdLl * 22.0;
    // streak
    let H = normalize(Ln + V);
    let spec = ggxAniso(dot(T, H), dot(Bz, H), clamp(dot(N, H), 0.0, 1.0), streakAt, streakAb);
    col = col + hcol * spec * fresnel(f0, clamp(dot(V, H), 0.0, 1.0)) * NdLl * att * wetF * 0.5;
  }

  // ------------------------------------------------ glints
  if (uniforms.glintIntensity > 0.001 && detailFade > 0.05) {
    let cell = floor(wp.xz * 140.0);
    let gr = nlHash2v(vec2<i32>(cell));
    if (gr.x > 0.93) {
      // micro-facet normal from hash, tight cone around N
      let mfn = normalize(N + vec3f(gr.x - 0.5, 0.0, gr.y - 0.5) * 0.9);
      let H = normalize(bestGlintDir + V);
      let alignment = clamp(dot(mfn, H), 0.0, 1.0);
      let grazing = pow(1.0 - NdV, 2.0);
      let nearFade = smoothstep(3.0, 9.0, dist);
      let sparkle = pow(alignment, 900.0) * grazing * (0.35 + wetF * 1.2) * (1.0 - waterMask);
      col = col + bestGlintCol * sparkle * uniforms.glintIntensity * 16.0 * detailFade * nearFade;
    }
  }

  // ------------------------------------------------ fog
  let fogT = nlFogFactor(camPos, wp, uniforms.fogDensity, uniforms.fogHeightFalloff);
  col = mix(uniforms.fogColor, col, fogT);

  // half-float safety: never emit Inf/NaN into the HDR chain. Any pixel that
  // still NaN'd upstream renders as fog instead of a black blob.
  col = select(col, uniforms.fogColor, col != col);
  col = clamp(col, vec3f(0.0), vec3f(120.0));
  fragmentOutputs.color = vec4f(col, 1.0);
}
