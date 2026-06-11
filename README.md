# Confluence Alert Bot

Scans Delta Exchange India every 15 minutes and sends Telegram alerts for VALID setups (3/4 family agreement + R:R ≥ 2).

## Deploy on Railway (free)

1. Go to [railway.app](https://railway.app) and sign up (free, no credit card)
2. Click **New Project → Deploy from GitHub repo**
3. Connect your GitHub account and select this repo (`confluence-alert-bot`)
4. Under **Variables**, add:
   - `TG_TOKEN` = your bot token (e.g. `8326212494:AAEGCl...`)
   - `TG_CHAT` = your Telegram chat ID (e.g. `1004014764`)
5. Click **Deploy** — it starts immediately and runs 24/7

## What it does
- Fetches Delta Exchange perpetual futures list
- Scores each coin: Trend (EMA20/50/200) + Momentum (RSI) + Volatility (ATR) + Structure (breakout)
- CUSUM change-point detector feeds into Trend family
- Fires Telegram alert only when: family ≥ 3/4 AND R:R ≥ 2.0
- 30-minute cooldown per coin (no spam)

## Environment Variables
| Variable | Value |
|----------|-------|
| `TG_TOKEN` | Your Telegram bot token from @BotFather |
| `TG_CHAT` | Your Telegram chat ID from @userinfobot |
