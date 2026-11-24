import json
import math
import os
import sys
import numpy as np
from typing import Dict, List, Tuple

class GESCameraConverter:
    # WGS-84 Ellipsoid constants
    WGS84_A = 6378137.0  # Semi-major axis (meters)
    WGS84_F = 1.0 / 298.257223563  # Flattening
    WGS84_E2 = 2 * WGS84_F - WGS84_F**2  # First eccentricity squared

    def __init__(self, origin_lat: float = None, origin_lon: float = None, origin_alt: float = None):
        """
        Initialize converter. If origin coordinates are not provided,
        the first frame's coordinates in the trajectory will be designated as the local ENU origin.
        """
        self.origin_lat = origin_lat
        self.origin_lon = origin_lon
        self.origin_alt = origin_alt
        self.origin_ecef = None
        if origin_lat is not None and origin_lon is not None and origin_alt is not None:
            self.set_origin(origin_lat, origin_lon, origin_alt)

    @classmethod
    def wgs84_to_ecef(cls, lat: float, lon: float, alt: float) -> Tuple[float, float, float]:
        """
        Converts Geodetic coordinates (Latitude, Longitude, Altitude) to Earth-Centered, Earth-Fixed (ECEF) coordinates.
        Uses standard WGS84 ellipsoidal transformations.
        """
        lat_rad = math.radians(lat)
        lon_rad = math.radians(lon)

        # Radius of curvature in the prime vertical
        n = cls.WGS84_A / math.sqrt(1.0 - cls.WGS84_E2 * (math.sin(lat_rad) ** 2))

        x = (n + alt) * math.cos(lat_rad) * math.cos(lon_rad)
        y = (n + alt) * math.cos(lat_rad) * math.sin(lon_rad)
        z = (n * (1.0 - cls.WGS84_E2) + alt) * math.sin(lat_rad)

        return x, y, z

    def ecef_to_enu(self, x: float, y: float, z: float) -> Tuple[float, float, float]:
        """
        Transforms ECEF coordinates into local East, North, Up (ENU) frame relative to the designated origin.
        """
        if self.origin_ecef is None:
            raise ValueError("Origin ECEF coordinates not set. Convert or set origin first.")

        dx = x - self.origin_ecef[0]
        dy = y - self.origin_ecef[1]
        dz = z - self.origin_ecef[2]

        lat_rad = math.radians(self.origin_lat)
        lon_rad = math.radians(self.origin_lon)

        sin_lat = math.sin(lat_rad)
        cos_lat = math.cos(lat_rad)
        sin_lon = math.sin(lon_rad)
        cos_lon = math.cos(lon_rad)

        # Rotation matrix from ECEF to ENU
        e = -sin_lon * dx + cos_lon * dy
        n = -sin_lat * cos_lon * dx - sin_lat * sin_lon * dy + cos_lat * dz
        u = cos_lat * cos_lon * dx + cos_lat * sin_lon * dy + sin_lat * dz

        return e, n, u

    def set_origin(self, lat: float, lon: float, alt: float):
        """Manually define the local system origin coordinates."""
        self.origin_lat = lat
        self.origin_lon = lon
        self.origin_alt = alt
        self.origin_ecef = self.wgs84_to_ecef(lat, lon, alt)

    def parse_ges_json(self, json_path: str) -> Dict:
        """
        Parses Google Earth Studio 3D Tracking JSON data.
        Recognizes the real schema with cameraFrames[] and trackPoints[].
        """
        with open(json_path, 'r') as f:
            data = json.load(f)

        # If data is list, it's old schema. We handle it as a fallback.
        if isinstance(data, list):
            return {
                "width": 1920,
                "height": 1080,
                "frameRate": 30,
                "numFrames": len(data) - 1,
                "cameraFrames": data,
                "trackPoints": []
            }

        # Real schema handling:
        camera_frames = data.get("cameraFrames", [])
        if not camera_frames:
            # Fallback to older keys in case we parse legacy wrapped files
            camera_frames = data.get("frames", data.get("camera", []))

        return {
            "name": data.get("name", "GES_Export"),
            "width": data.get("width", 1920),
            "height": data.get("height", 1080),
            "frameRate": data.get("frameRate", 30),
            "numFrames": data.get("numFrames", len(camera_frames) - 1 if camera_frames else 0),
            "cameraFrames": camera_frames,
            "trackPoints": data.get("trackPoints", [])
        }

    def convert_trajectory(self, input_file: str, convention: str = "opengl", use_ellipsoidal: bool = False) -> Dict:
        """
        Orchestrates reading input trajectory and mapping to local 6-DoF poses,
        as well as converting track points.
        """
        _, ext = os.path.splitext(input_file.lower())
        if ext == ".json":
            parsed_data = self.parse_ges_json(input_file)
        else:
            raise ValueError(f"Unsupported file extension: {ext}. Only real JSON schema is supported.")

        camera_frames = parsed_data["cameraFrames"]
        track_points = parsed_data["trackPoints"]
        width = parsed_data["width"]
        height = parsed_data["height"]

        if not camera_frames:
            raise ValueError(f"No trajectory frames parsed from {input_file}")

        # Establish origin on the fly if not set manually
        if self.origin_lat is None:
            first_frame = camera_frames[0]
            coord = first_frame.get("coordinate", first_frame)
            self.set_origin(coord["latitude"], coord["longitude"], coord["altitude"])

        # Compute B rotation matrix at the origin
        p = math.radians(self.origin_lat)
        l = math.radians(self.origin_lon)
        Ev = np.array([-math.sin(l), math.cos(l), 0.0])
        Nv = np.array([-math.sin(p)*math.cos(l), -math.sin(p)*math.sin(l), math.cos(p)])
        Uv = np.array([math.cos(p)*math.cos(l), math.cos(p)*math.sin(l), math.sin(p)])
        B = np.vstack([Ev, Nv, Uv])

        converted_frames = []
        for frame_idx, frame in enumerate(camera_frames):
            frame_num = frame.get("frame", frame_idx)
            coord = frame.get("coordinate", frame)
            lat = coord["latitude"]
            lon = coord["longitude"]
            alt = coord["altitude"]
            fov_v = frame.get("fovVertical", 40)

            # Rotation angles (Euler angles Rx, Ry, Rz in degrees)
            rot = frame.get("rotation", {"x": 0.0, "y": 0.0, "z": 0.0})
            rx, ry, rz = rot["x"], rot["y"], rot["z"]

            # Compute row-major camera-to-world matrix
            # R_c2w = B * Rx(x) * Ry(y) * Rz(z)
            ax, ay, az = map(math.radians, [rx, ry, rz])
            Rx = np.array([
                [1.0, 0.0, 0.0],
                [0.0, math.cos(ax), -math.sin(ax)],
                [0.0, math.sin(ax), math.cos(ax)]
            ])
            Ry = np.array([
                [math.cos(ay), 0.0, math.sin(ay)],
                [0.0, 1.0, 0.0],
                [-math.sin(ay), 0.0, math.cos(ay)]
            ])
            Rz = np.array([
                [math.cos(az), -math.sin(az), 0.0],
                [math.sin(az), math.cos(az), 0.0],
                [0.0, 0.0, 1.0]
            ])
            R_local = Rx @ Ry @ Rz
            R_c2w = B @ R_local

            # Translation vector
            if use_ellipsoidal:
                # ECEF -> ENU projection (ellipsoidal WGS-84 tangent-plane translation offset by ~0.5m ASL)
                x_ecef, y_ecef, z_ecef = self.wgs84_to_ecef(lat, lon, alt)
                tx, ty, tz = self.ecef_to_enu(x_ecef, y_ecef, z_ecef)
            else:
                # Spherical tangent plane ENU (R_earth = 6378137.0)
                R_earth = 6378137.0
                p_rad = math.radians(self.origin_lat)
                tx = R_earth * math.radians(lon - self.origin_lon) * math.cos(p_rad)
                ty = R_earth * math.radians(lat - self.origin_lat)
                tz = alt - self.origin_alt

            # Build 4x4 Row-Major c2w matrix (OpenCV camera convention)
            c2w_rowmajor = [
                float(R_c2w[0,0]), float(R_c2w[0,1]), float(R_c2w[0,2]), float(tx),
                float(R_c2w[1,0]), float(R_c2w[1,1]), float(R_c2w[1,2]), float(ty),
                float(R_c2w[2,0]), float(R_c2w[2,1]), float(R_c2w[2,2]), float(tz),
                0.0, 0.0, 0.0, 1.0
            ]

            # If opengl convention is explicitly requested, rotate OpenCV to OpenGL:
            # c2w_gl = c2w_cv @ diag(1, -1, -1, 1)
            # This flips the Y and Z camera axes (column 1 and column 2), keeping translation untouched.
            if convention == "opengl":
                c2w_rowmajor = [
                    float(R_c2w[0,0]), -float(R_c2w[0,1]), -float(R_c2w[0,2]), float(tx),
                    float(R_c2w[1,0]), -float(R_c2w[1,1]), -float(R_c2w[1,2]), float(ty),
                    float(R_c2w[2,0]), -float(R_c2w[2,1]), -float(R_c2w[2,2]), float(tz),
                    0.0, 0.0, 0.0, 1.0
                ]

            # Intrinsics: pinhole, fx=fy=(H/2)/tan(fov_v/2)
            fy = (height / 2.0) / math.tan(math.radians(fov_v / 2.0))
            fx = fy
            cx = width / 2.0
            cy = height / 2.0

            K = {
                "fx": round(float(fx), 3),
                "fy": round(float(fy), 3),
                "cx": round(float(cx), 3),
                "cy": round(float(cy), 3),
                "width": int(width),
                "height": int(height),
                "fov_vertical_deg": float(fov_v)
            }

            converted_frames.append({
                "frame": int(frame_num),
                "c2w_enu_zup_rowmajor": [round(val, 6) for val in c2w_rowmajor],
                "K": K,
                "lat": float(lat),
                "lon": float(lon),
                "alt_asl_m": float(alt)
            })

        # Convert track points
        converted_track_points = []
        for tp in track_points:
            pos = tp["position"]
            # Position is ECEF-shifted from the local origin track point
            # Rotate by B basis to treating it as meters East/North/Up
            xyz = np.array([pos["x"], pos["y"], pos["z"]])
            enu_pos = B @ xyz
            converted_track_points.append({
                "name": tp["name"],
                "E": round(float(enu_pos[0]), 2),
                "N": round(float(enu_pos[1]), 2),
                "U": round(float(enu_pos[2]), 2)
            })

        return {
            "origin": {
                "latitude": float(self.origin_lat),
                "longitude": float(self.origin_lon),
                "altitude": float(self.origin_alt)
            },
            "convention": convention,
            "anchors_enu": converted_track_points,
            "frames": converted_frames
        }

