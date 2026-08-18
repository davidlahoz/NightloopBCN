shader_type spatial;
render_mode world_vertex_coords, cull_back;

// NIGHTLOOP ground shader — zones, lane paint, districts, wetness.
// Mirrors scripts/city_plan.gd EXACTLY for: warp constants, cell_seed (u32
// math), street thinning, faces and the fillet SDF. Change both or neither.
// Heights come from the baked chunk meshes (road_profile.gd); this shader
// only colours the surface, so its noise does NOT need to match the CPU.

uniform uint world_seed = 0u;
uniform float wetness : hint_range(0.0, 1.0) = 0.55;
uniform float puddle_level : hint_range(0.0, 1.0) = 0.75;

// ---- plan constants (city_plan.gd) ----
const float PERIOD_X = 200.0;
const float PERIOD_Z = 160.0;
const float ROAD_HALF = 4.0;
const float GUTTER_W = 0.45;
const float CURB_FACE = 4.45;
const float CURB_W = 0.15;
const float SIDEWALK_W = 2.85;
const float CORNER_R = 5.5;
const float MWAY_HALF = 12.0;
const float MWAY_FACE = 12.45;
const float MWAY_MEDIAN = 1.0;
const float MWAY_LANE_W = 3.5;

varying vec3 wpos;

void vertex() {
	wpos = VERTEX; // world_vertex_coords: VERTEX is world-space here
}

// ---- seeded plan hashing (must match CityPlan.cell_seed bit-exactly) ----
float cell_seed(int i, int j, int salt) {
	uint h = uint(i) * 374761393u + uint(j) * 668265263u + uint(salt) * 2246822519u + world_seed;
	h = (h ^ (h >> 13u)) * 1274126177u;
	return float(h ^ (h >> 16u)) * (1.0 / 4294967296.0);
}

int floor_div3(int v) {
	return int(floor(float(v) / 3.0));
}

bool ns_drop_cand(int i, int jc) {
	float p = 0.16 + 0.34 * cell_seed(floor_div3(i), floor_div3(jc), 611);
	return cell_seed(i, jc, 271) < p;
}

bool ns_drop_raw(int i, int jc) {
	return ns_drop_cand(i, jc) && !ns_drop_cand(i, jc - 1);
}

bool ns_seg_present(int i, int jc) {
	if (i == 0 && (jc == -1 || jc == 0)) {
		return true; // spawn street always exists
	}
	return !(ns_drop_raw(i, jc) && !(ns_drop_raw(i - 1, jc) && ns_drop_raw(i - 2, jc)));
}

int district_of(int ix, int jz) {
	int mi = floor_div3(ix);
	int mj = floor_div3(jz);
	if (mi >= -1 && mi <= 0 && mj >= -1 && mj <= 0) {
		return 1; // spawn neighbourhood: commercial
	}
	float r = cell_seed(mi, mj, 977);
	if (r < 0.22) { return 0; }
	if (r < 0.52) { return 1; }
	if (r < 0.76) { return 2; }
	if (r < 0.88) { return 3; }
	return 4; // countryside
}

// ---- street curvature warp (city_plan.gd warp_of) ----
vec2 warp_of(vec2 p) {
	return vec2(
		4.5 * sin(p.y * 0.0146126 + 0.9) + 2.0 * sin(p.y * 0.0299199 + 4.1),
		4.0 * sin(p.x * 0.0161107 + 2.3) + 2.0 * sin(p.x * 0.0363201 + 0.7));
}

