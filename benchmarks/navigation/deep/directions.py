"""Compare semantically attributed directions without requiring an intervening row swap."""
import argparse
from collections import Counter
import json
from pathlib import Path
from statistics import median
import sys

HERE = Path(__file__).resolve().parent

from events import Run, check, elapsed, focus, norm, start


def marks(run, token):
    path = run.path / 'native-probe.json'
    if not path.is_file():
        return []
    lines = json.loads(path.read_text())['lines']
    return [json.loads(line.split(token, 1)[1]) for line in lines if token in line]

def visible_coverage(value):
    offset = value['offset']
    return value['visible'] == [row for row in range(18) if row*200 < offset+680 and row*200+188 > offset]

def same_focus(value, state):
    color = value.get('color', 0) & 0xffffffff
    return value['focus'] == [state['id']] and color == 0x3456c0ff

def marked_complete(transaction, state):
    values = [mark['value'] for mark in transaction['marks']]
    correct_layout = [value for value in values if focus(value, state, paint=False)]
    return bool(correct_layout and any(same_focus(v, state) for v in values) and
                all(visible_coverage(v) for v in correct_layout))

def move(run, key, state):
    base = start(key)
    bridge = run.key_transfer(key)
    row = {'id':state['id'], 'offset':state['offset'], 'keyNs':base,
           'bridge':bridge, 'keyToDispatchMs':elapsed(base, bridge['receive'])}
    try:
        bridge, anchor, applied, notification = run.direction(key)
        if run.marked:
            check(marked_complete(applied, state), 'expected focus, paint, clip, scroll or visible rows missing from linked apply')
        return {**row,'focus':anchor,'correct':applied,'notification':notification,
                'keyToCorrectSwapMs':elapsed(base,applied['swap']),
                'nativeApplyMs':elapsed(base,applied['apply'])}
    except (ValueError, TypeError, KeyError) as error:
        row['flowError'] = str(error)
        return row

def activation(launch, expected):
    return launch.activations == [dict(id=step['id'],offset=step['offset']) for step in expected]

def release_once(run, key):
    event_keys = [r for r in run.rows if r['name'] == 'keyEvent']
    i = next(i for i,r in enumerate(event_keys) if r['id'] == key['id'])
    return (i+1 < len(event_keys) and event_keys[i+1]['press'] == '0' and
            norm(event_keys[i+1]['key']) == norm(key['key']))

def linked_keys(run):
    check(run.keys_match, 'host key-down sequence and device trace differ')
    check(all(c['ok'] for c in run.replay['commands']), 'input transport failed')
    return run.keys

def replay_stage_pass(stage):
    return bool(stage and not stage.get('error'))

def analyze_frozen(run, plan):
    keys = linked_keys(run)
    rs = run.replay['trials']
    js_keys = marks(run, 'RNR_WINDOW_KEY|')
    phases = marks(run, 'RNR_WINDOW_PHASE|')
    if js_keys:
        check([norm(j['key']) for j in js_keys] == run.key_names, 'JS marker keys differ from Perfetto')
    actual_activation = activation(run, [t['expected'] for t in rs if t.get('burst')]) if run.marked else None
    output = []
    for t in rs:
        result = {'route':t['route'], 'repeat':t['repeat'], 'trial':t['number'],
                  'detail':replay_stage_pass(t.get('detail')),
                  'back':replay_stage_pass(t.get('restoration')), 'activation':actual_activation,
                  'error':t.get('error') or t.get('detail',{}).get('error') or t.get('restoration',{}).get('error')}
        output.append(result)
        if not t.get('burst'):
            continue
        k = {phase:keys[i] for phase,i in t['burst'].items()}
        ts = {phase:start(key) for phase,key in k.items()}
        first = move(run,k['first'],plan['first'])
        second = move(run,k['second'],t['expected'])
        latency_select = elapsed(ts['select'],run.key_transfer(k['select'])['receive'])
        first_window = None
        timing = 'unlinked'
        if 'correct' in first and second['bridge']['receive'] is not None:
            first_window = next((d for d in run.native if first['correct']['apply'] < d['start'] < second['bridge']['receive']), None)
            if first_window:
                timing = 'overlap' if first['correct']['apply'] < ts['second'] < first_window['swap'] else 'settled' if first_window['swap'] < ts['second'] else 'missed'
            elif first['correct']['apply'] < ts['second']:
                timing = 'before-next-transaction'
        result.update(first=first,second=second,SelectKeyToDispatchMs=latency_select,
                      SelectGesture=release_once(run,k['select']), firstWindow=first_window, timing=timing,
                      deviceSpacingMs=elapsed(ts['first'],ts['second']),
                      deviceSecondToSelectMs=elapsed(ts['second'],ts['select']),
                      firstToCorrectSecondSwapMs=elapsed(ts['first'],second.get('correct',{}).get('swap')))
        if js_keys:
            stamps = {phase:js_keys[i]['at'] for phase,i in t['burst'].items()}
            window = [p for p in phases if stamps['first'] <= p['start'] < stamps['back']]
            first_replacement = next((p for p in window if (p['first'],p['last'],p['nextFirst'],p['nextLast']) == (0,11,1,12)),None)
            result['firstReplacementBeforeBack'] = first_replacement
            result['windowPhasesBeforeBack'] = window
            result['attribution'] = {
                'firstWindowAfterFirstCallbackMs': (first_replacement['start']-stamps['first']) if first_replacement else None,
                'secondCallbackAfterWindowReturnMs': (stamps['second']-first_replacement['returned']) if first_replacement else None,
                'secondCallbackBeforeWindowStart': first_replacement is None or stamps['second'] < first_replacement['start'],
                'directNativeFocus': all(any(m['kind']=='focus' and m['value']['focus']==[step['id']] for m in move.get('focus',{}).get('marks',[])) for move,step in [(first,plan['first']),(second,t['expected'])]),
                'seedRowsInSecondCorrectApply': any(m['value']['rows']==plan['first']['rowsBefore'] for m in second.get('correct',{}).get('marks',[])),
            }
    return output

