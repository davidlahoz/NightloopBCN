varying vT : f32;
varying vFres : f32;

uniform density : f32;     // rain/fog thickness drives visibility
uniform tint : vec3f;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let t = fragmentInputs.vT;
  let body = (1.0 - t) * (1.0 - t) * smoothstep(0.0, 0.06, t);
  let edge = pow(fragmentInputs.vFres, 1.6);   // soft at silhouette edges
  let a = body * edge * uniforms.density * 0.16;
  fragmentOutputs.color = vec4f(uniforms.tint * a, a);
}
