# voice-intent — sidecar GLiClass per il voice trigger

Il ponte decide da solo, con tre livelli, se un messaggio chiede una risposta vocale.
Questo processo serve i livelli 2 e 3 (classificatore). Il livello 1 (lessico) è dentro
il ponte e non richiede niente.

```
livello 1  lessico deterministico     0 ms      sempre        frasi salvate dall'agente
livello 2  gliclass-base v3.0        ~160 ms   Pi 5 ok      187M · 750 MB
livello 3  gliclass-large v3.0       ~540 ms   desktop/GPU  439M · 1,75 GB
```

Misure sul set di 40 frasi (22 positive in it/en/de/fr/es, 18 negative), i5-9300H, CPU:

| configurazione | accuratezza | latenza mediana |
|---|---|---|
| solo lessico (decide 21/40) | 100% su ciò che decide | 0 ms |
| lessico + base | 37/40 = 92,5% | 0 ms / 215 ms |
| lessico + large | **40/40 = 100%** | 0 ms / 582 ms |

Il lessico prende le frasi canoniche e blocca le trappole ("alza il volume della voce",
"la voce di X", "per iscritto"): è quello che fa passare large da 39/40 a 40/40.

## Installazione

```bash
python -m pip install gliclass "transformers>=4.48" torch
```

Se preferisci non toccare il python di sistema, installa altrove e passa `--deps`:

```bash
python -m pip install --target /opt/gliclass-deps gliclass "transformers>=4.48" torch
python server.py --model base --deps /opt/gliclass-deps
```

I pesi si scaricano al primo avvio da Hugging Face (`knowledgator/gliclass-base-v3.0`,
`knowledgator/gliclass-large-v3.0`); circa 40 s per il base e 90 s per il large su un
disco lento, poi restano in cache.

## Avvio

```bash
python server.py --model base  --port 8197            # Pi 5, portatile, mini-pc
python server.py --model large --port 8197            # macchina con GPU o CPU recente
python server.py --model /percorso/gliclass-base      # pesi già scaricati a mano
```

Endpoint:

```bash
curl -s http://127.0.0.1:8197/health
curl -s -X POST http://127.0.0.1:8197/classify \
     -H 'content-type: application/json' \
     -d '{"text":"rispondi con un vocale"}'
# {"voice": 0.9971, "ms": 158, "model": "base"}
```

`voice` è la probabilità che il messaggio chieda una risposta vocale. Il ponte decide
con due soglie: ≥ `PI_TELEGRAM_VOICE_HIGH` voce, ≤ `PI_TELEGRAM_VOICE_LOW` testo, in
mezzo incerto → testo.

## Come lo usa il ponte

```bash
export PI_TELEGRAM_VOICE_URL=http://127.0.0.1:8197     # accende il livello 2/3
export PI_TELEGRAM_VOICE_MODE=auto                     # off | phrases | auto
```

Senza `PI_TELEGRAM_VOICE_URL` il ponte resta alle sole frasi: nessun errore, nessun
timeout, e la funzione continua a servire su un Pi 4.

Se il sidecar non risponde per tre volte di fila, il ponte smette di chiamarlo per un
minuto e degrada al lessico — un gate non deve mai bloccare un messaggio.

## Servizio (Linux)

```ini
# /etc/systemd/system/voice-intent.service
[Unit]
Description=GLiClass voice intent sidecar
After=network.target

[Service]
ExecStart=/usr/bin/python3 /opt/pi-telegram-bridge/voice-intent/server.py --model base
Restart=always

[Install]
WantedBy=multi-user.target
```

## Verifica

```bash
python selftest.py --url http://127.0.0.1:8197
```

Stampa accuratezza, latenza HTTP ed elenca gli errori con il punteggio. Esce 1 se
qualcosa sbaglia, così può girare in un cron notturno come il self-test dell'audio.

## Note

- `classification_type='multi-label'` è obbligatorio: con `single-label` e una sola
  etichetta il punteggio è sempre 1.0 (softmax su una classe).
- Il modello è zero-shot: non c'è niente da addestrare. Se un giorno servisse più
  precisione, GLiClass si specializza con LoRA sui dati raccolti dal ponte.
- Testi oltre i 512 token vengono troncati: per messaggi lunghissimi conta la parte
  iniziale, quindi conviene non usare questo gate come unico segnale su documenti.
