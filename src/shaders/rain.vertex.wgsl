#include<sceneUboDeclaration>

// One static mesh of N streak quads; all motion happens here.
// seed.xyz = random home position in the unit box, corner.x = ±0.5, corner.y = 0..1
attribute position : vec3f;   // x = corner side, y = corner up, z = streak random
attribute seed : vec3f;

varying vAlpha : f32;

uniform camPos : vec3f;
uniform time : f32;
uniform rainRate : f32;
uniform wind : vec2f;

const BOX_XZ : f32 = 26.0;
const BOX_Y : f32 = 16.0;
const FALL : f32 = 14.0;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let r = input.position.z;
  // fall + wrap inside the box, offset per streak
  let speed = FALL * (0.8 + r * 0.4);
  var y = fract(input.seed.y - uniforms.time * speed / BOX_Y);
  var xz = input.seed.xz * BOX_XZ - vec2f(BOX_XZ * 0.5);
  // wind drift while falling
  xz = xz + uniforms.wind * (1.0 - y) * 2.2;
  // anchor the box on the camera (quantized so streaks don't swim with the cam)
  let base = floor((uniforms.camPos.xz + uniforms.wind * 6.0) / BOX_XZ) * BOX_XZ;
  var wx = base.x + xz.x;
  var wz = base.y + xz.y;
  // wrap into the box around the camera
  wx = wx + BOX_XZ * step(wx, uniforms.camPos.x - BOX_XZ * 0.5);
  wx = wx - BOX_XZ * step(uniforms.camPos.x + BOX_XZ * 0.5, wx);
  wz = wz + BOX_XZ * step(wz, uniforms.camPos.z - BOX_XZ * 0.5);
  wz = wz - BOX_XZ * step(uniforms.camPos.z + BOX_XZ * 0.5, wz);
  let wy = uniforms.camPos.y - BOX_Y * 0.35 + y * BOX_Y;

  // streak quad: billboard around Y, stretched along fall+wind direction
  let toCam = normalize(vec2f(uniforms.camPos.x - wx, uniforms.camPos.z - wz));
  let side = vec2f(-toCam.y, toCam.x);
  let len = 0.55 * (0.8 + r * 0.5);
  let w = 0.010 + r * 0.006;
  let cx = input.position.x;
  let cy = input.position.y;
  let slant = uniforms.wind * 0.06;
  let px = wx + side.x * cx * w + slant.x * cy * len;
  let pz = wz + side.y * cx * w + slant.y * cy * len;
  let py = wy + cy * len;

  vertexOutputs.position = scene.viewProjection * vec4f(px, py, pz, 1.0);
  // fade top/bottom of the box, fade by rate; hide entirely when dry
  let edgeFade = smoothstep(0.0, 0.12, y) * (1.0 - smoothstep(0.82, 1.0, y));
  vertexOutputs.vAlpha = uniforms.rainRate * edgeFade * (0.10 + r * 0.16);
}
