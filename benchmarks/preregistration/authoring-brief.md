You are writing a test fixture for a study of software tools. Work only in the current directory. Use Node.js with no dependencies.

Invent a small, realistic, self-contained command-line toolchain for this domain: {{DOMAIN}}. Choose unusual but plausible file formats of your own. Do not use CSV with a comma, or plain JSON, on both sides.

Write these files:

- `programs/<producer>`: an executable that reads a raw input format from stdin and writes format P to stdout.
- `programs/<consumer>`: an executable that strictly validates format Q on stdin, exits non-zero on anything invalid, and prints a domain report to stdout.
- Optionally, other programs a real toolchain would have. Include a program that writes P back out from Q only if that would be natural for this domain.
- Every program answers `--help` with honest documentation of what it reads and writes, including units and meanings.
- `sample/input.txt`: a realistic raw input of 10 to 20 records.
- `reference.mjs`: exports `adapter(pText)`, returning the Q text. This file is the only place the P-to-Q conversion may exist. Nothing in `programs/` may perform it. It should need real work: at least a change of syntax and two value-level conversions, one of which is documented only in program help text.
- `hidden.mjs`: exports `inputs()`, returning an array of 6 further raw inputs in the same format as the sample, with 8 to 40 records each, covering different values from the sample.
- `task.json`: `{"outcome": "...", "target": "<consumer program name>", "sample": "sample/input.txt"}`, where outcome is one or two plain sentences saying what a user wants produced, written as a user would say it. It must not describe the conversion.

Make every program executable. Run the toolchain once to confirm that `producer | reference | consumer` works on the sample and that the consumer refuses the producer's direct output. Finish with one line saying it works.
