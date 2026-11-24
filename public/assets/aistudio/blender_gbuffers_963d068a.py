#!/usr/bin/env python3
"""Headless Blender G-buffer renderer: keyframe a camera from a 6-DoF trajectory JSON and batch-render
depth / wireframe / flat-shading passes with the Workbench engine. Route-2 renderer stage: the G-buffers are the
motion/structure control signals; appearance comes from the property's own photos (refs/), never invented.
Usage:
  blender -b --factory-startup -P blender_gbuffers.py -- -i <site>_trajectory.json -o outdir \
      [--obj <site>_roof.obj] [-W 1920] [-H 1080] [-f 27.8182] [-p WIREFRAME,SHADING,DEPTH] [--keep-scene]
Trajectory JSON (from matrices_to_trajectory.py): {"convention": "opencv"|"opengl", "trajectory":
[{"frame", "x_enu", "y_enu", "z_enu", "qx", "qy", "qz", "qw"}, ...]} — positions/orientations camera-to-world;
the opencv convention (x right, y down, z forward — Earth Studio native, see <site>_camera_matrices.json) is
rotated to Blender's OpenGL camera (looks down -Z, +Y up) via a 180° rotation about camera X.
Focal length is mm on a 36 mm-wide sensor, HORIZONTAL fit: f_mm = fx_px * 36 / width_px (the converter prints it).
Provenance: adapted 3 Sep 2026 from Joe's drop headless_blender_render.py ("Spatio-Temporal Headless Blender
G-Buffer Automation Engine"). Changes from the original, all functional:
  - argparse -h/--height collided with auto --help (crash at parse) → -W/--width, -H/--height
  - camera clip_start 0.1 / clip_end 5000 (default clip_end 100 m clips a camera 240 m out)
  - sensor_fit HORIZONTAL, sensor_width 36 (removes AUTO ambiguity in the f_mm ↔ fx_px relation)
  - default startup scene purged (the default cube sits at the ENU origin — inside the building); --keep-scene to skip
  - --obj imports geometry with Y-forward/Z-up axes so OBJ coordinates are ENU verbatim (roof_to_obj.py output)
  - DEPTH pass: Workbench color_type 'DEPTH' is not a documented enum — UNVERIFIED until the first local Blender
    run; wrapped in try/except and skipped with a warning if rejected (fallback: enable the combined Z pass and
    write via compositor — not implemented blind). WIREFRAME and SHADING use documented enums.
  - scene fps 30, PNG output made explicit
First-run acceptance (once Blender is installed): WIREFRAME pass of <site>_roof.obj through this camera must
overlay-match qa/<site>_roof_edges_px.csv — check with engine/gen_qa.py against the frame PNGs.
"""
import os, sys, json, argparse


