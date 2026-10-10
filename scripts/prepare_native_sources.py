"""Preserve a native 16-bit crop and reproducible display assets from HiRISE."""
import argparse, hashlib, json, shutil, subprocess, tempfile
from pathlib import Path
import numpy as np
from PIL import Image
ROOT = Path(__file__).resolve().parents[1]

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser(); p.add_argument('--source', type=Path, default=ROOT.parent/'data/planet-four/images/ESP_082142_0935_RED.JP2'); args=p.parse_args()
    decoder=shutil.which('opj_decompress')
    if not decoder: raise SystemExit('Install OpenJPEG (opj_decompress) to extract the original product')
    source=args.source.resolve(); out=ROOT/'public/sources'; out.mkdir(parents=True,exist_ok=True)
    native=ROOT/'assets/scout-native-16.png'; native.parent.mkdir(exist_ok=True)
    subprocess.run([decoder,'-i',str(source),'-o',str(native),'-d','2304,6976,4352,9024','-threads','2','-quiet'],check=True,stdout=subprocess.DEVNULL)
    pixels=np.asarray(Image.open(native)); valid=pixels[pixels>0]
    lo,hi=map(float,np.percentile(valid,[1,99.5])); display=np.uint8(np.clip((pixels.astype(np.float32)-lo)/max(1,hi-lo),0,1)**.92*255)
    Image.fromarray(display).save(out/'sample-native.png')
    Image.fromarray(display).resize((1024,1024),Image.Resampling.LANCZOS).save(out/'sample-preview.jpg',quality=92)
    meta={'id':'sample','name':'Spiders in Manhattan','observation':'ESP_082142_0935','width':2048,'height':2048,'bit_depth':16,'pixel_scale_m':.5,'raw_bounds':[2304,6976,4352,9024], 'coordinate_convention':'pixel edges; x right, y down; crop origin is (0,0)', 'original_sha256':digest(native),'product_sha256':digest(source),'display_sha256':digest(out/'sample-native.png'),'original_format':'png','source_note':'Unmodified native sample values extracted from the map-projected JP2; original full product retained separately','normalization':{'method':'percentile stretch','low':lo,'high':hi,'gamma':.92,'output_bits':8},'preview':'/sources/sample-preview.jpg','display':'/sources/sample-native.png','original':'/api/scout/sources/sample/original'}
    (out/'sample.json').write_text(json.dumps(meta,indent=2)+'\n')
    # Full-observation overview. ROI decoding will use the same display stretch.
    with tempfile.TemporaryDirectory() as t:
        raw=Path(t)/'overview.png'
        subprocess.run([decoder,'-i',str(source),'-o',str(raw),'-r','4','-threads','2','-quiet'],check=True,stdout=subprocess.DEVNULL)
        a=np.asarray(Image.open(raw),dtype=np.float32); v=a[a>0]; low,high=map(float,np.percentile(v,[1,99.5]))
        Image.fromarray(np.uint8(np.clip((a-low)/max(1,high-low),0,1)**.92*255)).save(out/'orbit-preview.jpg',quality=92)
    full={**meta,'id':'orbit','name':'Full HiRISE observation','width':17007,'height':16131,'raw_bounds':[0,0,17007,16131],'original_sha256':meta['product_sha256'],'original_format':'jp2','display_sha256':None,'native_focus':{'x':3328,'y':8000},'source_note':'Original map-projected HiRISE JP2; black gaps are missing image coverage, not negative terrain','normalization':{'method':'overview percentile stretch','low':low,'high':high,'gamma':.92,'output_bits':8},'preview':'/sources/orbit-preview.jpg','display':None,'original':'/api/scout/sources/orbit/original'}
    (out/'orbit.json').write_text(json.dumps(full,indent=2)+'\n')
    print(json.dumps({'native_pixels':list(pixels.shape),'sample_range':[lo,hi],'native_sha256':meta['original_sha256']}))
if __name__=='__main__': main()
