#!/usr/bin/env python3
"""Derive per-test truth from Node's JUnit reporter, using only the standard XML parser.

The TAP and JUnit files come from the same `node --test` run, written by two separate reporters in
Node itself. Nothing here is available to EXAPT or to the model. A test case is a leaf; suites and
parent tests are containers. `suite` is the chain of containers, joined with " > ".
"""
import json, os, sys
import xml.etree.ElementTree as ET

def status(case):
    for child in case:
        if child.tag == "failure":
            return "fail"
        if child.tag == "skipped":
            return "todo" if child.attrib.get("type") == "todo" else "skip"
    return "pass"

def walk(node, chain, out):
    for child in node:
        if child.tag == "testsuite":
            walk(child, chain + [child.attrib["name"]], out)
        elif child.tag == "testcase":
            out.append({"suite": " > ".join(chain), "name": child.attrib["name"], "status": status(child)})

for path in sys.argv[1:]:
    out = []
    walk(ET.parse(path).getroot(), [], out)
    with open(path[:-4] + ".truth.ndjson", "w") as f:
        for row in out:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(os.path.basename(path), len(out))