if __name__ == "__main__":
    import argparse

    if len(sys.argv) > 1:
        parser = argparse.ArgumentParser(description="Convert GES Trajectories to local 6-DoF systems.")
        parser.add_argument("--input", "-i", type=str, required=True, help="Input GES .json trajectory file")
        parser.add_argument("--output", "-o", type=str, required=True, help="Output converted .json file")
        parser.add_argument("--convention", "-c", type=str, choices=["opengl", "opencv"], default="opengl", help="Camera coordinate convention")
        parser.add_argument("--origin", nargs=3, type=float, metavar=("LAT", "LON", "ALT"), help="Explicit Local Origin override")
        parser.add_argument("--ellipsoidal", action="store_true", help="Use ellipsoidal ECEF->ENU for translation instead of spherical")
        
        args = parser.parse_args()
        
        converter = GESCameraConverter()
        if args.origin:
            converter.set_origin(args.origin[0], args.origin[1], args.origin[2])
            print(f"Manual origin locked: {args.origin}")

        try:
            results = converter.convert_trajectory(args.input, args.convention, use_ellipsoidal=args.ellipsoidal)
            with open(args.output, "w") as f:
                json.dump(results, f, indent=4)
            print(f"Success. Converted {len(results['frames'])} frames. Output written to {args.output}")
            sys.exit(0)
        except Exception as e:
            print(f"Execution failed: {str(e)}")
            sys.exit(1)

    # -------------------------------------------------------------
    # SELF-TEST & VERIFICATION ON THE MINI FIXTURE
    # -------------------------------------------------------------
    print("Initializing Geodetic Ingestion & Coordinate Engine Verification...")

    # Verification Data
    cameraFrames_subset = [
        { "frame": 0, "position": { "x": -122.34806883649435, "y": -120.6876521827653, "z": -103.71507750311866 }, "rotation": { "x": 312.9565726348549, "y": 38.0024849956505, "z": 13.23008906604355 }, "coordinate": { "latitude": 35.4678157, "longitude": -80.1041099, "altitude": 183 }, "fovVertical": 40 },
        { "frame": 180, "position": { "x": -63.25810786313377, "y": -89.46871743164957, "z": -40.334454303607345 }, "rotation": { "x": 297.6436504957929, "y": 34.013228025043105, "z": 22.273293172349824 }, "coordinate": { "latitude": 35.4683874, "longitude": -80.1034079, "altitude": 203 }, "fovVertical": 40 },
        { "frame": 285, "position": { "x": -80.93319811264519, "y": -59.18949061166495, "z": 31.646400881465524 }, "rotation": { "x": 242.68938650054338, "y": 53.4265893169004, "z": 80.3763567910641 }, "coordinate": { "latitude": 35.4690861, "longitude": -80.1035427, "altitude": 218 }, "fovVertical": 40 },
        { "frame": 390, "position": { "x": -61.338353642378934, "y": -18.324604612775147, "z": 83.42141691176221 }, "rotation": { "x": 189.33548415354906, "y": 37.644404713099476, "z": 142.25326275836233 }, "coordinate": { "latitude": 35.46965779999998, "longitude": -80.103252, "altitude": 218 }, "fovVertical": 40 },
        { "frame": 480, "position": { "x": -0.6357158706523478, "y": 3.6434450978413224, "z": 107.76806473825127 }, "rotation": { "x": 175.12085843404773, "y": 0.8502317895988672, "z": 170.13877418682617 }, "coordinate": { "latitude": 35.46989460000002, "longitude": -80.10255, "altitude": 223 }, "fovVertical": 40 },
        { "frame": 600, "position": { "x": 11.531577987945639, "y": -66.09032938815653, "z": 51.49953718204051 }, "rotation": { "x": 231.9020059188931, "y": -7.81838229576612, "z": 173.91206805061609 }, "coordinate": { "latitude": 35.4691131, "longitude": -80.10255, "altitude": 248 }, "fovVertical": 40 },
        { "frame": 660, "position": { "x": 11.531577987945639, "y": -66.09032938815653, "z": 51.49953718204051 }, "rotation": { "x": 231.9020059188931, "y": -7.81838229576612, "z": 173.91206805061609 }, "coordinate": { "latitude": 35.4691131, "longitude": -80.10255, "altitude": 248 }, "fovVertical": 40 }
    ]

    trackPoints_position_only = [
        { "name": "A1_cupola", "position": { "x": 0, "y": 0, "z": 0 } },
        { "name": "A2_roof_W_NW", "position": { "x": -32.21391362103168, "y": -1.3623740235343575, "z": 4.657174409832805 } },
        { "name": "A3_roof_W_SW", "position": { "x": -30.69175750471186, "y": -6.925155938602984, "z": -2.994038791861385 } },
        { "name": "A4_roof_E_NE", "position": { "x": 28.721535059041344, "y": -0.7505462858825922, "z": -8.790062507148832 } },
        { "name": "A5_roof_E_SE", "position": { "x": 24.44670249207411, "y": -9.970533681102097, "z": -22.230266857892275 } },
        { "name": "A6_lot_S_NE", "position": { "x": -37.24403916171286, "y": -53.148544299416244, "z": -75.66588700050488 } },
        { "name": "A7_lot_S_NW", "position": { "x": -69.42053425090853, "y": -66.319287029095, "z": -87.83828876540065 } },
        { "name": "A8_pavilion_W", "position": { "x": -71.80475986865349, "y": 12.158120124600828, "z": 28.13939090212807 } }
    ]

    expected_anchors_enu = [
        { "name": "A1_cupola", "E": 0.0, "N": 0.0, "U": 0.0 },
        { "name": "A2_roof_W_NW", "E": -31.98, "N": 6.19, "U": 0.0 },
        { "name": "A3_roof_W_SW", "E": -31.48, "N": -3.4, "U": 0.0 },
        { "name": "A4_roof_E_NE", "E": 28.21, "N": -10.51, "U": 0.0 },
        { "name": "A5_roof_E_SE", "E": 22.41, "N": -26.28, "U": -1.0 },
        { "name": "A6_lot_S_NE", "E": -45.83, "N": -88.44, "U": -6.0 },
        { "name": "A7_lot_S_NW", "E": -79.83, "N": -102.66, "U": -7.0 },
        { "name": "A8_pavilion_W", "E": -68.75, "N": 37.11, "U": -3.0 }
    ]

    expected_c2w_subset = [
        { "frame": 0, "c2w_enu_zup_rowmajor": [ 0.707063, -0.045908, 0.705659, -141.423326, -0.707151, -0.045903, 0.705571, -141.420281, -0.0, -0.99789, -0.06492, 20.0, 0, 0, 0, 1 ], "lat": 35.4678157, "lon": -80.1041099, "alt_asl_m": 183 },
        { "frame": 180, "c2w_enu_zup_rowmajor": [ 0.707052, -0.203418, 0.677272, -77.77875, -0.707161, -0.203387, 0.677168, -77.778928, -0.0, -0.957734, -0.287655, 40.0, 0, 0, 0, 1 ], "lat": 35.4683874, "lon": -80.1034079, "alt_asl_m": 203 },
        { "frame": 285, "c2w_enu_zup_rowmajor": [ -0.000129, -0.470981, 0.882144, -89.999959, -1.0, 6.1e-05, -0.000114, 0.0, -0.0, -0.882144, -0.470981, 55.0, 0, 0, 0, 1 ], "lat": 35.4690861, "lon": -80.1035427, "alt_asl_m": 218 },
        { "frame": 390, "c2w_enu_zup_rowmajor": [ -0.707154, -0.332975, 0.623747, -63.644577, -0.707059, 0.33302, -0.623831, 63.641353, -0.0, -0.882171, -0.47093, 55.0, 0, 0, 0, 1 ], "lat": 35.4696578, "lon": -80.103252, "alt_asl_m": 218 },
        { "frame": 480, "c2w_enu_zup_rowmajor": [ -1.0, -0.0, 0.0, 0.0, -0.0, 0.507788, -0.861482, 90.001808, 0.0, -0.861482, -0.507788, 60.0, 0, 0, 0, 1 ], "lat": 35.4698946, "lon": -80.10255, "alt_asl_m": 223 },
        { "frame": 600, "c2w_enu_zup_rowmajor": [ -1.0, -0.0, -0.0, 0.0, -0.0, 0.999255, -0.038606, 3.005626, 0.0, -0.038606, -0.999255, 85.0, 0, 0, 0, 1 ], "lat": 35.4691131, "lon": -80.10255, "alt_asl_m": 248 },
        { "frame": 660, "c2w_enu_zup_rowmajor": [ -1.0, -0.0, -0.0, 0.0, -0.0, 0.999255, -0.038606, 3.005626, 0.0, -0.038606, -0.999255, 85.0, 0, 0, 0, 1 ], "lat": 35.4691131, "lon": -80.10255, "alt_asl_m": 248 }
    ]

    # --- Step 1: Checksum Verification ---
    def numsum(obj) -> float:
        s = 0.0
        if isinstance(obj, dict):
            for k, v in obj.items():
                s += numsum(v)
        elif isinstance(obj, list):
            for v in obj:
                s += numsum(v)
        elif isinstance(obj, (int, float)):
            s += float(obj)
        return s

    sum_frames = numsum(cameraFrames_subset)
    sum_tracks = numsum(trackPoints_position_only)
    sum_expected = numsum(expected_c2w_subset)

    print(f"Checksum verification:")
    print(f"  cameraFrames_subset sum: {sum_frames:.6f} (expected: 6169.634614)")
    print(f"  trackPoints_position_only sum: {sum_tracks:.6f} (expected: -479.247067)")
    print(f"  expected_c2w_subset sum: {sum_expected:.6f} (expected: 3788.541470)")

    # Construct the mock input file
    export_payload = {
        "name": "ONSC Clubhouse Roof Hero FOV40 — mini fixture",
        "width": 1920,
        "height": 1080,
        "frameRate": 30,
        "numFrames": 660,
        "durationSeconds": 22,
        "cameraFrames": cameraFrames_subset,
        "trackPoints": trackPoints_position_only
    }

    temp_path = "temp_fixture_wrapped.json"
    with open(temp_path, "w") as f:
        json.dump(export_payload, f, indent=4)

    # Instantiate converter
    converter = GESCameraConverter()
    # Explicitly lock origin matching the cupola
    converter.set_origin(35.4690861, -80.10255, 163.0)

    # Convert coordinates using OpenCV convention (since expected is opencv, we test this)
    results = converter.convert_trajectory(temp_path, convention="opencv", use_ellipsoidal=False)

    print("\nCalculated Trajectory Matrices vs Expected:")
    for calculated, expected in zip(results["frames"], expected_c2w_subset):
        frame = calculated["frame"]
        c2w_calc = calculated["c2w_enu_zup_rowmajor"]
        c2w_exp = expected["c2w_enu_zup_rowmajor"]

        # Rotation block check: first 3x3
        R_calc = np.array([c2w_calc[0:3], c2w_calc[4:7], c2w_calc[8:11]])
        R_exp = np.array([c2w_exp[0:3], c2w_exp[4:7], c2w_exp[8:11]])
        max_rot_diff = np.max(np.abs(R_calc - R_exp))

        # Translation check
        t_calc = np.array([c2w_calc[3], c2w_calc[7], c2w_calc[11]])
        t_exp = np.array([c2w_exp[3], c2w_exp[7], c2w_exp[11]])
        max_trans_diff = np.max(np.abs(t_calc - t_exp))

        # Pointing error check to target (0, 0, 7)
        T = np.array([0.0, 0.0, 7.0])
        f_vec = np.array([c2w_calc[2], c2w_calc[6], c2w_calc[10]])  # Forward vector from matrix
        norm_f = f_vec / np.linalg.norm(f_vec)
        to_target = T - t_calc
        norm_target = to_target / np.linalg.norm(to_target)
        dot_val = np.clip(np.dot(norm_f, norm_target), -1.0, 1.0)
        angle_err = math.degrees(math.acos(dot_val))

        print(f"  Frame {frame:3d}:")
        print(f"    Max rotation block abs diff:    {max_rot_diff:.6e} (Target <= 1e-6)")
        print(f"    Max translation vector abs diff: {max_trans_diff:.6e} m")
        print(f"    Pointing angle error to (0,0,7): {angle_err:.6f}° (Target <= 0.05°)")

    print("\nCalculated TrackPoints vs Expected Anchors ENU:")
    worst_anchor_err = 0.0
    for calculated_tp, expected_anc in zip(results["anchors_enu"], expected_anchors_enu):
        calc_E, calc_N, calc_U = calculated_tp["E"], calculated_tp["N"], calculated_tp["U"]
        exp_E, exp_N, exp_U = expected_anc["E"], expected_anc["N"], expected_anc["U"]
        dist_err = math.hypot(calc_E - exp_E, calc_N - exp_N)
        worst_anchor_err = max(worst_anchor_err, dist_err)
        print(f"  Anchor {calculated_tp['name']:14s}: Calculated={calc_E:+6.2f}, {calc_N:+6.2f}, {calc_U:+6.2f} | Expected={exp_E:+6.2f}, {exp_N:+6.2f}, {exp_U:+6.2f} | Horiz Dev={dist_err:.4f} m")
    
    print(f"\nWorst Anchor horizontal deviation: {worst_anchor_err:.4f} m (Target <= 0.2 m)")

    # Cleanup temporary wrapped file
    if os.path.exists(temp_path):
        os.remove(temp_path)
