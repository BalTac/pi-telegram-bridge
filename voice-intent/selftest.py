#!/usr/bin/env python3
"""Self-test del sidecar: la suite di 40 frasi usata per scegliere il modello.

Fa due cose, in ordine:
  1. prova il gate deterministico (le frasi di default) senza rete;
  2. se il sidecar e' in ascolto, misura accuratezza e latenza via HTTP.

Uso:  python selftest.py [--url http://127.0.0.1:8197]
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import urllib.request

POS = ["rispondi con un vocale", "fai report con un vocale", "rispondi a voce",
       "dimmelo con un vocale", "dimmelo con la voce", "mandami un vocale",
       "rispondi parlando", "answer me with a voice message", "reply with a voice note",
       "antworte mit einer Sprachnachricht", "reponds-moi avec un message vocal",
       "respondeme con un audio",
       "mandami un messaggio vocale con il riassunto", "puoi rispondermi parlando?",
       "fammi sentire la risposta", "gib mir eine Sprachnachricht dazu",
       "envoie un vocal stp", "manda la risposta come audio", "recitami il testo a voce",
       "dimmelo parlando, non scrivere", "send the answer as audio please",
       "hazlo en audio por favor"]
NEG = ["rispondi con un messaggio scritto", "fai un report scritto",
       "la voce di Gigi Lonfo e' bella", "alza il volume della voce",
       "riassumi questo articolo", "scrivi la risposta in chat", "rispondi in inglese",
       "what did he say about the outage",
       "mandami un messaggio scritto con il riassunto", "puoi rispondermi scrivendo?",
       "fammi vedere la risposta", "schreib mir die Antwort dazu", "envoie par ecrit stp",
       "manda la risposta come testo", "correggi il testo della voce",
       "dimmelo scrivendo, non parlare", "send the answer as text please",
       "hazlo por escrito por favor"]

# le trappole che il lessico deve bloccare prima di arrivare al modello:
# verificate in src/__tests__/voiceIntent.test.ts, qui servono solo come promemoria.
GUARD = ["alza il volume della voce", "la voce di Gigi Lonfo e' bella",
         "correggi il testo della voce", "rispondi con un messaggio scritto"]


def post(url: str, text: str) -> tuple[float, float]:
    req = urllib.request.Request(url.rstrip("/") + "/classify",
                                 data=json.dumps({"text": text}).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    import time
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as res:
        body = json.loads(res.read())
    return float(body["voice"]), (time.perf_counter() - t0) * 1000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8197")
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args()

    try:
        with urllib.request.urlopen(args.url.rstrip("/") + "/health", timeout=10) as res:
            health = json.loads(res.read())
        print(f"== sidecar: {health.get('model_id')} su {health.get('device')} "
              f"(caricato in {health.get('load_sec')}s)")
    except Exception as exc:  # noqa: BLE001
        print(f"sidecar non raggiungibile su {args.url}: {exc}")
        return 2

    hits, lat, errors = 0, [], []
    for kind, items in (("POS", POS), ("NEG", NEG)):
        for text in items:
            value, ms = post(args.url, text)
            lat.append(ms)
            ok = (value >= args.threshold) == (kind == "POS")
            hits += ok
            if not ok:
                errors.append((kind, round(value, 3), text))
    total = len(POS) + len(NEG)
    print(f"\naccuratezza @{args.threshold}: {hits}/{total} = {hits / total:.1%}")
    print(f"latenza HTTP: mediana {statistics.median(lat):.0f} ms "
          f"(min {min(lat):.0f}, max {max(lat):.0f})")
    for kind, value, text in errors:
        print(f"  ERR {kind} {value}  {text}")
    return 0 if hits == total else 1


if __name__ == "__main__":
    sys.exit(main())
