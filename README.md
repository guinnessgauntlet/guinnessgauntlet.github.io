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

## What updates on its own

Every hour, automatically: regular-season records, Premier League and F1 standings, best record in each league, when each regular season ends, playoff progress round by round, golf major finishes and tennis Grand Slam results.

The commissioner (signed in with Google on the League tab) can correct anything on the Scores tab if a feed gets something wrong. A corrected playoff, golf or tennis result stays put until the commissioner changes it again. Special events (World Cups, Olympics) are set by the commissioner.

Everyone else can view the league and make draft picks, but can't change scores or settings.

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

- **Seasons:** everyone starts at 0. Each regular-season win is worth 162 ÷ the league's season length (NFL 9.5, NBA/NHL 2.0, Premier League 4.3, MLB 1). Ties and NHL OT losses count as half a win, Premier League draws as a third.
- **F1:** one driver; banks points race by race from championship position (1st ends the year at 162).
- **Golf:** 3 men x 4 majors, by finish: win 30, 2nd 20, 3rd 16, 4th 14, 5th 12, 6th-10th 10 down to 6, 11th-20th 5, 21st-40th 3, other made cuts 1. Missed cut, WD or didn't play = 0.
- **Tennis:** 2 men; about 2.9 per Slam match won, +10 per title, +5 per final lost.
- **AVP:** one men's pair and one women's pair per season, scored at the tournaments the league picks: 1st 10, 2nd 6, 3rd 4, 5th 3, 7th-9th 1.
- **Flex:** one extra pick from any sport in the season (not AVP).
- **Playoffs:** +5 to make it, +5 per round won (a bye counts), +10 more for the title. Champion = 35.
- **Best record:** +10. **Wooden spoon:** -10 for the worst record in each league, each relegated Premier League club, and the last F1 driver.
- **Winner:** most points; tiebreaks are most championships, then most playoff points. Every loser buys the winner a Guinness.

Bonus values can be changed on the League tab. Choose which sports are in each season on the League tab before the draft.
