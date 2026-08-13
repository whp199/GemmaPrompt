# Third-party material

## MiniMax H3 prompt-writing guides

`skills/h3-base-modes.txt` and `skills/h3-full-reference.txt` are **not** part of
this repository. They are MiniMax's own reference guides from
[MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing),
and that repository publishes no licence, so they are not redistributed here.

`server.py` downloads them into `skills/` on first run. Nothing else is fetched,
and the download only happens when the files are absent.

If you would rather not fetch them, place your own copies at those two paths and
the download is skipped. H3 mode still runs without them — `skills/h3.md` carries
the field names, section order and hard rules — but the output will be less
reliable, since the upstream guides are the normative spec.

## Hatsune Miku

Hatsune Miku is a character owned by Crypton Future Media, Inc. The artwork in
`web/img/` was generated locally with Stable Diffusion and is used here under the
spirit of the [Piapro Character Licence](https://piapro.net/intl/en_for_creators.html),
which permits non-commercial derivative works. This project is free, non-commercial
and unaffiliated with Crypton Future Media.

## Danbooru tag data

MikuPrompt reads the tag autocomplete database already installed in your ComfyUI
(`comfyui-custom-scripts`). No tag data is bundled with this repository.
