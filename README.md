# Guinness Gauntlet

A multi-sport league site for the group: live snake draft, standings that update on their own, and every sport scaled to MLB's 162 games.

- **Site:** GitHub Pages (free)
- **Live draft and league data:** Firebase Firestore, free Spark plan
- **Automatic scores:** a GitHub Action that runs every hour (free on a public repo)

Total cost: $0. A custom domain is optional, about $12 a year.

---

## What's in this folder

| File | What it does |
|---|---|
| `index.html` | The whole site |
| `manifest.webmanifest`, `icons/` | App name and icon for adding the site to a phone's home screen |
| `config.js` | Your Firebase connection settings (you paste these in during setup) |
| `firestore.rules` | Who can read and change the league data |
| `updater/update.mjs` | Pulls standings from ESPN (NFL, NBA, NHL, MLB, Premier League) and Jolpica (F1 drivers) |
| `updater/seasons.json` | Which season each league counts. Update this once a year |
| `.github/workflows/update-scores.yml` | Runs the updater every hour |

---

## Setup (about 45 minutes, once)

### 1. Create the Firebase project (15 min)

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. Click **Create a project**. Name it `guinness-gauntlet`. Turn Google Analytics **off**. Click **Create project**.
3. In the left menu: **Build → Firestore Database → Create database**.
   - Choose **Start in production mode**.
   - Location: `nam5 (United States)`. Click **Create**.
4. In Firestore, open the **Rules** tab. Delete what's there, paste the entire contents of `firestore.rules`, and click **Publish**.
5. Left menu: **Build → Authentication → Get started**. Under **Sign-in method**, choose **Anonymous**, switch it **on**, and click **Save**.
6. Click the **gear icon → Project settings**. Under **Your apps**, click the **`</>`** (Web) icon. Nickname it `site`, leave Hosting unchecked, and click **Register app**.
7. Firebase shows a block of code with `const firebaseConfig = { ... }`. Copy the six values (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`) into the matching lines of `config.js`.
8. Still in **Project settings**, open the **Service accounts** tab and click **Generate new private key → Generate key**. A `.json` file downloads. This is the updater's password. **Don't put it in the repo or share it.** You'll paste it into GitHub in step 3.

### 2. Put the site on GitHub (10 min)

1. Sign in at <https://github.com> (or create a free account).
2. Click **+ → New repository**. Name it `YOUR-USERNAME.github.io` (ours is `guinnessgauntlet.github.io`), set it to **Public**, and click **Create repository**.
3. Upload the files. Either:
   - **Easiest:** have Claude push everything for you, or
   - Click **uploading an existing file**, drag in everything from this folder **except** the `.github` folder, and click **Commit changes**. Then add the workflow by hand: **Add file → Create new file**, type the name `.github/workflows/update-scores.yml`, paste in that file's contents, and commit. Finder and File Explorer hide folders that start with a dot, which is why it's done separately.
4. Turn on the site: **Settings → Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **main** and folder **/ (root)**, then click **Save**. After a minute or two the site is live at **https://guinnessgauntlet.github.io**.

### 3. Turn on automatic scores (5 min)

1. In the repo: **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Secret: open the `.json` key file from step 1.8 in a text editor and paste **everything** in it.
   - Click **Add secret**.
2. Open the **Actions** tab. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
3. Click **Update scores → Run workflow → Run workflow**. After about 30 seconds, open the run. The log lists what it found for each league, for example `NFL: 32 teams/drivers, 32 changed. Best: …`.
4. Open the site. The header should say **Scores updated …**. From now on it runs every hour on its own.

### 4. Run the draft

1. Send the group the site link. On a phone, they can add it to the home screen (iPhone: Safari → Share → Add to Home Screen; Android: Chrome → ⋮ → Add to Home screen) so it opens like an app. Anyone with the link can view the league and make picks, so keep it within the group.
2. On the **League** tab, add everyone's name. Each person taps **This is me** on their own phone.
3. Turn on any special events for this year.
4. On the **Draft** tab, set or shuffle the order and press **Start the draft**.

Run the updater at least once before the draft (step 3.3). The draft board then uses the exact team and driver names from the score feeds and shows each team's current record.

---

## What updates on its own and what doesn't

| Updates every hour, automatically | Entered on the Scores tab when it happens |
|---|---|
| NFL, NBA, NHL, MLB records | Playoff results: one dropdown per team, as each round ends |
| Premier League record and table position | "Season over" checkbox for each league (locks in best-record and final-position bonuses) |
| F1 drivers' championship position | Golf major finishes (4 times a year) |
| Best regular-season record in each league | Tennis Grand Slam results (4 times a year) |
| | Special event results |

The free score feeds don't reliably publish playoff brackets, golf leaderboards or tennis draws, so those few results are entered by hand. Anyone in the league can enter them.

---

## Once a year

- Update `updater/seasons.json` to the new seasons (edit it right on GitHub).
- On the **Scores** tab, uncheck "Season over" for each league. On the **League** tab, change the league year and use **Clear all picks** to start a new draft.
- Check the Premier League team list. ESPN supplies it automatically once the updater runs, which covers promotion and relegation.

## If something breaks

- **Header says "Not connected":** `config.js` still has `PASTE_…` values, or Anonymous sign-in isn't turned on (step 1.5).
- **"The database refused that change":** the rules from `firestore.rules` weren't published (step 1.4).
- **Scores stopped updating:** open the **Actions** tab and look at the latest run's log. ESPN's feeds are free but unofficial, so if ESPN changes its format, the log shows which league failed. Every other league keeps updating, and you can type that league's records on the Scores tab until it's fixed.
- **Scores tab shows a drafted team with no record:** the team name didn't match the feed. The run log lists it as `no match for …`.

## Scoring summary

- **Season:** win % × 162. NFL ties and NHL OT losses count as half a win, Premier League draws as a third.
- **F1:** one driver. Share of the other drivers yours finishes ahead of in the standings × 162.
- **Golf:** 3 golfers × 4 majors. Share of the field beaten, averaged, × 162. +10 per major win, +5 per runner-up.
- **Tennis:** 2 players × 4 Slams. Combined match record × 162. +10 per title, +5 per final lost.
- **Playoffs:** +5 to make it, +5 per round won (a bye counts as a round won), +10 more for the title. Champion = 35.
- **Best regular-season record:** +10.
- **Premier League and F1 final standings:** 1st 35, 2nd 20, 3rd–4th 15, 5th–6th 10, 7th–10th 5.

All bonus values can be changed on the **League** tab.
