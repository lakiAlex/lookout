# Builds the README GIF from the frames record.cjs saved: rounded window
# corners, the three window buttons drawn in (the page has none), and one
# palette for all frames so colors do not flicker.
#
#   python3 -E scripts/demo-gif/make-gif.py <frames folder> <out.gif> [button center y] [first button center x]
#
# Needs Pillow (python3 -m pip install --user Pillow). -E lets Python find it in
# the user's site-packages.
import json
import sys

from PIL import Image, ImageDraw

frames_dir, out = sys.argv[1], sys.argv[2]
# Where the close, minimize and zoom buttons sit, in points from the top left.
# Matches trafficLightPosition in src-tauri/tauri.conf.json.
cy = float(sys.argv[3]) if len(sys.argv) > 3 else 17.0
cx0 = float(sys.argv[4]) if len(sys.argv) > 4 else 23.0

frames = json.load(open(f"{frames_dir}/frames.json"))
W, H = Image.open(frames[0]["file"]).size
S = 4  # Shapes are drawn 4x larger and scaled down, for smooth edges.

mask = Image.new("L", (W * S, H * S), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, W * S - 1, H * S - 1), radius=28 * S, fill=255)
mask = mask.resize((W, H), Image.LANCZOS).point(lambda a: 255 if a >= 128 else 0)

lights = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
draw = ImageDraw.Draw(lights)
for i, color in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
    x, y, r = (cx0 + 20 * i) * S, cy * S, 6 * S
    draw.ellipse((x - r, y - r, x + r, y + r), fill=color + (255,))
lights = lights.resize((W, H), Image.LANCZOS)

rgb = [Image.alpha_composite(Image.open(f["file"]).convert("RGBA"), lights).convert("RGB") for f in frames]

# One palette from a few frames across the tour: 255 colors plus transparent.
sample = Image.new("RGB", (W, H * 3))
for i, k in enumerate([0, len(rgb) // 2, len(rgb) - 5]):
    sample.paste(rgb[k], (0, H * i))
palette = sample.quantize(colors=255, method=Image.Quantize.MEDIANCUT)

out_frames = []
for im in rgb:
    q = im.quantize(palette=palette, dither=Image.Dither.NONE)
    # Outside the rounded corners is the transparent color, index 255.
    q.paste(255, mask=Image.eval(mask, lambda a: 255 - a))
    out_frames.append(q)
pal = palette.getpalette()[: 255 * 3] + [0, 0, 0]
for q in out_frames:
    q.putpalette(pal)

out_frames[0].save(
    out,
    save_all=True,
    append_images=out_frames[1:],
    duration=[f["ms"] for f in frames],
    loop=0,
    transparency=255,
    disposal=2,
    optimize=False,
)
print(out, len(out_frames), "frames")
