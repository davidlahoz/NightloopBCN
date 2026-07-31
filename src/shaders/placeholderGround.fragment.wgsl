#include<sceneUboDeclaration>

varying vWorldPos : vec3f;

fn gridLine(coord : vec2f, cell : f32, width : f32) -> f32 {
  let g = abs(fract(coord / cell - 0.5) - 0.5) * cell;
  let fw = fwidth(coord);
  let d = min(g.x / max(fw.x, 1e-5), g.y / max(fw.y, 1e-5));
  return 1.0 - smoothstep(0.0, width, d);
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let p = fragmentInputs.vWorldPos;
  let eye = scene.vEyePosition.xyz;
  let dist = length(p.xz - eye.xz);

  var col = vec3f(0.055, 0.06, 0.068);            // asphalt-ish base
  let g1 = gridLine(p.xz, 2.0, 1.2) * 0.05;       // fine grid
  let g10 = gridLine(p.xz, 10.0, 1.5) * 0.10;     // coarse grid
  col += vec3f(g1 + g10) * vec3f(0.5, 0.6, 0.75);

  // distance fade into dusk haze
  let fogT = 1.0 - exp(-dist * 0.004);
  let haze = vec3f(0.08, 0.09, 0.12);
  col = mix(col, haze, fogT);

  fragmentOutputs.color = vec4f(col, 1.0);
}
