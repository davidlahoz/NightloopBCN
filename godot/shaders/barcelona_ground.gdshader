shader_type spatial;
render_mode world_vertex_coords, cull_back;

// Barcelona ground surface, classified per pixel from a baked 500 m tile
// mask (tools/bake_ground_masks.py): R = carriageway asphalt (lane graph),
// G = park grass (OSM), B = bike lane (OSM cycleways). Unmasked = sidewalk
// paving. Priority: bike > asphalt > grass > paving, so bike lanes never
// read as sidewalk. Textures: ambientCG Road007 / Grass001 /
// PavingStones099 (CC0 — ASSETS.md). Wetness/puddles apply to the sealed
// surfaces (asphalt, bike, paving), not the grass.

// Tile meshes overhang their nominal 500 m bounds (up to a full tile), so
// the class mask CANNOT be a per-tile binding: fragments look up the mask
// for whatever tile the world position falls in, from a grid of layers
// around the player (rebuilt by the streamer on tile crossings).
uniform sampler2DArray class_masks : filter_linear, repeat_disable;
uniform vec2 grid_origin = vec2(0.0);   // world xz of layer (0,0) corner
uniform int grid_n = 9;                 // grid is grid_n x grid_n layers
uniform float tile_size = 500.0;

uniform sampler2D asphalt_alb : source_color, filter_linear_mipmap_anisotropic;
uniform sampler2D asphalt_nrm : hint_normal, filter_linear_mipmap_anisotropic;
uniform sampler2D asphalt_rgh : hint_default_white, filter_linear_mipmap_anisotropic;
uniform sampler2D paving_alb : source_color, filter_linear_mipmap_anisotropic;
uniform sampler2D paving_nrm : hint_normal, filter_linear_mipmap_anisotropic;
uniform sampler2D paving_rgh : hint_default_white, filter_linear_mipmap_anisotropic;
uniform sampler2D grass_alb : source_color, filter_linear_mipmap_anisotropic;
uniform sampler2D grass_nrm : hint_normal, filter_linear_mipmap_anisotropic;
uniform sampler2D grass_rgh : hint_default_white, filter_linear_mipmap_anisotropic;

uniform float wetness : hint_range(0.0, 1.0) = 0.15;
uniform float puddle_level : hint_range(0.0, 1.0) = 0.22;
uniform bool debug_classes = false;

varying vec3 wpos;
varying vec2 vuv;

void vertex() {
	wpos = VERTEX;
	vuv = UV;
}

float hash2u(uint ix, uint iz) {
	uint vx = ix * 1664525u + 1013904223u;
	uint vy = iz * 1664525u + 1013904223u;
	vx += vy * 1664525u;
	vy += vx * 1664525u;
	vx ^= vx >> 16u;
	vy ^= vy >> 16u;
	vx += vy * 1664525u;
	vx ^= vx >> 16u;
	return float(vx) * 2.3283064365386963e-10;
}

float vnoise(vec2 p) {
	vec2 ip = floor(p);
	vec2 f = p - ip;
	vec2 u = f * f * (3.0 - 2.0 * f);
	uint ix = uint(int(ip.x));
	uint iz = uint(int(ip.y));
	float a = hash2u(ix, iz);
	float b = hash2u(ix + 1u, iz);
	float c = hash2u(ix, iz + 1u);
	float d = hash2u(ix + 1u, iz + 1u);
	return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}

float fbm2(vec2 p) {
	return 0.667 * vnoise(p) + 0.333 * vnoise(p * 2.03 + 17.13);
}

