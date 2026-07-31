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

  // vertical gradient: haze band at horizon, horizon colour, zenith
  let hz = clamp(y * 2.2, 0.0, 1.0);
  var col = mix(uniforms.horizonColor, uniforms.zenithColor, pow(hz, 0.55));
  let hazeBand = exp(-abs(y) * 16.0);
  col = mix(col, uniforms.horizonHaze, hazeBand * 0.5);

  // sun disc + glow (visible when above horizon)
  let cosSun = dot(dir, toSun);
  let sunUp = clamp(toSun.y * 6.0 + 0.15, 0.0, 1.0);
  let glow = pow(clamp(cosSun, 0.0, 1.0), 24.0) * 0.5
           + pow(clamp(cosSun, 0.0, 1.0), 350.0) * 2.0
           + pow(clamp(cosSun, 0.0, 1.0), 4000.0) * 24.0;
  col = col + uniforms.sunColor * glow * uniforms.sunIntensity * 0.35 * sunUp;

  // clouds: two drifting fbm layers, lit warm toward the sun
  if (uniforms.cloudCover > 0.003 && y > 0.02) {
    // project onto a plane at height 1 for stable cloud shapes
    let cp = dir.xz / max(y, 0.08);
    let drift = vec2f(uniforms.time * 0.006, uniforms.time * 0.0023);
    var cd = nlFbm3(cp * 1.7 + drift);
    cd = cd + 0.5 * nlFbm3(cp * 4.3 - drift * 1.7);
    cd = cd / 1.5;
    let cover = smoothstep(1.0 - uniforms.cloudCover, 1.02 - uniforms.cloudCover * 0.55, cd);
    let horizonFade = smoothstep(0.02, 0.16, y);
    let cloudLit = mix(uniforms.zenithColor * 0.75 + uniforms.horizonHaze * 0.35,
                       uniforms.sunColor * (0.35 + 0.5 * sunUp),
                       pow(clamp(cosSun, 0.0, 1.0), 3.0) * 0.8);
    col = mix(col, cloudLit, cover * horizonFade * 0.85);
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
