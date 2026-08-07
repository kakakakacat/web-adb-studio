#!/usr/bin/env python3
"""Decode an animated WebP into composited RGBA frames, for test-convert.mjs.

Pillow decodes WebP animations through libwebp's own WebPAnimDecoder, so this is
a reference implementation reading our container — not our code checking itself.
Each frame comes out fully composited (disposal and blending already applied),
which is exactly what has to match the pixels we fed in.

    dump-webp-frames.py <file.webp> <outdir>   ->  JSON summary on stdout

ffmpeg is deliberately not used for this: its WebP decoder cannot read animated
files with sub-rectangle frames at all — it fails the same way on `img2webp`'s
own output — so a failure there says nothing about the file.
"""

import json
import sys

from PIL import Image


def main() -> int:
    path, outdir = sys.argv[1], sys.argv[2]
    im = Image.open(path)
    durations = []
    count = 0
    while True:
        try:
            im.seek(count)
        except EOFError:
            break
        with open(f"{outdir}/{count:04d}.rgba", "wb") as fh:
            fh.write(im.convert("RGBA").tobytes())
        durations.append(im.info.get("duration", 0))
        count += 1
    print(json.dumps({"frames": count, "durations": durations, "size": list(im.size)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
