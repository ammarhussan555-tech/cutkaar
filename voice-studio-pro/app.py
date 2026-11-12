"""
Voice Studio Pro — unlimited, free, offline AI voiceover with voice cloning.

Engines (both open-source, run on your own computer):
  * Kokoro-82M      — 28 ready-made premium English voices (fast, works on any CPU)
  * Chatterbox      — Resemble AI's voice cloning model (clone any voice from 6–30 s of audio)

No API key, no character limit, no daily limit.
"""
import os
import re
import sys
import json
import time
import shutil
import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# keep every downloaded model inside this folder
os.environ.setdefault("HF_HOME", str(ROOT / "models"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")

import numpy as np
import soundfile as sf
import gradio as gr

import importlib.util

MOCK = os.environ.get("VS_MOCK") == "1"  # for UI testing without the AI models
# Lite version = Kokoro only (low RAM PCs). Cloning needs the chatterbox package.
HAS_CB = (MOCK and os.environ.get("VS_LITE") != "1") or (
    os.environ.get("VS_LITE") != "1" and importlib.util.find_spec("chatterbox") is not None)

VOICES_DIR = Path(os.environ.get("VS_VOICES_DIR") or (ROOT / "my_voices"))
OUT_DIR = ROOT / "outputs"
VOICES_DIR.mkdir(exist_ok=True)
OUT_DIR.mkdir(exist_ok=True)
SR = 24000

# ---------------------------------------------------------------- voices
KOKORO = {
    # American female
    "⭐ Heart — US female, warm (best)": "af_heart",
    "⭐ Bella — US female, expressive": "af_bella",
    "Nicole — US female, soft / ASMR": "af_nicole",
    "Sarah — US female, clear": "af_sarah",
    "Sky — US female, young": "af_sky",
    "Nova — US female, bright": "af_nova",
    "Aoede — US female, breezy": "af_aoede",
    "Kore — US female, firm": "af_kore",
    "Alloy — US female, neutral": "af_alloy",
    "Jessica — US female, friendly": "af_jessica",
    "River — US female, calm": "af_river",
    # American male
    "⭐ Michael — US male, narrator": "am_michael",
    "⭐ Fenrir — US male, deep": "am_fenrir",
    "Puck — US male, upbeat": "am_puck",
    "Adam — US male, casual": "am_adam",
    "Echo — US male, smooth": "am_echo",
    "Eric — US male, confident": "am_eric",
    "Liam — US male, young": "am_liam",
    "Onyx — US male, low": "am_onyx",
    "Santa — US male, jolly": "am_santa",
    # British
    "⭐ Emma — UK female, elegant": "bf_emma",
    "Isabella — UK female, warm": "bf_isabella",
    "Alice — UK female, crisp": "bf_alice",
    "Lily — UK female, gentle": "bf_lily",
    "⭐ George — UK male, documentary": "bm_george",
    "Fable — UK male, storyteller": "bm_fable",
    "Lewis — UK male, deep": "bm_lewis",
    "Daniel — UK male, calm": "bm_daniel",
}
CB_DEFAULT = "🎭 Chatterbox default voice"
CLONE_PREFIX = "🧬 "


def list_clones():
    return sorted(p.stem for p in VOICES_DIR.glob("*.wav"))


def all_voice_choices():
    if not HAS_CB:
        return list(KOKORO.keys())
    return [CLONE_PREFIX + c for c in list_clones()] + list(KOKORO.keys()) + [CB_DEFAULT]


def need_cb():
    if not HAS_CB:
        raise gr.Error("Lite version mein voice clone nahi hai. Clone ke liye Colab version ya full INSTALL.bat use karein.")


# ---------------------------------------------------------------- engines (lazy)
_dev = None
_kokoro_model = None
_kokoro_pipes = {}
_cb = {}


def device():
    global _dev
    if _dev is None:
        if MOCK:
            _dev = "cpu"
        else:
            import torch
            if torch.cuda.is_available():
                _dev = "cuda"
            elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                _dev = "mps"
            else:
                _dev = "cpu"
            print(f"[Voice Studio] Using device: {_dev}")
    return _dev


def kokoro_pipe(voice_id):
    global _kokoro_model
    lang = "b" if voice_id.startswith("b") else "a"
    if lang not in _kokoro_pipes:
        from kokoro import KModel, KPipeline
        if _kokoro_model is None:
            _kokoro_model = KModel(repo_id="hexgrad/Kokoro-82M").to(device()).eval()
        _kokoro_pipes[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M", model=_kokoro_model)
    return _kokoro_pipes[lang]


def chatterbox(kind):
    """kind: 'turbo' (fast, supports [laugh] tags) or 'expressive' (emotion slider)."""
    if kind not in _cb:
        dev = device()
        if kind == "turbo":
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            _cb[kind] = ChatterboxTurboTTS.from_pretrained(device=dev)
        else:
            from chatterbox.tts import ChatterboxTTS
            _cb[kind] = ChatterboxTTS.from_pretrained(device=dev)
        _cb[kind]._vs_default = _cb[kind].conds  # remember the built-in voice
        _cb[kind]._vs_ref = None
    return _cb[kind]


# ---------------------------------------------------------------- text helpers
def split_text(text, max_chars):
    """Split into chunks of whole sentences. Returns list of (chunk, pause_after_seconds)."""
    text = text.replace("\r", "")
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n|\n", text) if p.strip()]
    out = []
    for p in paragraphs:
        sentences = re.findall(r"[^.!?…]+[.!?…]+[\"')\]]*|[^.!?…]+$", p) or [p]
        cur = ""
        for s in sentences:
            s = s.strip()
            if not s:
                continue
            while len(s) > max_chars:  # very long sentence: cut at comma / space
                cut = s.rfind(",", 0, max_chars)
                if cut < max_chars * 0.4:
                    cut = s.rfind(" ", 0, max_chars)
                if cut <= 0:
                    cut = max_chars
                if cur:
                    out.append((cur, 0.15))
                    cur = ""
                out.append((s[:cut + 1].strip(), 0.12))
                s = s[cut + 1:].strip()
            if cur and len(cur) + 1 + len(s) > max_chars:
                out.append((cur, 0.2))
                cur = s
            else:
                cur = (cur + " " + s).strip()
        if cur:
            out.append((cur, 0.2))
        if out:
            out[-1] = (out[-1][0], 0.55)  # longer pause after a paragraph
    return out


def silence(sec):
    return np.zeros(int(SR * sec), dtype=np.float32)


def to_float32(wav):
    if hasattr(wav, "detach"):
        wav = wav.detach().cpu().numpy()
    wav = np.asarray(wav, dtype=np.float32).squeeze()
    return wav


def trim_edges(wav, thresh=0.01, pad=0.04):
    idx = np.where(np.abs(wav) > thresh)[0]
    if len(idx) == 0:
        return wav
    a = max(0, idx[0] - int(SR * pad))
    b = min(len(wav), idx[-1] + int(SR * pad))
    return wav[a:b]


def normalise(wav, peak=0.95):
    m = float(np.max(np.abs(wav))) if len(wav) else 0.0
    return wav * (peak / m) if m > 0 else wav


def save_audio(wav, fmt, name):
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = re.sub(r"[^\w\-]+", "_", name).strip("_")[:40] or "voice"
    path = OUT_DIR / f"voiceover_{safe}_{stamp}.{fmt}"
    pcm16 = (np.clip(wav, -1, 1) * 32767).astype(np.int16)
    if fmt == "mp3":
        import lameenc
        enc = lameenc.Encoder()
        enc.set_bit_rate(192)
        enc.set_in_sample_rate(SR)
        enc.set_channels(1)
        enc.set_quality(2)
        data = enc.encode(pcm16.tobytes()) + enc.flush()
        path.write_bytes(bytes(data))
    else:
        sf.write(str(path), pcm16, SR, subtype="PCM_16")
    return str(path)


# ---------------------------------------------------------------- synthesis
def synth_chunk(chunk, voice_choice, speed, emotion, cb_kind, temperature):
    if MOCK:
        time.sleep(0.05)
        n = int(SR * max(0.4, len(chunk) / 15))
        t = np.arange(n) / SR
        return (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)

    import torch
    if voice_choice in KOKORO:
        vid = KOKORO[voice_choice]
        pipe = kokoro_pipe(vid)
        parts = []
        with torch.inference_mode():
            for res in pipe(chunk, voice=vid, speed=float(speed), split_pattern=None):
                audio = res.audio if hasattr(res, "audio") else res[2]
                if audio is not None:
                    parts.append(to_float32(audio))
        return np.concatenate(parts) if parts else silence(0.1)

    # Chatterbox (cloned or default voice)
    need_cb()
    model = chatterbox(cb_kind)
    ref = None
    if voice_choice.startswith(CLONE_PREFIX):
        ref = str(VOICES_DIR / (voice_choice[len(CLONE_PREFIX):] + ".wav"))
        if not Path(ref).exists():
            raise gr.Error("Ye cloned voice file nahi mili. Voice list refresh karein.")
    kwargs = dict(temperature=float(temperature))
    if cb_kind == "expressive":
        kwargs.update(exaggeration=float(emotion), cfg_weight=0.3 if emotion > 0.7 else 0.5)
    with torch.inference_mode():
        if ref:
            key = (cb_kind, ref, round(float(emotion), 2) if cb_kind == "expressive" else 0)
            if getattr(model, "_vs_ref", None) != key:
                if cb_kind == "expressive":
                    model.prepare_conditionals(ref, exaggeration=float(emotion))
                else:
                    model.prepare_conditionals(ref)
                model._vs_ref = key
        elif getattr(model, "_vs_ref", None) is not None:
            # back to the built-in voice
            model.conds = model._vs_default
            model._vs_ref = None
        wav = model.generate(chunk, **kwargs)
    wav = to_float32(wav)
    sr = getattr(model, "sr", SR)
    if sr != SR:
        import librosa
        wav = librosa.resample(wav, orig_sr=sr, target_sr=SR)
    # Chatterbox speed control (simple time-stretch) if requested
    if abs(float(speed) - 1.0) > 0.02:
        import librosa
        wav = librosa.effects.time_stretch(wav, rate=float(speed))
    return wav


def generate(text, voice_choice, speed, emotion, cb_kind_label, temperature, fmt, progress=gr.Progress()):
    text = (text or "").strip()
    if not text:
        raise gr.Error("Pehle script likhein.")
    if not voice_choice:
        raise gr.Error("Voice chunein.")
    cb_kind = "expressive" if cb_kind_label.startswith("🎭") else "turbo"
    is_kokoro = voice_choice in KOKORO
    max_chars = 400 if is_kokoro else (280 if cb_kind == "turbo" else 220)
    chunks = split_text(text, max_chars)
    t0 = time.time()
    progress(0, desc="Model load ho raha hai (pehli dafa download mein kuch minute lagte hain)...")
    pieces = []
    for i, (chunk, pause) in enumerate(chunks):
        progress(i / len(chunks), desc=f"Hissa {i + 1} / {len(chunks)} ban raha hai...")
        try:
            wav = synth_chunk(chunk, voice_choice, speed, emotion, cb_kind, temperature)
        except gr.Error:
            raise
        except Exception as e:  # keep going, but tell the user
            print(f"[Voice Studio] chunk {i + 1} failed: {e}", file=sys.stderr)
            raise gr.Error(f"Hissa {i + 1} mein masla: {e}")
        pieces.append(trim_edges(wav))
        pieces.append(silence(pause))
    progress(0.98, desc="Audio jor raha hoon...")
    full = normalise(np.concatenate(pieces[:-1]) if len(pieces) > 1 else pieces[0])
    name = voice_choice.replace(CLONE_PREFIX, "").split(" —")[0].replace("⭐", "").strip()
    path = save_audio(full, fmt, name)
    secs = len(full) / SR
    took = time.time() - t0
    info = (f"✅ Tayyar! {len(text):,} characters → {int(secs // 60)}:{int(secs % 60):02d} min audio, "
            f"{took:.0f} second mein bana ({device().upper()}).\n📁 File: {path}")
    return (SR, (np.clip(full, -1, 1) * 32767).astype(np.int16)), path, info


# ---------------------------------------------------------------- cloning
def load_any_audio(path):
    import librosa
    wav, _ = librosa.load(path, sr=SR, mono=True)
    return wav.astype(np.float32)


def save_clone(audio_path, name):
    need_cb()
    if not audio_path:
        raise gr.Error("Pehle awaaz record ya upload karein.")
    name = re.sub(r"[^\w\- ]+", "", (name or "").strip())[:40].strip()
    if not name:
        name = f"Voice {len(list_clones()) + 1}"
    if MOCK:
        wav, sr = sf.read(audio_path, dtype="float32")
        wav = wav if wav.ndim == 1 else wav.mean(axis=1)
    else:
        wav = load_any_audio(audio_path)
    secs = len(wav) / SR
    if secs < 6:
        raise gr.Error(f"Sirf {secs:.1f} second hai. Kam az kam 6 second (behtar 10–20 second) chahiye.")
    wav = trim_edges(wav, thresh=0.005, pad=0.1)[: SR * 30]
    wav = normalise(wav, 0.9)
    sf.write(str(VOICES_DIR / f"{name}.wav"), (wav * 32767).astype(np.int16), SR, subtype="PCM_16")
    choices = all_voice_choices()
    msg = f"✅ \"{name}\" save ho gayi ({min(secs, 30):.0f} sec). Voiceover tab mein 🧬 {name} chunein."
    return msg, gr.update(choices=choices, value=CLONE_PREFIX + name), gr.update(choices=list_clones(), value=name)


def delete_clone(name):
    if not name:
        raise gr.Error("Delete karne ke liye voice chunein.")
    p = VOICES_DIR / f"{name}.wav"
    if p.exists():
        p.unlink()
    choices = all_voice_choices()
    return f"🗑 \"{name}\" delete ho gayi.", gr.update(choices=choices, value=choices[0] if choices else None), \
        gr.update(choices=list_clones(), value=None)


def refresh():
    return gr.update(choices=all_voice_choices()), gr.update(choices=list_clones())


def preview(voice_choice, speed, emotion, cb_kind_label, temperature):
    if not voice_choice:
        raise gr.Error("Voice chunein.")
    cb_kind = "expressive" if cb_kind_label.startswith("🎭") else "turbo"
    wav = synth_chunk("Hello! This is a quick preview of how this voice sounds in your voiceover.",
                      voice_choice, speed, emotion, cb_kind, temperature)
    wav = normalise(trim_edges(wav))
    return SR, (wav * 32767).astype(np.int16)


def on_voice_change(voice_choice):
    is_cb = not (voice_choice in KOKORO)
    return gr.update(visible=is_cb), gr.update(visible=is_cb)


def count(text):
    t = text or ""
    words = len(t.split())
    return f"{len(t):,} characters · {words:,} words · ~{words / 150:.1f} min audio · koi limit nahi ♾️"


# ---------------------------------------------------------------- UI
CSS = """
.gradio-container {max-width: 1100px !important; margin: auto}
#title h1 {margin-bottom: 0}
#gen {font-size: 18px; padding: 14px}
footer {display: none !important}
"""

SAMPLE = ("Welcome back to the channel! Today, we're diving into five simple habits that can completely "
          "transform your mornings. And trust me — stay till the end, because the last one is a total game changer.")

with gr.Blocks(title="Voice Studio Pro") as demo:
    gr.Markdown("# 🎙️ Voice Studio Pro" + (" Lite" if not HAS_CB else "") +
                "\n**Unlimited · Free** — premium AI voices" + (" aur voice cloning" if HAS_CB else "") +
                ". Koi API key nahi, koi limit nahi.", elem_id="title")

    with gr.Tab("🎙️ Voiceover"):
        with gr.Row():
            with gr.Column(scale=3):
                text = gr.Textbox(label="Script (jitni lambi chahein)", value=SAMPLE, lines=14, max_lines=40)
                counter = gr.Markdown(count(SAMPLE))
                gr.Markdown("**Cloned voice (Turbo) ke liye tags:** `[laugh]` `[chuckle]` `[sigh]` `[gasp]` `[cough]` — script mein kahin bhi likhein.")
            with gr.Column(scale=2):
                voice = gr.Dropdown(all_voice_choices(), value="⭐ Michael — US male, narrator", label="Voice",
                                    info="🧬 = aap ki cloned voices · ⭐ = sab se behtareen")
                speed = gr.Slider(0.6, 1.5, value=1.0, step=0.05, label="Speed")
                cb_kind = gr.Radio(["⚡ Turbo (tez, tags support)", "🎭 Expressive (emotion control)"],
                                   value="⚡ Turbo (tez, tags support)", label="Clone engine", visible=False)
                emotion = gr.Slider(0.25, 1.5, value=0.5, step=0.05, label="Emotion (Expressive engine)",
                                    info="0.5 = normal · 0.8+ = zyada josh/drama", visible=False)
                with gr.Accordion("Advanced", open=False):
                    temperature = gr.Slider(0.3, 1.2, value=0.8, step=0.05, label="Variation (temperature)")
                fmt = gr.Radio(["mp3", "wav"], value="mp3", label="File format")
                with gr.Row():
                    prev_btn = gr.Button("🔈 Preview voice")
                prev_audio = gr.Audio(label="Preview", autoplay=True, interactive=False)
        gen_btn = gr.Button("⚡ Generate Voiceover", variant="primary", elem_id="gen")
        out_audio = gr.Audio(label="Voiceover", interactive=False)
        out_file = gr.File(label="Download")
        out_info = gr.Markdown()

    with gr.Tab("🧬 Voice Clone", visible=HAS_CB):
        gr.Markdown("""### Kisi bhi awaaz ka clone banayein (unlimited)
1. **10–20 second** ki saaf recording record ya upload karein — sirf ek shakhs ki awaaz, background music/shor ke baghair.
2. Naam likhein aur **Save** dabayein.
3. **Voiceover** tab mein 🧬 wali voice chunein aur script generate karein.

💡 *Behtareen result ke liye:* normal andaaz mein, saaf mic se, jaise aap ki voiceover chahiye usi tone mein bolein. MP3/WAV/M4A sab chalti hain.
⚠️ *Sirf apni awaaz ya jis ki ijazat ho us ki awaaz clone karein.*""")
        with gr.Row():
            with gr.Column():
                clone_audio = gr.Audio(sources=["upload", "microphone"], type="filepath", label="Awaaz ka sample (6–30 sec)")
                clone_name = gr.Textbox(label="Voice ka naam", placeholder="e.g. Meri Awaaz")
                save_btn = gr.Button("💾 Save cloned voice", variant="primary")
                clone_msg = gr.Markdown()
            with gr.Column():
                clone_list = gr.Dropdown(list_clones(), label="Meri cloned voices", value=None)
                with gr.Row():
                    del_btn = gr.Button("🗑 Delete")
                    ref_btn = gr.Button("↻ Refresh")
                gr.Markdown(f"Cloned voices is folder mein save hoti hain:\n`{VOICES_DIR}`")

    with gr.Tab("❓ Help"):
        gr.Markdown(f"""
### Kaise chalta hai
- **Premium voices (⭐ Kokoro):** 28 ready-made English voices (US + UK). Har computer par tez chalti hain.
- **Cloned voices (🧬 Chatterbox):** Resemble AI ka open-source model — blind tests mein log isay ElevenLabs se behtar kehte hain.
- **Turbo** tez hai aur `[laugh]` jaise tags samajhta hai. **Expressive** mein Emotion slider se josh kam/zyada hota hai.
- Lambi script khud hisson mein tooti hai aur ek file ban jati hai — **koi character limit nahi**.

### Speed
- **NVIDIA graphics card** ho to bohat tez (real-time se tez).
- Sirf **CPU** par: Kokoro voices tez rehti hain, lekin cloned voices dheere banti hain (1 min audio ≈ 2–6 min). Lambi script ho to chalne dein.

### Files
- Banayi hui voiceovers: `{OUT_DIR}`
- Models (pehli dafa download): `{ROOT / 'models'}`

*Har Chatterbox audio mein Resemble AI ka na-sunai dene wala watermark hota hai (AI audio pehchanne ke liye).*
""")

    text.change(count, text, counter)
    voice.change(on_voice_change, voice, [cb_kind, emotion])
    prev_btn.click(preview, [voice, speed, emotion, cb_kind, temperature], prev_audio)
    gen_btn.click(generate, [text, voice, speed, emotion, cb_kind, temperature, fmt], [out_audio, out_file, out_info])
    save_btn.click(save_clone, [clone_audio, clone_name], [clone_msg, voice, clone_list])
    del_btn.click(delete_clone, clone_list, [clone_msg, voice, clone_list])
    ref_btn.click(refresh, None, [voice, clone_list])

if __name__ == "__main__":
    port = int(os.environ.get("VS_PORT", "7860"))
    print("\n  Voice Studio Pro chal raha hai →  http://127.0.0.1:%d\n  (Band karne ke liye ye window close karein)\n" % port)
    share = os.environ.get("VS_SHARE") == "1"  # Colab: public link
    if share:
        print("  Neeche 'public URL' wala link (https://....gradio.live) kholein.\n", flush=True)
    demo.queue(default_concurrency_limit=1).launch(
        server_name="0.0.0.0" if share else "127.0.0.1", server_port=port, share=share,
        inbrowser=(not share) and os.environ.get("VS_NOBROWSER") != "1",
        theme=gr.themes.Soft(primary_hue="violet"), css=CSS, show_error=True,
    )
