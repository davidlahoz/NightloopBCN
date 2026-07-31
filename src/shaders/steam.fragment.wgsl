#include<nlCommon>

varying vUV : vec2f;
varying vAlpha : f32;
varying vRand : f32;

uniform time : f32;
uniform tint : vec3f;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let r = length(fragmentInputs.vUV);
  let base = exp(-r * r * 2.6);
  // wispy breakup drifting upward through the puff
  let n = nlFbm3(fragmentInputs.vUV * 2.1 + vec2f(fragmentInputs.vRand, fragmentInputs.vRand * 0.7 - uniforms.time * 0.25));
  let wisp = smoothstep(0.28, 0.75, n);
  let a = fragmentInputs.vAlpha * base * (0.35 + 0.65 * wisp);
  fragmentOutputs.color = vec4f(uniforms.tint * a, a);
}
