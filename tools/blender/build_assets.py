import json
import math
import struct
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "assets" / "models"


def make_material(name, color, metallic=0.0, roughness=0.75, emission=None, alpha=1.0):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*color, alpha)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, alpha)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Alpha"].default_value = alpha
    if emission is not None:
        shader.inputs["Emission Color"].default_value = (*emission, 1.0)
        shader.inputs["Emission Strength"].default_value = 3.0
    if alpha < 1.0:
        material.surface_render_method = "BLENDED"
        material.blend_method = "BLEND"
        material.use_transparency_overlap = False
    return material


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        bpy.data.materials.remove(block)


def finish_object(obj, material):
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    return obj


def add_box(name, size, location, material, bevel=0.0, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    if bevel > 0:
        modifier = obj.modifiers.new(name="Single bevel", type="BEVEL")
        modifier.width = bevel
        modifier.segments = 1
    return finish_object(obj, material)


def add_cylinder(
    name,
    radius,
    depth,
    location,
    material,
    vertices=10,
    rotation=(0.0, 0.0, 0.0),
):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    return finish_object(obj, material)


def add_cone(name, radius1, radius2, depth, location, material, vertices=12):
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius1,
        radius2=radius2,
        depth=depth,
        location=location,
    )
    obj = bpy.context.object
    obj.name = name
    return finish_object(obj, material)


def add_sphere(name, radius, location, material, scale=(1.0, 1.0, 1.0)):
    segments = 8
    rings = 4
    vertices = [(0.0, 0.0, radius)]
    for ring in range(1, rings):
        polar = math.pi * ring / rings
        ring_radius = math.sin(polar) * radius
        z = math.cos(polar) * radius
        for segment in range(segments):
            angle = math.tau * segment / segments
            vertices.append(
                (math.cos(angle) * ring_radius, math.sin(angle) * ring_radius, z)
            )
    bottom = len(vertices)
    vertices.append((0.0, 0.0, -radius))

    faces = []
    for segment in range(segments):
        next_segment = (segment + 1) % segments
        faces.append((0, 1 + segment, 1 + next_segment))
    for ring in range(rings - 2):
        upper = 1 + ring * segments
        lower = upper + segments
        for segment in range(segments):
            next_segment = (segment + 1) % segments
            faces.append((upper + segment, lower + segment, lower + next_segment))
            faces.append((upper + segment, lower + next_segment, upper + next_segment))
    last_ring = 1 + (rings - 2) * segments
    for segment in range(segments):
        next_segment = (segment + 1) % segments
        faces.append((bottom, last_ring + next_segment, last_ring + segment))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.scale = scale
    return finish_object(obj, material)


def add_bar(name, start, end, radius, material, vertices=8):
    start_point = Vector(start)
    end_point = Vector(end)
    direction = end_point - start_point
    obj = add_cylinder(
        name,
        radius,
        direction.length,
        (start_point + end_point) / 2,
        material,
        vertices,
    )
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    return obj


def build_proscenium(materials):
    wood, velvet, brass, _, _ = materials
    objects = [
        add_box("left_column", (0.75, 0.7, 4.6), (-3.75, 0.0, 2.3), wood, 0.08),
        add_box("right_column", (0.75, 0.7, 4.6), (3.75, 0.0, 2.3), wood, 0.08),
        add_box("left_base", (1.15, 0.95, 0.35), (-3.75, 0.0, 0.18), brass, 0.05),
        add_box("right_base", (1.15, 0.95, 0.35), (3.75, 0.0, 0.18), brass, 0.05),
        add_box("top_beam", (8.1, 0.78, 0.55), (0.0, 0.0, 4.65), wood, 0.08),
        add_box("inner_valance", (6.7, 0.28, 0.42), (0.0, -0.42, 4.15), velvet, 0.04),
    ]
    for index in range(9):
        angle = math.radians(180 - index * 22.5)
        x = math.cos(angle) * 2.9
        z = 3.85 + math.sin(angle) * 1.05
        objects.append(
            add_box(
                f"arch_{index}",
                (0.9, 0.5, 0.28),
                (x, -0.08, z),
                brass,
                0.04,
                rotation=(0.0, angle - math.pi / 2, 0.0),
            )
        )
    return objects


