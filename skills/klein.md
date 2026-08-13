# FLUX.2 Klein — natural language, structured prose

**Models:** `flux-2-klein-4b` (4 steps), `flux-2-klein-9b-fp8` (8 steps), `flux-2-klein-base-4b`
**Text encoder:** Qwen3-4B (type `flux2`) · **VAE:** flux2-vae
**Sampling:** CFG 1.0 distilled, `euler` + Flux2Scheduler

Klein is a **natural-language** model with a large instruction-tuned text
encoder. It reads prompts the way a person reads a shot description. Booru tags,
comma-salad, and weighting syntax all hurt it.

## Output format

Flowing prose — **two to five sentences**, one paragraph, no line breaks, no
tags, no markdown. Klein's sweet spot is a dense, well-ordered description of
roughly **40–110 words**. Past that, later clauses lose influence.

## What to include, in this order

Klein responds to prompts that read like a **photo caption written by someone
who was there**:

1. **Medium and style first** — "A photograph of…", "A 3D render of…", "A pen
   and ink illustration of…". This single leading phrase does more than any
   quality adjective.
2. **Primary subject**, described concretely: what it is, what it looks like,
   what it is doing.
3. **Placement in frame** — foreground/background, left/right, what it occludes.
4. **Environment**, only as far as it is visible.
5. **Lighting** — source, direction, hardness, colour temperature.
6. **Camera** — shot distance, lens, angle, depth of field.
7. **Colour and mood**, if it adds something the above did not already imply.

## Strengths worth exploiting

- **Text rendering.** Klein renders legible typography. Put the exact string in
  double quotes and say where it sits: `a neon sign reading "OPEN" above the
  door`. Keep rendered text short — a few words is reliable, a sentence is not.
- **Compositional instructions in plain English** — "shot from a low angle",
  "the subject fills the right third of the frame", "shallow depth of field with
  the background falling out of focus" — are followed faithfully.
- **Counting and spatial relations** are handled well. "three ceramic mugs, the
  middle one chipped" works.

## Do not

- Do not use `(weight:1.2)` syntax — CFG is 1.0 and the parser passes the
  literal parentheses through to the encoder.
- Do not write a negative prompt. Klein runs distilled at CFG 1.0; the negative
  is genuinely inert. Express what you *don't* want by describing what you *do*
  want instead ("an empty street" rather than "no people").
- Do not stack quality boilerplate. "masterpiece, best quality, 8k, ultra
  detailed, trending on artstation" adds nothing and displaces real content.
- Do not use booru tags or underscore_names.

## Worked example

*User idea:* "hedgehog party, retro camera look"

```
A flash photograph of a small hedgehog wearing a tiny conical party hat, sitting on a wooden table strewn with colourful confetti. The harsh on-camera flash blows out the foreground and drops the background into deep shadow, giving the scene the blown highlights and slight chromatic fringing of an early-2000s point-and-shoot digital camera. Shot from just above table height with a short zoom lens, the hedgehog centred and filling the lower half of the frame.
```

*User idea:* "cyberpunk ramen stall with a sign"

```
A photograph of a cramped night-time ramen stall in a rain-slicked alley, steam rolling off a broth pot into the cold air. A hand-painted sign reading "RAMEN" glows in pink neon above the counter, its light reflecting in the puddles below. A lone customer sits hunched on a stool at the right of the frame, back to the camera. Shot at eye level on a 35mm lens with a shallow depth of field, the deep background dissolving into bokeh of distant signage.
```
