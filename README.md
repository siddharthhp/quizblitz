# ⚡ QuizBlitz

Kahoot-style live quiz for 400+ players. One Node.js server — deploy anywhere.

## Quick start

```bash
cd server
npm install
npm start
# → http://localhost:3000
```

- **Host**: http://localhost:3000/host.html
- **Players**: http://localhost:3000/

## Docx question formats

### Prose (auto-detected)
```
Q: What is the capital of France?
A) London
B) Paris ✓
C) Berlin
D) Rome
```
Mark correct answer with `✓`, `✔`, `(correct)`, or trailing `*`.

### Table (auto-detected)
Header row must be: `| Question | A | B | C | D | Answer |`
`Answer` column holds the correct letter (A/B/C/D).

## Deploy to GitHub + Render/Railway

1. Push this repo to GitHub
2. Create a new Web Service on [Render](https://render.com) or [Railway](https://railway.app)
3. Set:
   - **Root directory:** `server`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Port:** auto-detected via `$PORT`

GitHub Pages alone won't work (no WebSocket support). Deploy the Node server to any cloud host and players connect via the deployed URL.

## How it works

| Who | Flow |
|-----|------|
| Host | Upload .docx → get 6-char room code → wait for players → Start |
| Players | Go to site → enter code + name → wait for questions |
| Per question | 20s timer, speed bonus scoring (500–1000 pts) |
| Reveal | Correct/wrong shown instantly per player + live leaderboard on host |
| End | Final leaderboard + per-player answer history (localStorage) |

## Scoring
`max(500, 1000 - (500 × elapsed / 20000))` — faster = more points. Wrong = 0.
