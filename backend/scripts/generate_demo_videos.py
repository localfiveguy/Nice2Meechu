"""One-shot demo video generator using Sora 2 via Emergent LLM key.

Generates 20 short (4-second) vertical lifestyle intro clips for demo users,
distributed by population rank across the top-12 cities supported by the
Change Location screen. Each clip is just B-roll — no lip-sync — so audio
quirks don't matter; the transcript text is overlaid by the frontend.

Run:  cd /app/backend && python3 -u scripts/generate_demo_videos.py
Idempotent: skips clips whose file already exists.
"""
from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

from emergentintegrations.llm.openai.video_generation import OpenAIVideoGeneration  # noqa: E402

OUT_DIR = ROOT / "videos"
OUT_DIR.mkdir(parents=True, exist_ok=True)
META_PATH = OUT_DIR / "demo_meta.json"

# 12 cities, ranked by approximate metro population. Demo count = (13 - rank),
# so #1 city gets 12 demos, #2 → 11, …, #12 → 1.  Total = 78.
CITY_PLAN = [
    ("Tokyo",        35.6762, 139.6503, "ja"),   # rank 1  → 12 demos
    ("São Paulo",   -23.5505, -46.6333, "pt"),   # rank 2  → 11 demos
    ("Mumbai",       19.0760,  72.8777, "hi"),   # rank 3  → 10 demos
    ("New York",     40.7128, -74.0060, "en"),   # rank 4  →  9 demos
    ("Lagos",         6.5244,   3.3792, "en"),   # rank 5  →  8 demos
    ("Los Angeles",  34.0522,-118.2437, "en"),   # rank 6  →  7 demos
    ("Paris",        48.8566,   2.3522, "fr"),   # rank 7  →  6 demos
    ("London",       51.5074,  -0.1278, "en"),   # rank 8  →  5 demos
    ("Toronto",      43.6532, -79.3832, "en"),   # rank 9  →  4 demos
    ("Madrid",       40.4168,  -3.7038, "es"),   # rank 10 →  3 demos
    ("Sydney",      -33.8688, 151.2093, "en"),   # rank 11 →  2 demos
    ("Berlin",       52.5200,  13.4050, "de"),   # rank 12 →  1 demo
]

VIBES_BY_CITY = {
    "Tokyo":       ["neon-lit ramen alley", "Shibuya street fashion", "Akihabara arcade", "Harajuku boutique", "Yanaka temple lane", "Shimokitazawa cafe", "Tsukiji morning market", "Roppongi rooftop", "Kichijoji park", "Asakusa lantern street", "Daikanyama bookshop", "Nakameguro cherry blossom"],
    "São Paulo":   ["bossa-nova rooftop", "skate park at dusk", "Vila Madalena cafe", "Liberdade lantern alley", "Avenida Paulista mural", "Pinheiros market", "Ibirapuera park bench", "Higienópolis cafe", "Beco do Batman graffiti", "Mercadão fruit stand", "Jardins boutique"],
    "Mumbai":      ["Marine Drive sunset", "Bandra art lane", "Colaba cafe", "Khar mural wall", "Juhu beach evening", "Versova fishing dock", "Powai rooftop", "Worli sea-link view", "Lower Parel rooftop bar", "Andheri street food stall"],
    "New York":    ["Brooklyn coffee shop", "rooftop golden hour", "Williamsburg vinyl shop", "DUMBO cobblestone", "East Village dive bar", "Central Park bench", "Lower East Side bodega", "Bushwick mural", "SoHo cafe"],
    "Lagos":       ["Lekki beach vibe", "art gallery opening", "Ikoyi rooftop sunset", "Surulere mural lane", "Victoria Island cafe", "Yaba print studio", "Lekki pier walk", "Ajah waterfront"],
    "Los Angeles": ["Venice Beach skate", "rooftop pool at dusk", "Echo Park sunset", "Silver Lake cafe", "Abbot Kinney boutique", "Griffith Park trail", "Mar Vista farmers market"],
    "Paris":       ["Montmartre cobblestones", "Canal Saint-Martin bench", "Le Marais cafe", "Belleville mural", "Pigalle record store", "Buttes-Chaumont park"],
    "London":      ["Shoreditch street art", "Camden market stall", "South Bank skate spot", "Notting Hill mews", "Brick Lane bagel shop"],
    "Toronto":     ["Kensington Market", "Queen West cafe", "Distillery district", "High Park trail"],
    "Madrid":      ["Malasaña tapas bar", "Retiro park bench", "Lavapiés mural"],
    "Sydney":      ["Bondi Beach morning", "Newtown laneway"],
    "Berlin":      ["Kreuzberg vinyl shop"],
}

