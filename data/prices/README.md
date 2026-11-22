# Daily closes

Source: Yahoo Finance (via yfinance), downloaded 2026-11-21 UTC, last bar 2026-11-20.
Closes are Yahoo's adjusted closes (auto_adjust=True). For indices this equals the price close (no dividends). For the ETFs it includes reinvested distributions.
Dates are the exchange's local trading date.

| file | ticker | name | first date | rows |
|---|---|---|---|---|
| sp500.csv | ^GSPC | S&P 500 | 1927-12-30 | 24841 |
| nyse_composite.csv | ^NYA | NYSE Composite | 1965-12-31 | 15324 |
| nasdaq_composite.csv | ^IXIC | NASDAQ Composite | 1971-02-05 | 14067 |
| sti.csv | ^STI | Straits Times Index | 1987-12-28 | 9722 |
| shanghai_composite.csv | 000001.SS | Shanghai Composite | 1997-07-02 | 7119 |
| shenzhen_component.csv | 399001.SZ | Shenzhen Component | 1997-08-22 | 7086 |
| es3_spdr_sti_etf.csv | ES3.SI | SPDR STI ETF | 2008-01-02 | 4738 |
| a35_abf_sg_bond_etf.csv | A35.SI | ABF Singapore Bond Index ETF | 2008-01-02 | 4738 |
| mbh_nikko_sgd_ig_bond_etf.csv | MBH.SI | Nikko AM SGD IG Bond ETF | 2018-08-24 | 2073 |

Gaps: Shanghai and Shenzhen start in 1997 on Yahoo (indices began 1990/1991). No Singapore unit-trust NAV history (not on Yahoo).
Rebuild: /mnt/project-files/market-phases/build.py
