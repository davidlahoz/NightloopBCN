#include<sceneUboDeclaration>

// Road chunk vertices are baked in world space (mesh.world = identity).
attribute position : vec3f;
attribute normal : vec3f;

varying vWorldPos : vec3f;
varying vNormal : vec3f;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let wp = vec4f(input.position, 1.0);
  vertexOutputs.position = scene.viewProjection * wp;
  vertexOutputs.vWorldPos = input.position;
  vertexOutputs.vNormal = input.normal;
}
