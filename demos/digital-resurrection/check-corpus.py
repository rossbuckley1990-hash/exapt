#!/usr/bin/env python3
"""Quality control for the corpus, independent of EXAPT and of any candidate.

A reference dBase reader, used for one purpose: to decide whether a .dbf and its GeoJSON-derived truth
describe the same data. The rule is fixed in advance and applied to every file: a pair is admissible
when the record counts are equal and at least 99% of comparable cell values agree. A pair that fails
is a corpus defect, because no correct reader could match it. EXAPT never sees this reader.
"""
import json, os, struct, sys

ROOT = os.path.dirname(os.path.abspath(__file__)) + "/corpus/"

def read_dbf(path):
    b = open(path, "rb").read()
    count, header, size = struct.unpack("<I", b[4:8])[0], struct.unpack("<H", b[8:10])[0], struct.unpack("<H", b[10:12])[0]
    fields, at = [], 32
    while b[at] != 0x0D:
        d = b[at:at + 32]
        fields.append((d[:11].split(b"\0")[0].decode(), d[16]))
        at += 32
    rows = []
    for r in range(count):
        rec, off = b[header + r * size:header + (r + 1) * size], 1
        row = {}
        for name, width in fields:
            row[name] = rec[off:off + width].decode("utf-8", "replace").strip()
            off += width
        rows.append(row)
    return rows

def same(a, b):
    if b is None:
        return a == ""
    if str(b).strip() == a:
        return True
    try:
        return abs(float(a) - float(b)) <= 1e-9 * max(1.0, abs(float(b))) * 1e3
    except ValueError:
        return False

manifest = json.load(open(ROOT + "MANIFEST.json"))
verdicts = []
for f in manifest["files"]:
    name = f["name"]
    rows = read_dbf(ROOT + name + ".dbf")
    truth = [json.loads(l) for l in open(ROOT + name + ".truth.ndjson")]
    cells = agree = 0
    if len(rows) == len(truth):
        for a, b in zip(rows, truth):
            for k in b:
                if k in a:
                    cells += 1
                    agree += same(a[k], b[k])
    ratio = agree / cells if cells else 0
    admissible = len(rows) == len(truth) and ratio >= 0.99
    verdicts.append({"name": name, "dbfRecords": len(rows), "truthRecords": len(truth), "cells": cells, "agreement": round(ratio, 5), "admissible": admissible})
    print(f"{'ok ' if admissible else 'BAD'} {name}: {len(rows)} vs {len(truth)} records, {ratio:.4%} of {cells} cells agree")
manifest["quality"] = {"rule": "equal record counts and at least 99% of comparable cells agree, by an independent reference reader", "verdicts": verdicts}
json.dump(manifest, open(ROOT + "MANIFEST.json", "w"), indent=2)
print(f"{sum(v['admissible'] for v in verdicts)} of {len(verdicts)} admissible")
