// NIGHTLOOP ground band — curbs + sidewalks, shaded to the same standard as
// the hero asphalt: multi-scale texture breakup, macro tone variation, the
// street-light pool loop with wet speculars, shadowed sun, wet darkening and
// the same height fog. Closes the quality gap at the road edge.
#include<sceneUboDeclaration>
#include<nlCommon>

varying vWorld : vec3f;
varying vNormal : vec3f;
varying vBandUV : vec2f;
varying vGrime : vec4f;

uniform sunDir : vec3f;
uniform sunColor : vec3f;            // pre-multiplied by intensity
uniform ambientSky : vec3f;
uniform ambientGround : vec3f;
uniform ambientIntensity : f32;
uniform fogColor : vec3f;
uniform fogDensity : f32;
uniform fogHeightFalloff : f32;
uniform wetness : f32;               // live road wetness 0..1
uniform tile : f32;                  // metres → texture uv
uniform albedoTint : vec3f;          // material family tint (walk vs curb)
uniform lightCount : f32;
uniform sunShadowMatrix : mat4x4<f32>;
uniform shadowMapSize : f32;
uniform shadowDV : vec2f;
uniform grassMode : f32;             // 1 = countryside verge: procedural grass

var albedoTex : texture_2d<f32>;
var albedoTexSampler : sampler;
var normalTex : texture_2d<f32>;
var normalTexSampler : sampler;
var roughTex : texture_2d<f32>;
var roughTexSampler : sampler;
var aoTex : texture_2d<f32>;
var aoTexSampler : sampler;
var sunShadowMap : texture_2d<f32>;  // FILTER_NONE float map (textureLoad)

