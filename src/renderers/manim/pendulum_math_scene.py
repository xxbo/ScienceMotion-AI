"""Headless Manim Cairo shot. The verified JSON is prepared in TypeScript, with no solver here."""
import argparse
import json
from math import degrees
from pathlib import Path
import platform
import shutil

import manim
import manimpango
import numpy as np
from manim import (
    Dot, DOWN, LEFT, Line, ORIGIN, RIGHT, RoundedRectangle, Scene, Text, UP,
    UpdateFromAlphaFunc, VGroup, VMobject, linear, tempconfig,
)

WIDTH, HEIGHT, SCALE = 640, 360, 50
X0, X1, Y0, Y1 = 58, 419, 138, 270
BG, PANEL = "#07111f", "#0e1d30"
WHITE, MUTED, GRID = "#f2f7fd", "#9fb4cb", "#273e55"
CYAN, ORANGE = "#63dbd6", "#f49b39"
FONT, MATH, MONO = "Noto Sans CJK SC", "DejaVu Sans", "DejaVu Sans Mono"


def point(x, y):
    return np.array([(x - WIDTH / 2) / SCALE, (HEIGHT / 2 - y) / SCALE, 0.0])


def segment(x0, y0, x1, y1, color=GRID, width=1):
    return Line(point(x0, y0), point(x1, y1), color=color, stroke_width=width)


def glyphs(string, height, color=WHITE, font=FONT, weight="NORMAL"):
    return Text(string, font=font, font_size=32, color=color, weight=weight).scale_to_fit_height(height / SCALE)


def label(string, x, y, height, color=WHITE, font=FONT, edge=LEFT, weight="NORMAL"):
    return glyphs(string, height, color, font, weight).move_to(point(x, y), aligned_edge=edge)


def panel(left, right):
    return RoundedRectangle(
        width=(right - left) / SCALE, height=229 / SCALE, corner_radius=0.22,
        stroke_color=GRID, stroke_width=1, fill_color=PANEL, fill_opacity=1,
    ).move_to(point((left + right) / 2, 218.5))


def equation():
    theta = glyphs("θ", 22, font=MATH)
    acceleration = VGroup(
        theta,
        VGroup(Dot(radius=0.027, color=WHITE), Dot(radius=0.027, color=WHITE))
        .arrange(RIGHT, buff=0.045).next_to(theta, UP, buff=0.047),
    )
    fraction = VGroup(
        glyphs("g", 14, CYAN, MATH),
        Line(LEFT * 0.20, RIGHT * 0.20, color=CYAN, stroke_width=1.7),
        glyphs("L", 14, CYAN, MATH),
    ).arrange(DOWN, buff=0.04)
    formula = VGroup(acceleration, glyphs("+", 16, font=MATH), fraction, glyphs("sin θ = 0", 21, font=MATH))
    formula.arrange(RIGHT, buff=0.13).move_to(point(614, 49), aligned_edge=RIGHT)
    acceleration.shift(DOWN * 0.036)
    return formula


def signed(value, places):
    if abs(value) < 0.5 * 10 ** -places:
        value = 0.0
    return f"{value:.{places}f}".replace("-", "−")


