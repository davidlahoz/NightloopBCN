// NIGHTLOOP skyline — merged far-field tower impostors.
// Positions are pre-baked in world space (mesh world matrix is identity,
// frozen). Passes the packed per-tower data straight through and forwards the
// eye position as a (constant) varying so the fragment stage needs no Scene
// UBO of its own.
#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3f;
attribute normal : vec3f;
attribute uv : vec2f;     // facade meters: u along face, v above tower base
attribute uv2 : vec2f;    // (towerSeed, towerTotalHeight m)
attribute uv3 : vec2f;    // (faceWidth m, ring 0|1|2 towers, 3 floor ribbon)
attribute color : vec4f;  // (litDensity, warmth, kind, extra)

varying vWorld : vec3f;
varying vCam : vec3f;
varying vNormal : vec3f;
varying vFacade : vec2f;
varying vSeedH : vec2f;
varying vFaceWRing : vec2f;
varying vTower : vec4f;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let worldPos = mesh.world * vec4f(input.position, 1.0);
  vertexOutputs.position = scene.viewProjection * worldPos;
  vertexOutputs.vWorld = worldPos.xyz;
  vertexOutputs.vCam = scene.vEyePosition.xyz;
  vertexOutputs.vNormal = input.normal;
  vertexOutputs.vFacade = input.uv;
  vertexOutputs.vSeedH = input.uv2;
  vertexOutputs.vFaceWRing = input.uv3;
  vertexOutputs.vTower = input.color;
}
