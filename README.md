# S7 Monitor

Monitoring botów Discord (Pterodactyl), stron WWW i serwera FiveM: backend na VPS-ie działa 24/7, aplikację instalujesz na iPhonie (PWA z powiadomieniami push) i na Windowsie (aplikacja w zasobniku z natywnymi powiadomieniami).

- **Pulpit:** ogólny stan („Wszystko działa” / „2 awarie”), kropka połączenia na żywo, sekcje *Serwer FiveM*, *Boty Discord* i *Strony*. Na kartach są gracze, latencja, CPU/RAM, wykres z 24 h i uptime.
- **Szczegóły monitora:** zakresy 24 h / 7 dni / 30 dni, wykresy (gracze, czas odpowiedzi, CPU, RAM), pasek dostępności, lista graczy FiveM z wyszukiwarką, incydenty i przyciski zasilania Start/Restart/Stop/Kill.
- **Powiadomienia** wysyłane są tylko wtedy, gdy coś padnie albo wróci do działania, np. „PADŁ: Bot EMS (timeout)” i „Działa znowu: Bot EMS (przerwa 4 min)”.
- Wszystko działa bez zewnętrznych CDN-ów. Wykresy to własny SVG, a aplikacja działa offline z cache.

---

## Spis treści
1. [Struktura repozytorium](#1-struktura-repozytorium)
2. [Szybki start lokalnie (mocki)](#2-szybki-start-lokalnie-mocki)
3. [Instalacja na VPS-ie (OVH, Ubuntu)](#3-instalacja-na-vps-ie-ovh-ubuntu)
4. [Klucz Client API w Pterodactylu](#4-klucz-client-api-w-pterodactylu)
5. [HTTPS: wariant A (Caddy) albo B (nginx od Pterodactyla)](#5-https)
6. [iPhone: instalacja i powiadomienia](#6-iphone-instalacja-i-powiadomienia)
7. [Windows: budowa i instalacja .exe](#7-windows-budowa-i-instalacja-exe)
8. [Dodawanie monitorów](#8-dodawanie-monitorów)
9. [Testy](#9-testy)
10. [Bezpieczeństwo](#10-bezpieczeństwo)
11. [Aktualizacja, kopie zapasowe, logi](#11-aktualizacja-kopie-zapasowe-logi)
12. [Rozwiązywanie problemów](#12-rozwiązywanie-problemów)

---

## 1. Struktura repozytorium

```
├─ docker-compose.yml        aplikacja na 127.0.0.1:3000 + opcjonalny Caddy (profil "caddy")
├─ Dockerfile                obraz Node 22 (proces działa jako użytkownik bez roota)
├─ Caddyfile                 wariant A: automatyczny HTTPS
├─ deploy/nginx-s7monitor.conf  wariant B: vhost dla nginx + certbot
├─ .env.example              wzór konfiguracji
├─ server/                   backend: Express, SQLite, SSE, Web Push
│  ├─ src/                   API, scheduler, checkery (http, fivem, pterodactyl), historia
│  ├─ public/                frontend PWA (czysty JS/HTML/CSS, bez budowania)
│  ├─ mock/                  fałszywy FiveM, Pterodactyl i strona do testów
│  ├─ test/                  testy (node:test)
│  └─ scripts/               generator ikon, zrzuty ekranu (Playwright)
└─ desktop/                  aplikacja Windows (Electron + electron-builder/NSIS)
```

## 2. Szybki start lokalnie (mocki)

Potrzebujesz Node.js 22 lub nowszego.

```bash
cd server
npm install
npm run dev:mock
```

Otwórz <http://localhost:3000> i zaloguj się hasłem `admin`. Startuje 7 przykładowych monitorów z historią z 30 dni. Mocki możesz sterować ręcznie:

```bash
curl "http://127.0.0.1:30121/__control?online=0"                   # FiveM pada
curl "http://127.0.0.1:30121/__control?paranoia=1"                 # zablokowane /players.json
curl "http://127.0.0.1:8091/__control?down=1"                      # strona zwraca 503
curl "http://127.0.0.1:8090/__control?id=a1b2c3d4&state=offline"   # bot EMS offline
```

Po 2 nieudanych sprawdzeniach (domyślnie co 30 s) monitor przechodzi w stan „Awaria”. W konsoli zobaczysz wtedy `[mock web-push] … PADŁ: …`.

## 3. Instalacja na VPS-ie (OVH, Ubuntu)

### 3.1 Docker
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER     # wyloguj się i zaloguj ponownie
```

### 3.2 Pobranie aplikacji
```bash
sudo mkdir -p /opt/s7-monitor && sudo chown $USER: /opt/s7-monitor
git clone https://github.com/Sevenek0/S7-monitor.git /opt/s7-monitor
cd /opt/s7-monitor
cp .env.example .env
nano .env
```

Uzupełnij `.env`:

| Zmienna | Co wpisać |
|---|---|
| `APP_PASSWORD` | **wymagane:** długie hasło do logowania |
| `APP_SECRET` | zostaw puste, wygeneruje się samo w `data/secret.key` |
| `PTERO_URL` | adres panelu, np. `https://panel.twojadomena.pl` (bez `/` na końcu) |
| `PTERO_KEY` | klucz Client API `ptlc_…` ([rozdział 4](#4-klucz-client-api-w-pterodactylu)) |
| `VAPID_SUBJECT` | `mailto:twoj@email.pl`, czyli prawdziwy e-mail (Apple go sprawdza) |
| `DOMAIN` | domena aplikacji (potrzebna tylko w wariancie A z Caddy) |

### 3.3 Uruchomienie
```bash
docker compose up -d --build
docker compose logs -f app        # Ctrl+C kończy podgląd logów
curl http://127.0.0.1:3000/api/health
```

Aplikacja nasłuchuje **tylko na `127.0.0.1:3000`**, czyli nie jest widoczna z internetu. Na zewnątrz wystawia ją Caddy albo nginx z HTTPS (rozdział 5). Dane (baza SQLite, klucze VAPID, sekret) leżą w katalogu `./data`.

### 3.4 Porty
| Port | Gdzie | Otworzyć? |
|---|---|---|
| 80, 443 TCP (+443 UDP dla Caddy) | VPS | **tak**, dla HTTPS. Jeśli stoi już nginx Pterodactyla, to te porty są już otwarte |
| 3000 | VPS | **nie**, działa tylko lokalnie |
| 30120 TCP | serwer FiveM | już otwarty dla graczy. Monitor korzysta z tych samych endpointów HTTP |

Jeśli używasz UFW: `sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp`. Sprawdź też firewall w panelu OVH (Network → Firewall), jeśli go włączyłeś.

## 4. Klucz Client API w Pterodactylu

1. Zaloguj się do panelu Pterodactyl na konto, które ma dostęp do serwerów z botami.
2. Kliknij ikonę konta w prawym górnym rogu i wybierz **Account → API Credentials**.
3. W **Description** wpisz `S7 Monitor`. W **Allowed IPs** możesz wpisać publiczne IP VPS-a albo zostawić pole puste.
4. Kliknij **Create** i skopiuj klucz zaczynający się od `ptlc_`. Panel pokaże go tylko raz.
5. Wklej klucz do `.env` jako `PTERO_KEY`, a adres panelu jako `PTERO_URL`. Następnie zrestartuj aplikację: `docker compose up -d`.

> To klucz **Client API** (`ptlc_`), a nie Application API (`ptla_`). Ma uprawnienia Twojego konta, więc dla przycisków zasilania konto musi mieć prawo start/stop dla tych serwerów. Klucz i URL panelu są tylko w `.env`: nie trafiają do bazy ani do przeglądarki.

## 5. HTTPS

Najpierw sprawdź, czy coś zajmuje już porty 80 i 443:
```bash
sudo ss -tlnp | grep -E ':(80|443)\s'
```
- Jeśli nic nie ma, wybierz **wariant A (Caddy)**.
- Jeśli widzisz `nginx` (zwykle od panelu Pterodactyla), wybierz **wariant B**.

Najpierw ustaw rekord DNS **A** dla domeny, np. `monitor.twojadomena.pl`, wskazujący na IP VPS-a.

### Wariant A: Caddy (automatyczny HTTPS)
```bash
# w .env: DOMAIN=monitor.twojadomena.pl
docker compose --profile caddy up -d
```
Caddy sam pobierze i odnowi certyfikat Let's Encrypt. Gotowe: aplikacja działa pod `https://monitor.twojadomena.pl`.

### Wariant B: nginx od Pterodactyla + certbot
```bash
sudo cp deploy/nginx-s7monitor.conf /etc/nginx/sites-available/s7monitor.conf
sudo sed -i 's/monitor.example.pl/monitor.twojadomena.pl/' /etc/nginx/sites-available/s7monitor.conf
sudo ln -s /etc/nginx/sites-available/s7monitor.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx     # jeśli nie masz
sudo certbot --nginx -d monitor.twojadomena.pl         # wybierz przekierowanie na HTTPS
```
W tym vhoście wyłączone jest buforowanie dla strumienia na żywo (`/api/events` z `proxy_buffering off`), bez tego kropka „Na żywo” by nie działała. Certbot odnawia certyfikat sam (`systemctl list-timers | grep certbot`). **Nie uruchamiaj** w tym wariancie profilu `caddy`.

### Nie mam domeny: sslip.io
Usługa sslip.io zamienia IP na domenę. Dla IP `51.75.12.34` adresem będzie **`51-75-12-34.sslip.io`** (kropki zamieniasz na myślniki). Nie trzeba nic ustawiać w DNS. Użyj tej nazwy jako `DOMAIN` (wariant A) albo w `server_name` i `certbot -d` (wariant B). Let's Encrypt wyda dla niej normalny certyfikat, więc pushe na iPhonie będą działać.

## 6. iPhone: instalacja i powiadomienia

**Wymagania iOS:**
- iOS / iPadOS **16.4 lub nowszy**;
- aplikacja otwierana **po HTTPS**, czyli z prawdziwym certyfikatem (rozdział 5);
- aplikacja **dodana do ekranu początkowego**. W zwykłej karcie Safari iOS nie pozwala na powiadomienia web push.

**Kroki:**
1. Otwórz w **Safari** adres `https://monitor.twojadomena.pl`.
2. Stuknij **Udostępnij** (kwadrat ze strzałką) → **Do ekranu początkowego** → **Dodaj**.
3. Zamknij Safari i otwórz **S7 Monitor z nowej ikony**.
4. Zaloguj się, wejdź w **Ustawienia → Powiadomienia → Włącz powiadomienia** i potwierdź zgodę.
5. Stuknij **Wyślij test** i sprawdź, czy przyszło powiadomienie.

Jak to działa w praktyce:
- Jeśli otworzysz aplikację w Safari zamiast z ikony, zobaczysz instrukcję „Udostępnij → Do ekranu początkowego”.
- Prośba o zgodę na powiadomienia pojawia się wyłącznie po kliknięciu przycisku, nigdy przy starcie aplikacji (tego wymaga iOS).
- Kliknięcie powiadomienia otwiera aplikację na szczegółach danego monitora.
- Aplikacja obsługuje notch i Dynamic Island (safe-area). Działa jako pełnoekranowa aplikacja (`display: standalone`) z ikoną 180×180.
- Jeśli wyłączysz zgodę w *Ustawienia iOS → Powiadomienia → S7 Monitor*, włącz ją z powrotem tam, a potem jeszcze raz przycisk w aplikacji.

Na Androidzie i w Chrome lub Edge na PC pushe działają też bez instalowania aplikacji.

## 7. Windows: budowa i instalacja .exe

Aplikacja desktop to okno z Twoim S7 Monitorem, ikona w zasobniku (tray) i natywne powiadomienia Windows. Web Push nie działa w Electronie, dlatego powiadomienia przychodzą przez połączenie na żywo (SSE).

**Budowa (na Twoim komputerze z Windowsem):**
1. Zainstaluj [Node.js 22 LTS](https://nodejs.org/) (instalator `.msi`).
2. Pobierz repozytorium (`git clone` albo ZIP z GitHuba) i otwórz **PowerShell** w folderze `desktop`:
   ```powershell
   cd s7-monitor\desktop
   npm install
   npm run dist
   ```
3. Instalator znajdziesz w `desktop\dist\S7-Monitor-Setup-1.0.0.exe`.

**Instalacja i pierwsze uruchomienie:**
1. Uruchom instalator. Aplikacja nie jest podpisana certyfikatem, więc Windows SmartScreen może ją zablokować. Kliknij wtedy **Więcej informacji → Uruchom mimo to**.
2. Przy pierwszym starcie wpisz adres serwera, np. `https://monitor.twojadomena.pl`. Aplikacja sprawdzi połączenie i zapisze adres w `%APPDATA%\S7 Monitor\config.json`.
3. Zaloguj się hasłem z `.env`.

**Obsługa:**
- **Zamknięcie okna (X)** chowa aplikację do zasobnika, a monitoring i powiadomienia działają dalej.
- **Ikona w zasobniku** ma kolor zależny od stanu: zielony, gdy wszystko działa, czerwony przy awarii i szary bez połączenia. Menu pod prawym przyciskiem myszy: *Otwórz*, *Zmień serwer…*, *Uruchamiaj z Windowsem*, *Zamknij*.
- Może działać tylko jedna kopia aplikacji naraz. Ponowne uruchomienie pokazuje istniejące okno.
- Linki zewnętrzne otwierają się w przeglądarce, a przejście na inną stronę w oknie aplikacji jest zablokowane.
- Jeśli powiadomienia się nie pokazują, sprawdź *Ustawienia Windows → System → Powiadomienia → S7 Monitor* i tryb „Nie przeszkadzać”.

## 8. Dodawanie monitorów

W aplikacji wejdź w **Ustawienia → Dodaj**. Każdy monitor ma interwał (domyślnie 30 s) i próg awarii (domyślnie 2 nieudane sprawdzenia z rzędu). Możesz go też wstrzymać przyciskiem **Pauza**.

| Typ | Co podać | Co jest sprawdzane |
|---|---|---|
| **Strona** | `https://twojastrona.pl` | GET (timeout 10 s, przekierowania), oczekiwany kod (domyślnie `200-399`), opcjonalne słowo kluczowe w treści, czas odpowiedzi |
| **FiveM** | `http://IP:30120` | `/dynamic.json` (jeśli nie odpowiada, monitor ma status DOWN), `/players.json` (lista graczy; jeśli jest zablokowana przez `sv_requestParanoia`, monitor nadal jest UP, tylko bez listy), `/info.json` (wersja, liczba zasobów). Identyfikatory graczy nie są nigdzie zapisywane. |
| **Bot** | serwer z listy Pterodactyla | stan (`running` → działa, `offline` → awaria, `starting/stopping` → uwaga), CPU, RAM, dysk, czas działania |

Uwagi:
- **Import z Pterodactyla** (przycisk w Ustawieniach) pokazuje listę serwerów z panelu do zaznaczenia.
- Opcja **„Powiąż z Pterodactylem”** w monitorze FiveM lub strony dodaje do niego CPU/RAM i przyciski zasilania. Przykład: monitor FiveM, którego serwer stoi w Pterodactylu.
- Przyciski zasilania pytają o potwierdzenie. **Stop** i **Kill** wymagają drugiego kliknięcia. Każda akcja jest zapisywana w logach serwera (`docker compose logs app | grep zasilanie`).

## 9. Testy

```bash
cd server
npm test                 # 21 testów: auth, checkery na mockach, przejścia UP→DOWN→UP, próg,
                         # incydenty, agregacja historii, push (mock web-push, usuwanie 404/410), API, SSE
npm run dev:mock         # w drugim terminalu:
npm run screenshots      # zrzuty PC 1440 px i iPhone 390 px → ../screenshots, wykrywa poziomy scroll

cd ../desktop && npm install
npm run test:smoke       # test aplikacji Electron (na Linuksie: xvfb-run -a npm run test:smoke)
```

## 10. Bezpieczeństwo

- **Logowanie:**
  - Jest jedno konto administratora z hasłem z `.env`. Hasło porównywane jest w sposób odporny na ataki czasowe.
  - Logowanie ma limit prób: 5 nieudanych na 15 minut z jednego IP.
  - Token podpisywany jest HMAC-SHA256 kluczem `APP_SECRET` i ważny 30 dni. Zmiana `APP_SECRET` wylogowuje wszystkie urządzenia.
- **Dostęp do API:**
  - Wszystkie `/api/*` poza `/api/login` i `/api/health` wymagają tokenu.
  - Strumień SSE przyjmuje token w parametrze `?token=`, bo `EventSource` nie wysyła nagłówków.
- **Pterodactyl:** `PTERO_URL` i `PTERO_KEY` są wyłącznie w `.env`. API nigdy ich nie zwraca, co sprawdzają testy.
- **Serwer i przeglądarka:**
  - Aplikacja nasłuchuje tylko na `127.0.0.1`, a proces w kontenerze działa bez roota.
  - Nagłówki CSP (bez zewnętrznych skryptów) i `X-Content-Type-Options` są ustawione.
- **Electron:** ma `contextIsolation: true`, `nodeIntegration: false` i `sandbox: true`. Nawigacja poza Twój serwer jest zablokowana.

## 11. Aktualizacja, kopie zapasowe, logi

```bash
cd /opt/s7-monitor
git pull && docker compose up -d --build                  # aktualizacja
docker compose logs -f app                                # logi
tar czf ~/s7-backup-$(date +%F).tgz data .env             # kopia zapasowa
```
Katalog `data/` zawiera bazę, `secret.key` i `vapid.json`. Utrata `vapid.json` oznacza, że trzeba ponownie włączyć powiadomienia na każdym urządzeniu. Historia pomiarów jest automatycznie czyszczona po 30 dniach (`RETENTION_DAYS`).

## 12. Rozwiązywanie problemów

| Objaw | Co zrobić |
|---|---|
| Kropka „Rozłączono” / brak odświeżania na żywo | W nginx brakuje `proxy_buffering off` dla `/api/events`. Użyj vhosta z `deploy/`. |
| Boty mają status „Awaria: Pterodactyl nie jest skonfigurowany” | Uzupełnij `PTERO_URL` i `PTERO_KEY` w `.env`, potem uruchom `docker compose up -d`. |
| „panel: HTTP 403” | Klucz nie ma dostępu do tego serwera albo w „Allowed IPs” jest inny adres IP. |
| FiveM ma status „timeout” | Sprawdź z VPS-a: `curl http://IP:30120/dynamic.json`. Port 30120/TCP musi być osiągalny. |
| Brak listy graczy | Serwer ma `sv_requestParanoia`, więc lista jest niedostępna. Liczba graczy nadal działa. |
| iPhone: brak przycisku „Włącz powiadomienia” | Otwórz aplikację z ikony na ekranie początkowym (nie w Safari). Wymagany jest iOS 16.4+ i HTTPS. |
| Windows: brak powiadomień | Zainstaluj aplikację instalatorem (nie uruchamiaj z folderu) i sprawdź ustawienia powiadomień Windows. |
| „Za dużo prób logowania” | Odczekaj 15 minut albo zrestartuj kontener. |
