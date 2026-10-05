#!/usr/bin/env bash
# S7 Monitor — instalacja jedną komendą na VPS (Ubuntu/Debian):
#   curl -fsSL https://raw.githubusercontent.com/Sevenek0/S7-monitor/feat/s7-monitor/deploy/install.sh | sudo bash
#
# Skrypt: instaluje Dockera i gita, pobiera aplikację do /opt/s7-monitor, pyta o hasło
# i klucz Pterodactyla, uruchamia kontener i konfiguruje HTTPS:
#   - jeśli na 80/443 działa nginx (np. od Pterodactyla) → vhost + certbot,
#   - jeśli porty są wolne → Caddy z automatycznym certyfikatem.
# Bez domeny używa adresu <IP-z-myślnikami>.sslip.io. Można uruchamiać ponownie (aktualizacja).
set -euo pipefail

REPO="${S7_REPO:-https://github.com/Sevenek0/S7-monitor.git}"
BRANCH="${S7_BRANCH:-feat/s7-monitor}"
DIR="/opt/s7-monitor"

c_ok() { printf '\033[32m✔ %s\033[0m\n' "$*"; }
c_info() { printf '\033[36m➜ %s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# Pytania czytamy z terminala (skrypt jest zwykle podawany przez "curl | bash").
ask() { local prompt="$1" def="${2:-}" ans; read -r -p "$prompt" ans </dev/tty || true; echo "${ans:-$def}"; }
ask_secret() { local prompt="$1" ans; read -r -s -p "$prompt" ans </dev/tty || true; echo >&2; echo "$ans"; }

[ "$(id -u)" = "0" ] || die "Uruchom z sudo:  curl -fsSL ... | sudo bash"
[ -r /dev/tty ] || die "Brak terminala do zadania pytań — uruchom w normalnej sesji SSH."

echo
echo "==================  S7 Monitor — instalacja  =================="
echo

# --- 1. Pakiety -------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
if ! command -v git >/dev/null || ! command -v curl >/dev/null; then
  c_info "Instaluję git i curl…"
  apt-get update -qq && apt-get install -y -qq git curl ca-certificates >/dev/null
fi
if ! command -v docker >/dev/null; then
  c_info "Instaluję Dockera (ok. 1–2 min)…"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
docker compose version >/dev/null 2>&1 || die "Brak 'docker compose'. Zainstaluj pakiet docker-compose-plugin."
c_ok "Docker gotowy"

# --- 2. Kod aplikacji -------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  c_info "Aktualizuję kod w $DIR…"
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  c_info "Pobieram aplikację do $DIR…"
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"
c_ok "Kod pobrany"

# --- 3. Konfiguracja (.env) -------------------------------------------------
IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
DEFAULT_DOMAIN="$(echo "$IP" | tr '.' '-').sslip.io"

if [ -f .env ] && grep -q '^APP_PASSWORD=.\+' .env; then
  c_ok "Znaleziono istniejący plik .env — zostawiam ustawienia"
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  EMAIL="${VAPID_SUBJECT#mailto:}"
else
  echo
  echo "Odpowiedz na kilka pytań (Enter = wartość w nawiasie)."
  echo
  PASS="$(ask_secret 'Hasło do logowania w S7 Monitor (Enter = wygeneruj): ')"
  GENERATED=""
  if [ -z "$PASS" ]; then PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16 || true)"; GENERATED=1; fi
  EMAIL="$(ask 'Twój e-mail (do certyfikatu HTTPS i powiadomień): ' '')"
  [ -n "$EMAIL" ] || die "E-mail jest wymagany (Let's Encrypt i Apple go potrzebują)."
  DOMAIN="$(ask "Domena aplikacji [$DEFAULT_DOMAIN]: " "$DEFAULT_DOMAIN")"
  PTERO_URL="$(ask 'Adres panelu Pterodactyl, np. https://panel.mojadomena.pl (Enter = pomiń): ' '')"
  PTERO_KEY=""
  if [ -n "$PTERO_URL" ]; then
    PTERO_URL="${PTERO_URL%/}"
    case "$PTERO_URL" in http://*|https://*) ;; *) PTERO_URL="https://$PTERO_URL" ;; esac
    PTERO_KEY="$(ask_secret 'Klucz Client API z panelu (ptlc_…): ')"
    case "$PTERO_KEY" in ptlc_*) ;; *) c_warn "Klucz nie zaczyna się od ptlc_ — sprawdź, czy to klucz Client API." ;; esac
  fi
  umask 077
  cat > .env <<EOF
