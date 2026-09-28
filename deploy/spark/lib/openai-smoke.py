#!/usr/bin/env python3
import json, os, sys, urllib.request
base=(sys.argv[1] if len(sys.argv)>1 else "http://127.0.0.1:8000/v1").rstrip("/")
served_model=sys.argv[2] if len(sys.argv)>2 else "text-api"
api_key=os.environ.get("SPARK_OPENAI_API_KEY", "")
headers={"authorization":f"Bearer {api_key}"} if api_key else {}

def get(path):
    req=urllib.request.Request(base.removesuffix("/v1")+path,headers=headers)
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=10) as r:
        return r.read().decode()

def post(payload):
    req=urllib.request.Request(base+"/chat/completions",data=json.dumps(payload).encode(),headers={"content-type":"application/json",**headers})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=90) as r:
        return json.loads(r.read())

models=json.loads(get("/v1/models"))
ids={x.get("id") for x in models.get("data",[]) if isinstance(x,dict)}
if served_model not in ids:
    raise SystemExit(f"model_not_listed:{served_model}")

chat=post({"model":served_model,"messages":[{"role":"user","content":"Reply with exactly SPARK_OK"}],"max_tokens":32,"temperature":0})
content=chat["choices"][0]["message"].get("content","")
if "SPARK_OK" not in content:
    raise SystemExit("chat_smoke_failed")

structured=post({
  "model":served_model,
  "messages":[{"role":"user","content":"Return a JSON object with ok=true and no extra keys."}],
  "max_tokens":64,"temperature":0,
  "response_format":{"type":"json_schema","json_schema":{"name":"spark_smoke","schema":{
    "type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":False
  }}}
})
raw=structured["choices"][0]["message"].get("content","").strip()
obj=json.loads(raw)
if obj != {"ok":True}: raise SystemExit("structured_output_failed")
print(json.dumps({"models":"PASS","model":served_model,"chat":"PASS","structured_output":"PASS"}))