def build_curtain(materials, side):
    _, velvet, brass, _, _ = materials
    objects = []
    for index in range(7):
        x = -1.38 + index * 0.46
        depth = 0.22 if index % 2 == 0 else 0.12
        height = 4.15 - abs(index - 3) * 0.06
        objects.append(
            add_box(
                f"{side}_fold_{index}",
                (0.52, depth, height),
                (x, -depth / 2, height / 2),
                velvet,
                0.045,
            )
        )
    inner = 1.25 if side == "left" else -1.25
    objects.extend(
        [
            add_box(
                f"{side}_valance", (3.35, 0.3, 0.55), (0.0, -0.05, 4.02), velvet, 0.06
            ),
            add_cylinder(
                f"{side}_tie",
                0.12,
                0.55,
                (inner, -0.22, 2.0),
                brass,
                8,
                (math.pi / 2, 0, 0),
            ),
        ]
    )
    return objects


def build_stage(materials):
    wood, velvet, brass, _, _ = materials
    return [
        add_box("stage_deck", (9.2, 4.4, 0.42), (0.0, 0.0, 0.58), wood, 0.06),
        add_box("stage_fascia", (9.25, 0.32, 0.62), (0.0, -2.1, 0.42), velvet, 0.04),
        add_box(
            "stage_brass_edge", (9.35, 0.18, 0.14), (0.0, -2.23, 0.78), brass, 0.03
        ),
        add_box("stage_step_top", (4.8, 0.9, 0.24), (0.0, -2.55, 0.3), wood, 0.04),
        add_box("stage_step_low", (3.8, 0.72, 0.18), (0.0, -3.05, 0.12), wood, 0.03),
    ]


def build_seat_row(materials):
    wood, velvet, brass, _, _ = materials
    objects = []
    for index in range(6):
        x = (index - 2.5) * 1.3
        objects.extend(
            [
                add_box(
                    f"seat_{index}", (1.02, 0.86, 0.25), (x, 0.0, 0.62), velvet, 0.08
                ),
                add_box(
                    f"back_{index}", (1.02, 0.22, 1.05), (x, 0.35, 1.16), velvet, 0.08
                ),
                add_box(
                    f"frame_{index}", (1.15, 0.12, 0.16), (x, 0.43, 0.65), wood, 0.03
                ),
                add_sphere(f"button_{index}", 0.06, (x, 0.22, 1.22), brass),
            ]
        )
    return objects


def build_footlight(materials):
    wood, _, brass, ghost_light, _ = materials
    return [
        add_box("footlight_base", (0.72, 0.52, 0.18), (0.0, 0.0, 0.09), wood, 0.04),
        add_cone("footlight_housing", 0.3, 0.2, 0.38, (0.0, 0.0, 0.31), brass, 10),
        add_sphere(
            "footlight_lens", 0.21, (0.0, 0.0, 0.52), ghost_light, (1.0, 1.0, 0.62)
        ),
    ]


def build_chandelier(materials):
    _, _, brass, ghost_light, _ = materials
    objects = [
        add_cylinder("ceiling_chain", 0.07, 1.8, (0.0, 0.0, 2.9), brass, 8),
        add_cylinder("center_stem", 0.13, 1.25, (0.0, 0.0, 1.42), brass, 10),
        add_sphere("center_light", 0.27, (0.0, 0.0, 0.8), ghost_light),
    ]
    for index in range(8):
        angle = index * math.tau / 8
        inner = (math.cos(angle) * 0.18, math.sin(angle) * 0.18, 1.25)
        outer = (math.cos(angle) * 1.2, math.sin(angle) * 1.2, 1.0)
        objects.append(add_bar(f"arm_{index}", inner, outer, 0.055, brass))
        objects.append(
            add_sphere(f"bulb_{index}", 0.17, (outer[0], outer[1], 1.05), ghost_light)
        )
    return objects


def build_poster_frame(materials):
    wood, velvet, brass, _, _ = materials
    return [
        add_box("poster_back", (2.3, 0.13, 3.25), (0.0, 0.08, 1.63), velvet, 0.04),
        add_box("poster_left", (0.19, 0.25, 3.55), (-1.18, 0.0, 1.78), brass, 0.04),
        add_box("poster_right", (0.19, 0.25, 3.55), (1.18, 0.0, 1.78), brass, 0.04),
        add_box("poster_top", (2.55, 0.25, 0.19), (0.0, 0.0, 3.48), brass, 0.04),
        add_box("poster_bottom", (2.55, 0.25, 0.19), (0.0, 0.0, 0.08), brass, 0.04),
        add_box("poster_crown", (2.8, 0.31, 0.24), (0.0, 0.0, 3.73), wood, 0.04),
    ]


