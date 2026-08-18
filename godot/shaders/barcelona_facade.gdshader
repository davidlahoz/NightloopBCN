shader_type spatial;
render_mode world_vertex_coords, cull_back;

// Barcelona building facades — procedural windows without UVs.
// The OSM-derived meshes carry no texture coordinates, so the window grid is
// built from world space: u runs along the wall (horizontal tangent from the
// face normal), v is world height. Windows light up with the time of day via
// the same uniforms as the procedural city's facades.

uniform vec3 wall_tint : source_color = vec3(0.5, 0.42, 0.34);
uniform float window_lit_fraction : hint_range(0.0, 1.0) = 0.5;
uniform float window_glow : hint_range(0.0, 8.0) = 2.6;

// harvested Mapillary facade patches (CC BY-SA — see ASSETS.md); when
// photo_layers > 0 walls sample the atlas instead of the procedural grid
uniform sampler2DArray facade_photos : source_color, filter_linear_mipmap;
uniform int photo_layers = 0;
uniform float patch_w_m = 15.0;
uniform float patch_h_m = 21.0;

varying vec3 wpos;
varying vec3 wnormal;   // fragment NORMAL is view-space; keep the world one

void vertex() {
	wpos = VERTEX;
	wnormal = NORMAL;   // world space under world_vertex_coords
}

float whash(uint a, uint b, uint c) {
	uint h = a * 374761393u + b * 668265263u + c * 2246822519u;
	h = (h ^ (h >> 13u)) * 1274126177u;
	return float(h ^ (h >> 16u)) * (1.0 / 4294967296.0);
}

void fragment() {
	vec3 wn = normalize(wnormal);
	bool roof = wn.y > 0.6;
	vec3 albedo;
	float rough = 0.85;
	float metal = 0.0;
	vec3 emission = vec3(0.0);

	if (roof) {
		albedo = vec3(0.16, 0.13, 0.11);
		rough = 0.95;
	} else {
		// horizontal along-wall coordinate from the face normal
		vec2 n = wn.xz;
		float nl = length(n);
		vec2 t = nl > 0.05 ? vec2(-n.y, n.x) / nl : vec2(1.0, 0.0);
		float u = dot(wpos.xz, t);
		float v = wpos.y;

		// per-building tone variation from coarse world position
		uint bx = uint(int(floor(wpos.x / 11.0)));
		uint bz = uint(int(floor(wpos.z / 11.0)));
		float tone = 0.78 + 0.42 * whash(bx, bz, 5u);
		albedo = wall_tint * tone;

		if (photo_layers > 0) {
			// real facade patch, mirrored repeat, ground line at v = 0
			float layer = floor(whash(bx, bz, 77u) * float(photo_layers));
			float mu = abs(fract(u / patch_w_m * 0.5) * 2.0 - 1.0);
			float mv = abs(fract(max(v, 0.0) / patch_h_m * 0.5) * 2.0 - 1.0);
			vec3 photo = texture(facade_photos, vec3(mu, 1.0 - mv, layer)).rgb;
			// the photos carry baked-in sunlight — compress contrast and
			// de-gain so the engine's own lighting doesn't blow them out
			float plum = dot(photo, vec3(0.333));
			photo = mix(vec3(plum), photo, 0.85);
			photo = min(photo * 0.62, vec3(0.72));
			albedo = photo * (0.90 + 0.16 * whash(bx, bz, 5u));
			rough = 0.85;
			metal = 0.0;
			// night windows: the photo's dark panes glow per window cell
			vec2 wc = floor(vec2(u / 1.9, v / 3.0));
			uint wu = uint(int(wc.x) + 40000);
			uint wv = uint(int(wc.y) + 40000);
			float lum = dot(photo, vec3(0.333));
			float dark = smoothstep(0.34, 0.10, lum);
			if (whash(wu * 13u, wv * 7u, bx + bz * 57u) < window_lit_fraction) {
				float warm = whash(wu + 5u, wv + 91u, 7u);
				vec3 tint = warm < 0.72 ? vec3(1.0, 0.78, 0.5) : vec3(0.72, 0.82, 1.0);
				// stay under the bloom threshold: lit panes glow, not flare
				emission = min(tint * dark * window_glow * 0.24, vec3(1.05));
			}
		} else {

		// window grid in metres; solid ground floor, parapet at the top edge
		vec2 cell_size = vec2(1.85, 3.05);
		vec2 cid = floor(vec2(u, v) / cell_size);
		vec2 f = fract(vec2(u, v) / cell_size);
		bool in_window = f.x > 0.22 && f.x < 0.78 && f.y > 0.28 && f.y < 0.80;
		bool ground_floor = v < 3.4;
		if (in_window && !ground_floor) {
			albedo = vec3(0.028, 0.034, 0.045);
			rough = 0.15;
			metal = 0.2;
			uint cu = uint(int(cid.x) + 40000);
			uint cv = uint(int(cid.y) + 40000);
			float lit = whash(cu * 13u, cv * 7u, bx + bz * 57u);
			if (lit < window_lit_fraction) {
				float warm = whash(cu + 5u, cv + 91u, 7u);
				float lum = 0.35 + 0.65 * whash(cu + 23u, cv + 3u, 31u);
				vec3 tint = warm < 0.72 ? vec3(1.0, 0.78, 0.5) : vec3(0.72, 0.82, 1.0);
				emission = tint * lum * (0.75 + 0.25 * f.y) * window_glow;
			}
		} else if (ground_floor) {
			albedo *= 0.62;   // storefront/portal band
			rough = 0.6;
		}
		}
	}

	ALBEDO = albedo;
	ROUGHNESS = rough;
	METALLIC = metal;
	EMISSION = emission;
}
