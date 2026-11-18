# Kalkulator wypłat

Polskojęzyczny kalkulator wypłat netto, premii, potrąceń i miesięcznego budżetu. Wersja 0.5.1.

[Kalkulator na GitHub Pages](https://thresholdops.github.io/kalkulator-wyplat/)

Otwórz `index.html` w przeglądarce, aby użyć kalkulatora lokalnie. Cała aplikacja mieści się w tym pliku, a obliczenia wykonują się w przeglądarce. Kwoty pokazane na starcie są przykładowe. Wyniki mają charakter szacunkowy, a przyjęte założenia znajdziesz pod wynikiem.

Plan zapisuje się automatycznie w tej przeglądarce na tym urządzeniu i wraca po odświeżeniu strony. Zapis obejmuje wynagrodzenie i jego zmiany, premie, potrącenia, KZP oraz ustawienia budżetu i rezerwy. Przycisk „Usuń zapisany plan” pozwala wrócić do danych przykładowych.

Testy regresyjne: `node --test tests/regressions.cjs` (Node.js, bez dodatkowych zależności).

Testy jednostkowe wykonują funkcje z pliku aplikacji w izolacji. Obejmują przepływy i zapis oraz stałe kotwice liczbowe naliczeń. Dla 10 000 zł brutto, KUP 250 zł, pomniejszenia zaliczki 300 zł, pełnych składek i dochodu poniżej progu: składki społeczne i zdrowotna 2 147,61 zł, PIT 705 zł, netto 7 147,39 zł. Inne kotwice obejmują miesiąc przekroczenia progu, stawkę 32%, limit składek, dwie wypłaty w miesiącu i przełom lat. Oczekiwane kwoty są zapisane jako liczby, bez wyliczania ich funkcjami aplikacji.

Te testy nie uruchamiają strony ani prawdziwej pamięci przeglądarki. Działanie formularzy i odtwarzania danych sprawdzamy dodatkowo na opublikowanej stronie. Kalkulator obejmuje potrącenia związane z wypłatą; wydatki domowe pozostają poza zakresem.

