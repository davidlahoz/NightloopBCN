#include<sceneUboDeclaration>

// Rising steam wisps: quads cycle upward from their vent, swaying and growing.
// position = (corner.x, corner.y, quadRand), vent = vent world pos, phase.x = cycle offset
attribute position : vec3f;
attribute vent : vec3f;
attribute phase : vec2f;

varying vUV : vec2f;
varying vAlpha : f32;
varying vRand : f32;

uniform time : f32;
uniform amount : f32;
uniform wind : vec2f;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let r = input.position.z;
  let cycle = 7.0 + r * 4.0;                      // seconds per rise
  let t = fract(uniforms.time / cycle + input.phase.x);
  let rise = t * (2.6 + r * 1.6);
  let sway = vec2f(
    sin(uniforms.time * 0.6 + input.phase.x * 21.0 + rise * 1.2),
    cos(uniforms.time * 0.47 + input.phase.x * 17.0 + rise * 0.9),
  ) * (0.12 + t * 0.55);
  let drift = uniforms.wind * t * 1.6;
  let cpos = vec3f(input.vent.x + sway.x + drift.x, input.vent.y + 0.12 + rise, input.vent.z + sway.y + drift.y);

  let eye = scene.vEyePosition.xyz;
  let toCam = normalize(eye - cpos);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toCam));
  let up = cross(toCam, right);
  let size = (0.5 + t * 1.9) * (0.8 + r * 0.5);
  let wp = cpos + right * (input.position.x * size) + up * (input.position.y * size);
  vertexOutputs.position = scene.viewProjection * vec4f(wp, 1.0);
  vertexOutputs.vUV = input.position.xy * 2.0;
  vertexOutputs.vRand = input.phase.x * 63.7 + r * 11.0;
  // fade in fast, fade out with height
  vertexOutputs.vAlpha = uniforms.amount * smoothstep(0.0, 0.10, t) * (1.0 - smoothstep(0.35, 1.0, t)) * 0.16;
}
