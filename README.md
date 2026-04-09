# 📐 Geopoint — Geodezijos užsakymų valdymo sistema

## Administratoriaus prisijungimas

- **El. paštas:** tomas.ruzveltas@energolt.eu
- **Slaptažodis:** Energo99

---

## 1 būdas: Azure per Portal (naršyklę)

### Žingsnis 1: Paruoškite ZIP failą
Supakuokite šiuos failus į **geopoint.zip**:
- server.js
- package.json
- public/index.html

(Neįtraukite node_modules aplanko ir README.md)

### Žingsnis 2: Sukurkite App Service
1. Eikite į https://portal.azure.com
2. **Create a resource** → ieškokite **Web App**
3. Užpildykite:
   - **Resource Group:** sukurkite naują (pvz. geopoint-rg)
   - **Name:** geopoint (tai bus adresas geopoint.azurewebsites.net)
   - **Runtime stack:** Node 22 LTS
   - **Operating System:** Linux
   - **Region:** North Europe
   - **Pricing plan:** Free F1 arba Basic B1
4. **Review + create** → **Create**

### Žingsnis 3: Įkelkite kodą
1. Atidarykite sukurtą resursą
2. Kairėje **Advanced Tools** → **Go** (atsidarys Kudu)
3. **Tools** → **Zip Push Deploy**
4. Nutempkite geopoint.zip į langą

### Žingsnis 4: Patikrinkite
Atidarykite https://geopoint.azurewebsites.net

---

## 2 būdas: Azure per CLI (greičiausia)

### Įdiekite Azure CLI
https://learn.microsoft.com/en-us/cli/azure/install-azure-cli

### Komandos
```bash
az login
cd geopoint
az webapp up --name geopoint --runtime "NODE:22-lts" --sku F1
```

Programa bus pasiekiama: https://geopoint.azurewebsites.net

---

## Paleidimas savo kompiuteryje

```bash
cd geopoint
npm install
npm start
```
Naršyklėje: http://localhost:3000

---

## Pastabos

- Duomenys saugomi: Azure /home/data/data.json, lokaliai ./data.json
- Free F1: programa užmiega po 20 min neaktyvumo. Basic B1 (~12 EUR/mėn) veikia nuolat.
