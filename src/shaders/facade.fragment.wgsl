// NIGHTLOOP facade fragment — ONE material for every building plus neon signs.
// Fully procedural at facade-metre scale: window grids with lit interiors,
// storefront bands, wall weathering, membrane roofs, neon tube signs.
//
// vMeta = (buildingSeed, flags, facadeWidth_m, wallTopV_m). Flag bits:
//   0..2 style | 8 roof | 16 street-front | 32 neon quad | 64 flicker | 128 trim
//
// All fwidth() calls happen up-front in uniform control flow; every later
// anti-aliasing width is derived analytically from those, so the shader stays
// clean under WGSL derivative-uniformity analysis.
#include<nlCommon>
#include<sceneUboDeclaration>

varying vWorld : vec3f;
varying vNormal : vec3f;
varying vFacadeUV : vec2f;
varying vMeta : vec4f;

uniform sunDir : vec3f;
uniform sunColor : vec3f;
uniform sunIntensity : f32;
uniform ambientSky : vec3f;
uniform ambientGround : vec3f;
uniform ambientIntensity : f32;
uniform fogColor : vec3f;
uniform fogDensity : f32;
uniform fogHeightFalloff : f32;
uniform exposure : f32;
uniform neonIntensity : f32;
uniform windowLitFraction : f32;
uniform time : f32;
uniform sunShadowMatrix : mat4x4<f32>;
uniform shadowDV : vec2f;
uniform shadowMapSize : f32;

var sunShadowMap : texture_2d<f32>;   // FILTER_NONE float map (textureLoad only)