# Popular first names by city (mix of native + international, cycled per city).
NAMES_BY_CITY = {
    "Tokyo":       ["Yui", "Haruto", "Sakura", "Riku", "Aoi", "Sota", "Mei", "Hinata", "Kazuki", "Rin", "Ren", "Hana"],
    "São Paulo":   ["Lucas", "Sofia", "Mateus", "Helena", "Pedro", "Alice", "Davi", "Manuela", "Gabriel", "Laura", "Arthur"],
    "Mumbai":      ["Aarav", "Ananya", "Vihaan", "Diya", "Aditya", "Saanvi", "Ishaan", "Aanya", "Reyansh", "Myra"],
    "New York":    ["Olivia", "Liam", "Emma", "Noah", "Ava", "Ethan", "Mia", "Lucas", "Sophia"],
    "Lagos":       ["Chinedu", "Adaeze", "Tunde", "Ngozi", "Oluwaseun", "Folake", "Emeka", "Chiamaka"],
    "Los Angeles": ["Sofia", "Diego", "Camila", "Mateo", "Isabella", "Lucas", "Valentina"],
    "Paris":       ["Léa", "Hugo", "Emma", "Louis", "Jade", "Gabriel"],
    "London":      ["Oliver", "Amelia", "Harry", "Mia", "Jack"],
    "Toronto":     ["Ethan", "Olivia", "Noah", "Emma"],
    "Madrid":      ["Lucía", "Hugo", "Sofía"],
    "Sydney":      ["Charlotte", "Oliver"],
    "Berlin":      ["Emilia"],
}

# Transcript copy per language (kept short, friendly, ~3 sec read).
TRANSCRIPTS = {
    "en": [
        "Hey, I'm new here. Coffee crawl this weekend?",
        "Just moved in. Show me your favourite spot in town.",
        "Studio nights and ramen mornings. Tag along?",
        "Looking for someone to explore hidden parks with.",
        "Hi! Vinyl, art, slow walks. You in?",
        "Quiet bookshops and loud dinners. My kind of weekend.",
        "Trying every taco truck in town. Backup needed.",
        "Beach mornings, art nights. Find me at golden hour.",
        "Brunch detective. Lead me to the secret spots.",
        "Live music or live theater — let's pick one tonight.",
        "Skate, sketch, snack. Slide into my orbit.",
        "Sunday walks and used bookstores. Plus one wanted.",
    ],
    "es": [
        "Hola! Nueva en la ciudad. ¿Tapas conmigo este finde?",
        "Buscando alguien para descubrir Madrid lentamente.",
        "Café, libros, paseos. ¿Te apuntas?",
    ],
    "pt": [
        "Oi, gente! Acabei de chegar. Bora um café?",
        "Procurando alguém pra explorar a cidade comigo.",
        "Sou nova aqui. Me mostra seu lugar favorito?",
        "Sambão e samba leve. Procurando companhia.",
        "Café especial, livros antigos, conversa boa.",
        "Vamos perder um sábado caminhando pelo centro?",
        "Adoro feirinha de domingo. Você também?",
        "Pôr-do-sol no Minhocão, alguém topa?",
        "Tô caçando o melhor pastel da cidade.",
        "Bossa, jazz, e silêncio. Procurando alguém quieto.",
        "Me chama pra um rolê tranquilo.",
    ],
    "ja": [
        "はじめまして。今週末カフェ行きませんか？",
        "新しい街、誰か案内してください！",
        "夜のラーメン、付き合ってくれる人募集中。",
        "古本屋巡り、好きな人いますか？",
        "ジャズ喫茶でゆっくり話そう。",
        "週末は朝の散歩。一緒にどう？",
        "美術館デート、誘って下さい。",
        "下北沢の小さなお店、好きです。",
        "東京タワーまで歩いて行ってみない？",
        "甘いもの巡り、相棒探してます。",
        "夜風と缶ビール、それだけでいい。",
        "一緒にゆっくりした時間を過ごしませんか。",
    ],
    "fr": [
        "Salut ! Nouvelle ici. Tu connais un bon café tranquille ?",
        "Cherche un binôme pour les balades du dimanche.",
        "Cinéma d'art, vin nature, longues discussions.",
        "Je collectionne les terrasses cachées.",
        "On va à Belleville voir le coucher de soleil ?",
        "Brocantes le weekend, ça te tente ?",
    ],
    "de": [
        "Hey! Neu in der Stadt. Lust auf einen Spaziergang?",
    ],
    "hi": [
        "नमस्ते! शहर में नई हूँ। कॉफ़ी पर मिलें?",
        "अच्छी जगहें बताओ, चलते हैं साथ में।",
        "किताबें, संगीत, और बातें। साथ चलोगे?",
        "मरीन ड्राइव पर शाम बिताते हैं?",
        "नई दोस्ती के लिए तैयार हूँ।",
        "स्ट्रीट फूड लवर। साथी चाहिए।",
        "इंडी म्यूज़िक और चाय। मेरा वीकेंड।",
        "बारिश में चाय, बस यही चाहिए।",
        "किसी के साथ धीरे-धीरे शहर देखना है।",
        "कला, कविता, कैफे। मिलेंगे?",
    ],
}

