# Title art: how the three game logos were normalised

Design note #1447. Written because the next person to replace one of these images has to reproduce the
measurement, and "I scaled it until it looked right" is not reproducible.

## Where the files are

**Sources** (build inputs, NOT deployed) live in `docs/ai_architecture/source_assets/title_art/`.
**Runtime** files (what the browser fetches) live in `frontend/public/images/`.

`title-project18xx.jpg` is the exception: it is BOTH a source for `game-18xx.jpg` and a runtime asset in its
own right -- `Lobby.tsx` draws the lobby wordmark from `/images/title-project18xx.jpg` -- so it stays in
`frontend/public/images/` and the generator reads it from there.

| file | role | where | pixels | format | intrinsic black margin (L/R/T/B) | what is in it |
|---|---|---|---|---|---|---|
| `title-project18xx.jpg` | source **and** runtime | `frontend/public/images/` | 900 x 617 | JPEG, no alpha | 11 / 11 / 12 / 11 | `Project` / `18XX` |
| `18xxPlus.png` | source only | `docs/ai_architecture/source_assets/title_art/` | 1076 x 802 | PNG, alpha present but fully opaque | 14 / 13 / 12 / 16 | `Project` / `18XX+`, deep flourish below |
| `18xx_LPF.png` | source only | `docs/ai_architecture/source_assets/title_art/` | 1076 x 802 | PNG, alpha present but fully opaque | 15 / 18 / 17 / 8 | `Project` / `18XX+` / `A Level Playing Field` |

## The problem

The host's game-selection step shows three AI-generated raster titles side by side. They are three separate
renders, not one artwork at three sizes, so the words **Project 18XX** are drawn at a different size in each
file and each file has a different amount of ornament hanging below the words:

The margins are measured at luminance > 45; the ornament genuinely reaches to within ~12px of every edge, so
there is no slack to crop and nothing useful to gain by trimming. **Fitting the three FILES to one box does not
make the three TITLES the same size** -- the file sizes are close (1.459 and 1.342 aspect) while the lettering
inside them is not.

## The reference

The `8` of `18XX`: the largest closed glyph, drawn identically in all three, and measurable without judgement.
Found as a connected component of the mask `luminance > 105` after a 5x5 binary opening -- the opening severs
the hairline flourishes that otherwise weld every glyph in the image into one blob. Applied the same way to all
three, so whatever bias erosion introduces is shared.

| file | `8` bounding box | height |
|---|---|---|
| `title-project18xx.jpg` | x 288..440, y 292..486 | **195** |
| `18xxPlus.png` | x 313..478, y 313..521 | **209** |
| `18xx_LPF.png` | x 345..525, y 346..569 | **224** |

Sanity check on the reference: the whole principal block (top of `P` to bottom of `8`) divided by the `8`'s
height is 2.431 / 2.411 / 2.469 -- within 2.4% across the three. The `8` scales with the lettering, so
normalising it normalises the words.

## What was done

Three NEW files. The originals are untouched and still on disk.

- **Canvas**: 1080 x 810 (4:3), identical for all three. Sized to the union of the three placed artworks plus a
  safe area, not chosen for looks.
- **Scale**: `195 / native 8-height`, so **1.00000**, **0.93301**, **0.87054**. Downscale only -- nothing is
  resampled upward. Lanczos.
- **Anchor**: the `8`'s vertical centre at canvas y **425**; the source's horizontal centre at canvas x **540**.
  The `18XX` line therefore sits on one baseline in all three, and `Project` follows it to within the 2.4%
  above.
- **Padding is black, added, and never subtracted.** Each scaled image is composited whole; the generator
  throws if a placement would fall outside the canvas, so a crop cannot happen silently.
- **Encoding**: JPEG q92, 4:4:4 (no chroma subsampling), progressive. 4:2:0 smears the gold/black edge.

| output | from | scale | placed size | position | clear black L/R/T/B | bytes |
|---|---|---|---|---|---|---|
| `game-18xx.jpg` | `title-project18xx.jpg` | 1.00000 | 900 x 617 | (90, 36) | 90 / 90 / 36 / 157 | 227 KB |
| `game-18xx-plus.jpg` | `18xxPlus.png` | 0.93301 | 1004 x 748 | (38, 36) | 38 / 38 / 36 / 26 | 242 KB |
| `game-18xx-lpf.jpg` | `18xx_LPF.png` | 0.87054 | 937 x 698 | (72, 27) | 72 / 71 / 27 / 85 | 234 KB |

