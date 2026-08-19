extends SceneTree
## List material names + surface areas in a few road tiles.
## Run: godot --headless --path . --script tools/probe_mats.gd


func _init() -> void:
	var totals: Dictionary = {}
	for t in ["tile_7_1_buildings.glb", "tile_7_0_buildings.glb", "tile_8_1_buildings.glb"]:
		var path: String = "res://barcelona/tiles/" + t
		if not ResourceLoader.exists(path):
			continue
		var root: Node = (load(path) as PackedScene).instantiate()
		_walk(root, totals)
		root.free()
	for k in totals:
		print("%-28s %10.0f m2" % [k, totals[k]])
	quit()


func _walk(n: Node, totals: Dictionary) -> void:
	if n is MeshInstance3D and (n as MeshInstance3D).mesh != null:
		var mesh: Mesh = (n as MeshInstance3D).mesh
		for si in mesh.get_surface_count():
			var mat: Material = mesh.surface_get_material(si)
			var nm := mat.resource_name if mat != null else "(none)"
			var arrays := mesh.surface_get_arrays(si)
			var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
			var idx: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
			var area := 0.0
			for k in range(0, idx.size(), 3):
				var a := verts[idx[k]]
				var b := verts[idx[k + 1]]
				var c := verts[idx[k + 2]]
				area += (b - a).cross(c - a).length() * 0.5
			totals[nm] = totals.get(nm, 0.0) + area
	for ch in n.get_children():
		_walk(ch, totals)