AVATARS = ["🌙", "✨", "🔥", "🌊", "🌸", "🪐", "🍵", "🌶️", "🎧", "🛹"]
GENDERS = ["young woman", "young man", "non-binary person in their 20s"]
HAIRS = ["short dark hair", "long wavy hair", "buzz cut", "curly afro", "shoulder-length brown hair", "platinum bob"]

# Deterministic-ish so re-runs don't re-roll personas.
import random
_rng = random.Random(2026)


def build_personas():
    personas = []
    name_idx = {k: 0 for k in NAMES_BY_CITY}
    for rank, (city, lat, lng, lang) in enumerate(CITY_PLAN, start=1):
        count = 13 - rank  # rank 1 -> 12, rank 12 -> 1
        vibes = VIBES_BY_CITY[city]
        names = NAMES_BY_CITY[city]
        for j in range(count):
            idx = len(personas)
            gender = _rng.choice(GENDERS)
            hair = _rng.choice(HAIRS)
            scene = vibes[j % len(vibes)]
            name = names[name_idx[city] % len(names)]
            name_idx[city] += 1
            transcript = f"Hi! My name is {name}! I live in {city}! Nice to meet you!"
            age = _rng.randint(22, 33)
            prompt = (
                f"A 4-second vertical selfie-style intro video for a social app. "
                f"A {gender}, around {age} years old, with {hair}, in {scene}, {city}. "
                f"They look directly into the camera and enthusiastically say the line "
                f'"Hi! My name is {name}! I live in {city}! Nice to meet you!" in a warm, friendly, energetic voice. '
                f"Their lips move naturally with each word and they smile. Real human voice, conversational tone, no music or background voices. "
                f"Soft natural lighting, shallow depth of field, gentle subtle motion (hair drift, ambient sway). "
                f"Photo-realistic, looks like a real iPhone selfie video. No text overlay, no logo."
            )
            personas.append({
                "idx": idx,
                "city": city,
                "city_rank": rank,
                "lat": lat,
                "lng": lng,
                "lang": lang,
                "age": age,
                "gender": gender,
                "name": name,
                "transcript": transcript,
                "prompt": prompt,
                "avatar_emoji": AVATARS[idx % len(AVATARS)],
                "file": f"demo_{idx:02d}.mp4",
            })
    return personas


