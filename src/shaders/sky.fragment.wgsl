#include<nlCommon>

varying vDir : vec3f;

uniform sunDir : vec3f;
uniform sunColor : vec3f;
uniform sunIntensity : f32;
uniform zenithColor : vec3f;
uniform horizonColor : vec3f;
uniform horizonHaze : vec3f;
uniform fogColor : vec3f;
uniform starAmount : f32;
uniform cloudCover : f32;
uniform exposure : f32;
uniform time : f32;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let dir = normalize(fragmentInputs.vDir);
  let y = dir.y;
  let toSun = -uniforms.sunDir;

  // vertical gradient: haze band at horizon, horizon colour, zenith.
  // the warm horizon lives around the sun's azimuth; opposite side stays cool
  let sunAzim = normalize(vec2f(toSun.x, toSun.z) + vec2f(1e-5));
  let dirAzim = normalize(vec2f(dir.x, dir.z) + vec2f(1e-5));
  let azAlign = dot(sunAzim, dirAzim) * 0.5 + 0.5;      // 1 toward sun, 0 away
  let warmT = pow(azAlign, 1.6);
  let horizonC = mix(uniforms.horizonHaze * 0.8 + uniforms.zenithColor * 0.25,
                     uniforms.horizonColor, warmT);
  let hz = clamp(y * 2.2, 0.0, 1.0);
  var col = mix(horizonC, uniforms.zenithColor, pow(hz, 0.50));
  let hazeBand = exp(-abs(y) * 14.0);
  col = mix(col, uniforms.horizonHaze, hazeBand * 0.45);

  // sun disc + glow (visible when above horizon)
  let cosSun = dot(dir, toSun);
  let sunUp = clamp(toSun.y * 6.0 + 0.15, 0.0, 1.0);
  let glow = pow(clamp(cosSun, 0.0, 1.0), 24.0) * 0.5
           + pow(clamp(cosSun, 0.0, 1.0), 350.0) * 2.0
           + pow(clamp(cosSun, 0.0, 1.0), 4000.0) * 24.0;
  col = col + uniforms.sunColor * glow * uniforms.sunIntensity * 0.35 * sunUp;

  // clouds: two drifting fbm layers, dark blue-grey wisps with warm sun edges
  if (uniforms.cloudCover > 0.003 && y > 0.015) {
    // project onto a plane at height 1 for stable cloud shapes
    let cp = dir.xz / max(y, 0.09);
    let drift = vec2f(uniforms.time * 0.006, uniforms.time * 0.0023);
    var cd = nlFbm3(cp * 0.55 + drift);
    cd = cd + 0.45 * nlFbm3(cp * 1.9 - drift * 1.7);
    cd = cd / 1.45;
    let th = 0.72 - uniforms.cloudCover * 0.42;
    let cover = smoothstep(th, th + 0.14, cd);
    let horizonFade = smoothstep(0.015, 0.14, y) * (1.0 - smoothstep(0.5, 0.95, y) * 0.4);
    let warmEdge = pow(clamp(cosSun, 0.0, 1.0), 2.0) * sunUp;
    let cloudDark = uniforms.zenithColor * 0.55 + vec3f(0.02, 0.02, 0.03);
    let cloudLit = mix(cloudDark, uniforms.sunColor * 0.55 + uniforms.horizonColor * 0.25, warmEdge * 0.75);
    // thin edges glow slightly warmer than the dense core
    let core = smoothstep(th + 0.10, th + 0.30, cd);
    let cloudCol = mix(cloudLit * 1.15, cloudDark, core * 0.7);
    col = mix(col, cloudCol, cover * horizonFade * 0.9);
  }

  // stars: stable hash points, only in dark skies, fade near horizon
  if (uniforms.starAmount > 0.003 && y > 0.04) {
    let sp = dir.xz / max(y + 0.28, 0.2) * 340.0;
    let cell = vec2<i32>(floor(sp));
    let rnd = nlHash2v(cell);
    let local = fract(sp) - 0.5 - (rnd - 0.5) * 0.7;
    let star = smoothstep(0.10, 0.015, length(local)) * step(0.9955, rnd.y);
    col = col + vec3f(0.75, 0.82, 1.0) * star * uniforms.starAmount * smoothstep(0.04, 0.3, y);
  }

  // below-horizon: fade into fog colour so the dome never shows a hard edge
  col = mix(uniforms.fogColor, col, smoothstep(-0.12, 0.03, y));

  fragmentOutputs.color = vec4f(col * uniforms.exposure, 1.0);
}
