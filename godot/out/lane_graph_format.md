# lane_graph.bin — format v1

Little-endian throughout. Produced by `tools/build_lane_graph.py`.

## Header (48 bytes)
| offset | type | field |
|---|---|---|
| 0  | 4 bytes | magic `"NLG1"` |
| 4  | u16 | version = 1 |
| 6  | u16 | flags = 0 |
| 8  | u32 | L — lane count |
| 12 | u32 | P — point count |
| 16 | u32 | C — connection count |
| 20 | u32 | J — junction count (informational) |
| 24 | u32 | T — traffic-light count |
| 28 | u32 | PH — phase count |
| 32 | u32 | S — successor list total |
| 36 | u32 | X — conflict list total |
| 40 | u32 | string blob bytes |
| 44 | u32 | phase-state blob bytes |

## Sections, in file order (no padding)
1. `lane_point_start` — u32 × (L+1). Prefix sums: lane i owns points
   `[start[i], start[i+1])`.
2. `points` — f32 × 4 × P: `x, y, z, cumdist`. Godot mesh-local metres
   (x = east − origin, z = −(north − origin), y = 0 — elevation is sampled
   at runtime). `cumdist` is arc length from the lane start; spacing ≈ 2 m,
   endpoints exact. Runtime lookup: `i = clamp(dist / spacing)` then lerp.
3. `lane_speed` — f32 × L, speed limit m/s.
4. `lane_length` — f32 × L, arc length m (equals last cumdist).
5. `lane_flags` — u16 × L. bit0 = junction-internal path, bit1 = spawnable.
6. `lane_spawn_weight` — f32 × L (0 for internal lanes).
7. `lane_succ_start` — u32 × (L+1) prefix into `succ_conn`.
8. `succ_conn` — u32 × S, connection indices leaving each lane.
9. `conn_from` — u32 × C, lane index.
10. `conn_to` — u32 × C, lane index.
11. `conn_via` — u32 × C, junction-internal lane index or `0xFFFFFFFF`.
    Cars traverse from→via→to; the via lane is the geometry across the
    junction.
12. `conn_dir` — u8 × C: 0 straight, 1 left, 2 right, 3 turn, 4 other.
13. `conn_tls` — u16 × C, traffic-light index or `0xFFFF`.
14. `conn_link` — u16 × C, linkIndex into the tls state string, `0xFFFF`
    when uncontrolled.
15. `conn_conflict_start` — u32 × (C+1) prefix into `conflicts`.
16. `conflicts` — u32 × X, connection indices this connection must yield
    to (derived offline from the junction `response` matrices).
17. `tls_offset` — f32 × T, program offset seconds.
18. `tls_phase_start` — u32 × (T+1) prefix into phases.
19. `phase_dur` — f32 × PH, seconds.
20. `phase_state_off` — u32 × PH, offset into the state blob.
21. `phase_state_len` — u16 × PH.
22. `state_blob` — u8 × (header field), concatenated phase state strings;
    one char per linkIndex: `G` protected green, `g` permissive green,
    `y` yellow, `r` red.
23. `lane_id_off` — u32 × (L+1) prefix into the string blob (SUMO lane ids,
    for debug/stuck-car logs only).
24. `string_blob` — utf-8.