def analyze_stress(run):
    result = run.replay
    keys = linked_keys(run)
    indexes = result.get('directions',[])
    first_key = start(keys[indexes[0]]) if indexes else None
    end_key = start(keys[result['back']]) if 'back' in result else float('inf')
    focused_marks = [(d,m['value']['focus'][0]) for d in run.native if first_key is not None and first_key<=d['apply']<end_key
                     for m in d['marks'] if m['kind']=='focus' and len(m['value']['focus'])==1]
    moves = []
    for index,key_index in enumerate(indexes):
        expected = result['steps'][index]
        key = keys[key_index]
        observed = move(run,key,expected)
        if 'keyToCorrectSwapMs' in observed:
            observed['linkedSwapCandidateMs'] = observed.pop('keyToCorrectSwapMs')
        observed['spacingMs'] = elapsed(start(keys[indexes[index-1]]),start(key)) if index else None
        if run.marked:
            focus_native = next((d for d,id in focused_marks if id==expected['id'] and d['apply']>=start(key)),None)
            if focus_native:
                following = next((d for d,id in focused_marks if id!=expected['id'] and d['applyStart']>focus_native['apply']),None)
                before = following['applyStart'] if following else end_key
                correct = next((d for d in run.native if focus_native['apply'] <= d['apply'] < before
                                and marked_complete(d,expected)),None)
                if correct:
                    render, swap = run.swap_after(correct['apply'],before)
                    observed['directCorrect'] = correct
                    observed['directKeyToEligibleSwapMs'] = elapsed(start(key),swap if swap is not None and swap<before else None)
                    observed['directRenderNs'] = render
                observed['directFocus'] = focus_native
        moves.append(observed)
    return {'route':result['route'], 'moves':moves, 'complete':result['complete'],
            'focusOrder': [id for _,id in focused_marks],
            'expectedFocusOrder':[step['id'] for step in result['steps']],
            'detail':result.get('detail'),'back':result.get('restoration'),
            'finalWindow':result.get('finalWindow'),'settledBeforeSelect':result.get('settled'),
            'activation':activation(run,[result['steps'][-1]]) if run.marked else None,
            'observedActivations':run.activations, 'error':result.get('error'),
            'SelectGesture': release_once(run,keys[result['select']]) if 'select'in result else None,
            'SelectKeyToDispatchMs': elapsed(start(keys[result['select']]), run.key_transfer(keys[result['select']])['receive']) if 'select' in result else None,
            'phases':marks(run,'RNR_WINDOW_PHASE|')}



def assess(data, marked):
    """A settled destination alone cannot qualify a rapid route."""
    if isinstance(data, list):
        return bool(data) and all(
            trial.get("detail") and trial.get("back") and trial.get("SelectGesture")
            and trial.get("first", {}).get("keyToCorrectSwapMs") is not None
            and trial.get("second", {}).get("keyToCorrectSwapMs") is not None
            and (not marked or trial.get("activation") is True)
            for trial in data
        )
    if not data["complete"] or not all(replay_stage_pass(data.get(key)) for key in ("detail", "back", "finalWindow")):
        return False
    if data["route"] == "long" and not replay_stage_pass(data.get("settledBeforeSelect")):
        return False
    if not data["SelectGesture"] or len(data["moves"]) != len(data["expectedFocusOrder"]):
        return False
    if marked:
        return (data["activation"] and data["focusOrder"] == data["expectedFocusOrder"]
                and all(m.get("directKeyToEligibleSwapMs") is not None for m in data["moves"]))
    return all(m.get("linkedSwapCandidateMs") is not None for m in data["moves"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        run = Run(args.run)
        if "trials" in run.replay:
            data = analyze_frozen(run, json.loads((HERE / "plan.json").read_text()))
        else:
            data = analyze_stress(run)
        passed = bool(run.replay["complete"] and assess(data, run.marked))
        report = {"passed": passed, "status": "PASS" if passed else "FAIL",
                  "sha256": run.replay["sha256"], "marked": run.marked,
                  "firstVisibleHighlight": None, "results": data}
    except (ValueError, OSError, KeyError, IndexError, StopIteration) as error:
        passed = False
        report = {"passed": False, "status": "UNMEASURED", "reason": str(error)}
    if args.output:
        with args.output.open("x") as stream:
            json.dump(report, stream, indent=2)
    else:
        print(json.dumps(report, indent=2))
    sys.exit(0 if passed else 1)
