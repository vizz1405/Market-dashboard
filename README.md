# Market Phases dashboard

A phone and laptop dashboard for the bull and bear phase study: current entry and exit signals, alerts, forecasts, phase history and per-ticker research, with plain-English takeaways under each chart.

- `site/` is the static web app (no build step). Add it to your phone's home screen for an app-like view.
- `pipeline/signals.py`, `pipeline/corr.py` and `pipeline/build.py` are the project's rule and phase code, copied unchanged.
- `pipeline/make_site_data.py` runs that code and writes `site/data/*.json`. It only adds presentation: chart series, flip levels for the coming month end, alerts and takeaways.
- `pipeline/fetch_prices.py` refreshes `data/prices/*.csv` from Yahoo Finance, keeping the old file if a download fails.
- `.github/workflows/refresh.yml` runs at 7:35 AM Singapore time, Tuesday to Saturday, then publishes to GitHub Pages. Run it any time from the Actions tab ("Run workflow").
- `pipeline/watchlist.json` lists the watchlist (NVDA, SPCX, crypto names, bitcoin) with its analyst snapshot; the pipeline recomputes entry lines, the bitcoin gate, and exit and trim flags each morning into `site/data/watchlist.json`.
- `site/data/research.json` and `site/data/plan.json` hold the research notes and the monthly plan; edit them to update those pages.

Rules (unchanged): US exits follow the S&P 500 dual rule (out only when the price is below its 10-month average and below its level 12 months ago); SGX exits follow the STI 10-month average; China A exits follow the Shanghai 10-month average. Signals are read on month-end closes. Cash earns 0.5 x the US 3-month T-bill as a stand-in for an SGD deposit.

Educational analysis, not personal advice.

Local preview: `python3 -m http.server -d site 8000`, then open http://localhost:8000.