// ---- decorative noise (pcg-ish; free to differ from CPU) ----
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
	// ---- road space (mirror of CityPlan.sample_road_space) ----
	vec2 xz = wpos.xz;
	vec2 w = warp_of(xz);
	float wx = xz.x + w.x;
	float wz = xz.y + w.y;
	int iA = int(floor(wx / PERIOD_X + 0.5));
	int iB = int(floor(wz / PERIOD_Z + 0.5));
	float tA = wx - float(iA) * PERIOD_X;
	float tB = wz - float(iB) * PERIOD_Z;
	bool mwayB = ((iB % 4) + 4) % 4 == 2;
	float faceA = CURB_FACE;
	float faceB = mwayB ? MWAY_FACE : CURB_FACE;

	// street thinning
	bool armN = ns_seg_present(iA, iB);
	bool armS = ns_seg_present(iA, iB - 1);
	if (!(armN && armS)) {
		bool col_here = (tB > faceB) ? armN : ((tB < -faceB) ? armS : (armN || armS));
		if (!col_here) {
			tA = faceA + 40.0;
		}
	}

	float atA = abs(tA);
	float atB = abs(tB);
	float dA = atA - faceA;
	float dB = atB - faceB;
	float d = min(dA, dB);
	if (dA < CORNER_R && dB < CORNER_R && dA > 0.0 && dB > 0.0) {
		float fd = CORNER_R - length(vec2(CORNER_R - dA, CORNER_R - dB));
		d = min(d, fd);
	}

	// district of the containing block cell
	int bx = int(floor(wx / PERIOD_X));
	int bz = int(floor(wz / PERIOD_Z));
	int district = district_of(bx, bz);
	bool rural = district == 4;

	// shared noise fields
	float patch = fbm2(xz * 0.043);          // large-scale tone patches
	float grain = vnoise(xz * 2.3);          // fine grain
	float wear = 0.45 + 0.55 * fbm2(xz * 0.9); // paint wear

	vec3 albedo;
	float rough;
	float spec = 0.5;

	if (d < 0.0) {
		// ---- carriageway ----
		vec3 aspB = mix(vec3(0.038, 0.039, 0.043), vec3(0.058, 0.059, 0.063), patch);
		albedo = aspB * (0.9 + 0.2 * grain);
		// gutter band darkening (last 0.45 m before the curb)
		albedo *= mix(0.72, 1.0, smoothstep(-0.02, -GUTTER_W, d));
		rough = 0.88 - 0.12 * grain;

		bool inA = atA < faceA;
		bool inB = atB < faceB;
		bool junction = inA && inB;

		// ---- lane paint (grid-space, follows the curves) ----
		float paint = 0.0;
		vec3 paint_col = vec3(0.62, 0.62, 0.60);
		if (inA && !junction && atB > faceB + 0.8) {
			// N-S street: dashed centre line
			float line = 1.0 - smoothstep(0.055, 0.085, atA);
			float dash = step(fract(wz / 6.0), 0.42);
			paint = max(paint, line * dash);
		}
		if (inB && !junction && atA > faceA + 0.8) {
			if (mwayB) {
				// median edge lines (solid)
				paint = max(paint, (1.0 - smoothstep(0.09, 0.13, abs(atB - 1.38))));
				// lane dashes at 4.5 and 8.0 from centre
				float dashm = step(fract(wx / 9.0), 0.5);
				paint = max(paint, (1.0 - smoothstep(0.06, 0.10, abs(atB - 4.5))) * dashm);
				paint = max(paint, (1.0 - smoothstep(0.06, 0.10, abs(atB - 8.0))) * dashm);
				// solid edge line
				paint = max(paint, 1.0 - smoothstep(0.07, 0.11, abs(atB - 11.6)));
			} else {
				float line = 1.0 - smoothstep(0.055, 0.085, atB);
				float dash = step(fract(wx / 6.0), 0.42);
				paint = max(paint, line * dash);
			}
		}
		paint *= wear;
		albedo = mix(albedo, paint_col, paint * 0.85);
		rough = mix(rough, 0.55, paint);

		// ---- motorway median island: concrete, faded near junctions ----
		if (mwayB) {
			float g = clamp((atA - faceA - 0.6) / 2.0, 0.0, 1.0);
			float island = (1.0 - smoothstep(0.95, 1.15, atB)) * g;
			albedo = mix(albedo, vec3(0.26, 0.255, 0.24) * (0.85 + 0.3 * grain), island);
			rough = mix(rough, 0.9, island);
		}

		// ---- wetness + puddles ----
		// damp asphalt darkens but stays fairly rough — mirror gloss lives in
		// the puddles, else SSR smears every lit window into milky blobs
		albedo *= 1.0 - wetness * 0.45;
		rough = mix(rough, 0.52, wetness * 0.8);
		spec = mix(spec, 0.32, wetness);
		float pn = fbm2(xz * 0.11 + 7.3);
		// puddles collect toward the gutters, avoid the crown
		float side = smoothstep(-3.4, -0.9, d);
		float pud = smoothstep(0.86 - puddle_level * 0.30, 0.94 - puddle_level * 0.30, pn * (0.55 + 0.45 * side)) * wetness;
		albedo = mix(albedo, albedo * 0.45, pud);
		rough = mix(rough, 0.04, pud);
		spec = mix(spec, 0.6, pud);

	} else if (d < CURB_W) {
		// ---- curb ----
		albedo = vec3(0.285, 0.28, 0.265) * (0.8 + 0.35 * grain);
		rough = 0.85;
		albedo *= 1.0 - wetness * 0.25;
		rough -= wetness * 0.25;

	} else if (d < CURB_W + SIDEWALK_W) {
		// ---- sidewalk (grass verge in the countryside) ----
		if (rural) {
			albedo = mix(vec3(0.045, 0.072, 0.030), vec3(0.078, 0.102, 0.044), fbm2(xz * 0.7));
			rough = 0.95;
		} else {
			albedo = mix(vec3(0.185, 0.178, 0.168), vec3(0.235, 0.228, 0.215), patch) * (0.86 + 0.25 * grain);
			// expansion joints in the warped frame (aligned with the street)
			float ja = step(fract(wx / 1.83), 0.028);
			float jb = step(fract(wz / 1.83), 0.028);
			albedo *= 1.0 - 0.3 * max(ja, jb);
			rough = 0.9;
			albedo *= 1.0 - wetness * 0.3;
			rough -= wetness * 0.3;
		}

	} else {
		// ---- block interior ----
		if (rural) {
			float gn = fbm2(xz * 0.35);
			albedo = mix(vec3(0.040, 0.066, 0.027), vec3(0.083, 0.106, 0.046), gn);
			rough = 0.95;
		} else {
			albedo = mix(vec3(0.115, 0.112, 0.106), vec3(0.155, 0.150, 0.142), patch) * (0.88 + 0.22 * grain);
			rough = 0.92;
			albedo *= 1.0 - wetness * 0.25;
		}
	}

	ALBEDO = albedo;
	ROUGHNESS = clamp(rough, 0.03, 1.0);
	SPECULAR = spec;
	METALLIC = 0.0;
}
