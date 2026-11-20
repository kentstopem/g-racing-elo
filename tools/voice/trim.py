#!/usr/bin/env python3
"""Schneidet die Stille am Anfang und Ende von Sprach-Schnipseln ab (braucht ffmpeg).

Die TTS-Stimmen hängen hinten 0,5–1,3 s Stille an (vorne ~0,2 s). Das macht Ansagen aus mehreren
Teilen ([Name] + Ansage) zäh und den Countdown träge. Ein kleiner Rest bleibt stehen, damit kein
Laut abgeschnitten wird. Schon gekürzte Dateien werden nicht noch einmal neu kodiert.

  python tools/voice/trim.py assets/voice          # alle MP3s darunter
  python tools/voice/trim.py datei.mp3 …
"""
import os, re, subprocess, sys

THRESH = '-50dB'   # leiser gilt als Stille
LEAD = 0.01        # so viel Stille bleibt vorne stehen (s)
TAIL = 0.04        # … und hinten (s), damit der Ausklang nicht abgeschnitten wird
MIN_CUT = 0.03     # weniger abzuschneiden lohnt keine Neukodierung


def bounds(path):
    """(Dauer, Sprachbeginn, Sprachende) in Sekunden."""
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', f'silencedetect=n={THRESH}:d=0.05',
                          '-f', 'null', '-'], capture_output=True, text=True).stderr
    m = re.search(r'Duration: (\d+):(\d+):([\d.]+)', out)
    dur = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
    starts = [float(x) for x in re.findall(r'silence_start: ([\d.]+)', out)]
    ends = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', out)]
    begin = ends[0] if starts and starts[0] < 0.01 and ends else 0.0
    # letzte Stille, die bis zum Dateiende reicht (silence_end fehlt dann oder liegt am Ende)
    end = dur
    if starts and starts[-1] > begin:
        last_end = ends[len(starts) - 1] if len(ends) >= len(starts) else dur
        if last_end >= dur - 0.03:
            end = starts[-1]
    return dur, begin, end


def trim(path):
    """Kürzt die Datei an Ort und Stelle. Gibt die eingesparten Sekunden zurück (0 = unverändert)."""
    dur, begin, end = bounds(path)
    if end <= begin:   # nur Stille? lieber nichts anfassen
        return 0.0
    a, b = max(0.0, begin - LEAD), min(dur, end + TAIL)
    if a < MIN_CUT and dur - b < MIN_CUT:
        return 0.0
    tmp = path + '.tmp.mp3'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-af', f'atrim={a:.3f}:{b:.3f}',
                    '-map_metadata', '-1', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '48k', tmp], check=True)
    os.replace(tmp, path)
    return a + (dur - b)


def main(args):
    files = []
    for p in args or ['assets/voice']:
        if os.path.isdir(p):
            files += [os.path.join(r, f) for r, _, fs in os.walk(p) for f in fs if f.endswith('.mp3')]
        else:
            files.append(p)
    total = 0.0
    for f in sorted(files):
        cut = trim(f)
        total += cut
        print(f'  {"✂" if cut else "·"} {f}  {f"−{cut:.2f} s" if cut else "schon kurz"}')
    print(f'{len(files)} Dateien, zusammen {total:.1f} s Stille entfernt')


if __name__ == '__main__':
    main(sys.argv[1:])