const GF_H : f32 = 4.5;   // ground/storefront band height in facade metres

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let world = fragmentInputs.vWorld;
  let n = normalize(fragmentInputs.vNormal);
  let u = fragmentInputs.vFacadeUV.x;
  let v = fragmentInputs.vFacadeUV.y;
  let seed = fragmentInputs.vMeta.x;
  let flags = u32(fragmentInputs.vMeta.y + 0.5);
  let facadeW = fragmentInputs.vMeta.z;
  let topV = fragmentInputs.vMeta.w;

  let style = flags & 7u;
  let isRoof = (flags & 8u) != 0u;
  let isFront = (flags & 16u) != 0u;
  let isNeon = (flags & 32u) != 0u;
  // district character (flag bits 8-9): 0 commercial, 1 residential warm
  // brick, 2 downtown cool glass, 3 industrial drab
  let dTint = (flags >> 8u) & 3u;
  let doFlicker = (flags & 64u) != 0u;
  let isTrim = (flags & 128u) != 0u;

  // -- derivatives, uniform control flow only ------------------------------
  let aaU = max(fwidth(u), 0.0012);
  let aaV = max(fwidth(v), 0.0012);
  let aaW = max(fwidth(world.x) + fwidth(world.z), 0.0012);

  let eye = scene.vEyePosition.xyz;
  let viewDir = normalize(world - eye);
  let iseed = i32(seed * 8191.0);
  let detailFade = clamp(1.0 - aaV * 8.0, 0.0, 1.0);

  var albedo = vec3f(0.1, 0.1, 0.1);
  var emis = vec3f(0.0, 0.0, 0.0);

  if (isNeon) {
    // ---------- neon sign quad; vMeta.zw = sign width / height ------------
    let sw = max(facadeW, 0.001);
    let sh = max(topV, 0.001);
    var pals = array<vec3f, 4>(
      vec3f(0.10, 1.00, 0.85),   // teal
      vec3f(1.00, 0.16, 0.72),   // magenta
      vec3f(1.00, 0.42, 0.10),   // orange
      vec3f(1.00, 0.10, 0.12)    // red
    );
    let pcol = pals[u32(seed * 3.999)];
    var flick = 1.0;
    if (doFlicker) {
      let t = uniforms.time;
      let buzz = nlValueNoise(vec2f(t * 9.0, seed * 90.0));
      let drop = step(0.94, nlValueNoise(vec2f(t * 2.1 + 7.0, seed * 40.0)));
      flick = clamp(0.86 + 0.14 * buzz - drop * 0.55, 0.15, 1.0);
    }
    // border tube 0.15 m inside the edge
    let eb = min(min(u, sw - u), min(v, sh - v));
    let aaE = max(aaU, aaV);
    let tube = 1.0 - smoothstep(0.05, 0.08 + aaE * 2.0, abs(eb - 0.15));
    // abstract tube lettering along the long axis
    var lu = u; var lv = v; var ls = sw; var cs = sh;
    if (sh > sw) { lu = v; lv = u; ls = sh; cs = sw; }
    let cw = clamp(cs * 0.42, 0.30, 0.62);
    let ci = floor((lu - 0.42) / cw);
    let nGl = floor((ls - 0.84) / cw);
    var glyph = 0.0;
    if (ci >= 0.0 && ci < nGl) {
      let gr = nlHash2v(vec2<i32>(i32(ci) + iseed, 11));
      let gx = fract((lu - 0.42) / cw);
      let inV = step(cs * (0.30 - 0.06 * gr.y), lv) * step(lv, cs * (0.72 + 0.05 * gr.x));
      glyph = step(0.14, gx) * step(gx, 0.86) * step(0.18, gr.x) * inV;
    }
    let halo = exp(-abs(eb - 0.15) * 3.0) * 0.20;
    emis = pcol * ((tube * 1.7 + glyph * 2.5 + halo) * uniforms.neonIntensity * flick);
    albedo = vec3f(0.020, 0.020, 0.026);

  } else if (isRoof) {
    // ---------- roof membrane / rooftop clutter ---------------------------
    let rn = nlFbm3(world.xz * 0.33 + vec2f(seed * 19.0, seed * 7.0));
    var ra = mix(vec3f(0.050, 0.050, 0.056), vec3f(0.088, 0.084, 0.079), rn);
    ra = ra * (0.82 + 0.36 * nlValueNoise(world.xz * 6.5));
    // membrane roll seams, fading out with distance
    let seam = fract(world.x * 0.3448);
    let sd = min(seam, 1.0 - seam) * 2.9;
    let seamLine = (1.0 - smoothstep(0.02, 0.05 + aaW * 2.0, sd)) * clamp(1.0 - aaW * 5.0, 0.0, 1.0);
    ra = ra + vec3f(0.020, 0.019, 0.018) * seamLine;
    // vertical faces (AC units, tanks, bulkheads, sign frames): weathered metal
    let vertF = 1.0 - clamp(n.y * 2.2, 0.0, 1.0);
    let mt = 0.75 + 0.5 * nlValueNoise(vec2f(u, v) * 1.9 + vec2f(seed * 43.0, 0.0));
    ra = mix(ra, vec3f(0.095, 0.100, 0.108) * mt, vertF);
    ra = ra * (1.0 - vertF * 0.35 * nlValueNoise(vec2f(u * 3.1 + seed * 77.0, 1.0)));
    albedo = ra;

  } else {
    // ---------- facade wall ------------------------------------------------
    var floorHs = array<f32, 6>(3.0, 3.2, 3.6, 3.05, 3.45, 3.25);
    var cellWs = array<f32, 6>(1.70, 2.20, 2.60, 1.55, 2.00, 2.35);
    var winFs = array<f32, 6>(0.52, 0.62, 0.72, 0.46, 0.55, 0.66);
    let floorH = floorHs[style];
    let cellW = cellWs[style];
    let winF = winFs[style];

    // per-building wall albedo: brick red-browns, warm greys, muted ochres
    var wallPal = array<vec3f, 6>(
      vec3f(0.300, 0.160, 0.115),
      vec3f(0.235, 0.125, 0.100),
      vec3f(0.270, 0.255, 0.235),
      vec3f(0.345, 0.325, 0.295),
      vec3f(0.330, 0.260, 0.155),
      vec3f(0.215, 0.175, 0.140)
    );
    let pi0 = u32(seed * 5.999);
    let pi1 = (pi0 + 2u + (u32(seed * 97.0) % 3u)) % 6u;
    var wall = mix(wallPal[pi0], wallPal[pi1], fract(seed * 13.7) * 0.5);
    // district palette shift
    var dPal = array<vec3f, 4>(
      vec3f(1.00, 1.00, 1.00),   // commercial: as authored
      vec3f(1.14, 0.94, 0.82),   // residential: warm brick
      vec3f(0.80, 0.86, 1.00),   // downtown: cool concrete/glass
      vec3f(0.90, 0.89, 0.84),   // industrial: drab
    );
    wall = wall * dPal[dTint];
    // large-scale tone drift + fine material grain
    let tone = nlFbm3(vec2f(u * 0.045 + seed * 61.0, v * 0.045));
    wall = wall * (0.84 + 0.34 * tone);
    wall = wall * (0.93 + 0.14 * nlValueNoise(vec2f(u, v) * 3.4));
    // brick coursing on masonry styles, gone at distance
    if (style == 0u || style == 1u || style == 5u) {
      let course = fract(v * 2.985);
      let cl = 1.0 - smoothstep(0.06, 0.18, min(course, 1.0 - course));
      wall = wall * (1.0 - 0.09 * cl * detailFade);
    }
    // grime: dark base, sooty streaks under the parapet
    let baseGrime = (1.0 - smoothstep(0.0, 3.2, v)) * 0.38;
    let streaks = 0.55 + 0.45 * nlValueNoise(vec2f(u * 1.9 + seed * 31.0, 2.0));
    let topGrime = smoothstep(topV - 3.0, topV - 0.2, v) * 0.30 * streaks;
    wall = wall * (1.0 - clamp(baseGrime + topGrime, 0.0, 0.55));
    albedo = wall;

    if (isTrim) {
      // cornice / parapet bands: painted stone, no windows
      albedo = mix(albedo, vec3f(0.30, 0.28, 0.25) * (0.75 + 0.4 * tone), 0.30);

    } else if (v > GF_H) {
      // thin floor-slab shadow lines
      let flm = fract((v - GF_H) / floorH) * floorH;
      let slab = 1.0 - smoothstep(0.04, 0.15, min(flm, floorH - flm));
      albedo = albedo * (1.0 - 0.16 * slab * detailFade);

      if (v < topV - 0.55) {
        // ---- window grid in facade metres, centred on the facade ----
        let nCol = max(1.0, floor((facadeW - 1.5) / cellW));
        let u0 = (facadeW - nCol * cellW) * 0.5;
        let cu = (u - u0) / cellW;
        let col = floor(cu);
        let rowF = (v - GF_H) / floorH;
        let row = floor(rowF);
        let rowTop = GF_H + (row + 1.0) * floorH;
        if (cu >= 0.0 && cu < nCol && rowTop < topV - 0.35) {
          let wpx = fract(cu) * cellW;
          let wpy = fract(rowF) * floorH;
          let winW = cellW * winF;
          let winH = floorH - 1.4;
          let wu = (wpx - (cellW - winW) * 0.5) / winW;
          let wv = (wpy - 0.85) / winH;
          let eU = clamp(aaU / winW, 0.01, 0.5);
          let eV = clamp(aaV / winH, 0.01, 0.5);
          let mask = smoothstep(-eU, eU, wu) * (1.0 - smoothstep(1.0 - eU, 1.0 + eU, wu))
                   * smoothstep(-eV, eV, wv) * (1.0 - smoothstep(1.0 - eV, 1.0 + eV, wv));
          // dark recessed frame ring around the glass
          let fz = smoothstep(-0.20, -0.02, wu) * (1.0 - smoothstep(1.02, 1.20, wu))
                 * smoothstep(-0.24, -0.02, wv) * (1.0 - smoothstep(1.02, 1.24, wv));
          let ring = clamp(fz - mask, 0.0, 1.0);
          albedo = mix(albedo, albedo * 0.35, ring * detailFade);

          let wid = vec2<i32>(i32(col) + iseed * 7, i32(row) + iseed * 13);
          let wr = nlHash2v(wid);
          let wr2 = nlHash2v(wid + vec2<i32>(517, 217));
          // per-building occupancy clustering: some buildings glow, some sleep;
          // districts modulate it (offices blaze, warehouses sleep)
          var dLit = array<f32, 4>(1.0, 0.7, 1.35, 0.3);
          let bldOcc = (0.35 + 1.15 * nlHash2(vec2<i32>(iseed, 4441))) * dLit[dTint];
          let lit = step(wr.x, uniforms.windowLitFraction * bldOcc);
          let gridFade = 1.0 - smoothstep(0.25, 0.70, aaU / cellW);

          // lit interior: warm/cool temperature, vignette, blinds
          let wcol = mix(vec3f(0.70, 0.80, 1.00), vec3f(1.00, 0.70, 0.40), pow(wr.y, 0.55));
          let bright = 0.35 + 1.5 * wr2.x * wr2.x;
          let vig = smoothstep(0.0, 0.16, wu) * (1.0 - smoothstep(0.84, 1.0, wu))
                  * smoothstep(0.0, 0.10, wv) * (1.0 - smoothstep(0.80, 1.0, wv));
          var inter = (0.45 + 0.55 * vig) * (1.0 - 0.30 * clamp(wv, 0.0, 1.0));
          if (wr2.y < 0.38) {
            let blindY = 0.32 + 0.5 * fract(wr2.y * 9.2);
            inter = inter * mix(1.0, 0.20, smoothstep(blindY - 0.06, blindY + 0.03, wv));
          }
          let litEm = wcol * (bright * inter * 0.8);

          // unlit glass: dark, sheen tinted by sky ambient at grazing angles
          let sheen = pow(clamp(1.0 - abs(dot(viewDir, n)), 0.0, 1.0), 4.0);
          let glassAlb = vec3f(0.020, 0.024, 0.032) * (0.8 + 0.5 * wr.y);
          let glassEm = uniforms.ambientSky * (uniforms.ambientIntensity * (0.03 + 0.14 * sheen));

          albedo = mix(albedo, mix(glassAlb, vec3f(0.012, 0.012, 0.012), lit), mask * gridFade);
          emis = emis + mix(glassEm, litEm, lit) * (mask * gridFade);
          // far away the grid collapses to an average glow so towers stay alive
          let areaFrac = winF * winH / floorH;
          emis = emis + vec3f(0.95, 0.72, 0.47) *
                 (uniforms.windowLitFraction * 0.75 * areaFrac * (1.0 - gridFade));
        }
      }

    } else {
      // ---- ground floor ----
      if (isFront) {
        // storefront band: tall glazing, fascia sign strip, occasional shutter
        let sf = nlHash2v(vec2<i32>(iseed, 91));
        let sf2 = nlHash2v(vec2<i32>(iseed, 173));
        let nBay = max(1.0, floor(facadeW / (4.0 + sf.y * 1.8)));
        let bayW = facadeW / nBay;
        let bu = fract(u / bayW) * bayW;
        let bx = bu / bayW;
        let pier = 0.52;
        let gU = smoothstep(pier, pier + 0.06 + aaU * 2.0, bu) *
                 (1.0 - smoothstep(bayW - pier - 0.06 - aaU * 2.0, bayW - pier, bu));
        let gV = smoothstep(0.50, 0.62, v) * (1.0 - smoothstep(3.10, 3.22, v));
        let glassM = gU * gV;
        let fasciaM = smoothstep(3.34, 3.46, v) * (1.0 - smoothstep(4.12, 4.24, v));
        let litShop = step(sf.x, 0.44);
        let shut = step(0.86, sf.x);
        var shopPal = array<vec3f, 5>(
          vec3f(1.00, 0.88, 0.66),
          vec3f(1.00, 0.76, 0.46),
          vec3f(0.80, 0.90, 1.00),
          vec3f(1.00, 0.62, 0.55),
          vec3f(0.98, 0.92, 0.78)
        );
        let scol = shopPal[u32(sf2.x * 4.999)];
        var shopAlb = wall * 0.9;
        var shopEm = vec3f(0.0, 0.0, 0.0);
        if (shut > 0.5) {
          // closed roller shutter: horizontal corrugation + staining
          let cor = 0.82 + 0.18 * (0.5 + 0.5 * sin(v * 19.0));
          let stain = 0.8 + 0.4 * nlValueNoise(vec2f(u * 0.7 + seed * 23.0, v * 0.7));
          let shutM = gU * smoothstep(0.18, 0.30, v) * (1.0 - smoothstep(3.10, 3.22, v));
          shopAlb = mix(shopAlb, vec3f(0.085, 0.085, 0.090) * (cor * stain), shutM);
        } else {
          let vigS = smoothstep(0.02, 0.22, bx) * (1.0 - smoothstep(0.78, 0.98, bx));
          let vGrad = 1.0 - 0.28 * smoothstep(0.6, 3.1, v);
          let pane = fract(u * 0.8696);
          let pd = min(pane, 1.0 - pane) * 1.15;
          let paneL = 1.0 - smoothstep(0.03, 0.06 + aaU, pd);
          let dimF = mix(0.08, 1.0, litShop);
          // interior breakup: shelves/displays block parts of the glazing
          let breakup = 0.30 + 0.70 * nlValueNoise(vec2f(u * 0.85 + seed * 31.0, v * 0.9));
          let glow = scol * ((0.50 * dimF) * (0.35 + 0.65 * vigS) * vGrad * breakup);
          let sheenS = pow(clamp(1.0 - abs(dot(viewDir, n)), 0.0, 1.0), 2.5);
          // unlit shops still read as glass: sky sheen + faint interior grey
          let glassEmS = (uniforms.ambientSky * (uniforms.ambientIntensity * (0.07 + 0.20 * sheenS))
                          + vec3f(0.010, 0.011, 0.013)) * (1.0 - litShop);
          shopAlb = mix(shopAlb, vec3f(0.030, 0.032, 0.038), glassM);
          shopEm = (glow * (1.0 - paneL * 0.85) + glassEmS) * glassM;
        }
        // dark recessed frame at the glazing/pier boundary
        let db = min(abs(bu - pier), abs(bayW - pier - bu));
        let frameLn = (1.0 - smoothstep(0.04, 0.12 + aaU, db)) * gV;
        shopAlb = mix(shopAlb, vec3f(0.045, 0.044, 0.042), frameLn * 0.9);
        // fascia sign band above the glazing
        let fasciaOn = litShop * (0.4 + 0.6 * sf2.y);
        shopEm = shopEm + scol * (fasciaM * fasciaOn * (0.16 + 0.42 * uniforms.neonIntensity) *
                 (0.60 + 0.40 * nlValueNoise(vec2f(u * 2.3 + seed * 53.0, 0.5))));
        shopAlb = mix(shopAlb, vec3f(0.050, 0.050, 0.055), fasciaM * (1.0 - litShop * 0.5) * 0.6);
        albedo = shopAlb;
        emis = emis + shopEm;
        let plinth = 1.0 - smoothstep(0.22, 0.36, v);
        albedo = mix(albedo, wall * 0.45, plinth);
      } else {
        // side/back ground floor: service wall with the odd steel door
        let du = fract(u * 0.0909) * 11.0;
        let door = step(4.8, du) * step(du, 6.0) * (1.0 - smoothstep(2.10, 2.30, v));
        let doorAlb = vec3f(0.055, 0.057, 0.060) * (0.8 + 0.4 * nlValueNoise(vec2f(u * 2.0, v * 2.0)));
        albedo = mix(albedo, doorAlb, door * 0.92);
        let plinth = 1.0 - smoothstep(0.25, 0.42, v);
        albedo = mix(albedo, wall * 0.5, plinth * 0.85);
      }
    }
  }

  // ---------- lighting: hemispheric ambient + shadowed directional sun ----
  let hemi = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  let amb = mix(uniforms.ambientGround, uniforms.ambientSky, hemi) * uniforms.ambientIntensity;
  var sunT = max(dot(n, -uniforms.sunDir), 0.0) * uniforms.sunIntensity * 0.35;
  if (sunT > 0.001) {
    // 4-tap PCF against the car-follow shadow map (same encoding as the road)
    let sp = uniforms.sunShadowMatrix * vec4f(world, 1.0);
    let suv = vec2f(sp.x, sp.y) * 0.5 + vec2f(0.5);
    if (suv.x > 0.002 && suv.x < 0.998 && suv.y > 0.002 && suv.y < 0.998) {
      let viewZ = sp.z * (uniforms.shadowDV.y - uniforms.shadowDV.x) + uniforms.shadowDV.x;
      let refM = (viewZ + uniforms.shadowDV.x) / (uniforms.shadowDV.x + uniforms.shadowDV.y);
      let ip = vec2<i32>(suv * uniforms.shadowMapSize);
      var sh = 0.0;
      sh = sh + select(0.0, 1.0, refM <= textureLoad(sunShadowMap, ip, 0).r + 0.0013);
      sh = sh + select(0.0, 1.0, refM <= textureLoad(sunShadowMap, ip + vec2<i32>(2, 1), 0).r + 0.0013);
      sh = sh + select(0.0, 1.0, refM <= textureLoad(sunShadowMap, ip + vec2<i32>(-1, 2), 0).r + 0.0013);
      sh = sh + select(0.0, 1.0, refM <= textureLoad(sunShadowMap, ip + vec2<i32>(-2, -2), 0).r + 0.0013);
      sunT = sunT * (sh * 0.25);
    }
  }
  var col = albedo * (amb + uniforms.sunColor * sunT) + emis;

  let fogF = nlFogFactor(eye, world, uniforms.fogDensity, uniforms.fogHeightFalloff);
  col = mix(uniforms.fogColor, col, fogF);
  fragmentOutputs.color = vec4f(col * uniforms.exposure, 1.0);
}
