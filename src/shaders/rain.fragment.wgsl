varying vAlpha : f32;

uniform tint : vec3f;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = vec4f(uniforms.tint * fragmentInputs.vAlpha, fragmentInputs.vAlpha);
}