def build_marquee(materials):
    _, velvet, brass, ghost_light, _ = materials
    objects = [
        add_box("marquee_back", (5.8, 0.28, 1.65), (0.0, 0.12, 0.83), velvet, 0.08),
        add_box("marquee_top", (6.2, 0.45, 0.2), (0.0, 0.0, 1.7), brass, 0.05),
        add_box("marquee_bottom", (6.2, 0.45, 0.2), (0.0, 0.0, -0.04), brass, 0.05),
        add_box("marquee_left", (0.2, 0.45, 1.55), (-3.0, 0.0, 0.83), brass, 0.04),
        add_box("marquee_right", (0.2, 0.45, 1.55), (3.0, 0.0, 0.83), brass, 0.04),
    ]
    bulb_positions = [
        (x, z) for x in (-2.7, -1.8, -0.9, 0.0, 0.9, 1.8, 2.7) for z in (0.1, 1.55)
    ]
    bulb_positions.extend([(-2.85, 0.55), (-2.85, 1.1), (2.85, 0.55), (2.85, 1.1)])
    for index, (x, z) in enumerate(bulb_positions):
        objects.append(
            add_sphere(f"marquee_bulb_{index}", 0.1, (x, -0.17, z), ghost_light)
        )
    return objects


def build_spotlight_cone(materials):
    _, _, brass, ghost_light, ghost_glass = materials
    return [
        add_cone("spotlight_beam", 1.2, 0.16, 3.8, (0.0, 0.0, 1.9), ghost_glass, 12),
        add_cylinder("spotlight_cap", 0.24, 0.22, (0.0, 0.0, 3.86), brass, 10),
        add_sphere("spotlight_source", 0.15, (0.0, 0.0, 3.72), ghost_light),
    ]


def build_foyer_doors(materials):
    wood, velvet, brass, _, _ = materials
    objects = [
        add_box("door_left", (2.65, 0.28, 4.1), (-1.38, 0.0, 2.05), wood, 0.06),
        add_box("door_right", (2.65, 0.28, 4.1), (1.38, 0.0, 2.05), wood, 0.06),
        add_box("door_header", (6.0, 0.5, 0.35), (0.0, 0.0, 4.27), velvet, 0.06),
        add_box(
            "door_left_trim", (0.22, 0.42, 4.35), (-2.83, -0.04, 2.17), brass, 0.04
        ),
        add_box(
            "door_right_trim", (0.22, 0.42, 4.35), (2.83, -0.04, 2.17), brass, 0.04
        ),
    ]
    for side in (-1, 1):
        objects.append(
            add_box(
                f"door_panel_{side}",
                (1.85, 0.12, 2.75),
                (side * 1.38, -0.2, 2.0),
                velvet,
                0.06,
            )
        )
        objects.append(
            add_sphere(f"door_handle_{side}", 0.12, (side * 0.36, -0.32, 2.0), brass)
        )
    return objects


def build_pedestal(materials):
    wood, velvet, brass, _, _ = materials
    return [
        add_cylinder("pedestal_base", 0.68, 0.22, (0.0, 0.0, 0.11), brass, 12),
        add_cone("pedestal_column", 0.38, 0.27, 1.35, (0.0, 0.0, 0.88), wood, 10),
        add_cylinder("pedestal_top", 0.58, 0.2, (0.0, 0.0, 1.62), brass, 12),
        add_box(
            "pedestal_plaque", (0.62, 0.08, 0.28), (0.0, -0.39, 0.9), velvet, 0.025
        ),
    ]


def build_tophat(materials):
    wood, velvet, brass, _, _ = materials
    return [
        add_cylinder("hat_brim", 0.72, 0.11, (0.0, 0.0, 0.06), wood, 16),
        add_cone("hat_crown", 0.47, 0.4, 0.72, (0.0, 0.0, 0.45), wood, 14),
        add_cylinder("hat_band", 0.485, 0.18, (0.0, 0.0, 0.2), velvet, 14),
        add_box("hat_buckle", (0.2, 0.08, 0.17), (0.0, -0.48, 0.22), brass, 0.025),
    ]


def build_mask(materials):
    _, velvet, brass, ghost_light, _ = materials
    objects = [
        add_sphere("mask_face", 0.72, (0.0, 0.0, 0.75), velvet, (1.0, 0.22, 0.7)),
        add_sphere(
            "mask_eye_left", 0.18, (-0.27, -0.16, 0.82), ghost_light, (1.15, 0.18, 0.55)
        ),
        add_sphere(
            "mask_eye_right", 0.18, (0.27, -0.16, 0.82), ghost_light, (1.15, 0.18, 0.55)
        ),
        add_bar("mask_handle", (0.52, 0.0, 0.34), (0.95, 0.0, -0.55), 0.055, brass, 8),
        add_box("mask_brow", (0.9, 0.08, 0.08), (0.0, -0.2, 1.05), brass, 0.02),
    ]
    return objects


