import json
import math
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "assets" / "sounds"
SAMPLE_RATE = 44_100
TARGET_PEAK = 10 ** (-1 / 20)


def timeline(duration):
    return np.arange(round(duration * SAMPLE_RATE), dtype=np.float64) / SAMPLE_RATE


def fade(samples, attack, release):
    envelope = np.ones(samples.size, dtype=np.float64)
    attack_samples = min(samples.size, round(attack * SAMPLE_RATE))
    release_samples = min(samples.size, round(release * SAMPLE_RATE))
    if attack_samples:
        envelope[:attack_samples] = np.linspace(
            0.0, 1.0, attack_samples, endpoint=False
        )
    if release_samples:
        envelope[-release_samples:] = np.linspace(1.0, 0.0, release_samples)
    return samples * envelope


def tone(duration, frequencies, release=0.2):
    time = timeline(duration)
    samples = sum(
        np.sin(math.tau * frequency * time) / (index + 1)
        for index, frequency in enumerate(frequencies)
    )
    return fade(samples, 0.008, release)


def glide(duration, start_frequency, end_frequency, release=0.2):
    frequencies = np.linspace(
        start_frequency, end_frequency, round(duration * SAMPLE_RATE)
    )
    phase = math.tau * np.cumsum(frequencies) / SAMPLE_RATE
    return fade(np.sin(phase), 0.006, release)


def filtered_noise(duration, seed, cutoff, kind):
    randomizer = np.random.default_rng(seed)
    noise = randomizer.standard_normal(round(duration * SAMPLE_RATE))
    filter_sections = butter(4, cutoff, btype=kind, fs=SAMPLE_RATE, output="sos")
    return sosfilt(filter_sections, noise)


def add_burst(target, start, burst):
    offset = round(start * SAMPLE_RATE)
    if offset >= target.size:
        return
    length = min(burst.size, target.size - offset)
    target[offset : offset + length] += burst[:length]


def make_room_tone():
    duration = 12.0
    crossfade = 1.0
    source_duration = duration + crossfade
    time = timeline(source_duration)
    low_air = filtered_noise(source_duration, 101, 420, "lowpass") * 0.13
    high_air = filtered_noise(source_duration, 102, (900, 4_200), "bandpass") * 0.025
    hum = np.sin(math.tau * 55 * time) * 0.025 + np.sin(math.tau * 110 * time) * 0.009
    source = low_air + high_air + hum
    output_samples = round(duration * SAMPLE_RATE)
    crossfade_samples = round(crossfade * SAMPLE_RATE)
    blend = np.linspace(0.0, 1.0, crossfade_samples, endpoint=False)
    samples = source[:output_samples].copy()
    samples[:crossfade_samples] = (
        source[output_samples : output_samples + crossfade_samples] * (1.0 - blend)
        + source[:crossfade_samples] * blend
    )
    return samples


def make_tick():
    duration = 0.18
    time = timeline(duration)
    click = np.sin(math.tau * 2_250 * time) * np.exp(-time * 42)
    body = np.sin(math.tau * 520 * time) * np.exp(-time * 30) * 0.35
    return click + body


def make_drumroll():
    duration = 2.6
    time = timeline(duration)
    noise = filtered_noise(duration, 201, (110, 2_600), "bandpass")
    pulse_rate = np.linspace(13.0, 31.0, time.size)
    pulse_phase = math.tau * np.cumsum(pulse_rate) / SAMPLE_RATE
    pulses = np.maximum(0.0, np.sin(pulse_phase)) ** 5
    crescendo = np.linspace(0.18, 1.0, time.size) ** 1.4
    drum = np.sin(math.tau * 82 * time) * pulses * 0.35
    return fade((noise * pulses * 0.62 + drum) * crescendo, 0.03, 0.12)


def make_sting():
    duration = 1.2
    time = timeline(duration)
    chord = tone(duration, (196.0, 233.08, 293.66), release=0.55)
    shimmer = glide(duration, 1_450, 410, release=0.35) * np.exp(-time * 1.5) * 0.28
    impact = filtered_noise(duration, 301, 1_800, "lowpass") * np.exp(-time * 13) * 0.22
    return chord * 0.8 + shimmer + impact


def make_hit():
    duration = 0.8
    time = timeline(duration)
    chord = tone(duration, (523.25, 659.25, 783.99), release=0.34)
    sparkle = np.sin(math.tau * 1_568 * time) * np.exp(-time * 5) * 0.22
    return chord + sparkle


def make_miss():
    duration = 1.0
    low = glide(duration, 233.08, 116.54, release=0.25)
    shadow = glide(duration, 174.61, 87.31, release=0.25) * 0.62
    return low + shadow


def make_applause():
    duration = 2.8
    samples = filtered_noise(duration, 401, (380, 6_500), "bandpass") * 0.045
    randomizer = np.random.default_rng(402)
    for clap_time in sorted(randomizer.uniform(0.02, duration - 0.08, 82)):
        length = randomizer.uniform(0.025, 0.065)
        burst = filtered_noise(
            length, randomizer.integers(1, 1_000_000), (650, 7_800), "bandpass"
        )
        burst *= np.exp(-timeline(length) * randomizer.uniform(45, 70))
        add_burst(samples, clap_time, burst * randomizer.uniform(0.3, 0.72))
    crowd = np.linspace(0.65, 1.0, samples.size)
    return fade(samples * crowd, 0.05, 0.25)


