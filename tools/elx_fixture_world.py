"""What the elx fixture does with the world's own blocks: the calls they make.

TASKS-flows.md "The fixture", widened by TASKS-live.md. A process server runs
a World block by calling the world with the job's key; `motion` and
`interact` (LV.3) are composites over the same calls. The fixture runs each
block it knows as the one call its composite makes, passes values along the
wires between such blocks, and interprets nothing else. A flow that passed
against it has passed against the fixture only.
"""

import json
import xml.etree.ElementTree as ET


def _json(text, fallback):
    try:
        return json.loads(text) if text not in (None, '') else fallback
    except (TypeError, ValueError):
        return text


def _num(v, fallback=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return fallback


def _bool(v, fallback=True):
    if v in (None, ''):
        return fallback
    return v is True or str(v).lower() == 'true'


def _motion(value):
    return lambda c: ('port_write', {'p_instance': c.get('Object', ''),
                                     'p_port': c.get('Port', ''),
                                     'p_value': json.dumps(value(c))})


def _to(keys):
    return lambda c: {'to': {k.lower(): _num(c.get(k)) for k in keys},
                      'over_s': _num(c.get('Over'), 1.0)}


# (plugin, block id) -> inputs -> (rpc, args).
CALLS = {
    ('world', 'port.write'): lambda c: ('port_write', {
        'p_instance': c.get('Object', ''), 'p_port': c.get('Port', ''),
        'p_value': c.get('Value', '')}),
    ('world', 'port.read'): lambda c: ('live_of', {'p_instance': c.get('Object', '')}),
    ('world', 'mover.set'): lambda c: ('mover_set', {
        'p_mover': c.get('Mover', ''), 'p_fields': _json(c.get('Fields'), {})}),
    ('world', 'events.since'): lambda c: ('world_events', {'p_after': int(_num(c.get('After')))}),
    ('world', 'clock.now'): lambda c: ('world_clock', {}),
    ('motion', 'part.move-to'): _motion(_to(['X', 'Y', 'Z'])),
    ('motion', 'part.turn-to'): _motion(_to(['Yaw', 'Pitch', 'Roll'])),
    ('motion', 'part.scale-to'): _motion(lambda c: {
        'to': {'scale': _num(c.get('Scale'), 1.0)}, 'over_s': _num(c.get('Over'), 1.0)}),
    ('motion', 'part.follow-path'): _motion(lambda c: {
        'route_m': _json(c.get('Route'), []), 'speed': _num(c.get('Speed'), 1.0),
        'loop': _bool(c.get('Loop'), False)}),
    ('motion', 'part.spin'): _motion(lambda c: {
        'axis': c.get('Axis') or 'y', 'rpm': _num(c.get('RPM'), 6.0)}),
    ('motion', 'part.stop'): _motion(lambda c: {'to': {}, 'over_s': 0}),
    ('interact', 'trigger.on'): lambda c: ('triggers_since', {
        'p_after': int(_num(c.get('After'))), 'p_instance': c.get('Object', ''),
        'p_kind': c.get('Kind') or 'near'}),
    ('interact', 'hold.give'): lambda c: ('give', {
        'p_instance': c.get('Object', ''), 'p_to': c.get('To', '')}),
    ('interact', 'hold.take'): lambda c: ('take', {'p_instance': c.get('Object', '')}),
    ('interact', 'say.post'): lambda c: ('post_note', {
        'p_instance': c.get('Object', ''), 'p_text': c.get('Text', '')}),
}

# What a block's outputs are, from the status and the answer.
ANSWERS = {
    'world_events': lambda s: {'Events': s.get('events'), 'Last ID': s.get('last_id')},
    'triggers_since': lambda s: {'Fired': s.get('fired'), 'Events': s.get('events'),
                                 'Last ID': s.get('last_id')},
    'world_clock': lambda s: {'Seconds': s},
    'live_of': lambda s: {'Value': s},
}


def _constants(node):
    out = {}
    for c in node.findall('constant'):
        v = c.find('.//value')
        out[c.get('port', '')] = (v.text or '') if v is not None else ''
    return out


def _wires(root):
    """(node, input) -> (node, output) for every net between two nodes."""
    out = {}
    for net in root.findall('net'):
        ends = [(c.get('node'), c.get('port')) for c in net.findall('connection')]
        if len(ends) >= 2 and all(p for _, p in ends):
            src = ends[0]
            for dst in ends[1:]:
                out[dst] = src
    return out


def run_flow(elx, call):
    """Every block the fixture knows, once, in an order the wires allow.
    `call(rpc, args)` -> (status, said). Returns [(block name, rpc, status, said)]."""
    root = ET.fromstring(elx)
    known = {n.get('name'): n for n in root.findall('node')
             if (n.get('plugin'), n.get('id')) in CALLS}
    wires = _wires(root)
    done, ran = {}, []
    while len(done) < len(known):
        ready = [name for name in known if name not in done and all(
            src[0] in done for (dst, _), src in wires.items()
            if dst == name and src[0] in known)]
        if not ready:
            break
        for name in ready:
            node = known[name]
            given = _constants(node)
            for (dst, port), (src, out) in wires.items():
                if dst == name and src in known and out in done[src]:
                    given[port] = done[src][out]
            if not _bool(given.get('When')):
                done[name] = {}
                continue
            rpc, args = CALLS[(node.get('plugin'), node.get('id'))](given)
            status, said = call(rpc, args)
            ran.append((name, rpc, status, said))
            answer = _json(said, None) if 200 <= status < 300 else None
            done[name] = {'OK': 200 <= status < 300,
                          **(ANSWERS.get(rpc, lambda s: {})(answer)
                             if isinstance(answer, (dict, float, int)) else {})}
    return ran