void fragment() {
	vec2 xz = wpos.xz;
	vec2 local = (xz - grid_origin) / tile_size;
	ivec2 cell = ivec2(floor(local));
	vec3 m = vec3(0.0);   // outside the loaded grid: sidewalk paving
	if (cell.x >= 0 && cell.y >= 0 && cell.x < grid_n && cell.y < grid_n) {
		float layer = float(cell.y * grid_n + cell.x);
		m = texture(class_masks, vec3(local - vec2(cell), layer)).rgb;
	}

	// The generator UV-maps the SIDEWALK strips as ribbons (u = 0..1 across
	// a 2–35 m strip); carriageway and plaza polygons carry junk/stretched
	// UVs. |dWorld/du| recovers the strip width per pixel, so "am I on a
	// sidewalk strip" comes from the mesh itself and always aligns. The
	// dilated mask asphalt then fills the carriageway polygons; its spill
	// onto the strips is overridden by the ribbon test.
	vec2 dwx = dFdx(wpos.xz);
	vec2 dwy = dFdy(wpos.xz);
	float dux = dFdx(vuv.x);
	float duy = dFdy(vuv.x);
	float det = dwx.x * dwy.y - dwy.x * dwx.y;
	vec2 grad_u = vec2(dux * dwy.y - duy * dwx.y,
			duy * dwx.x - dux * dwy.x) / max(abs(det), 1e-6);
	float w_est = 1.0 / max(length(grad_u), 1e-4);
	bool sidewalk_strip = w_est > 1.5 && w_est < 40.0
			&& vuv.x > -0.05 && vuv.x < 1.05;

	float bike = smoothstep(0.35, 0.65, m.b);
	float road = smoothstep(0.35, 0.65, m.r) * (1.0 - bike);
	if (sidewalk_strip) {
		road = 0.0;
	}
	float grass = smoothstep(0.35, 0.65, m.g) * (1.0 - bike) * (1.0 - road);
	if (sidewalk_strip) {
		grass = 0.0;
	}
	float pave = clamp(1.0 - bike - road - grass, 0.0, 1.0);

	// asphalt is a non-seamless crop: mirror-repeat kills the seams
	vec2 uv_a = abs(fract(xz / 16.0) * 2.0 - 1.0);
	vec2 uv_p = xz / 2.0;     // panot pavers
	vec2 uv_g = xz / 3.5;     // grass

	vec3 alb = texture(asphalt_alb, uv_a).rgb * 0.55 * (road + bike)
			 + texture(paving_alb, uv_p).rgb * 1.0 * pave
			 + texture(grass_alb, uv_g).rgb * 0.95 * grass;
	// Barcelona bike lanes are dark red asphalt
	alb = mix(alb, alb * vec3(1.55, 0.45, 0.42), bike);

	// NOTE: no NORMAL_MAP — the sampling is world-planar but the mesh
	// tangent basis follows the glb UVs; mixing them wrecks the lighting.
	float rgh = texture(asphalt_rgh, uv_a).r * (road + bike)
			  + texture(paving_rgh, uv_p).r * pave
			  + texture(grass_rgh, uv_g).r * grass;

	float patch = fbm2(xz * 0.043);
	alb *= 0.92 + 0.16 * patch;

	float sealed = 1.0 - grass;   // wetness gloss on built surfaces only
	float spec = 0.25;
	rgh = max(rgh, 0.72);         // dry city surfaces are matte
	alb *= 1.0 - wetness * 0.40 * sealed;
	rgh = mix(rgh, 0.5, wetness * 0.75 * sealed);
	spec = mix(spec, 0.34, wetness * sealed);
	float pn = fbm2(xz * 0.11 + 7.3);
	float pud = smoothstep(0.86 - puddle_level * 0.30, 0.94 - puddle_level * 0.30, pn)
			* wetness * sealed;
	alb = mix(alb, alb * 0.45, pud);
	rgh = mix(rgh, 0.05, pud);
	spec = mix(spec, 0.6, pud);

	if (debug_classes) {
		vec3 dc = vec3(0.0);
		dc += vec3(1.0, 0.0, 0.0) * road;          // asphalt
		dc += vec3(0.0, 1.0, 0.0) * pave;          // paving
		dc += vec3(1.0, 1.0, 0.0) * grass;         // grass
		dc += vec3(0.0, 0.0, 1.0) * bike;          // bike
		if (sidewalk_strip) {
			dc = mix(dc, vec3(0.0, 1.0, 1.0), 0.5); // strip overlay: cyan
		}
		alb = dc;
	}
	ALBEDO = alb;
	ROUGHNESS = clamp(rgh, 0.03, 1.0);
	SPECULAR = spec;
	METALLIC = 0.0;
}
