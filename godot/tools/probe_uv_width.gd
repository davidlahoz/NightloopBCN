extends SceneTree
## Distribution of per-triangle "ribbon width" |dWorld/du| for road tiles —
## validates the shader's UV-based asphalt classifier.


func _init() -> void:
	var buckets: Dictionary = {}
	for t in ["tile_7_1_roads.glb", "tile_7_0_roads.glb", "tile_8_1_roads.glb"]:
		var root: Node = (load("res://barcelona/tiles/" + t) as PackedScene).instantiate()
		_walk(root, Transform3D.IDENTITY, buckets)
		root.free()
	var keys := buckets.keys()
	keys.sort()
	for k in keys:
		print("width %4d-%4d m : %8.0f m2" % [k, k * 2, buckets[k]])
	quit()


func _walk(n: Node, xf: Transform3D, buckets: Dictionary) -> void:
	if n is Node3D:
		xf = xf * (n as Node3D).transform
	if n is MeshInstance3D and (n as MeshInstance3D).mesh != null:
		var mesh: Mesh = (n as MeshInstance3D).mesh
		for si in mesh.get_surface_count():
			var arrays := mesh.surface_get_arrays(si)
			var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
			var uvs: PackedVector2Array = arrays[Mesh.ARRAY_TEX_UV]
			var idx: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
			for t in range(0, idx.size(), 3):
				var a := xf * verts[idx[t]]
				var b := xf * verts[idx[t + 1]]
				var c := xf * verts[idx[t + 2]]
				var e1 := Vector2(b.x - a.x, b.z - a.z)
				var e2 := Vector2(c.x - a.x, c.z - a.z)
				var u1 := uvs[idx[t + 1]] - uvs[idx[t]]
				var u2 := uvs[idx[t + 2]] - uvs[idx[t]]
				var den := u1.x * u2.y - u2.x * u1.y
				var area := absf(e1.cross(e2)) * 0.5
				if absf(den) < 1e-9:
					buckets[9998] = buckets.get(9998, 0.0) + area
					continue
				# dWorld/du (holding v): solve [e1 e2] = M [u1 u2]
				var wdu := (e1 * u2.y - e2 * u1.y) / den
				var w := wdu.length()
				var bucket := mini(int(w / 2.0), 100) * 2 / 2
				bucket = mini(int(w / 2.0) * 2, 200)
				buckets[bucket] = buckets.get(bucket, 0.0) + area
	for ch in n.get_children():
		_walk(ch, xf, buckets)
