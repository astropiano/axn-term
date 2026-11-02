# Theme generator

`libs/shell-ui/themes/*.yaml` are generated from `palettes.py`:

```bash
python3 tools/themes/gen.py libs/shell-ui/themes /tmp/themes.json
```

`gen.py` holds every theme to the same legibility rules (see its docstring):
foreground >= 7:1, ANSI text colours >= 4.5:1, bright black >= 3.5:1,
readable selection and UI text. A colour that misses keeps its hue; only its
lightness moves. Each generated YAML lists what was adjusted.
`libs/shell-ui/src/themes.test.ts` enforces the same rules on the YAMLs.
To add a theme: add it to `palettes.py` with its source palette, credit it in
`SOURCES` (and `UPSTREAM` for a new project — check the upstream licence
first: MIT/BSD/Apache/public domain are fine, copyleft is not), run the
generator, commit everything. Each YAML gets a `# Palette:` credit line (the
YAMLs are bundled raw, so it ships in the app) and the generator rewrites
`libs/shell-ui/themes/THIRD_PARTY_NOTICES.md` with the copyright lines and the
MIT text. The second argument writes a JSON of all themes
(used for the design canvas previews).
