shader_type spatial;
render_mode cull_back;

// NIGHTLOOP facade shader — procedural windows on the streamed buildings.
// UV is in facade metres (u along, v up). COLOR carries per-parcel data:
//   r = parcel seed, g = district / 8, b = building height / 150.

uniform float window_lit_fraction : hint_range(0.0, 1.0) = 0.5;
uniform float window_glow : hint_range(0.0, 8.0) = 3.0;

float whash(uint a, uint b, uint c) {
	uint h = a * 374761393u + b * 668265263u + c * 2246822519u;
	h = (h ^ (h >> 13u)) * 1274126177u;
	return float(h ^ (h >> 16u)) * (1.0 / 4294967296.0);
}

void fragment() {
	int district = int(round(COLOR.g * 8.0));
	uint bseed = uint(COLOR.r * 65535.0);
	float u = UV.x;
	float v = UV.y;
	bool roof = NORMAL.y > 0.55;

	// district wall palettes
	vec3 wall;
	float wall_rough = 0.85;
	float wall_metal = 0.0;
	float pick = whash(bseed, 11u, 3u);
	if (district == 0) {          // downtown: dark curtain wall
		wall = vec3(0.045, 0.052, 0.065);
		wall_rough = 0.35;
		wall_metal = 0.4;
	} else if (district == 2) {   // residential: warm brick rows
		wall = mix(vec3(0.21, 0.10, 0.075), vec3(0.26, 0.15, 0.10), pick);
	} else if (district == 3) {   // industrial: concrete + sheet metal
		wall = mix(vec3(0.17, 0.165, 0.155), vec3(0.22, 0.21, 0.20), pick);
	} else {                      // commercial: mixed brick/plaster/stone
		if (pick < 0.4) { wall = vec3(0.23, 0.11, 0.08); }
		else if (pick < 0.7) { wall = vec3(0.30, 0.26, 0.22); }
		else { wall = vec3(0.22, 0.21, 0.19); }
	}

	vec3 albedo = wall;
	float rough = wall_rough;
	float metal = wall_metal;
	vec3 emission = vec3(0.0);

	if (roof) {
		albedo = vec3(0.055, 0.055, 0.06);
		rough = 0.95;
		metal = 0.0;
	} else {
		// window grid in facade metres
		vec2 cell_size = district == 3 ? vec2(3.0, 3.6) : vec2(1.72, 3.05);
		vec2 cw = district == 0 ? vec2(0.055, 0.10) : (district == 3 ? vec2(0.32, 0.30) : vec2(0.20, 0.28));
		vec2 cid = floor(vec2(u, v) / cell_size);
		vec2 f = fract(vec2(u, v) / cell_size);
		bool in_window = f.x > cw.x && f.x < 1.0 - cw.x && f.y > cw.y && f.y < 1.0 - cw.y;
		// keep a solid parapet band at the top and a taller ground floor
		bool ground_floor = v < cell_size.y * 1.15;
		if (in_window && !ground_floor) {
			// unlit glass
			albedo = district == 0 ? vec3(0.03, 0.04, 0.055) : vec3(0.025, 0.03, 0.04);
			rough = 0.12;
			metal = 0.2;
			float lit = whash(uint(int(cid.x)) + 61u, uint(int(cid.y)) * 7u, bseed);
			if (lit < window_lit_fraction) {
				float warm = whash(uint(int(cid.x)) + 5u, uint(int(cid.y)) + 91u, bseed + 7u);
				float lum = 0.35 + 0.65 * whash(uint(int(cid.x)) + 23u, uint(int(cid.y)) + 3u, bseed + 31u);
				vec3 tint = warm < 0.72 ? vec3(1.0, 0.78, 0.5) : vec3(0.72, 0.82, 1.0);
				// soft interior gradient so windows aren't flat cards
				float grad = 0.75 + 0.25 * f.y;
				emission = tint * lum * grad * window_glow;
			}
		} else if (ground_floor && (district == 0 || district == 1)) {
			// storefront band
			albedo = wall * 0.65 + vec3(0.02);
			rough = 0.55;
		}
	}

	ALBEDO = albedo;
	ROUGHNESS = rough;
	METALLIC = metal;
	EMISSION = emission;
}
