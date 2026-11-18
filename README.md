# Kalkulator wypłat

Polskojęzyczny kalkulator wypłat netto, premii, potrąceń i miesięcznego budżetu. Wersja 0.6.1.

[Kalkulator na GitHub Pages](https://thresholdops.github.io/kalkulator-wyplat/)

Otwórz `index.html` w przeglądarce, aby użyć kalkulatora lokalnie. Cała aplikacja mieści się w tym pliku, a obliczenia wykonują się w przeglądarce. Kwoty pokazane na starcie są przykładowe. Wyniki mają charakter szacunkowy, a przyjęte założenia znajdziesz pod wynikiem.

Plan zapisuje się automatycznie w tej przeglądarce na tym urządzeniu i wraca po odświeżeniu strony. Zapis obejmuje wynagrodzenie i jego zmiany, premie, potrącenia, KZP oraz ustawienia budżetu i rezerwy. Przycisk „Usuń zapisany plan” pozwala wrócić do danych przykładowych.

Testy regresyjne: `node --test tests/regressions.cjs` (Node.js, bez dodatkowych zależności).

Testy jednostkowe wykonują funkcje z pliku aplikacji w izolacji. Obejmują przepływy i zapis oraz stałe kotwice liczbowe naliczeń. Dla 10 000 zł brutto, KUP 250 zł, pomniejszenia zaliczki 300 zł, pełnych składek i dochodu poniżej progu: składki społeczne i zdrowotna 2 147,61 zł, PIT 705 zł, netto 7 147,39 zł. Inne kotwice obejmują miesiąc przekroczenia progu, stawkę 32%, limit składek, dwie wypłaty w miesiącu i przełom lat. Oczekiwane kwoty są zapisane jako liczby, bez wyliczania ich funkcjami aplikacji.

Te testy nie uruchamiają strony ani prawdziwej pamięci przeglądarki. Działanie formularzy i odtwarzania danych sprawdzamy dodatkowo na opublikowanej stronie. Kalkulator obejmuje potrącenia związane z wypłatą; wydatki domowe pozostają poza zakresem.

W ustawieniach „Plan i rezerwa” można wybrać skalę PIT dla dat wypłat w 2027 r. Domyślny wariant „Jak w 2026 r.” stosuje 12% do 120 000 zł oraz 32% od nadwyżki. „Wariant 3293” jest oznaczoną symulacją: 12% do 130 000 zł, 24% od nadwyżki do 150 000 zł i 32% powyżej 150 000 zł. Podział działa także wtedy, gdy jedna wypłata przekracza oba progi. Wypłaty z datą w 2026 r., miesięczne pomniejszenie zaliczki, składki i mechanizm ograniczenia zdrowotnej zachowują swoje zasady.

Wybrany wariant zapisuje się z planem i jest widoczny w założeniach oraz podpisie tabeli obejmującej 2027 r. Zapis z wersji 0.5.1 bez nowego pola wczytuje się jako „Jak w 2026 r.” z zachowaniem wszystkich wcześniejszych danych. Nieznane wartości nowego pola są odrzucane.

Testy obejmują oba warianty, stałe kwoty dla nowych progów, przekroczenie dwóch progów jedną wypłatą, współdzielone naliczenia miesiąca, faktyczny rok przelewu, maksimum dla całego 2027 r., limit składek 300 990 zł i odtwarzanie starszego zapisu. Dla przykładowej pensji 14 500 zł brutto maksimum 2027 wynosi 9 762,38 zł w wariancie domyślnym i 10 043,47 zł w symulacji.

Źródła parametrów: [skala 2026 — podatki.gov.pl](https://podatki.gov.pl/podatki-osobiste/pit/informacje-podstawowe/co-jest-opodatkowane/dochody-z-pracy), [progi wariantu 3293 — materiał sejmowy, art. 1](https://api.sejm.gov.pl/sejm/term10/prints/3323/3323.pdf), [limit składek 2027 — Monitor Polski, poz. 1098](https://www.dziennikustaw.gov.pl/M2026000109801.pdf). Etykieta symulacji opisuje wybrany scenariusz obliczeń; aplikacja nie aktualizuje samoczynnie statusu legislacyjnego ani wariantu domyślnego.

Wersja 0.6.1 porządkuje interfejs: komunikaty stosują formy „od stycznia” i „do grudnia”, pole potwierdzonego przelewu używa przecinka i dwóch miejsc po przecinku, a listy okresów premiowych obejmują tylko wypłaty mieszczące się w obsługiwanych latach. Wykres pokazuje cały wybrany plan z osobnymi oznaczeniami lat. Na ekranach do 640 px tabela pokazuje komplet kwot każdego miesiąca w pionie, bez poziomego przewijania. Nazwy wariantów PIT są krótsze; pełne stawki i progi pozostają w opisie ustawienia.

