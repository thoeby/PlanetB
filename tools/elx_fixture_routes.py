"""elx_fixture_routes.py — the routes and the memory of tools/elx-fixture.py.

Split out of it only for size (CLAUDE.md: files < 400 lines). Everything the
docstring there says holds here.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

LOCK = threading.Lock()
STATE = {'process': {}, 'service': {}, 'job': {}, 'report': {}, 'next': 1,
         'plugins': [], 'settings': {'server.control.port': ('integer', '8080')},
         'calls': [], 'version': 'fixture-1'}


def new_id():
    STATE['next'] += 1
    return str(STATE['next'])


def envelope(data='', code=0, message=''):
    return ('<elx_api_msg type="response" version="1"><data>%s</data>'
            '<error><code>%d</code><message language="en">%s</message></error>'
            '</elx_api_msg>' % (data, code, escape(message)))


def document(text):
    return ('<document content-type="0" encoding-type="1"><content>%s</content>'
            '</document>' % escape(text))


def body_fields(raw, ctype):
    """A write body, JSON or XML — the fixture takes both (see the docstring)."""
    text = raw.decode('utf-8') if raw else ''
    if not text.strip():
        return {}
    if 'json' in ctype or text.lstrip().startswith(('{', '[')):
        return json.loads(text)
    root = ET.fromstring(text)
    out = {c.tag: (c.text or '') for c in root if len(c) == 0}
    out['_xml'] = root
    return out


def tag(name, value):
    return '<%s>%s</%s>' % (name, escape(str(value)), name)


def process_xml(p):
    return '<process>%s%s%s</process>' % (tag('id', p['id']), tag('name', p['name']),
                                          tag('group_flat', p.get('group', '')))


def service_xml(s):
    return ('<service id="%s" plugin="%s" component-id="%s">%s%s</service>'
            % (s['id'], escape(s['plugin_id']), escape(s['component_id']),
               tag('name', s['name']), inner(s.get('parameters', ''), 'parameters')))


def inner(xml_text, wrapper):
    """The children of a <wrapper>…</wrapper> string, or '' — how the
    reference sends inputs and parameters and how it reads them back."""
    m = re.search(r'<%s[^>]*>(.*)</%s>' % (wrapper, wrapper), xml_text or '', re.S)
    return m.group(1) if m else ''


def trigger_xml(t):
    fields = ''.join(tag(k, str(v).lower() if isinstance(v, bool) else v)
                     for k, v in t.items() if k != 'type')
    return '<trigger type="%s">%s</trigger>' % (escape(t.get('type', '')), fields)


def job_xml(j):
    proc = STATE['process'].get(str(j.get('process_id', '')), {})
    return ('<job id="%s">%s%s<process id="%s"/>%s<config>%s%s</config>%s%s</job>'
            % (j['id'], tag('name', j['name']), tag('group_flat', j.get('group_flat', '')),
               j.get('process_id', ''), tag('process_name', proc.get('name', '')),
               tag('log_level', j.get('cfg_log_level', 'info')),
               tag('store_report', j.get('cfg_store_report', 'always')),
               inner(j.get('inputs', ''), 'inputs'),
               ''.join(trigger_xml(t) for t in j.get('triggers', []))))


def report_xml(r):
    return ('<report id="%s" job_id="%s">%s%s%s</report>'
            % (r['id'], r['job_id'], tag('job_name', r['job_name']),
               tag('timestamp', r['timestamp']), tag('result_code', r['code'])))


# ------------------------------------------------------------------ running

def input_values(inputs_xml):
    out = {}
    try:
        root = ET.fromstring(inputs_xml or '<inputs/>')
    except ET.ParseError:
        return out
    for el in root.iter('input'):
        v = el.find('.//value')
        out[el.get('name', '')] = (v.text or '') if v is not None else ''
    return out


def constants(node):
    out = {}
    for c in node.findall('constant'):
        v = c.find('.//value')
        out[c.get('port', '')] = (v.text or '') if v is not None else ''
    return out


def call_world(world, key, fn, args):
    req = urllib.request.Request(
        world.rstrip('/') + '/rpc/' + fn, data=json.dumps(args).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, res.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()
    except OSError as err:
        return 0, str(err)


def run_job(job):
    """One run: every World Write Port block, in document order."""
    values = input_values(job.get('inputs', ''))
    world, key = values.get('world', ''), values.get('world_key', '')
    proc = STATE['process'].get(str(job.get('process_id', '')))
    lines, code = [], 0
    if not proc:
        return 1, ['no such process']
    for node in ET.fromstring(proc['elx']).iter('node'):
        if node.get('plugin') != 'world' or node.get('id') != 'port.write':
            continue
        c = constants(node)
        status, said = call_world(world, key, 'port_write', {
            'p_instance': c.get('Object', ''), 'p_port': c.get('Port', ''),
            'p_value': c.get('Value', '')})
        STATE['calls'].append({'job': job['name'], 'status': status, 'said': said})
        lines.append('%s: %s %s' % (node.get('name'), status, said[:200]))
        if status >= 300 or status == 0:
            code = 1
    return code, lines or ['nothing to do']


def record_run(job):
    code, lines = run_job(job)
    rid = new_id()
    stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    body = '<report>%s%s<log>%s</log></report>' % (
        tag('job', job['name']), tag('result_code', code),
        ''.join(tag('line', ln) for ln in lines))
    STATE['report'][rid] = {'id': rid, 'job_id': job['id'], 'job_name': job['name'],
                            'timestamp': stamp, 'code': code, 'body': body}
    return STATE['report'][rid]


# ------------------------------------------------------------------ routes

def page(kind, query, render):
    rows = list(STATE[kind].values())
    offset = int(query.get('offset', ['0'])[0] or 0)
    limit = int(query.get('limit', ['100'])[0] or 100)
    return ''.join(render(r) for r in rows[offset:offset + limit])


def named(query, fields):
    return (query.get('name', [''])[0] or fields.get('name') or '').strip()


def routes(method, parts, query, fields, raw):
    """(status, data) for one request. parts are the path after /api/v1."""
    head = parts[0] if parts else ''
    one = parts[1] if len(parts) > 1 else None
    if head == 'system':
        return system(method, one)
    if head == 'process':
        return process(method, one, parts, query, fields, raw)
    if head == 'service':
        return service(method, one, query, fields)
    if head == 'job':
        return job(method, one, parts, query, fields)
    if head == 'report':
        return report(method, one, query)
    return 400, None


def system(method, one):
    if one == 'status':
        return 200, '<thread_pool><size>8</size></thread_pool>' + tag('version', STATE['version'])
    if one == 'plugins':
        return 200, ''.join('<descriptor>%s</descriptor>' % escape(x) for x in STATE['plugins'])
    if one == 'settings' and method == 'GET':
        return 200, ''.join('<setting key="%s" value_type="%s">%s</setting>'
                            % (k, t, escape(v)) for k, (t, v) in STATE['settings'].items())
    return (200, '') if one == 'settings' else (400, None)


def process(method, one, parts, query, fields, raw):
    procs = STATE['process']
    if method == 'GET' and one is None:
        return 200, page('process', query, process_xml)
    if one == 'exists':
        want = query.get('name', [''])[0]
        return 200, tag('exists', 'true' if any(p['name'] == want for p in procs.values())
                        else 'false')
    if one == 'validate':
        try:
            ET.fromstring(raw.decode())
            return 200, ''
        except ET.ParseError as err:
            return 200, '<errors><error><message>%s</message></error></errors>' % escape(str(err))
    if one == 'duplicate':
        src = procs.get(str(fields.get('id', '')))
        if not src:
            return 404, None
        pid = new_id()
        procs[pid] = {**src, 'id': pid, 'name': fields.get('new_name') or 'Copy'}
        return 200, process_xml(procs[pid])
    if method == 'PUT' and one is None:
        name = named(query, {})
        if not name or any(p['name'] == name for p in procs.values()):
            return 409, None
        pid = new_id()
        procs[pid] = {'id': pid, 'name': name, 'elx': raw.decode()}
        return 200, process_xml(procs[pid])
    p = procs.get(one or '')
    if not p:
        return 404, None
    if method == 'GET' and len(parts) > 2 and parts[2] == 'download':
        return 200, document(p['elx']) + tag('id', p['id'])
    if method == 'PATCH':
        if raw.strip():
            p['elx'] = raw.decode()
        p['name'] = named(query, {}) or p['name']
        return 200, process_xml(p)
    if method == 'DELETE':
        del procs[one]
        return 200, ''
    return 400, None


def service(method, one, query, fields):
    svcs = STATE['service']
    if method == 'GET' and one is None:
        return 200, page('service', query, service_xml)
    if one == 'exists':
        want = query.get('name', [''])[0]
        return 200, tag('exists', 'true' if any(s['name'] == want for s in svcs.values())
                        else 'false')
    if method == 'POST' and one is None:
        sid = new_id()
        svcs[sid] = {'id': sid, **{k: fields.get(k, '') for k in
                                   ('name', 'plugin_id', 'component_id', 'parameters')}}
        return 200, service_xml(svcs[sid])
    if one not in svcs:
        return 404, None
    if method == 'PATCH':
        svcs[one].update({k: v for k, v in fields.items() if not k.startswith('_')})
        return 200, ''
    if method == 'DELETE':
        del svcs[one]
        return 200, ''
    return 400, None


def job(method, one, parts, query, fields):
    jobs = STATE['job']
    if method == 'GET' and one is None:
        return 200, page('job', query, job_xml)
    if method == 'POST' and one is None:
        jid = new_id()
        jobs[jid] = {'id': jid, **{k: v for k, v in fields.items() if not k.startswith('_')}}
        return 200, job_xml(jobs[jid])
    if one == 'run':
        return 400, None
    j = jobs.get(one or '')
    if not j:
        return 404, None
    if len(parts) > 2 and parts[2] == 'run' and method == 'POST':
        r = record_run(j)
        return 200, report_xml(r)
    if method == 'GET':
        return 200, job_xml(j)
    if method == 'PATCH':
        j.update({k: v for k, v in fields.items() if not k.startswith('_')})
        return 200, ''
    if method == 'DELETE':
        # A real server that is asked to forget a job may still run it once
        # more; /__fixture/replay stands in for that (story 38).
        STATE.setdefault('gone', {})[j['name']] = j
        del jobs[one]
        return 200, ''
    return 400, None


def report(method, one, query):
    reps = STATE['report']
    if method == 'GET' and one is None:
        want = query.get('job_id', [None])[0]
        return 200, ''.join(report_xml(r) for r in reps.values()
                            if want in (None, '', r['job_id']))
    if method == 'GET':
        r = reps.get(one)
        return (200, document(r['body'])) if r else (404, None)
    if method == 'DELETE':
        rid = query.get('id', [None])[0]
        if rid:
            reps.pop(rid, None)
        else:
            reps.clear()
        return 200, ''
    return 400, None