def reuse_existing_renders(personas):
    """If we have previously-rendered MP4s (from the old 20-plan), rename each
    one to the first available NEW slot whose city matches — so we don't pay
    to re-render. Reads the previous demo_meta.json next to the videos.

    Returns the number of files preserved.
    """
    if not META_PATH.exists():
        return 0
    try:
        old_meta = json.loads(META_PATH.read_text())
    except Exception:
        return 0

    # Map: old filename -> city of that render
    by_file = {}
    for o in old_meta:
        f = OUT_DIR / o["file"]
        if f.exists() and f.stat().st_size > 50_000:
            by_file[f] = o["city"]

    if not by_file:
        return 0

    # Available slots per city, in order
    slots_by_city = {}
    for p in personas:
        slots_by_city.setdefault(p["city"], []).append(p)

    # Move existing files OUT of the way first (avoid clobbering during rename)
    tmp_dir = OUT_DIR / "_tmp_remap"
    tmp_dir.mkdir(exist_ok=True)
    for f in list(by_file):
        tmp = tmp_dir / f.name
        f.rename(tmp)
        by_file[tmp] = by_file.pop(f)

    preserved = 0
    for tmp_path, city in by_file.items():
        slots = slots_by_city.get(city, [])
        if not slots:
            print(f"[drop ] {tmp_path.name} (city '{city}' not in new plan)", flush=True)
            tmp_path.unlink(missing_ok=True)
            continue
        slot = slots.pop(0)  # take the first unclaimed slot for this city
        dst = OUT_DIR / slot["file"]
        tmp_path.rename(dst)
        print(f"[reuse] {tmp_path.name} → {slot['file']} ({city})", flush=True)
        preserved += 1

    try:
        tmp_dir.rmdir()
    except OSError:
        pass
    return preserved


def render_one(p, model="sora-2", size="720x1280", duration=4):
    out = OUT_DIR / p["file"]
    if out.exists() and out.stat().st_size > 50_000:
        print(f"[skip] {p['file']} already exists ({out.stat().st_size//1024} KB)", flush=True)
        return p
    print(f"[start] {p['file']}  city={p['city']}  '{p['prompt'][:80]}…'", flush=True)
    t0 = time.time()
    try:
        gen = OpenAIVideoGeneration(api_key=os.environ["EMERGENT_LLM_KEY"])
        video_bytes = gen.text_to_video(
            prompt=p["prompt"], model=model, size=size, duration=duration, max_wait_time=600,
        )
        if not video_bytes:
            print(f"[FAIL ] {p['file']} returned no bytes", flush=True)
            return None
        gen.save_video(video_bytes, str(out))
        dt = int(time.time() - t0)
        print(f"[done ] {p['file']} ({out.stat().st_size//1024} KB, {dt}s)", flush=True)
        return p
    except Exception as exc:
        print(f"[FAIL ] {p['file']}  {exc.__class__.__name__}: {exc}", flush=True)
        return None


def main():
    personas = build_personas()
    print(f"Planning {len(personas)} demo videos across {len(CITY_PLAN)} cities", flush=True)

    # Preserve any already-rendered videos from a previous run by remapping
    # them to the first matching-city slot in the new plan.
    preserved = reuse_existing_renders(personas)
    if preserved:
        print(f"Preserved {preserved} previously-rendered videos", flush=True)

    META_PATH.write_text(json.dumps(personas, indent=2, ensure_ascii=False))
    print(f"Wrote persona metadata → {META_PATH}", flush=True)

    # Run with bounded concurrency to avoid overwhelming the API.
    concurrency = int(os.environ.get("SORA_CONCURRENCY", "4"))
    rendered = []
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futures = {ex.submit(render_one, p): p for p in personas}
        for fut in as_completed(futures):
            r = fut.result()
            if r is not None:
                rendered.append(r)

    print(f"\nFinished: {len(rendered)}/{len(personas)} videos succeeded", flush=True)
    if rendered:
        META_PATH.write_text(json.dumps(personas, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
