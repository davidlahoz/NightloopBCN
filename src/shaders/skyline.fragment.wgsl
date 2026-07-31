// NIGHTLOOP skyline fragment — near-silhouette tower mass with hash-lit
// window POINTS (fwidth-clamped to ~1-2 px, energy conserving), lit crowns,
// blinking aviation beacons on antenna spikes, and heavy aerial perspective:
// nlFogFactor toward fogColor plus an extra distance/height haze lift toward
// the horizon so the furthest ring is barely separable from the sky.
#include<nlCommon>

varying vWorld : vec3f;
varying vCam : vec3f;
varying vNormal : vec3f;
varying vFacade : vec2f;     // meters: u along face, v above tower base
varying vSeedH : vec2f;      // (seed 0..1, total height m)
varying vFaceWRing : vec2f;  // (face width m, ring)
varying vTower : vec4f;      // (litDensity, warmth, kind, extra)

uniform fogColor : vec3f;
uniform hazeColor : vec3f;   // env horizonHaze
uniform bodyColor : vec3f;   // precomputed dark atmosphere-tinted mass color
uniform sunDir : vec3f;
uniform sunTint : vec3f;     // premultiplied dusk rim color (0 at night)
uniform fogDensity : f32;
uniform fogHeightFalloff : f32;
uniform windowLitFraction : f32;
uniform windowEmission : f32;
uniform beaconIntensity : f32;
uniform exposure : f32;
uniform time : f32;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let world = fragmentInputs.vWorld;
  let cam = fragmentInputs.vCam;
  let n = normalize(fragmentInputs.vNormal);
  let facU = fragmentInputs.vFacade.x;
  let facV = fragmentInputs.vFacade.y;
  let seed = fragmentInputs.vSeedH.x;
  let totH = fragmentInputs.vSeedH.y;
  let faceW = fragmentInputs.vFaceWRing.x;
  let ring = fragmentInputs.vFaceWRing.y;
  let litDensity = fragmentInputs.vTower.x;
  let towerWarm = fragmentInputs.vTower.y;
  let kind = fragmentInputs.vTower.z;   // 0 facade, 3 antenna spike
  let extra = fragmentInputs.vTower.w;  // crown-lit (facade) / beacon flag (antenna)

  let dist = length(world - cam);
  let seedI = i32(seed * 8191.0);

  // ---------------- body: very dark blue-grey mass, never flat ----------------
  let hFrac = clamp(facV / max(totH, 1.0), 0.0, 1.0);
  var body = uniforms.bodyColor * (0.70 + 0.55 * nlHash2(vec2<i32>(seedI, 17)));
  // slight per-tower hue drift so adjacent silhouettes separate
  let hueJ = nlHash2(vec2<i32>(seedI, 77)) - 0.5;
  body = body * vec3f(1.0 + hueJ * 0.18, 1.0, 1.0 - hueJ * 0.14);
  // sky-bounce vertical gradient (tops read lighter against the haze band)
  body = body * (0.78 + 0.55 * hFrac);
  // facade panel/dirt streaking
  let streak = nlValueNoise(vec2f(facU * 0.33 + seed * 173.0, facV * 0.055 + seed * 61.0));
  body = body * (0.82 + 0.36 * streak);
  // corner shading gives the box impostors a 3D read
  let edgeD = min(facU, faceW - facU);
  body = body * (0.72 + 0.28 * smoothstep(0.0, 2.2, edgeD));
  // antenna spikes are darker slivers
  body = body * select(1.0, 0.45, kind > 2.5);
  // dusk rim on sun-facing facades (sunTint -> 0 below horizon)
  let sunSide = clamp(dot(n, -uniforms.sunDir), 0.0, 1.0);
  body = body + uniforms.sunTint * (0.35 * sunSide + 0.65 * pow(sunSide, 3.0));

  // ---------------- window grid: hash-lit points of light ----------------
  let colW = 2.4 + 1.5 * nlHash2(vec2<i32>(seedI, 31));
  let floorH = 3.05 + 0.95 * nlHash2(vec2<i32>(seedI, 47));
  let gx = facU / colW;
  let gy = facV / floorH;
  let cellX = i32(floor(gx));
  let cellY = i32(floor(gy));
  // decorrelate columns per face while keeping floor rows shared around the tower
  let faceId = i32(round(n.x) * 2.0 + round(n.z) * 3.0);
  let wh = nlHash2v(vec2<i32>(cellX * 7 + faceId * 131 + seedI * 3, cellY * 29 + seedI));
  // per-floor activity: lit windows clump into busy floors and dead floors
  let floorAct = nlHash2(vec2<i32>(cellY + seedI * 5, seedI - 991));
  var density = litDensity * uniforms.windowLitFraction * (0.22 + 1.65 * floorAct * floorAct);
  // lit crowns: dense band on the top floors of a few towers
  let crown = extra * step(kind, 0.5);
  let crownBand = smoothstep(totH - 8.0, totH - 2.5, facV) * crown;
  density = max(density, crownBand * 0.8);
  let lit = step(wh.x, clamp(density, 0.0, 0.93));

  // point shaping: physical 0.4 m core clamped to ~1 px, coverage-compensated
  // so far windows dim instead of shimmering
  let lx = (fract(gx) - 0.5) * colW;
  let ly = (fract(gy) - 0.56) * floorH;
  let r = length(vec2f(lx, ly * 1.35));
  let pixM = fwidth(facU) + fwidth(facV); // ~facade meters per pixel
  let rad = max(0.40, pixM * 0.9);
  let pt = 1.0 - smoothstep(rad * 0.30, rad, r);
  let cov = clamp(0.40 / rad, 0.0, 1.0);
  let margin = step(0.9, edgeD) * step(2.0, facV) * step(facV, totH - 1.1);
  let warm = clamp(towerWarm + (wh.y - 0.5) * 0.5, 0.0, 1.0);
  let wcol = mix(vec3f(0.60, 0.76, 1.05), vec3f(1.06, 0.70, 0.36), warm);
  let bright = 0.30 + 1.25 * wh.y * wh.y + step(0.985, wh.y) * 1.8;
  let ringDim = 1.0 / (1.0 + ring * 0.45);
  var emit = wcol * (lit * pt * cov * cov * bright * margin * ringDim
                     * uniforms.windowEmission * step(kind, 0.5));
  // soft crown wash above the dense band
  emit = emit + vec3f(0.55, 0.75, 1.0) * (crownBand * 0.10 * uniforms.windowEmission * ringDim);

  // ---------------- aviation beacon at flagged antenna tips ----------------
  let isBeacon = step(2.5, kind) * step(0.5, extra);
  let br = length(vec2f(facU - faceW * 0.5, facV - (totH - 0.55)));
  let brad = max(0.30, pixM * 0.9);
  let bpt = 1.0 - smoothstep(brad * 0.25, brad, br);
  let bcov = clamp(0.30 / brad, 0.0, 1.0);
  let blink = pow(0.5 + 0.5 * sin(uniforms.time * 2.05 + seed * 51.0), 7.0);
  emit = emit + vec3f(1.0, 0.055, 0.04) * (isBeacon * bpt * bcov * bcov
              * (0.10 + 1.9 * blink) * uniforms.beaconIntensity);

  var col = body + emit;

  // ---------------- aerial perspective: the skyline sits IN the atmosphere ----
  let fogT = nlFogFactor(cam, world, uniforms.fogDensity, uniforms.fogHeightFalloff);
  // extra horizon-haze lift: distance-driven, scales with fogDensity so the
  // fogbank state erases the skyline entirely and smoothly
  let hazeAmt = 1.0 - exp(-dist * (0.00095 + uniforms.fogDensity * 0.42));
  // low fragments melt toward fogColor, high ones toward the horizon haze band
  let hTarget = mix(uniforms.fogColor, uniforms.hazeColor,
                    clamp(world.y * 0.0055 + 0.25, 0.0, 1.0));
  col = mix(col, hTarget, hazeAmt);   // contrast compresses hard with distance
  col = mix(uniforms.fogColor, col, fogT);

  fragmentOutputs.color = vec4f(col * uniforms.exposure, 1.0);
}
