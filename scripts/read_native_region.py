"""Bounded JP2 region decoder. The original product is never changed."""
import json, math, os, shutil, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image
source,destination,raw_region,maximum,raw_norm=sys.argv[1:6]
target=json.loads(sys.argv[6]) if len(sys.argv)>6 else None
r=json.loads(raw_region); norm=json.loads(raw_norm); maximum=int(maximum)
ratio=max(r['width'],r['height'])/maximum
level=max(0,min(5,int(math.floor(math.log2(max(1,ratio))))))
factor=2**level
# Align the decoder grid, then sample the requested rectangle using an explicit
# fractional box. Odd source origins must not move when the level changes.
left=math.floor(r['x']/factor)*factor; top=math.floor(r['y']/factor)*factor
right=math.ceil((r['x']+r['width'])/factor)*factor; bottom=math.ceil((r['y']+r['height'])/factor)*factor
with tempfile.TemporaryDirectory() as t:
    decoded=Path(t)/'region.png'
    subprocess.run([shutil.which('opj_decompress') or 'opj_decompress','-i',source,'-o',str(decoded),'-d',','.join(map(str,[left,top,right,bottom])),'-r',str(level),'-threads','2','-quiet'],check=True,stdout=subprocess.DEVNULL,timeout=40)
    pixels=np.asarray(Image.open(decoded),dtype=np.float32)
    image=Image.fromarray(np.uint8(np.clip((pixels-norm['low'])/max(1,norm['high']-norm['low']),0,1)**norm['gamma']*255))
    scale=min(1,maximum/max(r['width'],r['height']))
    box=((r['x']-left)/factor,(r['y']-top)/factor,min(image.width,(r['x']+r['width']-left)/factor),min(image.height,(r['y']+r['height']-top)/factor))
    size=(target['width'],target['height']) if target else (max(1,math.floor(r['width']*scale+.5)),max(1,math.floor(r['height']*scale+.5)))
    image=image.resize(size,Image.Resampling.LANCZOS,box=box)
    tmp=destination+'.tmp'; image.save(tmp,format='PNG'); os.replace(tmp,destination)
