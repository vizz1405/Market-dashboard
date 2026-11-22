import sys, json, numpy as np, pandas as pd
from signals import load
def stats(s, depths=(0.05,0.10,0.15)):
    v=s.values; hi=pd.Series(v).rolling(252,min_periods=1).max().values
    out={}
    # current
    cur_hi_i=int(np.argmax(v[-252:]))+len(v)-252 if len(v)>=252 else int(np.argmax(v))
    cur_dd=v[-1]/v[cur_hi_i]-1
    for d in depths:
        n=bear=0; i=0; recov=[]
        while i<len(v)-1:
            if v[i]<=hi[i]*(1-d):
                H=hi[i]; j=i; hit=False
                while j<len(v) and v[j]<H and v[j]>H*0.8: j+=1
                if j==len(v): break  # current, unresolved episode
                hit = v[j]<=H*0.8
                n+=1; bear+=hit
                if not hit: recov.append(j-i); i=j+1; continue
                j+=1
                while j<len(v) and v[j]<hi[j]: j+=1   # wait for a fresh 1-year high
                i=j+1; continue
            i+=1
        out[f"{int(d*100)}%"]=dict(episodes=n, became_bear=bear, rate=bear/n if n else None,
             median_days_to_recover_if_not=float(np.median(recov)) if recov else None)
    return dict(current_dd_from_1y_high=float(cur_dd), high_date=str(s.index[cur_hi_i].date()), stats=out)
res={}
for m in sys.argv[1:]:
    res[m]=stats(load(f"/mnt/project-files/data/prices/{m}.csv"))
print(json.dumps(res,indent=1,default=float))
