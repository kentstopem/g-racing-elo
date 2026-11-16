#!/usr/bin/env python3
"""Erzeugt die Sprach-Schnipsel für G!RP mit den kostenlosen Microsoft-Edge-Neural-Stimmen (edge-tts).

Modi:
  samples  – je Stimme eine Hörprobe nach voice-samples/ (wird nicht eingecheckt)
  phrases  – alle festen Ansagen aus phrases.json neu erzeugen
  drivers  – Fahrernamen erzeugen, die fehlen oder deren Aussprache sich geändert hat
  driver   – einen Fahrer neu erzeugen (--driver <id>)
  all      – phrases + alle Fahrernamen neu

Ausgabe: assets/voice/phrases/<key>.mp3, assets/voice/drivers/<id>.mp3, assets/voice/manifest.json
Fahrer kommen öffentlich lesbar aus Firestore; gesprochen wird `pronunciation`, sonst `name`.
"""
import argparse, asyncio, json, os, sys, urllib.request
import edge_tts

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'voice')
MANIFEST = os.path.join(OUT, 'manifest.json')
PROJECT, API_KEY = 'g-racing-elo', 'AIzaSyCgpQQQ4OW_HGLqCYmn8WRwclUW8DXqJC0'

SAMPLE_VOICES = [
    'de-DE-ConradNeural', 'de-DE-KillianNeural', 'de-DE-FlorianMultilingualNeural',
    'de-DE-KatjaNeural', 'de-DE-AmalaNeural', 'de-DE-SeraphinaMultilingualNeural',
    'de-AT-JonasNeural', 'de-AT-IngridNeural', 'de-CH-JanNeural', 'de-CH-LeniNeural',
]
SAMPLE_TEXT = 'Drei. Zwei. Eins. Los! … {name}: Neuer Streckenrekord! … Tank fast leer, bitte an die Box!'


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def fetch_drivers():
    url = (f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/drivers'
           f'?pageSize=300&key={API_KEY}')
    with urllib.request.urlopen(url, timeout=30) as r:
        docs = json.load(r).get('documents', [])
    out = []
    for d in docs:
        f = {k: next(iter(v.values())) for k, v in d.get('fields', {}).items()}
        name = (f.get('name') or '').strip()
        if not name:
            continue
        spoken = (f.get('pronunciation') or '').strip() or name
        out.append({'id': d['name'].rsplit('/', 1)[-1], 'name': name, 'text': spoken})
    return out


async def say(text, path, voice, rate, pitch):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    await edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(path)
    print(f'  ✓ {os.path.relpath(path, ROOT)}  «{text}»')


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['samples', 'phrases', 'drivers', 'driver', 'all'])
    ap.add_argument('--voice', default='')
    ap.add_argument('--rate', default='')
    ap.add_argument('--pitch', default='')
    ap.add_argument('--driver', default='')
    a = ap.parse_args()

    man = load_json(MANIFEST, {'voice': 'de-DE-ConradNeural', 'rate': '+0%', 'pitch': '+0Hz', 'phrases': {}, 'drivers': {}})
    voice_changed = bool(a.voice) and a.voice != man['voice']
    man['voice'] = a.voice or man['voice']
    man['rate'] = a.rate or man.get('rate', '+0%')
    man['pitch'] = a.pitch or man.get('pitch', '+0Hz')
    v, rate, pitch = man['voice'], man['rate'], man['pitch']

    if a.mode == 'samples':
        drivers = fetch_drivers()
        name = next((d['text'] for d in drivers if d['name'] == 'Tris'), 'Tristan')
        avail = [x['ShortName'] for x in await edge_tts.list_voices() if x['Locale'].startswith('de-')]
        print('Verfügbare deutsche Stimmen:', ', '.join(avail))
        for voice in ([a.voice] if a.voice else avail):
            await say(SAMPLE_TEXT.format(name=name), os.path.join(ROOT, 'voice-samples', f'{voice}.mp3'), voice, rate, pitch)
        return

    if a.mode in ('phrases', 'all') or voice_changed:
        phrases = {k: t for k, t in load_json(os.path.join(os.path.dirname(__file__), 'phrases.json'), {}).items() if not k.startswith('_')}
        man['phrases'] = {}
        for key, text in phrases.items():
            await say(text, os.path.join(OUT, 'phrases', f'{key}.mp3'), v, rate, pitch)
            man['phrases'][key] = text

    if a.mode in ('drivers', 'driver', 'all') or voice_changed:
        drivers = fetch_drivers()
        ids = {d['id'] for d in drivers}
        for d in drivers:
            path = os.path.join(OUT, 'drivers', f"{d['id']}.mp3")
            want = (a.mode == 'all' or voice_changed or (a.mode == 'driver' and d['id'] == a.driver)
                    or (a.mode == 'drivers' and (man['drivers'].get(d['id'], {}).get('text') != d['text'] or not os.path.exists(path))))
            if want:
                await say(d['text'], path, v, rate, pitch)
                man['drivers'][d['id']] = {'name': d['name'], 'text': d['text']}
        if a.mode == 'driver' and a.driver not in ids:
            sys.exit(f'Fahrer {a.driver} nicht gefunden')
        for gone in [i for i in man['drivers'] if i not in ids]:   # gelöschte Fahrer aufräumen
            man['drivers'].pop(gone)
            p = os.path.join(OUT, 'drivers', f'{gone}.mp3')
            if os.path.exists(p):
                os.remove(p)

    os.makedirs(OUT, exist_ok=True)
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(man, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')


asyncio.run(main())
