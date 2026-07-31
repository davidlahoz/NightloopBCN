#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3f;
attribute normal : vec3f;

varying vT : f32;          // 0 at lamp, 1 at cone end
varying vFres : f32;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let wp = mesh.world * vec4f(input.position, 1.0);
  vertexOutputs.position = scene.viewProjection * wp;
  // cone local z runs 0..CONE_LEN
  vertexOutputs.vT = clamp(input.position.z / 9.0, 0.0, 1.0);
  let wn = normalize((mesh.world * vec4f(input.normal, 0.0)).xyz);
  let vdir = normalize(scene.vEyePosition.xyz - wp.xyz);
  vertexOutputs.vFres = abs(dot(wn, vdir));
}