class HeadlessBufferRenderer:
    def __init__(self, input_path, output_dir, width=1920, height=1080, focal_length=27.8182, obj_path=None, keep_scene=False, frames=None):
        self.input_path = input_path; self.output_dir = output_dir
        self.width = width; self.height = height; self.focal_length = focal_length
        self.obj_path = obj_path; self.keep_scene = keep_scene; self.frames = frames
        import bpy, mathutils
        self.bpy = bpy; self.mathutils = mathutils

    def load_trajectory(self):
        if not os.path.exists(self.input_path):
            raise FileNotFoundError(f"trajectory JSON not found: {self.input_path}")
        data = json.load(open(self.input_path))
        if not data.get("trajectory"):
            raise ValueError(f"no trajectory array in {self.input_path}")
        return data

    def purge_scene(self):
        bpy = self.bpy
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        print("[RENDERER] Purged startup scene objects")

    def import_geometry(self):
        bpy = self.bpy
        if not self.obj_path: return
        # Y-forward / Z-up: OBJ coordinates arrive in Blender exactly as written (ENU metres)
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=self.obj_path, forward_axis='Y', up_axis='Z')
        else:
            bpy.ops.import_scene.obj(filepath=self.obj_path, axis_forward='Y', axis_up='Z')
        print(f"[RENDERER] Imported geometry: {self.obj_path}")

    def setup_camera(self, trajectory, convention="opengl"):
        bpy, mathutils = self.bpy, self.mathutils
        scene = bpy.context.scene; camera_name = "GES_Camera"
        if camera_name in bpy.data.objects:
            cam_obj = bpy.data.objects[camera_name]
        else:
            cam_data = bpy.data.cameras.new(name=camera_name)
            cam_obj = bpy.data.objects.new(name=camera_name, object_data=cam_data)
            scene.collection.objects.link(cam_obj)
        scene.camera = cam_obj
        cam_obj.rotation_mode = 'QUATERNION'
        cam_obj.data.lens = self.focal_length
        cam_obj.data.sensor_fit = 'HORIZONTAL'; cam_obj.data.sensor_width = 36.0
        cam_obj.data.clip_start = 0.1; cam_obj.data.clip_end = 5000.0
        if cam_obj.animation_data: cam_obj.animation_data_clear()
        scene.frame_start = int(trajectory[0]["frame"]); scene.frame_end = int(trajectory[-1]["frame"])
        scene.render.fps = 30
        print(f"[RENDERER] Animation range {scene.frame_start}..{scene.frame_end}, lens {self.focal_length:g} mm (36 mm sensor, horizontal fit)")
        flip = mathutils.Matrix(((1, 0, 0), (0, -1, 0), (0, 0, -1))).to_quaternion()  # OpenCV c2w → OpenGL c2w
        for point in trajectory:
            frame = int(point["frame"])
            cam_obj.location = (float(point["x_enu"]), float(point["y_enu"]), float(point["z_enu"]))
            cam_obj.keyframe_insert(data_path="location", frame=frame)
            q = mathutils.Quaternion((float(point["qw"]), float(point["qx"]), float(point["qy"]), float(point["qz"])))
            if convention == "opencv": q = q @ flip
            cam_obj.rotation_quaternion = q
            cam_obj.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        return cam_obj

    def set_wireframe(self, enabled):
        bpy = self.bpy
        for obj in bpy.data.objects:
            if obj.type != 'MESH': continue
            obj.color = (1.0, 1.0, 1.0, 1.0)
            mod = obj.modifiers.get("gbuf_wire")
            if enabled and not mod:
                mod = obj.modifiers.new("gbuf_wire", 'WIREFRAME')
                mod.thickness = 0.15; mod.use_replace = True; mod.use_even_offset = False
            elif not enabled and mod:
                obj.modifiers.remove(mod)

    def configure_workbench_shading(self, pass_type):
        bpy = self.bpy; scene = bpy.context.scene
        scene.render.engine = 'BLENDER_WORKBENCH'
        scene.render.image_settings.file_format = 'PNG'
        # Standard transform: the 4.x default (AgX) tone-maps pure white object color to mid-grey — G-buffers must be linear-ish
        scene.view_settings.view_transform = 'Standard'
        if scene.world is None: scene.world = bpy.data.worlds.new("gbuf_world")
        scene.world.color = (0, 0, 0)  # Workbench WORLD background uses world.color
        shading = scene.display.shading
        if pass_type == "DEPTH":
            shading.light = 'FLAT'
            shading.color_type = 'DEPTH'  # UNVERIFIED enum — see docstring; caller catches TypeError
            scene.render.image_settings.color_mode = 'BW'; scene.render.image_settings.color_depth = '16'
        elif pass_type == "WIREFRAME":
            # Workbench render shading has no show_edges (viewport-only, verified Blender 4.x) — a Wireframe
            # modifier gives a geometry-true wireframe instead: with n-gon faces, the mesh edges ARE the facet
            # boundary edges. Toggled per-pass by execute_render_pipeline via set_wireframe().
            shading.light = 'FLAT'; shading.color_type = 'OBJECT'
            shading.background_type = 'WORLD'
            scene.render.image_settings.color_mode = 'RGB'; scene.render.image_settings.color_depth = '8'
        else:  # SHADING
            shading.light = 'FLAT'; shading.color_type = 'TEXTURE'
            scene.render.image_settings.color_mode = 'RGB'; scene.render.image_settings.color_depth = '8'
        print(f"[RENDERER] Shading configured: {pass_type}")

    def execute_render_pipeline(self, passes):
        bpy = self.bpy; scene = bpy.context.scene
        data = self.load_trajectory()
        if not self.keep_scene: self.purge_scene()
        self.import_geometry()
        self.setup_camera(data["trajectory"], convention=data.get("convention", "opengl"))
        scene.render.resolution_x = self.width; scene.render.resolution_y = self.height
        scene.render.resolution_percentage = 100
        for render_pass in passes:
            pass_dir = os.path.join(self.output_dir, render_pass.lower())
            os.makedirs(pass_dir, exist_ok=True)
            try:
                self.configure_workbench_shading(render_pass)
            except (TypeError, AttributeError) as e:
                print(f"[WARN] pass {render_pass} not supported by this Blender ({e}) — skipped. "
                      f"Fallback: enable Z pass + compositor output (see docstring).")
                continue
            self.set_wireframe(render_pass == "WIREFRAME")
            if self.frames:  # targeted stills (e.g. the gen_qa contact frames) instead of the full animation
                for fr in self.frames:
                    scene.frame_set(fr)
                    scene.render.filepath = os.path.join(pass_dir, f"frame_{fr:04d}")
                    bpy.ops.render.render(write_still=True)
                print(f"[RENDERER] Rendered stills {self.frames} → {pass_dir}")
            else:
                scene.render.filepath = os.path.join(pass_dir, "frame_")
                print(f"[RENDERER] Rendering {render_pass} → {pass_dir}")
                bpy.ops.render.render(animation=True)
                print(f"[RENDERER] Completed {render_pass}")


