// NIGHTLOOP facade vertex — buildings are baked in world space (identity world
// matrix, frozen). Passes facade-local metric uv and per-building metadata
// (seed / flags / facade width / wall-top height) straight through.
#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3f;
attribute normal : vec3f;
attribute uv : vec2f;
attribute color : vec4f;

varying vWorld : vec3f;
varying vNormal : vec3f;
varying vFacadeUV : vec2f;
varying vMeta : vec4f;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let worldPos = mesh.world * vec4f(input.position, 1.0);
  vertexOutputs.position = scene.viewProjection * worldPos;
  vertexOutputs.vWorld = worldPos.xyz;
  vertexOutputs.vNormal = (mesh.world * vec4f(input.normal, 0.0)).xyz;
  vertexOutputs.vFacadeUV = input.uv;
  vertexOutputs.vMeta = input.color;
}
