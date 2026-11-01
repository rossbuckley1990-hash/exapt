"""Audit oracle: independent implementation, no EXAPT imports and no candidate code.
The six quantities are selected metrics, not a physical-memory conservation proof.
"""
import json, re, sys

NAMES = {
    'Pages free': 'memory.free_bytes', 'Pages active': 'memory.active_bytes',
    'Pages inactive': 'memory.inactive_bytes', 'Pages speculative': 'memory.speculative_bytes',
    'Pages wired down': 'memory.wired_bytes', 'Pages occupied by compressor': 'memory.compressor_bytes',
}

def expected(text):
    lines = [s for s in text.splitlines() if s.strip()]
    if not lines:
        raise ValueError('empty input')
    header = re.fullmatch(r'Mach Virtual Memory Statistics: \(page size of ([0-9]+) bytes\)', lines[0])
    if not header or int(header[1]) <= 0:
        raise ValueError('invalid header/page size')
    page = int(header[1])
    seen = {}
    for line in lines[1:]:
        record = re.fullmatch(r'(.*?):\s*([0-9]+)\.?\s*', line)
        if not record:
            raise ValueError('invalid statistic')
        label = record[1].strip()
        if label in seen:
            raise ValueError('duplicate statistic')
        seen[label] = int(record[2])
    if not NAMES.keys() <= seen.keys():
        raise ValueError('missing metric')
    return '\n'.join(json.dumps({'metric': metric, 'value': seen[label] * page}, separators=(',', ':')) for label, metric in NAMES.items()) + '\n'

if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'output': expected(sys.stdin.read())}))
    except ValueError as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
