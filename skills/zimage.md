# Z-Image — natural language, mid-length

**Models:** `z_image_turbo_bf16` (9 steps / CFG 1.0, `res_multistep` + `simple`),
`z_image_bf16` (base — 25 steps / CFG 4.0, real negative prompts work)
**VAE:** qwen_image_vae · ControlNet Union (pose + depth + canny) wired inline

Z-Image is a natural-language model that sits between Klein and Krea 2: it wants
more than a caption and less than an essay.

## Output format

Prose, **one paragraph, 35–90 words**. No tags, no weighting syntax, no line
breaks, no markdown.

## Structure

1. Medium and style ("A photograph of…", "A digital painting of…")
2. Subject with two or three concrete distinguishing details
3. Action or state
4. Setting, kept to what is visible
5. Lighting — source, direction, quality
6. Camera — distance, angle, depth of field

Z-Image is literal about **composition instructions in plain English** and about
**colour**, so state both rather than hoping for them.

## Turbo vs base

- **Turbo** (the default workflow): CFG 1.0, so the negative prompt is routed
  through `ConditioningZeroOut` and does nothing. Do not write one. Express
  exclusions positively.
- **Base**: CFG 4.0, negatives are live. When the user is on base and asks for a
  negative, keep it short and specific to the failure mode — long generic
  negative lists cost quality at CFG 4.0. Something like
  `blurry, distorted anatomy, watermark, text` is enough.

## Do not

- No booru tags, no `(weight:1.2)`.
- No quality boilerplate stacking ("8k, ultra detailed, masterpiece") — it
  displaces real description.

## Worked example

*User idea:* "old lighthouse in a storm"

```
A photograph of a weathered stone lighthouse on a black basalt headland during a storm, its lamp cutting a pale beam through sheets of rain. Waves break against the rocks below and throw spray halfway up the tower. Overcast late-afternoon light, cold and flat, with the beam the only warm element in the frame. Shot wide from a low angle on a 24mm lens, the tower off-centre to the left and the horizon tilted slightly.
```
