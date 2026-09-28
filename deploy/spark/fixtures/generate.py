#!/usr/bin/env python3
import math, shutil, struct, sys, wave
from pathlib import Path

source=Path(sys.argv[1]) if len(sys.argv)>1 else Path()
out=Path(sys.argv[2]) if len(sys.argv)>2 else Path("runtime/benchmarks/spark/fixtures")
out.mkdir(parents=True,exist_ok=True)

def tone(path,seconds,freq):
    rate=24000
    with wave.open(str(path),"wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        frames=bytearray()
        for i in range(int(rate*seconds)):
            value=int(0.10*32767*math.sin(2*math.pi*freq*i/rate))
            frames.extend(struct.pack("<h",value))
        w.writeframes(frames)

tone(out/"transport-short.wav",1.0,440)
tone(out/"transport-long.wav",8.0,220)

official=source/"assets/give_me_a_brief_introduction_to_the_great_wall.wav"
if official.exists():
    shutil.copy2(official,out/"speech-short.wav")
    with wave.open(str(official),"rb") as src:
        params=src.getparams(); frames=src.readframes(src.getnframes())
    with wave.open(str(out/"speech-long.wav"),"wb") as dst:
        dst.setparams(params); dst.writeframes(frames*5)
    print("official speech fixtures ready")
else:
    print(f"official speech fixture missing: {official}",file=sys.stderr)
