// NIGHTLOOP shared WGSL — hashing, noise, fog. Registered as include "nlCommon".
// The JS mirror of the noise functions lives in src/city/noise.js and MUST stay
// numerically identical (same pcg2d hash, same interpolation).

fn nlPcg2d(pIn : vec2<u32>) -> vec2<u32> {
  var v = pIn * vec2<u32>(1664525u) + vec2<u32>(1013904223u);
  v.x = v.x + v.y * 1664525u;
  v.y = v.y + v.x * 1664525u;
  v = v ^ (v >> vec2<u32>(16u));
  v.x = v.x + v.y * 1664525u;
  v.y = v.y + v.x * 1664525u;
  v = v ^ (v >> vec2<u32>(16u));
  return v;
}

// hash of integer lattice point -> [0,1)
fn nlHash2(ip : vec2<i32>) -> f32 {
  let q = nlPcg2d(bitcast<vec2<u32>>(ip));
  return f32(q.x) * 2.3283064365386963e-10; // / 2^32
}

// hash -> vec2 [0,1)
fn nlHash2v(ip : vec2<i32>) -> vec2<f32> {
  let q = nlPcg2d(bitcast<vec2<u32>>(ip));
  return vec2<f32>(f32(q.x), f32(q.y)) * 2.3283064365386963e-10;
}

// value noise, [0,1)
fn nlValueNoise(p : vec2<f32>) -> f32 {
  let ip = vec2<i32>(floor(p));
  let fp = fract(p);
  let u = fp * fp * (3.0 - 2.0 * fp);
  let a = nlHash2(ip);
  let b = nlHash2(ip + vec2<i32>(1, 0));
  let c = nlHash2(ip + vec2<i32>(0, 1));
  let d = nlHash2(ip + vec2<i32>(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 3-octave fbm, [0,1)-ish
fn nlFbm3(pIn : vec2<f32>) -> f32 {
  var p = pIn;
  var f = 0.0;
  var w = 0.5;
  for (var i = 0; i < 3; i = i + 1) {
    f = f + w * nlValueNoise(p);
    p = p * 2.03 + vec2<f32>(17.13, 9.71);
    w = w * 0.5;
  }
  return f;
}

// Exponential height fog. Returns transmittance factor 0..1 (1 = no fog).
fn nlFogFactor(camPos : vec3<f32>, worldPos : vec3<f32>, density : f32, heightFalloff : f32) -> f32 {
  let dv = worldPos - camPos;
  let dist = length(dv);
  // integrate exp(-falloff * y) along the ray (stable form)
  let fy = heightFalloff;
  let dy = dv.y;
  var integral : f32;
  if (abs(dy) > 0.01) {
    integral = (exp(-fy * camPos.y) - exp(-fy * worldPos.y)) / (fy * dy);
  } else {
    integral = exp(-fy * camPos.y);
  }
  return exp(-density * dist * max(integral, 0.0));
}

// cheap luminance
fn nlLuma(c : vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}
