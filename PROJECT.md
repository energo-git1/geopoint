# Geopoint — Projekto aprašymas

## Apžvalga
Geodezijos užsakymų valdymo sistema. Node.js/Express backend + React 18 single-file frontend (Babel standalone, be build žingsnio).

## Techninė struktūra
- **Backend:** `server.js` — Express, better-sqlite3, ldapjs, multer
- **Frontend:** `public/index.html` — React 18 + Recharts + Babel standalone (viskas viename faile)
- **DB:** SQLite (`geopoint.db`), WAL mode, viena `store` lentelė (key/value)
- **Failai:** `uploads/` aplankas serveryje (arba `/home/data/uploads/` Azure)
- **Procesų valdymas:** PM2
- **Versija:** 1.4.2

## Deployment workflow
1. Claude rašo pakeitimus į `C:\Users\a\Documents\GitHub\geopoint`
2. Vartotojas pusha per GitHub Desktop
3. Serveris kas minutę: `git pull && npm install && pm2 restart geopoint`

## Serveris
- Linux, už firewall (tik outbound connections)
- IP: (lokalus tinklas)
- PM2 process name: `geopoint`
- Port: 3000 (Nginx proxy → HTTPS 443)

## Autentikacija
- **AD:** ldapjs v3, UPN bind (`username@hata.local`), svc_jira service account paieška
  - LDAP: `ldap://192.168.1.100:389`, base DN: `DC=hata,DC=local`
  - SVC DN: `CN=svc_jira,OU=Service Accounts,DC=hata,DC=local`
  - Slaptažodis: `pm2 set geopoint LDAP_SVC_PASS <password>`
  - Narrow search base: `pm2 set geopoint LDAP_USERS_BASE "OU=...,DC=hata,DC=local"`
- **Vietinis admin:** `geoadmin` / slaptažodis DB (numatytasis `Energo99`, keičiamas per UI)

## Rolės
- `admin` — pilna prieiga
- `orderer` — kuria užsakymus
- `surveyor` — geodezininkas, mato tik savo užduotis
- `pending` — naujas AD vartotojas, laukia rolės priskyrimo

## Svarbūs PM2 komandai
```bash
pm2 restart geopoint --update-env
pm2 logs geopoint
pm2 flush
```

## Svarbūs env kintamieji
```bash
pm2 set geopoint LDAP_SVC_PASS <password>
pm2 set geopoint LDAP_SVC_DN "CN=svc_jira,OU=Service Accounts,DC=hata,DC=local"
pm2 set geopoint LDAP_USERS_BASE "OU=Users,DC=hata,DC=local"
```

## Žinomi sprendimai
- **ldapjs referral problema:** AD grąžina DomainDnsZones/ForestDnsZones referralus → Operations Error. Sprendimas: `done` flag, `searchReference` ignoruojamas, `LDAP_USERS_BASE` siaurina paiešką
- **Slaptažodžiai:** niekada nesiunčiami klientui — `GET /api/store/gp-users` juos stripina, `PUT /api/store/gp-users` juos atkuria iš DB
- **Sesija:** saugoma `localStorage` (ne serveryje) — incognito naršyklė visada prasideda be sesijos
- **Failai:** multer → `uploads/`, max 500 MB, max 70 simbolių pavadinimas

## Pagrindiniai API endpoint'ai
| Metodas | Kelias | Aprašymas |
|---------|--------|-----------|
| POST | `/api/auth/local` | Vietinis prisijungimas |
| POST | `/api/auth/ldap` | AD prisijungimas |
| POST | `/api/auth/change-password` | Slaptažodžio keitimas |
| GET | `/api/store/gp-users` | Vartotojai (be slaptažodžių) |
| PUT | `/api/store/gp-users` | Išsaugoti vartotojus (slaptažodžiai atkuriami) |
| PATCH | `/api/users/:id/email` | Redaguoti el. paštą |
| POST | `/api/upload` | Įkelti failą |
| GET | `/uploads/:file` | Atsisiųsti failą |
| GET/PUT | `/api/store/:key` | Bendras key-value store |