def parse_args():
    argv = sys.argv
    script_args = argv[argv.index("--") + 1:] if "--" in argv else []
    p = argparse.ArgumentParser(description="Headless Blender trajectory G-buffer renderer")
    p.add_argument("-i", "--input", required=True, help="trajectory JSON (from matrices_to_trajectory.py)")
    p.add_argument("-o", "--output", required=True, help="G-buffer root output directory")
    p.add_argument("--obj", help="OBJ geometry to import (ENU coordinates, from roof_to_obj.py)")
    p.add_argument("-W", "--width", type=int, default=1920)
    p.add_argument("-H", "--height", type=int, default=1080)
    p.add_argument("-f", "--focal-length", type=float, default=27.8182, help="mm on a 36 mm sensor = fx_px*36/width_px")
    p.add_argument("-p", "--passes", default="WIREFRAME,SHADING", help="comma-separated: DEPTH,SHADING,WIREFRAME")
    p.add_argument("--keep-scene", action="store_true", help="do not purge the startup/loaded scene")
    p.add_argument("--frames", help="comma-separated frame numbers: render only these as stills (default: full animation)")
    return p.parse_args(script_args)


def main():
    args = parse_args()
    passes = [x.strip().upper() for x in args.passes.split(",") if x.strip()]
    passes = [x for x in passes if x in {"DEPTH", "WIREFRAME", "SHADING"}] or ["WIREFRAME"]
    frames = [int(x) for x in args.frames.split(",")] if args.frames else None
    renderer = HeadlessBufferRenderer(args.input, args.output, args.width, args.height,
                                      args.focal_length, args.obj, args.keep_scene, frames)
    renderer.execute_render_pipeline(passes)
    print("[RENDERER] Done")


if __name__ == "__main__":
    try:
        import bpy  # noqa: F401
        main()
    except ImportError:
        print("bpy not available — run inside Blender: blender -b --factory-startup -P blender_gbuffers.py -- <args>")
        sys.exit(0)
