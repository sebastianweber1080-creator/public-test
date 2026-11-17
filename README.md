# ⛽ Spritpreise in der Nähe

Web-App (PWA), die die aktuellen Preise für **Super E5, Super E10 und Diesel** aller Tankstellen in deiner Umgebung anzeigt –
live aus der Markttransparenzstelle für Kraftstoffe (MTS-K) über die kostenlose [Tankerkönig-API](https://creativecommons.tankerkoenig.de).

## Funktionen
- Standort per GPS oder Suche nach Ort/PLZ (OpenStreetMap/Nominatim)
- Umkreis 2–25 km, Sortierung nach Preis oder Entfernung, Filter „nur geöffnet“
- Farbliche Markierung günstig / mittel / teuer, alle drei Sorten pro Tankstelle
- Automatische Aktualisierung (alle 5 oder 10 Minuten) und beim Zurückkehren in die App
- Route (Google Maps) und Karte (OpenStreetMap) pro Tankstelle
- Installierbar auf dem Handy („Zum Startbildschirm hinzufügen“), Hell-/Dunkelmodus

## Einrichtung
1. Kostenlosen API-Key holen: <https://onboarding.tankerkoenig.de>
2. App öffnen, auf ⚙️ tippen und den Key eintragen (wird nur lokal im Browser gespeichert).

## Starten
Reine statische Dateien, kein Build nötig:
```bash
python3 -m http.server 8000   # dann http://localhost:8000 öffnen
```
Für GPS auf dem Handy muss die Seite über **HTTPS** laufen – am einfachsten über GitHub Pages
(Settings → Pages → Branch auswählen).

## Hinweise
- Die MTS-K-Daten gelten für Deutschland. Preise werden von den Tankstellen innerhalb weniger Minuten gemeldet.
- Tankerkönig bittet, nicht öfter als alle 5 Minuten automatisch abzufragen – das ist in der App so voreingestellt.
- Daten: Tankerkönig / MTS-K, Lizenz CC BY 4.0.