Minimum clear black on any side of any file, counting the source's own margin, is **~38px = 3.5% of the canvas
width**. `game-18xx.jpg` has 157px below its artwork because it has no subtitle and no deep flourish; that is
the honest shape of the artwork, and buying it back would mean moving `Project 18XX` off the shared baseline.

Nothing was recoloured, redrawn, vectorised, de-ornamented or keyed to transparency. The black grounds are left
in place because the artwork sits in a black media well, and an aggressive black-to-alpha pass would eat the
gold's own dark edge pixels.

## Why this and not a CSS transform

A per-logo `scale()` and `translateY()` in the stylesheet would give the same picture today. It would also put
three numbers derived from three specific image files into a component that has no way to notice when one of
those files is replaced. Normalising in the files means the presentation rule is the whole rule: **one well,
`object-fit: contain`, no per-logo anything** -- and `hostGameGallery.test.ts` asserts both halves (the three
files are one size; the stylesheet holds no transform).

## Regenerating

Requires Pillow, numpy and scipy. Run from the repository root -- the two PNG sources are not in `public/`,
so the paths below are the ones to keep in step if anything moves again.

```python
from PIL import Image
import numpy as np
from scipy import ndimage as ndi

CANVAS_W, CANVAS_H = 1080, 810
ANCHOR_X, ANCHOR_Y = 540, 425
RUNTIME = "frontend/public/images/"                    # deployed
SOURCE  = "docs/ai_architecture/source_assets/title_art/"   # build inputs, not deployed
SOURCES = [                                  # file, a seed pixel inside the '8', output
    (RUNTIME + "title-project18xx.jpg", (364, 389), "game-18xx.jpg"),
    (SOURCE  + "18xxPlus.png",          (395, 417), "game-18xx-plus.jpg"),
    (SOURCE  + "18xx_LPF.png",          (370, 370), "game-18xx-lpf.jpg"),
]

def lum(im):
    a = np.asarray(im.convert("RGB"), dtype=np.float32)
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]

def eight(im, seed, T=105, erode=5):
    lab, _ = ndi.label(ndi.binary_opening(lum(im) > T, structure=np.ones((erode, erode), bool)))
    i = lab[seed[1], seed[0]]
    assert i, "seed landed on background"
    ys, xs = np.nonzero(lab == i)
    return int(ys.max() - ys.min() + 1), (int(ys.min()) + int(ys.max())) / 2.0

src = [(n, Image.open(n).convert("RGB"), s, o) for n, s, o in SOURCES]
meas = [eight(im, s) for _, im, s, _ in src]
target = min(h for h, _ in meas)             # 195

for (name, im, _, out), (h, cy) in zip(src, meas):
    k = target / h
    sw, sh = int(round(im.width * k)), int(round(im.height * k))
    left, top = int(round(ANCHOR_X - sw / 2.0)), int(round(ANCHOR_Y - cy * k))
    assert left >= 0 and top >= 0 and left + sw <= CANVAS_W and top + sh <= CANVAS_H, "would crop"
    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), (0, 0, 0))
    canvas.paste(im.resize((sw, sh), Image.LANCZOS), (left, top))
    canvas.save(RUNTIME + out, "JPEG", quality=92, subsampling=0, optimize=True, progressive=True)
```

The seed pixels are the only hand-supplied numbers, and they only have to land somewhere inside the `8`.
If a replacement logo changes the lettering's proportions, re-run this and re-read the table above -- do not
adjust a transform in `HostSetupCard.tsx`.

## Why the sources are not in `public/`

Create React App copies `frontend/public` verbatim into the build, so a file there ships whether or not
anything references it. `18xxPlus.png` and `18xx_LPF.png` are 1,410,835 and 1,463,459 bytes and were referenced
by nothing at runtime -- **2,874,294 bytes of deploy for two files the browser never asked for**. They were
moved here whole: same bytes, same md5, no recompression.

`hostGameGallery.test.ts` asserts the split in both directions -- the two sources are present here and absent
from `public/images`, and the three runtime JPEGs are present in `public/images`. A source original dropped
back into `public/` fails that case rather than quietly adding a megabyte to the bundle.