APP_PASSWORD=$PASS
APP_SECRET=
PTERO_URL=$PTERO_URL
PTERO_KEY=$PTERO_KEY
VAPID_SUBJECT=mailto:$EMAIL
DOMAIN=$DOMAIN
TZ=Europe/Warsaw
EOF
  umask 022
  c_ok "Zapisano $DIR/.env"
fi

# --- 4. Uruchomienie aplikacji ---------------------------------------------
mkdir -p data
c_info "Buduję i uruchamiam kontener (pierwszy raz ok. 1–3 min)…"
if [ -n "${S7_SKIP_BUILD:-}" ]; then docker compose up -d app >/dev/null; else docker compose up -d --build app >/dev/null; fi
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 || { docker compose logs --tail 30 app; die "Aplikacja nie wystartowała (logi powyżej)."; }
c_ok "Aplikacja działa na 127.0.0.1:3000"

# --- 5. HTTPS ---------------------------------------------------------------
LISTEN="$(ss -tlnpH '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
if echo "$LISTEN" | grep -q nginx; then
  c_info "Wykryto nginx na 80/443 — dodaję vhost dla $DOMAIN i certyfikat (certbot)…"
  docker compose stop caddy >/dev/null 2>&1 || true
  CONF=/etc/nginx/sites-available/s7monitor.conf
  if [ -d /etc/nginx/sites-available ]; then
    [ -f "$CONF" ] && grep -q "listen 443" "$CONF" || {
      sed "s/monitor.example.pl/$DOMAIN/" deploy/nginx-s7monitor.conf > "$CONF"
      ln -sf "$CONF" /etc/nginx/sites-enabled/s7monitor.conf
    }
  else
    CONF=/etc/nginx/conf.d/s7monitor.conf
    [ -f "$CONF" ] && grep -q "listen 443" "$CONF" || sed "s/monitor.example.pl/$DOMAIN/" deploy/nginx-s7monitor.conf > "$CONF"
  fi
  nginx -t >/dev/null 2>&1 || { nginx -t; die "Błąd w konfiguracji nginx (powyżej)."; }
  systemctl reload nginx
  if ! command -v certbot >/dev/null; then
    apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  fi
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring \
    || die "certbot nie wydał certyfikatu. Sprawdź, czy port 80 jest otwarty i czy $DOMAIN wskazuje na $IP."
  c_ok "HTTPS przez nginx skonfigurowany"
elif [ -n "$LISTEN" ]; then
  echo "$LISTEN"
  die "Porty 80/443 zajmuje inny program niż nginx — zwolnij je albo skonfiguruj proxy ręcznie (README, rozdział 5)."
else
  c_info "Porty 80/443 wolne — uruchamiam Caddy z automatycznym HTTPS dla $DOMAIN…"
  DOMAIN="$DOMAIN" docker compose --profile caddy up -d >/dev/null
  for _ in $(seq 1 45); do
    curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1 && break
    sleep 2
  done
  c_ok "Caddy uruchomiony"
fi

# --- 6. Zapora --------------------------------------------------------------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  c_ok "Otwarto porty 80 i 443 w UFW"
fi

# --- 7. Podsumowanie --------------------------------------------------------
echo
if curl -fsS --max-time 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
  c_ok "Gotowe! S7 Monitor działa pod: https://$DOMAIN"
else
  c_warn "Aplikacja działa, ale https://$DOMAIN jeszcze nie odpowiada z zewnątrz."
  c_warn "Poczekaj minutę (certyfikat) i sprawdź firewall w panelu OVH (porty 80 i 443)."
fi
echo
echo "  Adres (do aplikacji Windows i iPhone'a):  https://$DOMAIN"
if [ -n "${GENERATED:-}" ]; then
  echo "  Wygenerowane hasło:  $PASS   ← zapisz je!"
else
  echo "  Hasło:  to, które podałeś (zapisane w $DIR/.env)"
fi
echo
echo "  Logi:         cd $DIR && docker compose logs -f app"
echo "  Aktualizacja: uruchom tę samą komendę instalacyjną ponownie"
echo
