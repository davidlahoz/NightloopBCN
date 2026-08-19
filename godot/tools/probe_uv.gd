extends SceneTree
## UV statistics for the roads tile — did the generator encode anything?


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
			var uv2 = arrays[Mesh.ARRAY_TEX_UV2]
			var col = arrays[Mesh.ARRAY_COLOR]
			print("surface %d verts=%d uv2=%s color=%s" % [
				si, verts.size(),
				"yes" if uv2 != null else "no",
				"yes" if col != null else "no"])
			var umin := Vector2(1e9, 1e9)
			var umax := Vector2(-1e9, -1e9)
			for u in uvs:
				umin = umin.min(u)
				umax = umax.max(u)
			print("  uv range: ", umin, " .. ", umax)
			for k in range(0, mini(24, verts.size())):
				var v := xf * verts[k]
				print("  v=(%.1f, %.1f)  uv=(%.3f, %.3f)" % [v.x, v.z, uvs[k].x, uvs[k].y])
	for ch in n.get_children():
		_walk(ch, xf)
