#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3f;
varying vDir : vec3f;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let worldPos = mesh.world * vec4f(input.position, 1.0);
  vertexOutputs.position = scene.viewProjection * worldPos;
  vertexOutputs.vDir = input.position;
}