class PendulumMathScene(Scene):
    def __init__(self, shot):
        self.shot = shot
        super().__init__()

    def construct(self):
        shot = self.shot
        model, curve, frames = shot["model"], shot["curve"], shot["frames"]
        length, gravity = model["lengthMeters"], model["gravityMetersPerSecondSquared"]
        release = degrees(model["initialState"]["angleRadians"])
        fps = shot["profile"]["fps"]
        period = shot["period"]
        end = curve[-1]["timeSeconds"]
        amplitude = max(abs(degrees(row["angleRadians"])) for row in curve)

        def plot_x(t):
            return X0 + (X1 - X0) * t / end

        def plot_y(angle):
            return (Y0 + Y1) / 2 - (Y1 - Y0) * degrees(angle) / (2.5 * amplitude)

        def plot_point(sample):
            return point(plot_x(sample["timeSeconds"]), plot_y(sample["angleRadians"]))

        static = VGroup(
            label("理想单摆    /    NONLINEAR", 25, 20, 10, CYAN),
            label("单摆的运动方程", 24, 46, 23, weight="BOLD"),
            label(f"长度 {length:g} m   ·   重力 {gravity:g} m/s²   ·   初始角 {signed(release, 0)}°", 25, 78, 11, MUTED),
            equation(),
            panel(23, 438), panel(449, 617),
            label("摆角 θ", 38, 122, 12, WHITE, weight="BOLD"),
            label("物理时间 t / s", 421, 296, 9, MUTED, edge=RIGHT),
            label("当前状态", 463, 120, 12, weight="BOLD"),
            label("t", 466, 148, 17, MUTED, MATH),
            label("θ", 466, 180, 16, MUTED, MATH),
            segment(463, 200, 602, 200),
            label("实测周期", 463, 217, 11, CYAN),
            label(f"{period['measuredSeconds']:.3f} s", 463, 243, 24, WHITE, MATH, weight="BOLD"),
            label("相邻两次同向过最低点", 463, 264, 10, MUTED),
            segment(463, 280, 602, 280),
            label("小角近似", 463, 298, 11, MUTED),
            label(f"{period['smallAngleSeconds']:.3f} s", 601, 299, 13, WHITE, MATH, edge=RIGHT),
            label(f"留存轨迹  ·  RK4 / {shot['sampleRateHz']:g} Hz", 25, 345, 9, MUTED),
            label(f"原场景帧 / {fps} fps", 614, 345, 9, MUTED, edge=RIGHT),
        )
        for i in range(5):
            t = end * i / 4
            x = plot_x(t)
            static.add(segment(x, Y0, x, Y1), label(f"{t:.4g}", x, 280, 9, MUTED, MATH, edge=ORIGIN))
        for angle in [-abs(model["initialState"]["angleRadians"]), 0, abs(model["initialState"]["angleRadians"])]:
            y = plot_y(angle)
            static.add(segment(X0, y, X1, y, "#45607a" if angle == 0 else GRID),
                       label(f"{signed(degrees(angle), 0)}°", X0 - 6, y, 9, MUTED, MATH, edge=RIGHT))

        line = VMobject(stroke_color=CYAN, stroke_width=2.55)
        line.set_points_as_corners([plot_point(row) for row in curve])
        static.add(line)
        for row in shot["phases"]:
            static.add(Dot(plot_point(row), radius=3 / SCALE, color=PANEL, stroke_width=1.1, stroke_color=CYAN))
        start, finish = period["periodIntervalSeconds"]
        static.add(Dot(point(plot_x(finish), plot_y(0)), radius=3 / SCALE, color=PANEL, stroke_width=1.1, stroke_color=CYAN))
        xa, xb, y = plot_x(start), plot_x(finish), 312
        center = (xa + xb) / 2
        note = label("同向过最低点的一周期", center, y, 10, CYAN, edge=ORIGIN)
        gap = 0.5 * note.width * SCALE + 8
        if xb - xa > 2 * gap + 6:
            static.add(segment(xa, y, center - gap, y, CYAN),
                       segment(center + gap, y, xb, y, CYAN),
                       segment(xa, y - 4, xa, y + 4, CYAN), segment(xb, y - 4, xb, y + 4, CYAN), note)

        cursor = segment(X0, Y0, X0, Y1, "#66859e", 1.35)
        dot = Dot(radius=4.5 / SCALE, color=ORANGE, stroke_color=BG, stroke_width=1)
        readouts = [(
            label(f"{row['timeSeconds']:.2f} s", 601, 148, 16, WHITE, MONO, edge=RIGHT),
            label(f"{signed(degrees(row['angleRadians']), 2)}°", 601, 180, 16, WHITE, MONO, edge=RIGHT),
        ) for row in frames]
        time_value, angle_value = (obj.copy() for obj in readouts[0])
        moving = VGroup(cursor, dot, time_value, angle_value)

        def advance(_group, alpha):
            # Manim emits one sample per output index. The retained time and angle are precomputed.
            index = min(round(alpha * len(frames)), len(frames) - 1)
            row = frames[index]
            x = plot_x(row["timeSeconds"])
            cursor.put_start_and_end_on(point(x, Y0), point(x, Y1))
            dot.move_to(plot_point(row))
            time_value.become(readouts[index][0])
            angle_value.become(readouts[index][1])

        self.add(static, moving)
        self.play(UpdateFromAlphaFunc(moving, advance), run_time=len(frames) / fps, rate_func=linear)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shot", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("media_dir", type=Path)
    args = parser.parse_args()
    shot = json.loads(args.shot.read_text(encoding="utf-8"))
    profile = shot["profile"]
    if shot["schemaVersion"] != "1.0.0" or (profile["width"], profile["height"]) != (WIDTH, HEIGHT):
        raise ValueError("Expected the v1 pendulum mathematics shot and its 640 × 360 canvas.")
    if len(shot["frames"]) != shot["range"]["durationFrames"] or not shot["frames"]:
        raise ValueError("The prepared shot must contain one pose per output frame.")
    if not {FONT, MATH, MONO}.issubset(manimpango.list_fonts()):
        raise RuntimeError("Install Noto Sans CJK SC and DejaVu Sans/Mono fonts for the mathematics shot.")
    with tempconfig({
        "renderer": "cairo", "format": "mp4", "write_to_movie": True, "disable_caching": True,
        "frame_width": WIDTH / SCALE, "frame_height": HEIGHT / SCALE,
        "pixel_width": WIDTH, "pixel_height": HEIGHT, "frame_rate": profile["fps"],
        "background_color": BG, "progress_bar": "none", "verbosity": "WARNING",
        "media_dir": str(args.media_dir.resolve()), "output_file": "pendulum-math",
    }):
        scene = PendulumMathScene(shot)
        scene.render()
        shutil.copyfile(scene.renderer.file_writer.movie_file_path, args.output)
    print(json.dumps({"manim": manim.__version__, "python": platform.python_version(),
                      "pango": manimpango.__version__, "renderer": "cairo"}))


if __name__ == "__main__":
    main()
