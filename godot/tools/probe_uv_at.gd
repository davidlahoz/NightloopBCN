extends SceneTree
## Print the UV at given world points by locating the containing triangle.

const POINTS := [
	Vector2(3793.1, 624.9),   # Consell de Cent street centre (spawn)
	Vector2(3789.0, 630.0),   # a few metres SE (still street?)
	Vector2(3782.0, 636.0),   # further SE (sidewalk?)
	Vector2(3740.0, 590.0),   # block interior
	Vector2(3651.0, 597.0),   # narrow side street
]


func _init() -> void:
	var root: Node = (load("res://barcelona/tiles/tile_7_1_roads.glb") as PackedScene).instantiate()
	_walk(root, Transform3D.IDENTITY)
	root.free()
	quit()


func _walk(n: Node, xf: Transform3D) -> void:
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
				for p in POINTS:
					var bc := _bary(p, Vector2(a.x, a.z), Vector2(b.x, b.z), Vector2(c.x, c.z))
					if bc.x >= -0.001 and bc.y >= -0.001 and bc.x + bc.y <= 1.001:
						var w := 1.0 - bc.x - bc.y
						var uv: Vector2 = uvs[idx[t]] * w + uvs[idx[t + 1]] * bc.x + uvs[idx[t + 2]] * bc.y
						print("point (%.0f,%.0f): uv=(%.3f, %.3f)  tri area %.0f m2" % [
							p.x, p.y, uv.x, uv.y,
							absf((b - a).cross(c - a).length()) * 0.5])
	for ch in n.get_children():
		_walk(ch, xf)


static func _bary(p: Vector2, a: Vector2, b: Vector2, c: Vector2) -> Vector2:
	var v0 := b - a
	var v1 := c - a
	var v2 := p - a
	var den := v0.x * v1.y - v1.x * v0.y
	if absf(den) < 1e-9:
		return Vector2(-1, -1)
	return Vector2((v2.x * v1.y - v1.x * v2.y) / den, (v0.x * v2.y - v2.x * v0.y) / den)