struct RoadLight { posRadius : vec4f, colorIntensity : vec4f };
var<storage, read> roadLights : array<RoadLight>;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let wp = fragmentInputs.vWorld;
  let camPos = scene.vEyePosition.xyz;
  let V = normalize(camPos - wp);
  let dist = length(camPos - wp);
  let uv1 = fragmentInputs.vBandUV * uniforms.tile;
  let uv2 = fragmentInputs.vBandUV * uniforms.tile * 0.171;   // macro mottle

  // ---- albedo: two texture scales + macro tone + baked grime ----
  var albedo = pow(textureSample(albedoTex, albedoTexSampler, uv1).rgb, vec3f(2.2));
  let macroA = pow(textureSample(albedoTex, albedoTexSampler, uv2).rgb, vec3f(2.2));
  albedo = mix(albedo, macroA, 0.38);
  let ao = textureSample(aoTex, aoTexSampler, uv1).r;
  let tone = nlFbm3(wp.xz * 0.021 + vec2f(3.1, 8.7));
  albedo = albedo * uniforms.albedoTint * fragmentInputs.vGrime.rgb
         * (0.74 + tone * 0.48) * (0.55 + ao * 0.45);

  // ---- normal: map detail on the baked ground normal ----
  var N = normalize(fragmentInputs.vNormal);
  let detailFade = 1.0 - smoothstep(12.0, 45.0, dist);
  let tn = textureSample(normalTex, normalTexSampler, uv1).rgb * 2.0 - 1.0;
  if (detailFade > 0.01) {
    // the band is near-horizontal: perturb in world xz like the road does
    N = normalize(N + vec3f(tn.x, 0.0, tn.y) * (0.55 * detailFade));
  }

  // ---- countryside grass: procedural over the same geometry/lighting ----
  if (uniforms.grassMode > 0.5) {
    let meadow = nlFbm3(wp.xz * 0.043 + vec2f(11.3, 4.9));         // meadow patches
    // high-frequency terms fade with distance or they alias into a weave
    let gFade = 1.0 - smoothstep(16.0, 70.0, dist);
    let tuft = mix(0.5, nlValueNoise(wp.xz * 1.9 + vec2f(2.2, 7.8)), gFade);
    let blade = mix(0.5, nlValueNoise(wp.xz * vec2f(9.0, 31.0)), gFade);
    var grass = mix(vec3f(0.045, 0.075, 0.022), vec3f(0.115, 0.135, 0.038), meadow);
    grass = mix(grass, vec3f(0.140, 0.118, 0.050), smoothstep(0.62, 0.9, tuft) * 0.55); // dry stalks
    grass = grass * (0.72 + 0.42 * blade) * (0.8 + 0.4 * ao);
    // gentle earthy shift from the baked grime — smooth, no hard threshold
    // (a steep cutoff here turns per-vertex noise into sawtooth dirt triangles)
    let earth = clamp(1.0 - fragmentInputs.vGrime.r, 0.0, 1.0);
    grass = mix(grass, grass * vec3f(1.25, 0.98, 0.72), earth * 0.5);
    albedo = grass * (0.74 + tone * 0.48);
  }

  // ---- roughness + wet response ----
  var rough = clamp(0.55 + textureSample(roughTex, roughTexSampler, uv1).r * 0.45, 0.0, 1.0);
  rough = mix(rough, 0.94, uniforms.grassMode);   // grass never gets glossy
  let wetF = smoothstep(0.05, 0.8, uniforms.wetness) * (0.5 + 0.5 * fragmentInputs.vGrime.r)
           * (1.0 - uniforms.grassMode * 0.65);   // sod drains; no mirror sheen
  // paving joints hold water: low grime (joints/gutter) darkens harder
  albedo = albedo * mix(1.0, 0.52, wetF);
  rough = mix(rough, 0.16, wetF * 0.8);

  // ---- lighting ----
  let hemi = mix(uniforms.ambientGround, uniforms.ambientSky, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  var col = albedo * hemi * uniforms.ambientIntensity;

  // shadowed sun (same map + encoding as the road/facades)
  let L = -normalize(uniforms.sunDir);
  let NdL = clamp(dot(N, L), 0.0, 1.0);
  if (NdL > 0.001) {
    var sh = 1.0;
    let sp = uniforms.sunShadowMatrix * vec4f(wp, 1.0);
    let suv = vec2f(sp.x, sp.y) * 0.5 + vec2f(0.5);
    if (suv.x > 0.002 && suv.x < 0.998 && suv.y > 0.002 && suv.y < 0.998) {
      let viewZ = sp.z * (uniforms.shadowDV.y - uniforms.shadowDV.x) + uniforms.shadowDV.x;
      let refM = (viewZ + uniforms.shadowDV.x) / (uniforms.shadowDV.x + uniforms.shadowDV.y);
      let ip = vec2<i32>(suv * uniforms.shadowMapSize);
      var s4 = 0.0;
      s4 = s4 + select(0.0, 1.0, refM <= textureLoad(sunShadowMap, ip, 0).r + 0.0013);
      s4 = s4 + select(0.0, 1.0, refM <= textureLoad(sunShadowMap, ip + vec2<i32>(2, 1), 0).r + 0.0013);
      s4 = s4 + select(0.0, 1.0, refM <= textureLoad(sunShadowMap, ip + vec2<i32>(-1, 2), 0).r + 0.0013);
      s4 = s4 + select(0.0, 1.0, refM <= textureLoad(sunShadowMap, ip + vec2<i32>(-2, -2), 0).r + 0.0013);
      sh = s4 * 0.25;
    }
    col = col + albedo * uniforms.sunColor * NdL * sh;
  }

  // street-light pools — the same buffer the asphalt uses, so the sidewalk
  // sits in the same sodium light as the road beside it
  let count = i32(uniforms.lightCount);
  for (var i = 0; i < count; i = i + 1) {
    let lp = roadLights[i].posRadius;
    let lc = roadLights[i].colorIntensity;
    let toL = lp.xyz - wp;
    let d2 = dot(toL, toL);
    let radius = lp.w;
    if (d2 > radius * radius) { continue; }
    let ld = sqrt(d2);
    let Ln = toL / ld;
    let att = pow(1.0 - ld / radius, 2.2) / (1.0 + d2 * 0.035);
    let NdLl = clamp(dot(N, Ln), 0.0, 1.0);
    let lcol = lc.rgb * lc.w;
    col = col + albedo * lcol * NdLl * att * 22.0;
    // damp sheen: modest blinn highlight, grows with wetness
    if (wetF > 0.03) {
      let H = normalize(Ln + V);
      let spec = pow(clamp(dot(N, H), 0.0, 1.0), mix(24.0, 90.0, wetF));
      col = col + lcol * spec * att * NdLl * wetF * 1.4;
    }
  }

  // ---- fog: identical model to the road so the band never pops ----
  let fogT = nlFogFactor(camPos, wp, uniforms.fogDensity, uniforms.fogHeightFalloff);
  col = mix(uniforms.fogColor, col, fogT);

  col = select(col, uniforms.fogColor, col != col);
  col = clamp(col, vec3f(0.0), vec3f(120.0));
  fragmentOutputs.color = vec4f(col, 1.0);
}
