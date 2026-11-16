"""Record native Python title-case exceptions; no source settings, DB, or network."""
import json
import unicodedata
from pathlib import Path
exceptions={chr(value):chr(value).title() for value in range(0x110000) if chr(value).title()!=chr(value).upper()}
output=Path(__file__).resolve().parents[2]/'src/modules/administration/python-titlecase.json'
output.write_text(json.dumps({'unicodeVersion':unicodedata.unidata_version,'exceptions':exceptions},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'unicodeVersion':unicodedata.unidata_version,'exceptionCount':len(exceptions)}))
