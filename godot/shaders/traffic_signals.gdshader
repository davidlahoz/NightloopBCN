// Ambient-traffic signal quads (brake / indicators / headlights).
// One MultiMesh surface; quad group in UV.x, state in INSTANCE_CUSTOM:
// r = brake, g = blink left, b = blink right, a = headlights on.
shader_type spatial;
render_mode unshaded, blend_mix, cull_back, depth_draw_opaque;

varying vec4 v_state;
varying float v_group;

void vertex() {
	v_state = INSTANCE_CUSTOM;
	v_group = UV.x;
}

void fragment() {
	vec3 col;
	float k;
	if (v_group < 0.5) {           // tail: running light at night + brake
		col = vec3(1.0, 0.05, 0.03);
		k = v_state.a * 0.35 + v_state.r * 1.8;
	} else if (v_group < 1.5) {    // left indicator
		col = vec3(1.0, 0.55, 0.08);
		k = v_state.g * 2.4;
	} else if (v_group < 2.5) {    // right indicator
		col = vec3(1.0, 0.55, 0.08);
		k = v_state.b * 2.4;
	} else {                       // headlights
		col = vec3(1.0, 0.94, 0.82);
		k = v_state.a * 2.2;
	}
	ALBEDO = vec3(0.0);
	EMISSION = col * k;
	ALPHA = k > 0.03 ? 1.0 : 0.0;
}
