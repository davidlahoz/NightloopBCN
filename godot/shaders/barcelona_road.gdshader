shader_type spatial;
render_mode world_vertex_coords, cull_back;

// Barcelona road surface — asphalt tone variation + the NightLoop wetness
// system (damp darkening, puddle gloss) on the OSM road meshes. No lane
// paint: the tiles carry no lane data (yet).

uniform float wetness : hint_range(0.0, 1.0) = 0.15;
uniform float puddle_level : hint_range(0.0, 1.0) = 0.22;

varying vec3 wpos;

void vertex() {
	wpos = VERTEX;
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
	float patch = fbm2(xz * 0.043);
	float grain = vnoise(xz * 2.3);

	vec3 albedo = mix(vec3(0.040, 0.041, 0.045), vec3(0.060, 0.061, 0.065), patch) * (0.9 + 0.2 * grain);
	float rough = 0.88 - 0.12 * grain;
	float spec = 0.5;

	// wetness + puddles (same recipe as the procedural ground)
	albedo *= 1.0 - wetness * 0.45;
	rough = mix(rough, 0.52, wetness * 0.8);
	spec = mix(spec, 0.32, wetness);
	float pn = fbm2(xz * 0.11 + 7.3);
	float pud = smoothstep(0.86 - puddle_level * 0.30, 0.94 - puddle_level * 0.30, pn) * wetness;
	albedo = mix(albedo, albedo * 0.45, pud);
	rough = mix(rough, 0.04, pud);
	spec = mix(spec, 0.6, pud);

	ALBEDO = albedo;
	ROUGHNESS = clamp(rough, 0.03, 1.0);
	SPECULAR = spec;
	METALLIC = 0.0;
}
