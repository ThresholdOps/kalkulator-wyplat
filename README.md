# Kalkulator wypłat

Polskojęzyczny kalkulator wypłat netto, premii, potrąceń i miesięcznego budżetu. Wersja 0.5.0.

[Kalkulator na GitHub Pages](https://thresholdops.github.io/kalkulator-wyplat/)

Otwórz `index.html` w przeglądarce, aby użyć kalkulatora lokalnie. Cała aplikacja mieści się w tym pliku, a obliczenia wykonują się w przeglądarce. Kwoty pokazane na starcie są przykładowe. Wyniki mają charakter szacunkowy, a przyjęte założenia znajdziesz pod wynikiem.

Plan zapisuje się automatycznie w tej przeglądarce na tym urządzeniu i wraca po odświeżeniu strony. Zapis obejmuje wynagrodzenie i jego zmiany, premie, potrącenia, KZP oraz ustawienia budżetu i rezerwy. Przycisk „Usuń zapisany plan” pozwala wrócić do danych przykładowych.

Testy regresyjne: `node --test tests/regressions.cjs` (Node.js, bez dodatkowych zależności).
