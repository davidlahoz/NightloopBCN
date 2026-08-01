// NIGHTLOOP surface state update — one fused full-screen pass, ping-ponged.
// Channels: R = water cleared (0..1, tyres pushed water out, rain refills)
//           G = displaced-water ridge (extra water thrown to the track edges)
//           B = local damp film delta (spray / wiped tracks)
//           A = rubber deposit (0..1, very slow decay)
//
// The buffer is car-centred; when the centre moves we re-sample the previous
// buffer with a UV offset (texel-snapped on the CPU). Newly scrolled-in texels
// fall outside [0,1] and reset to neutral zero.

varying vUV : vec2f;

uniform scrollUV : vec2f;      // uv offset of previous frame's data
uniform dt : f32;
uniform rainRate : f32;
uniform evaporation : f32;     // weather-driven 0..2
uniform splatCount : f32;
// per splat: [pos.xy(uv), dirAlong.xy] [len, width, clear, ridge] [damp, rubber, avail, pad]
uniform splats : array<vec4f, 24>;

var prevState : texture_2d<f32>;
var prevStateSampler : sampler;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;
  let puv = uv + uniforms.scrollUV;
  // sample unconditionally (WGSL uniform control flow), mask out-of-range
  let inR = step(0.0, puv.x) * step(puv.x, 1.0) * step(0.0, puv.y) * step(puv.y, 1.0);
  var s = textureSample(prevState, prevStateSampler, clamp(puv, vec2f(0.0), vec2f(1.0))) * inR;
  // self-heal: the buffer ping-pongs forever, so a NaN texel from any source
  // would otherwise persist and smear along the drive as black road blobs
  s = select(clamp(s, vec4f(0.0), vec4f(1.0)), vec4f(0.0), s != s);

  // ---- decay / recovery -------------------------------------------------
  let dtc = uniforms.dt;
  // cleared water refills (faster in rain — the street heals itself)
  let refill = (0.022 + uniforms.rainRate * 0.35 + uniforms.evaporation * 0.01) * dtc;
  s.r = max(s.r - refill, 0.0);
  // ridges relax and drain away
  s.g = s.g * exp(-dtc * (0.16 + uniforms.rainRate * 0.4));
  // damp film evaporates; rain keeps it saturated
  s.b = s.b * exp(-dtc * (0.05 + uniforms.evaporation * 0.12) * (1.0 - uniforms.rainRate * 0.9));
  // rubber wears off over minutes
  s.a = s.a * exp(-dtc * 0.0035);

  // ---- splats -----------------------------------------------------------
  let n = i32(uniforms.splatCount);
  for (var i = 0; i < n; i = i + 1) {
    let a0 = uniforms.splats[i * 3];
    let a1 = uniforms.splats[i * 3 + 1];
    let a2 = uniforms.splats[i * 3 + 2];
    let dp = uv - a0.xy;
    let dir = a0.zw;                       // normalized motion dir in uv space
    let along = dp.x * dir.x + dp.y * dir.y;
    let across = -dp.x * dir.y + dp.y * dir.x;
    let sl = max(a1.x, 1e-5);
    let sw = max(a1.y, 1e-5);
    let g = exp(-(along * along) / (2.0 * sl * sl) - (across * across) / (2.0 * sw * sw));
    // contact patch: clear water, lay damp + rubber
    // (displaced-water ridge lobes removed — they read as melting asphalt)
    s.r = min(s.r + g * a1.z, 1.0);
    s.b = min(s.b + g * a2.x, 1.0);
    s.a = min(s.a + g * a2.y, 1.0);
  }

  fragmentOutputs.color = s;
}
