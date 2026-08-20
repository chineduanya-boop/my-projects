# MangVault Twitter Bot

Automated Twitter/X bot for **mangvault.com** — posts viral manga/manhwa content, engages with the community, and generates fresh tweets with AI.

---

## Setup

### 1. Get Twitter API credentials

1. Go to [developer.twitter.com](https://developer.twitter.com/en/portal/dashboard)
2. Create a project + app
3. Under **User authentication settings** → enable **OAuth 1.0a** with **Read and Write** permissions
4. Generate your **Access Token & Secret** (must be Read+Write, not Read-only)

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Fill in your credentials:

```
TWITTER_API_KEY=xxxx
TWITTER_API_SECRET=xxxx
TWITTER_ACCESS_TOKEN=xxxx
TWITTER_ACCESS_SECRET=xxxx
ANTHROPIC_API_KEY=xxxx   # for AI tweet generation — get at console.anthropic.com
DRY_RUN=false
```

### 3. Install dependencies

```bash
npm install
```

---

## Usage

### Posting

```bash
npm run post                      # post next queued tweet
node post-now.js --id sl-01       # post a specific tweet by ID
node post-now.js --random         # post a random tweet
npm run schedule                  # start scheduler (4 posts/day, engagement off)
node scheduler.js --post-now      # start scheduler and post one immediately
```

### Engagement

```bash
npm run engage                    # run all engagement (mentions, hashtags, follow-back)
node engage.js --mentions         # reply to mentions only
node engage.js --hashtags         # engage with hashtag posts only
node engage.js --followback       # follow back followers only
node quote-tweet.js               # quote-tweet one trending post
node quote-tweet.js --count 3     # quote-tweet up to 3 posts
```

### AI Tweet Generation

```bash
npm run generate                          # preview 5 AI-generated tweets
node generate.js --count 10              # generate 10 tweets
node generate.js --series "Solo Leveling" # generate for a specific series
node generate.js --save                  # generate and save to tweets.js
node generate.js --post                  # generate and post one immediately
```

### Preview & Stats

```bash
npm run preview                   # list all tweets grouped by series
node preview.js --id sl-01        # view a specific tweet
node preview.js --stats           # see posting history
```

---

## Images

Place image files in the `images/` folder. The bot will automatically attach them when posting.

**Naming convention:**
- `sl-01.jpg` — matches tweet ID `sl-01` exactly
- `sl-03.png` — any `sl-` prefixed file matches any Solo Leveling tweet
- `gen-01.jpg` — matches general promo tweets

Supported formats: `.jpg` `.jpeg` `.png` `.gif` `.webp`

If no image is found for a tweet, it posts as text only.

---

## Automatic Schedule (when running `npm run schedule`)

**4 posts per day, on a fixed 7-day rotation.** Every day uses different clock
times from the day before; after Sunday the same week repeats. Times below are
UTC, with WAT (UTC+1) in brackets.

| Day | Post times (UTC) | WAT |
|-----|------------------|-----|
| Mon | 07:15, 11:40, 16:25, 20:10 | 08:15, 12:40, 17:25, 21:10 |
| Tue | 08:05, 12:20, 17:10, 21:30 | 09:05, 13:20, 18:10, 22:30 |
| Wed | 06:50, 10:55, 15:45, 19:35 | 07:50, 11:55, 16:45, 20:35 |
| Thu | 07:35, 11:15, 16:55, 20:45 | 08:35, 12:15, 17:55, 21:45 |
| Fri | 08:25, 13:05, 17:35, 22:00 | 09:25, 14:05, 18:35, 23:00 |
| Sat | 09:10, 14:30, 18:20, 21:15 | 10:10, 15:30, 19:20, 22:15 |
| Sun | 07:55, 12:45, 16:10, 19:50 | 08:55, 13:45, 17:10, 20:50 |

To change the schedule, edit `WEEKLY_SLOTS` in `scheduler.js` — keep 4 entries
per day and the bot stays at 4 posts/day.

**Engagement is off by default.** Likes, follow-backs, replies and auto-threads
only run when `ENABLE_ENGAGEMENT=true` is set explicitly; otherwise the bot does
nothing but publish its 4 scheduled posts, leaving all interaction to the account
owner. `engage.js`, `quote-tweet.js` and `thread.js` can still be run by hand.


---

## Deploy to Railway (run 24/7 for free)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Go to **Variables** and add all your `.env` values
5. Railway will run `npm start` automatically — the bot runs forever

That's it. No server management needed.

---

## Tweet Bank

113 pre-written tweets covering:

| Series | Tweets |
|--------|--------|
| General MangVault promo | 12 |
| Solo Leveling | 8 |
| Tower of God | 6 |
| Omniscient Reader's Viewpoint | 6 |
| The Beginning After The End | 5 |
| Nano Machine | 5 |
| Return of the Mount Hua Sect | 5 |
| The Eminence in Shadow | 5 |
| Discovery / Starter Pack | 5 |
| Noblesse, Eleceed, Mercenary Enrollment, God of High School | 4 each |
| Northern Blade, Murim Login, Sword Master's Youngest Son, Tomb Raider King, Dungeon Reset, Ranker's Return, Heavenly Demon | 3 each |
| Reality Quest, Max Level Returner, Hero Returns, Volcanic Age, The Breaker, LV999, Absolute Sword Sense, Suicidal Battle God, Pick Me Up | 2 each |

At 4 posts/day the full cycle completes in ~28 days, then resets.

---

## Safe Testing

Set `DRY_RUN=true` in `.env` — all actions (posting, engagement, image upload) are logged but nothing is sent to Twitter.
