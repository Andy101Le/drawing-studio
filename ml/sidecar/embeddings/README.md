# Negative embeddings

Drop textual-inversion files here (`.safetensors` or `.pt`). The sidecar loads each one at start
and the app appends the file name to the negative prompt when "Neg. embeddings" is ticked, so a
file called `bad-hands-5.safetensors` puts `bad-hands-5` in every negative.

These are small (a few hundred KB) and were trained on exactly the failures you want gone:
merged fingers, extra limbs, flat anime faces. The ones people use most with SD 1.5 anime
models are called bad-hands-5, badhandv4 and EasyNegative; they are published by their
authors on Civitai and Hugging Face under their own licences. Read the licence before using one
in work you publish. Nothing is downloaded for you.

SDXL models need SDXL-specific embeddings; an SD 1.5 file will be skipped with a message.
