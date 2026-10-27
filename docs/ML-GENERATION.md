# ML generation for OMNI-CELL: phased plan

Goal: produce finished anime-style illustrations (and, later, layered editable versions of them)
from inside the app, with the artist's own lines and colours steering the result. The system is a
separate subsystem ("ML Studio") that talks to the drawing core through images only, so the core
stays deterministic and the zero-knowledge story stays intact when the model runs locally.

Assumptions are marked [A]. Nothing here has been run on a GPU yet; the sidecar in `ml/sidecar/` is
written against the diffusers API as documented at the time of writing [A] and must be verified on
real hardware in Phase 1.

## 0a. Decisions taken (2026-10-25)

- Runs on the artist's own GPU first; a hosted provider is added later behind the same interface. Target machine: RTX A3000 Laptop GPU, 6 GB dedicated VRAM, 16 GB DDR4 (13.8 GB in use at the time of the screenshot), Intel UHD as the display adapter, Windows, driver 32.0.101.x.
- Base model: SDXL anime checkpoint, `animagine-xl-4` preset by default (Fair AI Public License 1.0-SD [A: check the model card]); `illustrious-xl` as the second SDXL choice, chosen for anatomy; `counterfeit-v3-sd15` (SD 1.5) as the fallback when memory or time is short. "Much better anatomy and landscape" is addressed by the Illustrious family and by the quality-tag prefix each preset carries; a dedicated landscape model is not selected yet [A: evaluate after the first runs].
- Memory profile `6gb`: fp16, model CPU offload, VAE tiling and slicing, requests capped at 832x1216 px and scaled down to fit. Needs roughly 8 GB of free system RAM while running [A]; close other applications first.
- Licence stance: none for now (deferred by the owner); results still record model id, seed and parameters in layer metadata so a stance can be applied later.
- Steering default: "Colour my lines" (the artist's Ink/Sketch layers drive a lineart ControlNet), so the drawing stays the artist's; text-only generation is available but not the showcase.

## 0b. Decisions that were open (kept for the record)

| Decision | Options | Trade-off |
|---|---|---|
| Where the model runs | (a) local sidecar on the artist's GPU; (b) hosted API (Replicate, Stability, fal, RunPod); (c) in-browser WebGPU (ONNX / transformers.js) | (a) private, free per image, needs an 8 GB+ GPU [A: SDXL fp16 fits in 8 GB with offload, 12 GB comfortable]; (b) no hardware, per-image cost, images leave the device (conflicts with Phase 2 privacy claims unless disclosed and opt-in); (c) only small models (SD 1.5 at 512 px, minutes per image on integrated GPUs) |
| Base model | SDXL anime checkpoints (Animagine XL 3.x, Pony-derived, NoobAI) vs SD 1.5 anime checkpoints (Anything, Counterfeit) | SDXL: better anatomy and 1024 px native, 2× memory; SD 1.5: fast, large ControlNet/LoRA ecosystem, 512–768 px |
| Steering | text only; img2img from the current drawing; ControlNet (lineart, canny, openpose, depth) from the artist's lines; IP-Adapter for style reference | ControlNet lineart is the one that makes the app's own drawing matter: the artist inks, the model colours and renders |
| Licence stance | model licence (CreativeML Open RAIL-M, Fair AI Public License for Animagine) and generated-content policy | some licences restrict commercial use of outputs or require the licence to travel with derivatives; must be written into the Samples gallery metadata |
| Style references | none; the artist's own work only; third-party images | third-party references raise the same licensing question as tracing them |

## Phase 1: local sidecar (the private path)

1. Package `ml/sidecar/` (Python 3.11, FastAPI, diffusers, torch) with a pinned requirements file and a one-command start (`python -m sidecar --model <checkpoint>`).
2. Endpoints: `GET /health` (model, device, VRAM, controlnets loaded), `POST /generate` returns a job id, `GET /jobs/{id}` (status, progress step/total, preview every N steps, result PNG base64 on done), `POST /jobs/{id}/cancel`.
3. Pipelines: text-to-image; image-to-image (strength); ControlNet lineart with the artist's ink layer as the control image (preprocessor off when the input is already clean lines, on for a rough sketch); optional IP-Adapter style reference.
4. Memory: fp16, VAE tiling and slicing, model CPU offload on 8 GB cards [A]; one job at a time with a queue; progress callbacks each step.
5. Verify on hardware: time per 1024² image at 25 steps, VRAM high-water mark, output quality against the reference set. Record numbers in ARCHITECTURE.md.

## Phase 2: the app side (built now, provider-agnostic)

1. `engine/ml.ts`: `Provider` interface (`health`, `submit`, `poll`, `cancel`), `SidecarProvider` (HTTP to 127.0.0.1:8790), `MockProvider` (deterministic placeholder for tests and for the UI without a GPU), a `JobRunner` with progress events and cancellation, and helpers that turn layers into control images (ink layers flattened on white at the requested size) and results into layers.
2. `ui/generate-panel.ts` ("Generate" tab): provider status; mode (Text / Colour my lines / Repaint this drawing / Style from reference); prompt and negative prompt; size, steps, guidance, seed, strength, control weight; a results strip with "Add as layer", "Replace flats", "Use as reference"; every job logged with its parameters so a result can be reproduced.
3. Privacy switch: a provider that leaves the device is marked and off by default; the panel states where the image goes before the first remote job.
4. Reproducibility: seed and parameters stored on the result layer (`layer.meta`) and in the sample manifest.

## Phase 3: hosted provider (optional)

1. `ReplicateProvider` / `StabilityProvider` behind the same interface, with the API key kept in the vault (never in localStorage plain).
2. Cost display per job (per-second or per-image pricing from the provider) before submitting.
3. Rate limiting and retry with backoff; the queue survives a page reload (jobs persisted in OPFS).

## Phase 4: steering from the artist's work

1. ControlNet lineart from the Ink layer; pose from a posed 3D mannequin (the NPR layer) through openpose or depth; panel-aware generation (one job per panel polygon, masked).
2. Inpainting: a selection becomes the mask; "regenerate this area".
3. Iteration: results land as layers with the job parameters, so "more like this, seed +1" is a click.

## Phase 5: from generated image to editable layers (option 2, next)

1. Line extraction: adaptive threshold on luminance, thinning, cleanup; result on an Ink layer.
2. Flats: colour clustering (k-means in Lab) under the lines, filled into a Flats layer; shading separated as the residual (multiply layer); highlights as the bright residual (screen layer).
3. Quality gates: per-layer coverage, edge agreement between ink and flats, and a side-by-side with the source.

## Phase 6: samples and licensing

1. Generate the five gallery samples with recorded prompts, seeds and model name; split them with Phase 5; ship with a `LICENSE-SAMPLES.md` stating model, licence and that the images are machine-generated.
2. Each sample records its provenance in the manifest (model, seed, parameters) and the gallery shows it.

## Risks

- Quality: anime checkpoints produce convincing faces and hair at 1024 px but fail on hands, glasses, cameras and text [A, widely reported]; expect several seeds per result and manual cleanup on layers.
- Hardware: without a discrete GPU the local path is minutes per image or unavailable; the hosted path is the fallback, with the privacy disclosure above.
- Policy: generated samples must not be presented as hand-drawn, and the project write-up must say which model produced them.

## Phase 2b (built): quality controls on top of the base models

What was added to get more out of the same checkpoints on a 6 GB card, all request-level so the app decides per job:
- Schedulers: DPM++ 2M Karras (default, sharp at 20–30 steps), Euler a (softer, more seed variation), Euler, DDIM. CFG rescale 0–1 against over-saturation at high guidance.
- Hi-res fix: second img2img pass at 1.5× (capped by the memory profile) with low strength; sharper hair, eyes and line edges at about 2× the time.
- Inpaint ("Fix this area"): the app's selection becomes the mask; SDXL / SD 1.5 inpaint pipelines regenerate only inside it. The practical answer to hands and faces.
- Line input preprocessors: clean ink goes straight to the lineart ControlNet; rough pencil goes through controlnet-aux Anime Lineart or HED scribble first.
- LoRA adapters: `ml/sidecar/loras/*.safetensors` listed by `/loras`, applied per request with a weight; the path to a house style trained on the studio's own drawings.
- IP-Adapter weight exposed (Style from reference).
- Model swap without restart (`/models`, `POST /load`), so the SD 1.5 fallback is one click when memory or time is short.
- Tag assistant: Danbooru-style tag groups (subject, style, light, scene, face, hair) prepended to the prompt; anime checkpoints answer tags better than sentences. Quality-tag prefix and the preset's negative list on by default.
- Reporting: free VRAM in the health chip, peak VRAM per result, so the profile can be tuned from real numbers.
Not done: a landscape-specialised checkpoint (evaluate after the first runs), openpose/depth from the 3D mannequin (Phase 4), training a house-style LoRA (needs 30–100 of the studio's own drawings and a few GPU hours [A]).

## Phase 2c (built): steering and throughput

- Depth from the 3D layer: the NPR G-buffer's linear depth is read back as a MiDaS-style map (near white, far black) and sent as a second ControlNet (`diffusers/controlnet-depth-sdxl-1.0` or the SD 1.5 depth net), alone or with the lines; the mannequin's pose, volume and camera survive generation. First step of Phase 4.
- Fast preview: LCM-LoRA (loaded once as an adapter) with the LCM scheduler, ≤8 steps and guidance ≤2; seconds per image on a laptop GPU for composition and seed hunting, then off for the final.
- FreeU on by default (backbone/skip scaling, no memory cost); off switch in the panel.
- Tags from drawing: WD14 tagger (`SmilingWolf/wd-v1-4-moat-tagger-v2`, ONNX) reads the current drawing and adds the confident tags (p ≥ 0.5) to the prompt prefix.
- Upscale 2× (Real-ESRGAN anime 6B, tiled) from the results strip, straight onto a layer, for 300 dpi pages.
- Keep reference: the picked character/style image can ride along with any mode (IP-Adapter), for the same character across panels and frames.
- Render all frames: one job per drawing on the timeline with a fixed seed and each frame's own lines; results land as a Gen layer inside each frame.
Verified against the stub: tags added, upscaled layer added, two frames rendered into their own frames.

## Phase 2d (built): images attached to the prompt

"Attach images…" in the Generate tab takes up to four pictures (character sheet, colour key, style sample, reference photo). They are sent as IP-Adapter images next to the prompt; with more than one, their embeddings are averaged. "Keep reference" sends them with every mode, so Colour my lines, Repaint and Fix this area all see them. The attached images say how the result should look; the prompt says what to draw; the lines say where. Verified against the stub: a job in lines mode carried the control image, two references and the prompt.

## Phase 2e (built): images in the prompt, and learning the artist's taste

- Up to four pictures ride with the prompt through IP-Adapter. One adapter with several images needs
  them nested (`[[a, b, c]]`); a flat list means one image per adapter and raises a length error.
- The IP-Adapter is attached only for jobs that carry references. Resident, it makes diffusers pass
  `added_cond_kwargs=None` for every other job and the UNet then evaluates `"image_embeds" not in None`.
- ControlNet is likewise built on first lineart job and freed when a job does not need it: on a 6 GB
  card the difference is running on the card versus spilling into shared memory (~20x slower).
- SD 1.5 is capped at 640x768; above ~600k px it is slower and starts duplicating heads and limbs.
- Accept / reject: every result has Keep and Discard. `POST /dataset/add` writes the image plus its
  prompt and parameters to `ml/sidecar/dataset/liked` or `/rejected`; `GET /dataset/stats` reports the
  counts and whether there are enough (20) to train. `train_lora.py` trains a LoRA on the UNet
  attention layers from the liked set at 512 px with gradient checkpointing (fits 6 GB) and writes
  `loras/<name>.safetensors`, which appears in the Generate tab. Rejected images are the negative half
  for preference tuning (Diffusion-DPO), which needs pairs from the same prompt and is not implemented.
- Selection: Esc now clears it, and Settings has "Clear on tool change" (off by default, as in other
  art apps, because select-then-paint-inside is a core workflow).

## Manga panels (loop 15)

Goal: print-ready black-and-white panels, made for a specific panel on the page.

- **Target panel** (`generate-panel.ts` panelRegion / panelSize): the job is made in the panel's shape at the model's native pixel count (SD 1.5 about 0.39 Mpx, SDXL about 1 Mpx), with the aspect clamped to 0.4-2.5. Lines, repaint and inpaint inputs and the depth map are cropped to that panel (`ml.ts` regionMap), so a rough sketch inside one panel steers only that panel. The result lands on a layer clipped to the panel (`panelMask`).
- **Manga look**: adds `monochrome, greyscale, manga, lineart, screentones, high contrast` and puts colour, 3D/photo, the model's own panel borders, speech bubbles and lettering in the negative prompt. Lettering and balloons belong to the Balloons tool.
- **Finish** (`engine/manga-finish.ts`), applied when a result is added as a layer: Greyscale (S-curve between black and white points), Screentone (pure black and white, round amplitude-modulated dots at the chosen lpi and 45 degrees, computed in page coordinates so dots line up across tiles, panels and results), or Ink only.
- **Vocabulary** (`ui/manga-tags.ts`): 20 searchable, collapsible groups (cast, shot, camera, manga look, colour style, motion FX, talking, emotion, movement, fighting, blades, guns, disarm, stealth, drama, effects, light, setting, look) and 23 scene recipes (dialogue close-up, two-shot, reaction, establishing walk, chase, jump, punch impact, flying kick, sword clash, draw, gunfight, gun to camera, sniper, disarm, restrain, sneak, ambush, reveal, standoff, defeat, death scene, explosion escape, power-up). A recipe replaces action, camera and effect tags and keeps cast, look, emotion and manga-look tags. Own tags can be typed in.
- Kept results are captioned with the full prompt that produced them, so a style trained on them answers to the same tags.

Limits (not solved by tags):
- **Exact poses.** Tags describe an action; they do not fix limb positions, and SD 1.5 at 0.4 Mpx often fumbles hands and weapons. The reliable route is a pose input: sketch the pose in the panel and use "Colour my lines", or pose the 3D mannequin and turn on 3D depth. An OpenPose control is the planned next step.
- **Two interacting characters** (disarms, grapples) are the hardest case for any current model; expect to pick from several seeds (x4 seeds) and fix with "Fix this area".
- **Resolution.** For print, use Hi-res fix, then Upscale 2x on the chosen result before adding it.

## Variety and taste (loop 16)

- **New seed every run** (default): the seed field keeps the value that was used, so a good result can be repeated; "Keep seed" (or typing a seed) holds it for comparing settings. ×4 seeds gives four new seeds.
- **No repeats**: each finished result gets a 64-bit difference hash; one within 6 bits of an earlier result in this session is dropped and the job runs once more with a fresh seed. The panel reports how many were replaced.
- **Kept-image taste**: each job also sends two random images from `dataset/liked` (`GET /dataset/sample`) as IP-Adapter references at a low weight (0.3 by default). A different pair every job, so results lean toward the kept set without converging on any one image. Skipped when the sidecar has no IP-Adapter.
- Fixed in the sidecar: `/dataset/add` was defined twice and the first copy (which won) wrote no caption into the `.json`; training now falls back to the `.txt` caption, and new Keeps write both.

## Placing pictures in panels

- Move (T) with nothing selected lifts the whole active layer's content, so a generated or pasted picture can be resized straight away.
- Corner handles keep proportions and the opposite corner stays put (Shift: free aspect, Alt: from the centre). Moving and resizing snap to panel edges and centres and the page edges and centre within 10 screen pixels (Alt while moving: no snap); the panel the picture will land in is outlined.
- Toolbar under the picture: Fit panel (all of it inside, centred), Fill panel (covers the panel; the overflow shows faintly and is cropped to the panel shape on Done), Reset, Done. Double-click the picture = Fill panel. A filled picture dragged to another panel crops to that panel instead.

## Redraw (loop 17)
Every Generate result has a Redraw button: the Redraw tab rebuilds it in its panel with OMNI-CELL's tools (Trace Pen ink, flats, multiply shadows, screen light, screentone layers). Details and measurements: ARCHITECTURE.md section 24.

## Prompt length, order and the character design controls (loop 18)

The sidecar passed the prompt as a plain string, and CLIP reads 77 tokens: quality tags + manga look + twenty scene tags came first, so the subject at the end was silently cut. This was the main reason tags "did not work as well as they should".

- `sidecar/prompt.py`: WebUI-style encoding. Emphasis syntax `(tag:1.3)`, `((tag))`, `[tag]`; the prompt is tokenised whole, cut into 75-token chunks (at a comma where possible), each chunk encoded with start/end tokens, hidden states concatenated; token embeddings scaled by their weight with the chunk mean restored; positive and negative padded to the same chunk count. SD 1.5 uses the last layer; SDXL both encoders' penultimate layers plus the pooled output. Encoding happens after the LoRAs are applied. Falls back to plain strings on any error. `POST /tokens` returns counts; the result carries `promptTokens`, `chunks` and `fast`.
- Order sent (generate-panel `composePrompt`): LoRA trigger words, character design, the prompt text, scene tags, style words last. The panel shows "Sent as: ..." and a token meter.
- **Character design** section (`ui/character-design.ts`): armour colour + type, accent colour, clothing colour + garment, hair and eye colour (named colours or a custom material like "matte gunmetal"), helmet On / Off / Open visor (Off puts helmet, mask, visor, hood in the negative), free text for the armour design, the helmet design and the aesthetic, an emphasis slider (x1.0-1.5 on the design fragments), and a **Render style**: Model default / Anime cel / Semi-realistic / Realistic (adds style tags at the end and the opposite look to the negative). Realistic depends on the checkpoint: two SD 1.5 presets were added, `dreamshaper-8-sd15` (semi-realistic, what the user has been running) and `realistic-vision-sd15` [A: hub ids as published].
- **Why "my-style" images looked poor**: the screenshots show Fast preview on (LCM: 8 steps at guidance 2, LoRA and sliders mostly ignored) with Guidance 15 and 60 steps set underneath, and results arriving in 4 s. Fast results are now badged "preview" with a **Full quality** button (same seed, Fast off, at least 28 steps); the checkbox says what it costs; Guidance above 9 shows a warning with a "Use 7" button (and a CFG-rescale hint); LoRA weight above 1.0 warns; the LoRA default weight is 0.7.
- Training: `train_lora.py` now defaults the step count to about 12 passes over the set (300-1500), writes checkpoints `<name>-s250`, `-s500`... so an earlier, lighter version can be compared, and writes `<name>.json` with the trigger word (default `ohwx-style`). `/loras` returns the triggers and the app adds the word to prompts automatically when the LoRA is ticked. [A: whether the current my-style is over- or under-trained cannot be judged from here; compare the checkpoints at weight 0.6-0.8 with Fast preview off.]

## Action folders and a better trainer (loop 20)

Question asked: does sorting the kept images into folders per action (running, walking, shooting, sword, jumping, sneaking...) make the model better?

Short answer: not on its own. A LoRA learns from the captions next to the images, and the caption already says "running". Folder names never reach the model. What the folders do give you is bookkeeping and balance, and balance does change the result:

- You can see the shape of the set. 40 standing portraits and 3 sneaking images means the model has seen sneaking three times; no amount of training fixes that. The Generate tab now shows the count per action and lists the actions under 8 images, so you know what to keep next.
- The trainer samples every action folder equally (`--balance 1`, default), capped at three times an image's natural share, so a thin action is drawn as often as a fat one instead of being drowned.
- `eval_lora.py` renders one fixed prompt per action for each checkpoint and lays them out as a sheet, so you pick the checkpoint by looking at the actions you care about rather than at one lucky seed.

What changed:

- `sidecar/actions.py`: the action list and the caption-to-folder rule (first action group whose tag appears wins; emphasis syntax is stripped; no action tag means `misc`). Keep writes into `dataset/liked/<action>/`. `POST /dataset/organize` sorts older flat images; the app offers it as a button when it sees unsorted files. `/dataset/stats` returns `actions`, `thin` and `unsorted`.
- `train_lora.py`: walks the action folders, prints the count per action and the thin ones, balanced sampling, 10% caption dropout (the LoRA then also helps when a prompt says little), min-SNR-gamma 5 loss weighting (steadier training; the paper's value), and the same checkpoints and `.json` as before.
- `eval_lora.py --name my-style [--weights 0.5,0.7,0.9]` writes `loras/my-style-eval.png`: rows are actions, columns are "no LoRA" then each checkpoint at each weight.
- Tags: `sword swing`, `slash`, `weapon drop` added so the vocabulary matches the folder rule.

What would move quality more than any of this, in order, and why it is not in this loop:

1. More and better images per action. 8 is a floor, 20 per action is where the look settles. This is on you, not the code.
2. Pose control from the 3D mannequin (OpenPose ControlNet). Actions are poses; a pose image pins the body, and the LoRA only has to supply the look. Needs the openpose ControlNet (about 1.4 GB) and a skeleton renderer for the mannequin. Filed as an issue.
3. Preference tuning on the kept/discarded pairs (Diffusion-DPO). Uses the Discard pile, which nothing uses today. Needs pairs from the same prompt and seed and a second training script. Filed as an issue.
4. Training at 768 instead of 512 on a card with 8 GB or more. On the 6 GB card it does not fit with the current settings.

None of the training changes have been run on a GPU here; the classifier and the organise step have unit tests (`python -m pytest ml/sidecar/tests`), and the app side is covered by the Playwright script `actions.py` against the stub.

### Naming what goes into the set (loop 20b)

Keep now opens a form on the result: name, action folder and caption. The sidecar takes `name` and `action` on `POST /dataset/add` (`/dataset/actions` lists the folders, `/dataset/guess` returns the folder the caption implies), slugs the name to a file-safe stem and appends six digits of the timestamp so two "sword swing" images never collide. The caption box is prefilled with the prompt that made the image; editing it is the point, since the image only teaches what its caption says. Shift-click keeps at once with the prompt as caption, as before. Playwright `keep.py` covers the dialog; `test_slug_is_file_safe` covers the stem.

## Hands, limbs and eyes (loop 21)

What was asked: five fingers that do not merge, two arms and two legs in the right places, eyes that match, and a manga look that reads as drawn rather than generated.

What is true about the model first: an SD 1.5 checkpoint at 512 px gives a hand about 40 px and cannot draw five fingers in 40 px, however it is prompted or trained. The LoRA teaches a look, not anatomy. So the fixes are around the model, not inside it, and they are the same ones the WebUI crowd settled on:

1. **Pose skeleton** (`engine/pose.ts`, "Pose and anatomy" in the Generate tab). An 18-joint OpenPose figure with twelve presets (standing, running, punching, kicking, sword swing, shooting, kneeling, sneaking...). Drag joints, Shift-drag carries a limb, double-click hides a joint, Mirror flips it. It is rendered in OpenPose's colours and sent as a `pose` ControlNet (`lllyasviel/control_v11p_sd15_openpose`, `thibaud/controlnet-openpose-sdxl-1.0` for SDXL [A: ids as published]). This is what fixes "two legs, two arms, where they should be": the net is told where the limbs are and how many there are. The sidecar now takes depth and pose together, each with its own weight.
2. **Detail pass** (`sidecar/detail.py`). After the image (and the hi-res pass), controlnet_aux's OpenPose detector finds the face, the eye strip and each hand; each region is padded 35%, cut out, scaled to 512 px, inpainted at strength 0.42 with a prompt that names it ("detailed hand, five fingers..." / "symmetrical eyes, sharp pupils...") and the matching failures in the negative, then blended back with a 12% feathered edge. Hands that overlap are redone as one region so there is no seam. Hands with fewer than six confident keypoints are left alone rather than guessed. The result line says what was redone ("detail: 1 face, 2 hands"). This is the ADetailer idea and is the single biggest lever for fingers and eyes. Skipped in Fast preview.
3. **Anatomy guard**: `(correct anatomy:1.1), five fingers, symmetrical eyes` on the positive side and the usual failure list (extra fingers, fused fingers, extra limbs, asymmetrical eyes, cross-eyed...) in the negative. Cheap and on by default.
4. **Negative embeddings**: files in `ml/sidecar/embeddings/` are loaded as textual inversions and their names appended to the negative. bad-hands-5 and EasyNegative are the usual ones; the user downloads them (licences vary), nothing is fetched automatically.
5. **Manga look** negative grew: cgi, render, airbrush, smooth shading, gradient shading, western comic. The look itself depends most on the checkpoint: Counterfeit and the Illustrious preset are trained on manga and anime; DreamShaper is semi-realistic and will keep looking painted.

Honest limits: none of this guarantees five fingers; it raises the hit rate, and the detail pass fixes most of what remains. The pose detector is a photo model and misses some anime hands (those are left as they are). Each detail region costs 3 to 6 s on the 6 GB card [A: estimate]. For a real step up on hands and eyes the model has to change: Illustrious XL (Danbooru-trained, far better hands) at ~60 to 90 s per image on 6 GB with offload. Not run on a GPU here; the geometry (`ml/sidecar/tests/test_detail.py`) and the skeleton (`web/test/pose.test.ts`) are unit-tested, the UI by `tools/qa/pose.py` against the stub.

## Dataset tab and the panel script (loop 22)

**Dataset tab.** Every kept image with its caption, newest first, filtered to the weak ones by default. The sidecar grades each caption (`actions.caption_issues`): no caption, fewer than three content tags, no subject tag, no action tag, too many quality words, over 40 tags. A row opens into an editor: rewrite the caption, "Suggest tags" (WD14 tagger on the stored file, confident tags appended), +1boy / +1girl, "Strip quality words", move to another action folder, rename, and a **character** tag. Save rewrites the .json and .txt and moves or renames the files; "Remove from set" moves the image to `dataset/removed` (never deleted). Endpoints: `GET /dataset/list`, `GET /dataset/thumb?id=`, `POST /dataset/update|remove|suggest`.

**Character LoRA.** Tag 15 to 30 clean images of one character with the same word in the Dataset tab, then `train_lora.py --name kai --only kai --trigger kai`: the trainer keeps only images whose character tag or caption carries that word. Use it together with the style LoRA in the Generate tab.

**Story tab.** A panel script, one panel per line (`engine/script.ts`): `@Name = trigger, tags` cast lines; `[shot]` picks camera tags; segments split on `|`; a segment starting with a cast name is that character with an optional emotion and a quoted line; everything else is scene tags; blank line = new page. The plan under the editor shows every panel's prompt and dialogue as it will be sent, and names speakers that are not in the cast. "Lay out page" applies the template that fits the count and shape (1 splash, 2 rows, wide-top+2 or 3 rows, 2x2 or tall-left+3, Action 5, 2x3 or Staircase 6). "Generate page" runs every panel through the Generate tab's settings (a hook `app.generateFor` overrides target panel and tags for one job, cast first, the user's prompt text last as the style line), places each result in its panel, then drops the dialogue into balloons in manga order (right to left, top to bottom), shout balloons for lines with !!/?? or capitals. One undo step per layout and per balloon set.

What this does not do yet: read prose (the optional local-LLM "draft the script for me" step comes after), keep characters consistent without a character LoRA, or choose panel sizes by beat weight. Tests: `web/test/script.test.ts`, `ml/sidecar/tests/test_actions.py::test_caption_issues_and_review_edits`, `tools/qa/story.py` and `tools/qa/dataset.py` against the stub (five panels generated and placed, two balloons).

## Manga pipeline and one-layer redraws (loop 23)

**One layer by default.** Redraw now lands on a single raster layer (`Layers: One layer`): the group is built as before, composited with its blend modes, tones baked as real dot screens at page resolution (`renderer.bakeTone`), and the parts are dropped. Colour / Manga in the report re-bake the same layer from the parts kept in memory, so switching the look does not touch the layer list. `Separate layers (group)` is still there for editing each part. Headless on the sample: one layer, 140 tiles, dot screens present in the alpha, undo removes exactly that layer.

**Found and fixed on the way:** `renderer.flatten()` drew tone layers as their raw masks, so every PNG, PDF and PSD export showed screentones as solid black. It now bakes them (`tools/qa/tonebake.py`: a 30% tone square flattens to dots, nothing outside the square).

**Lines from the anime lineart detector.** `POST /lineart` runs controlnet_aux's `lineart_anime` on the picture and returns white lines on black; the Redraw tab (`Lines from: anime lineart detector`) feeds that map into `trace()` in place of its own valley detection (ink where the map is above 90, core above 170), so the ink is what an anime line model would ink, not every dark edge. Falls back to the tracer with a note when the sidecar is off. The stub answers with an edge map of the input, which keeps the regression honest: ΔE 2.5, F1 0.98 on the sample (traced lines: 2.1 / 0.98).

**Manga panel, one click.** Every Generate result has a Manga panel button: manga look, black ink, detector lines, one layer, into the result's panel, run at once. The Redraw tab opens with the report.

Not measured on a GPU here; the detector's real output will differ from the stub's edge map.


## Keep from the picture, and the weapon guard (loop 25)

**Keep fills itself from the picture.** Pressing Keep now sends the result to `POST /describe`: the WD14 tagger looks at the image and the form opens with a name, an action folder and a caption built from what is actually there, not from what was asked for. `actions.describe()` orders the caption subject first (1boy, 1girl...) then by tagger confidence, picks the folder with `action_for`, and makes the name from subject + action + the three most confident tags that are specific to the picture (a stop list keeps out solo, looking at viewer, simple background and the like). LoRA trigger words from the prompt go first in the caption, because a character LoRA needs them and the tagger cannot see them. The form says where its fields came from; "Use prompt instead" and "Merge prompt" bring the prompt back when the tagger misses something it has no word for (a costume name, a character). Without a sidecar or with an old one the form falls back to the prompt, as before. Measured with the stub: the form opens with `1boy-shooting-helmet-armor-holding-gun`, folder `shooting`, caption from the tags; Merge appends the prompt's unseen tags; Save sends exactly the edited fields.

**Weapon guard.** When the Anatomy guard is on and the prompt, tags or character design name a weapon (`weaponIn`: gun, pistol, rifle, sword, katana, knife, bow... through emphasis syntax), the prompt gains how it is held (`holding gun, two-handed grip, finger on trigger, aiming down sights, (gun held in hands:1.1), correct weapon proportions, weapon separate from body`; blades get `both hands on the hilt`) and the negative gains the failure modes by name (`gun fused with hand, gun growing from arm, floating gun, extra gun, duplicate weapon, weapon merged with body, weapon without hand, arm merged with weapon`). The general anatomy negative also now lists `extra objects, floating objects, objects growing from body, stray limbs, disconnected limbs`.

**Hands redone with the weapon.** The detail pass is told the weapon word (`detail.weapon`). A hand patch then widens from 35% to 60% padding so the grip and the weapon are inpainted together, with the prompt `hand gripping a gun, fingers wrapped around the grip, five fingers, correct grip, gun held naturally` and the fused/floating/extra failures in its negative. A hand patch that stops at the knuckles cannot fix a grip, and a gun redrawn without the hand is where "weapon growing from the wrist" comes from.

What this can and cannot do, honestly: negatives steer, they do not forbid. SD1.5 at 512 px draws a believable pistol maybe half the time even with all of this; the pose control (hands included) and a LoRA trained on 20 to 30 kept images of *correct* grips move that number far more than any prompt. The three generations in the report that prompted this (weapon out of the forearm, pauldron turning into a barrel) are the classic SD1.5 merge failure; the detail pass with the weapon word is the one change here that acts on the pixels rather than on the prompt. Not measured on a GPU in this loop: the detail pass path is covered by a pytest with a fake engine (prompt and box size), the prompt changes by vitest and a headless run, the picture quality is for the user's next batch to judge. [A: the 0.6 padding is a guess at "hand plus pistol"; a rifle will still spill out of the patch.]