def make_gasp():
    duration = 1.4
    time = timeline(duration)
    breath = filtered_noise(duration, 501, (500, 4_800), "bandpass")
    inhale = np.sin(np.linspace(0, math.pi, time.size)) ** 1.8
    voices = tone(duration, (196.0, 246.94, 293.66), release=0.45) * 0.28
    return fade(breath * inhale * 0.38 + voices, 0.08, 0.32)


def make_unlock():
    duration = 1.7
    samples = np.zeros(round(duration * SAMPLE_RATE), dtype=np.float64)
    for index, frequency in enumerate((392.0, 523.25, 659.25, 783.99)):
        note = tone(0.62, (frequency, frequency * 2), release=0.34)
        add_burst(samples, index * 0.26, note * (0.72 + index * 0.08))
    shimmer = filtered_noise(duration, 601, (2_200, 9_000), "bandpass") * np.linspace(
        0.0, 0.12, samples.size
    )
    return fade(samples + shimmer, 0.01, 0.28)


def make_curtain():
    duration = 1.6
    time = timeline(duration)
    cloth = filtered_noise(duration, 701, (90, 2_400), "bandpass")
    sweep = np.sin(np.linspace(0, math.pi, time.size)) ** 0.7
    samples = cloth * sweep * 0.48
    for start in (0.04, 1.35):
        thump_time = timeline(0.24)
        thump = np.sin(math.tau * 72 * thump_time) * np.exp(-thump_time * 18)
        add_burst(samples, start, thump * 0.38)
    return fade(samples, 0.02, 0.18)


def make_stamp():
    duration = 0.45
    time = timeline(duration)
    thud = np.sin(math.tau * 78 * time) * np.exp(-time * 22)
    snap = filtered_noise(duration, 801, 2_500, "lowpass") * np.exp(-time * 48) * 0.48
    return thud + snap


def normalize(samples):
    peak = float(np.max(np.abs(samples)))
    if peak == 0 or not np.isfinite(peak):
        raise RuntimeError("Generated silence or invalid samples")
    normalized = np.clip(samples * (TARGET_PEAK / peak), -1.0, 1.0)
    return np.round(normalized * np.iinfo(np.int16).max).astype(np.int16)


def encode_mp3(wav_path, mp3_path):
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(wav_path),
            "-map_metadata",
            "-1",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "96k",
            "-write_xing",
            "1",
            "-id3v2_version",
            "0",
            str(mp3_path),
        ],
        check=True,
    )


def measure_encoded(mp3_path, wav_path):
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(mp3_path),
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-codec:a",
            "pcm_s16le",
            str(wav_path),
        ],
        check=True,
    )
    sample_rate, samples = wavfile.read(wav_path)
    if sample_rate != SAMPLE_RATE or samples.ndim != 1:
        raise RuntimeError(f"Unexpected decoded format for {mp3_path.name}")

    decoded = samples.astype(np.float64) / 32768.0
    peak = float(np.max(np.abs(decoded)))
    return {
        "samples": decoded,
        "peakDbfs": round(20 * math.log10(peak), 3),
    }


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for stale in OUTPUT.glob("*.mp3"):
        stale.unlink()

    sounds = {
        "room_tone.mp3": make_room_tone(),
        "tick.mp3": make_tick(),
        "drumroll.mp3": make_drumroll(),
        "sting.mp3": make_sting(),
        "hit.mp3": make_hit(),
        "miss.mp3": make_miss(),
        "applause.mp3": make_applause(),
        "gasp.mp3": make_gasp(),
        "unlock.mp3": make_unlock(),
        "curtain.mp3": make_curtain(),
        "stamp.mp3": make_stamp(),
    }

    manifest_entries = []
    with tempfile.TemporaryDirectory(prefix="ghostlight-audio-") as temporary:
        temporary_path = Path(temporary)
        for filename, samples in sounds.items():
            wav_path = temporary_path / filename.replace(".mp3", ".wav")
            decoded_path = temporary_path / filename.replace(".mp3", "-decoded.wav")
            mp3_path = OUTPUT / filename
            wavfile.write(wav_path, SAMPLE_RATE, normalize(samples))
            encode_mp3(wav_path, mp3_path)
            measured = measure_encoded(mp3_path, decoded_path)
            decoded = measured.pop("samples")
            if decoded.size != samples.size:
                raise RuntimeError(
                    f"Gapless metadata mismatch for {filename}: "
                    f"expected {samples.size} samples, decoded {decoded.size}"
                )
            entry = {
                "file": filename,
                "durationSeconds": round(decoded.size / SAMPLE_RATE, 3),
                "decodedSamples": decoded.size,
                "sampleRate": SAMPLE_RATE,
                "channels": 1,
                **measured,
                "bytes": mp3_path.stat().st_size,
            }
            if filename == "room_tone.mp3":
                interior_deltas = np.abs(np.diff(decoded))
                boundary_delta = abs(float(decoded[-1] - decoded[0]))
                entry["loopBoundaryDeltaDbfs"] = round(
                    20 * math.log10(max(boundary_delta, 1 / 32768)), 3
                )
                entry["loopBoundaryP99Ratio"] = round(
                    boundary_delta / float(np.quantile(interior_deltas, 0.99)), 3
                )
            manifest_entries.append(entry)

    manifest = {
        "generator": "tools/audio/build_sounds.py",
        "sounds": manifest_entries,
        "totals": {"bytes": sum(sound["bytes"] for sound in manifest_entries)},
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps(manifest["totals"], indent=2))


if __name__ == "__main__":
    main()