def build_trophy(materials):
    wood, velvet, brass, _, _ = materials
    objects = [
        add_box("trophy_base", (0.9, 0.62, 0.22), (0.0, 0.0, 0.11), wood, 0.05),
        add_box("trophy_plaque", (0.54, 0.07, 0.18), (0.0, -0.33, 0.13), velvet, 0.02),
        add_cylinder("trophy_stem", 0.1, 0.58, (0.0, 0.0, 0.48), brass, 10),
        add_cone("trophy_cup", 0.48, 0.27, 0.7, (0.0, 0.0, 1.02), brass, 14),
        add_cylinder("trophy_lip", 0.52, 0.1, (0.0, 0.0, 1.41), brass, 14),
    ]
    objects.append(
        add_bar(
            "trophy_handle_left", (-0.3, 0.0, 1.23), (-0.68, 0.0, 0.9), 0.055, brass
        )
    )
    objects.append(
        add_bar("trophy_handle_right", (0.3, 0.0, 1.23), (0.68, 0.0, 0.9), 0.055, brass)
    )
    return objects


def read_glb_metrics(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise RuntimeError(f"Invalid GLB written at {path}")
    offset = 12
    document = None
    while offset < len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        if chunk_type == 0x4E4F534A:
            document = json.loads(
                data[offset : offset + chunk_length].decode("utf8").rstrip(" \x00")
            )
        offset += chunk_length
    if document is None:
        raise RuntimeError(f"No JSON chunk in {path}")

    triangles = 0
    accessors = document.get("accessors", [])
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            accessor = primitive.get(
                "indices", primitive.get("attributes", {}).get("POSITION")
            )
            triangles += accessors[accessor]["count"] // 3
    return {
        "file": path.name,
        "triangles": triangles,
        "materials": [
            material.get("name", "") for material in document.get("materials", [])
        ],
        "bytes": len(data),
    }


def export_model(filename, objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    target = OUTPUT / filename
    bpy.ops.export_scene.gltf(
        filepath=str(target),
        export_format="GLB",
        export_apply=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_texcoords=False,
        export_draco_mesh_compression_enable=False,
        export_yup=True,
        use_selection=True,
        check_existing=False,
    )
    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    return read_glb_metrics(target)


def main():
    reset_scene()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for stale in OUTPUT.glob("*.glb"):
        stale.unlink()

    materials = (
        make_material("Warm Wood", (0.22, 0.075, 0.035), roughness=0.68),
        make_material("Velvet Red", (0.33, 0.012, 0.045), roughness=0.88),
        make_material("Brass Gold", (0.64, 0.34, 0.07), metallic=0.72, roughness=0.28),
        make_material(
            "Ghost Light Cyan",
            (0.05, 0.62, 0.67),
            roughness=0.24,
            emission=(0.06, 0.9, 1.0),
        ),
        make_material(
            "Ghost Light Glass",
            (0.04, 0.55, 0.62),
            roughness=0.12,
            emission=(0.06, 0.8, 0.9),
            alpha=0.2,
        ),
    )

    builders = [
        ("proscenium.glb", lambda: build_proscenium(materials)),
        ("curtain_left.glb", lambda: build_curtain(materials, "left")),
        ("curtain_right.glb", lambda: build_curtain(materials, "right")),
        ("stage.glb", lambda: build_stage(materials)),
        ("seat_row.glb", lambda: build_seat_row(materials)),
        ("footlight.glb", lambda: build_footlight(materials)),
        ("chandelier.glb", lambda: build_chandelier(materials)),
        ("poster_frame.glb", lambda: build_poster_frame(materials)),
        ("marquee.glb", lambda: build_marquee(materials)),
        ("spotlight_cone.glb", lambda: build_spotlight_cone(materials)),
        ("foyer_doors.glb", lambda: build_foyer_doors(materials)),
        ("pedestal.glb", lambda: build_pedestal(materials)),
        ("prop_tophat.glb", lambda: build_tophat(materials)),
        ("prop_mask.glb", lambda: build_mask(materials)),
        ("prop_trophy.glb", lambda: build_trophy(materials)),
    ]

    models = [export_model(filename, builder()) for filename, builder in builders]
    unique_materials = sorted(
        {material for model in models for material in model["materials"]}
    )
    manifest = {
        "generator": "tools/blender/build_assets.py",
        "blenderVersion": bpy.app.version_string,
        "models": models,
        "totals": {
            "triangles": sum(model["triangles"] for model in models),
            "materials": unique_materials,
            "bytes": sum(model["bytes"] for model in models),
        },
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps(manifest["totals"], indent=2))


if __name__ == "__main__":
    main()
