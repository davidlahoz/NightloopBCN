varying vColor : vec4f;
varying vUV : vec2f;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let r = length(fragmentInputs.vUV);
  let core = exp(-r * r * 5.0);
  let outer = exp(-r * 2.6) * 0.4;
  let a = fragmentInputs.vColor.a * (core + outer);
  fragmentOutputs.color = vec4f(fragmentInputs.vColor.rgb * a, a * 0.85);
}
