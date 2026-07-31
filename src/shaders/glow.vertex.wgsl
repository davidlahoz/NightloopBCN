#include<sceneUboDeclaration>

// Billboard halo quads baked into one mesh.
// position = (corner.x ±0.5, corner.y ±0.5, sizeM), center = world pos,
// tint = rgb, misc = (baseIntensity, isNeon, rand, 0)
attribute position : vec3f;
attribute center : vec3f;
attribute tint : vec4f;
attribute misc : vec4f;

varying vColor : vec4f;
varying vUV : vec2f;

uniform fogDensity : f32;
uniform streetlight : f32;
uniform neon : f32;
uniform time : f32;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let eye = scene.vEyePosition.xyz;
  let toCam = normalize(eye - input.center);
  let up0 = vec3f(0.0, 1.0, 0.0);
  let right = normalize(cross(up0, toCam));
  let up = cross(toCam, right);

  // halos bloom with fog: base size + fog growth
  let fogGrow = clamp(uniforms.fogDensity * 120.0, 0.0, 2.6);
  let size = input.position.z * (0.8 + fogGrow);
  let wp = input.center + right * (input.position.x * size) + up * (input.position.y * size);
  vertexOutputs.position = scene.viewProjection * vec4f(wp, 1.0);
  vertexOutputs.vUV = input.position.xy * 2.0;

  let master = mix(uniforms.streetlight, uniforms.neon, input.misc.y);
  // halos only really appear once the air is thick
  let fogAlpha = clamp(uniforms.fogDensity * 90.0 - 0.06, 0.0, 1.0);
  let a = input.misc.x * master * fogAlpha;
  vertexOutputs.vColor = vec4f(input.tint.rgb, a);
}
