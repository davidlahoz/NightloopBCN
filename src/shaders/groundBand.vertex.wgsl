// NIGHTLOOP ground band vertex — curbs and sidewalks are baked in world
// space (identity world matrix, frozen). uv = (path metres, cross metres),
// color = baked grime tint.
#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3f;
attribute normal : vec3f;
attribute uv : vec2f;
attribute color : vec4f;

varying vWorld : vec3f;
varying vNormal : vec3f;
varying vBandUV : vec2f;
varying vGrime : vec4f;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let worldPos = mesh.world * vec4f(input.position, 1.0);
  vertexOutputs.position = scene.viewProjection * worldPos;
  vertexOutputs.vWorld = worldPos.xyz;
  vertexOutputs.vNormal = (mesh.world * vec4f(input.normal, 0.0)).xyz;
  vertexOutputs.vBandUV = input.uv;
  vertexOutputs.vGrime = input.color;
}
